# Reorder a `wrangler d1 export` dump so it imports through D1's REST import API.
#
#   python3 scripts/reorder-d1-dump.py dump.sql ordered.sql
#   wrangler d1 execute <db> --remote --file=ordered.sql
#
# Why (PLNR-143): D1's import endpoint does NOT honor the dump's leading
# `PRAGMA defer_foreign_keys=TRUE` across its internal batching, so a raw export
# fails with "no such table" / FK errors the moment one table's INSERTs reference
# a table that appears later in the file (tables are dumped alphabetically).
# BACKUP.md's restore path depends on this script for any schema with FK
# forward-references — which ours has had since `runners`.
#
# What it emits: schema first (tables in FK-topological order), then data in the
# same order, then indexes/triggers/views. True FK cycles (agents↔oauth_tokens)
# are broken by deferring a nullable, CHECK-free FK column: those columns load as
# NULL and are patched by UPDATEs once both sides exist. Self-referential tables
# emit parents before children. Explicit rowids are preserved for tables whose PK
# is not an INTEGER alias (the events notice-cursor relies on rowid).
#
# The output is verified before the script exits: re-imported into a scratch
# SQLite with foreign_keys=ON and NO deferral, row counts and events rowids
# compared, foreign_key_check clean. A run that prints OK IS the import
# rehearsal; on any failure it exits non-zero — do not use the output file.
import sqlite3, sys

SRC, OUT = sys.argv[1], sys.argv[2]

db = sqlite3.connect(':memory:')
db.execute('PRAGMA foreign_keys = OFF')
db.executescript(open(SRC).read())

skip = ('sqlite_', '_cf_')
tables = [r[0] for r in db.execute(
    "SELECT name FROM sqlite_master WHERE type='table'"
).fetchall() if not r[0].startswith(skip)]

tbl_sql_all = {r[0]: r[1] for r in db.execute(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")}

# FK graph: edges child -> set(parents); remember which column carries each edge.
deps, self_fk_cols, edge_cols = {}, {}, {}
for t in tables:
    fks = db.execute(f'PRAGMA foreign_key_list("{t}")').fetchall()
    deps[t] = {fk[2] for fk in fks if fk[2] != t and fk[2] in tables}
    self_fk_cols[t] = [fk[3] for fk in fks if fk[2] == t]
    for fk in fks:
        if fk[2] != t and fk[2] in tables:
            edge_cols.setdefault((t, fk[2]), []).append(fk[3])

def nullable(t, c):
    return not any(r[1] == c and r[3] for r in db.execute(f'PRAGMA table_info("{t}")').fetchall())

# Kahn topo sort; on a cycle, defer a nullable FK column (insert NULL, UPDATE later).
order, pending, deferred = [], dict(deps), {}   # deferred: table -> [cols]
while pending:
    ready = sorted(t for t, d in pending.items() if not (d - set(order)))
    if not ready:
        broke = False
        for t in sorted(pending):
            for parent in sorted(pending[t] - set(order)):
                cols = edge_cols[(t, parent)]
                # Only defer columns that are nullable AND not referenced by any CHECK
                # constraint (inserting NULL there could violate the CHECK — e.g.
                # agents.runner_id must be NOT NULL for kind='agent' rows).
                sql = tbl_sql_all[t].upper()
                checks = sql[sql.index('CHECK'):] if 'CHECK' in sql else ''
                if all(nullable(t, c) and c.upper() not in checks for c in cols):
                    deferred.setdefault(t, []).extend(cols)
                    pending[t] = pending[t] - {parent}
                    broke = True
                    break
            if broke: break
        if not broke:
            raise SystemExit(f'unbreakable FK cycle among: {sorted(pending)}')
        continue
    order.extend(ready)
    for t in ready: del pending[t]
if deferred:
    print('deferred edges:', {t: c for t, c in deferred.items()})

def cols_of(t):
    return [r[1] for r in db.execute(f'PRAGMA table_info("{t}")').fetchall()]

def has_integer_pk_alias(t):
    return any(r[5] == 1 and r[2].upper() == 'INTEGER'
               for r in db.execute(f'PRAGMA table_info("{t}")').fetchall())

def pk_col(t):
    pks = [r[1] for r in db.execute(f'PRAGMA table_info("{t}")').fetchall() if r[5] == 1]
    return pks[0] if len(pks) == 1 else None

out = open(OUT, 'w')
out.write('PRAGMA defer_foreign_keys=TRUE;\n')

# Schema: tables in topo order, then everything else (indexes/triggers/views) at the end.
master = db.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL").fetchall()
tbl_sql = {name: sql for (ty, name, tbl, sql) in master if ty == 'table'}
for t in order:
    out.write(tbl_sql[t].rstrip(';') + ';\n')

# Data. Deferred FK columns are inserted as NULL and patched by UPDATEs once their
# parent table has loaded (collected in `patches`, emitted after all inserts).
patches = []
for t in order:
    cols = cols_of(t)
    explicit_rowid = not has_integer_pk_alias(t)
    dcols = deferred.get(t, [])
    if dcols:
        key = 'rowid' if explicit_rowid else pk_col(t)
        for c in dcols:
            for rid, val in db.execute(
                f'SELECT quote("{key}"), quote("{c}") FROM "{t}" WHERE "{c}" IS NOT NULL'):
                patches.append(f'UPDATE "{t}" SET "{c}" = {val} WHERE "{key}" = {rid};')
    sel_cols = (['rowid'] if explicit_rowid else []) + cols
    ins_cols = ', '.join(f'"{c}"' for c in sel_cols)
    quoted = ', '.join(
        ("quote(NULL)" if c in dcols else f'quote("{c}")') for c in sel_cols)

    if self_fk_cols[t]:
        pk = pk_col(t)
        assert pk, f'{t} self-references but has no single-column pk'
        rows = db.execute(f'SELECT {quoted}, "{pk}", '
                          + ', '.join(f'"{c}"' for c in self_fk_cols[t])
                          + f' FROM "{t}" ORDER BY rowid').fetchall()
        n_extra = 1 + len(self_fk_cols[t])
        emitted, remaining = set(), list(rows)
        while remaining:
            progress = []
            still = []
            for row in remaining:
                parents = row[-(n_extra - 1):] if n_extra > 1 else []
                if all(p is None or p in emitted for p in parents):
                    progress.append(row)
                else:
                    still.append(row)
            if not progress:
                raise SystemExit(f'self-FK ordering stuck in {t} ({len(still)} rows)')
            for row in progress:
                vals = ', '.join(row[:-n_extra])
                out.write(f'INSERT INTO "{t}"({ins_cols}) VALUES({vals});\n')
                emitted.add(row[-n_extra])
            remaining = still
    else:
        for row in db.execute(f'SELECT {quoted} FROM "{t}" ORDER BY rowid'):
            out.write(f'INSERT INTO "{t}"({ins_cols}) VALUES({", ".join(row)});\n')

for p in patches:
    out.write(p + '\n')
for (ty, name, tbl, sql) in master:
    if ty != 'table' and not name.startswith('sqlite_'):
        out.write(sql.rstrip(';') + ';\n')
out.close()

# Strict rehearsal: FKs ON with NO deferral (the PRAGMA line is dropped), so every
# statement is FK-checked immediately — if this passes, no import batching can break it.
chk = sqlite3.connect(':memory:')
chk.execute('PRAGMA foreign_keys = ON')
body = open(OUT).read()
body = body.replace('PRAGMA defer_foreign_keys=TRUE;\n', '', 1)
try:
    chk.executescript(body)
except Exception as e:
    raise SystemExit(f'strict rehearsal failed: {e}')
viol = chk.execute('PRAGMA foreign_key_check').fetchall()
assert not viol, f'FK violations: {viol[:5]}'
for t in order:
    a = db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    b = chk.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    assert a == b, f'{t}: {a} != {b}'
for t, dcols in deferred.items():
    for c in dcols:
        a = db.execute(f'SELECT COUNT(*) FROM "{t}" WHERE "{c}" IS NOT NULL').fetchone()[0]
        b = chk.execute(f'SELECT COUNT(*) FROM "{t}" WHERE "{c}" IS NOT NULL').fetchone()[0]
        assert a == b, f'deferred {t}.{c}: {a} != {b} after patches'
ev_src = db.execute('SELECT MIN(rowid), MAX(rowid), COUNT(*) FROM events').fetchone()
ev_chk = chk.execute('SELECT MIN(rowid), MAX(rowid), COUNT(*) FROM events').fetchone()
assert ev_src == ev_chk, f'events rowids not preserved: {ev_src} vs {ev_chk}'
print(f'OK: {len(order)} tables, rowids preserved (events {ev_chk}), counts match, 0 FK violations')
