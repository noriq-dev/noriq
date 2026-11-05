/** Combine matching freshness SELECTs into bounded SQL statements and D1 batches. No results survive
 * a flush: later stages still read current data. Only pending identical reads are shared.
 * Keeping the existing evaluator avoids a second implementation of readiness/override rules.
 */
export function batchedFreshnessReads(db: D1Database): D1Database {
  type Pending = {
    sql: string;
    values: unknown[];
    statement: D1PreparedStatement;
    resolve: (result: D1Result) => void;
    reject: (error: unknown) => void;
    result: Promise<D1Result>;
  };
  let pending = new Map<string, Pending>();
  let scheduled = false;
  const flush = async () => {
    const reads = [...pending.values()];
    pending = new Map();
    scheduled = false;
    try {
      // Group identical query shapes. Each arm retains its own ORDER BY / LIMIT and DISTINCT;
      // UNION ALL must not deduplicate rows belonging to different subjects.
      const groups = new Map<string, Pending[]>();
      for (const read of reads) {
        const group = groups.get(read.sql) ?? [];
        group.push(read);
        groups.set(read.sql, group);
      }
      const requests: Array<{ statement: D1PreparedStatement; reads: Pending[]; combined: boolean }> = [];
      for (const group of groups.values()) {
        const sql = group[0]!.sql;
        // Only combine anonymous parameters. Numbered/named placeholders could alias between
        // arms; unfamiliar query shapes retain the ordinary batch behavior.
        const combinable = !/\?\d|[:@$][a-zA-Z_]/.test(sql);
        // workerd/D1 caps compound SELECTs at five arms, below stock SQLite's default.
        const width = combinable ? Math.max(1, Math.min(5,
          Math.floor(100 / Math.max(1, group[0]!.values.length)),
          Math.floor(80_000 / (new TextEncoder().encode(sql).length + 80)))) : 1;
        for (let i = 0; i < group.length; i += width) {
          const members = group.slice(i, i + width);
          requests.push({
            reads: members, combined: members.length > 1,
            statement: members.length === 1 ? members[0]!.statement : db.prepare(members.map((r, index) =>
              `SELECT ${index} AS __noriq_freshness_read, * FROM (${r.sql})`).join(' UNION ALL '))
              .bind(...members.flatMap(r => r.values)),
          });
        }
      }
      for (let i = 0; i < requests.length; i += 50) {
        const chunk = requests.slice(i, i + 50);
        try {
          const results = await db.batch(chunk.map(r => r.statement));
          chunk.forEach((request, n) => {
            const result = results[n];
            if (!result || !result.success) {
              request.reads.forEach(read => read.reject(new Error('Freshness read batch failed')));
            } else if (!request.combined) {
              request.reads[0]!.resolve(result);
            } else {
              const rows = request.reads.map(() => [] as Record<string, unknown>[]);
              for (const raw of result.results as Array<Record<string, unknown>>) {
                const { __noriq_freshness_read: index, ...row } = raw;
                rows[Number(index)]!.push(row);
              }
              request.reads.forEach((read, index) => read.resolve({ ...result, results: rows[index]! }));
            }
          });
        } catch (error) { chunk.forEach(request => request.reads.forEach(read => read.reject(error))); }
      }
    } catch (error) {
      // Also reject preparation/binding failures rather than leaving queued readers pending.
      reads.forEach(read => read.reject(error));
    }
  };
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    // This adapter is deliberately read-only and used only by the freshness evaluator.
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Freshness batching only supports SELECT');
    const raw = db.prepare(sql).bind(...values);
    const read = () => {
      const key = JSON.stringify([sql, values]);
      const existing = pending.get(key);
      if (existing) return existing.result;
      let resolve!: Pending['resolve'];
      let reject!: Pending['reject'];
      const result = new Promise<D1Result>((yes, no) => { resolve = yes; reject = no; });
      pending.set(key, { sql, values, statement: raw, resolve, reject, result });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => { void flush(); });
      }
      return result;
    };
    return new Proxy(raw, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => statement(sql, args);
        if (key === 'all') return read;
        if (key === 'first') return async (column?: string) => {
          const row = ((await read()).results[0] ?? null) as Record<string, unknown> | null;
          if (column === undefined || row === null) return row;
          if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found`);
          return row[column];
        };
        if (key === 'run' || key === 'raw') return () => { throw new Error('Freshness batching supports all() and first() only'); };
        return Reflect.get(target, key, target);
      },
    });
  };
  return new Proxy(db, {
    get(_target, key) {
      if (key === 'prepare') return statement;
      throw new Error('Freshness batching supports prepare() only');
    },
  });
}
