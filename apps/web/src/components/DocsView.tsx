// Project docs (PLNR-158, organization PLNR-188) — reference material agents and humans
// share. Humans edit here; agents read/write over MCP. Docs are organized by FOLDER
// (a path string, purely for this view — everything addresses docs by id) and by TAGS
// (the same vocabulary tasks use, for filtering).
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { ApiDocVersion, ApiDocVersionSummary, ApiProjectDoc } from '../api';
import type { AppStore } from '../store';
import { Markdown } from './Markdown';
import { MonoTag, SectionLabel } from './bits';
import { Button, TextInput } from './ui';
import { confirm } from './Dialog';

export interface DocumentDiffRow {
  kind: 'same' | 'changed' | 'added' | 'removed' | 'omitted';
  fromLine?: number;
  toLine?: number;
  fromText?: string;
  toText?: string;
}

export interface DocumentDiffResult {
  rows: DocumentDiffRow[];
  bounded: boolean;
}

const MAX_DIFF_CELLS = 200_000;
const MAX_DIFF_ROWS = 2_000;

function comparableDocument(doc: ApiDocVersion): string {
  return [
    `name: ${doc.name}`,
    `description: ${doc.description}`,
    `folder: ${doc.folder}`,
    `tags: ${doc.tags.join(', ')}`,
    '',
    doc.body,
  ].join('\n');
}

/** A bounded line diff: LCS for ordinary documents, positional fallback for pathological inputs. */
export function diffDocumentLines(fromText: string, toText: string): DocumentDiffResult {
  const from = fromText.split('\n');
  const to = toText.split('\n');
  let prefix = 0;
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < from.length - prefix && suffix < to.length - prefix
    && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) suffix += 1;

  const before: DocumentDiffRow[] = Array.from({ length: prefix }, (_, index) => ({
    kind: 'same', fromLine: index + 1, toLine: index + 1,
    fromText: from[index], toText: to[index],
  }));
  const fromMiddle = from.slice(prefix, from.length - suffix);
  const toMiddle = to.slice(prefix, to.length - suffix);
  const raw: DocumentDiffRow[] = [];
  let bounded = fromMiddle.length * toMiddle.length > MAX_DIFF_CELLS;

  if (bounded) {
    const shared = Math.min(fromMiddle.length, toMiddle.length);
    for (let index = 0; index < shared; index += 1) {
      raw.push({
        kind: fromMiddle[index] === toMiddle[index] ? 'same' : 'changed',
        fromLine: prefix + index + 1, toLine: prefix + index + 1,
        fromText: fromMiddle[index], toText: toMiddle[index],
      });
    }
    for (let index = shared; index < fromMiddle.length; index += 1) {
      raw.push({ kind: 'removed', fromLine: prefix + index + 1, fromText: fromMiddle[index] });
    }
    for (let index = shared; index < toMiddle.length; index += 1) {
      raw.push({ kind: 'added', toLine: prefix + index + 1, toText: toMiddle[index] });
    }
  } else {
    const width = toMiddle.length + 1;
    const lcs = new Uint32Array((fromMiddle.length + 1) * width);
    for (let fromIndex = fromMiddle.length - 1; fromIndex >= 0; fromIndex -= 1) {
      for (let toIndex = toMiddle.length - 1; toIndex >= 0; toIndex -= 1) {
        const cell = fromIndex * width + toIndex;
        lcs[cell] = fromMiddle[fromIndex] === toMiddle[toIndex]
          ? lcs[(fromIndex + 1) * width + toIndex + 1]! + 1
          : Math.max(lcs[(fromIndex + 1) * width + toIndex]!, lcs[fromIndex * width + toIndex + 1]!);
      }
    }
    let fromIndex = 0;
    let toIndex = 0;
    while (fromIndex < fromMiddle.length || toIndex < toMiddle.length) {
      if (fromIndex < fromMiddle.length && toIndex < toMiddle.length && fromMiddle[fromIndex] === toMiddle[toIndex]) {
        raw.push({
          kind: 'same', fromLine: prefix + fromIndex + 1, toLine: prefix + toIndex + 1,
          fromText: fromMiddle[fromIndex], toText: toMiddle[toIndex],
        });
        fromIndex += 1; toIndex += 1;
      } else if (
        fromIndex < fromMiddle.length
        && (toIndex >= toMiddle.length || lcs[(fromIndex + 1) * width + toIndex]! >= lcs[fromIndex * width + toIndex + 1]!)
      ) {
        raw.push({ kind: 'removed', fromLine: prefix + fromIndex + 1, fromText: fromMiddle[fromIndex] });
        fromIndex += 1;
      } else {
        raw.push({ kind: 'added', toLine: prefix + toIndex + 1, toText: toMiddle[toIndex] });
        toIndex += 1;
      }
    }
  }

  // Pair adjacent remove/add runs into explicit changed rows while retaining unpaired additions/removals.
  const middle: DocumentDiffRow[] = [];
  for (let index = 0; index < raw.length;) {
    if (raw[index]!.kind === 'same' || raw[index]!.kind === 'changed') {
      middle.push(raw[index]!); index += 1; continue;
    }
    const segment: DocumentDiffRow[] = [];
    while (index < raw.length && raw[index]!.kind !== 'same' && raw[index]!.kind !== 'changed') {
      segment.push(raw[index]!); index += 1;
    }
    const removed = segment.filter((row) => row.kind === 'removed');
    const added = segment.filter((row) => row.kind === 'added');
    const paired = Math.min(removed.length, added.length);
    for (let pair = 0; pair < paired; pair += 1) {
      middle.push({
        kind: 'changed', fromLine: removed[pair]!.fromLine, toLine: added[pair]!.toLine,
        fromText: removed[pair]!.fromText, toText: added[pair]!.toText,
      });
    }
    middle.push(...removed.slice(paired), ...added.slice(paired));
  }

  const after: DocumentDiffRow[] = Array.from({ length: suffix }, (_, index) => ({
    kind: 'same',
    fromLine: from.length - suffix + index + 1,
    toLine: to.length - suffix + index + 1,
    fromText: from[from.length - suffix + index],
    toText: to[to.length - suffix + index],
  }));
  let rows = [...before, ...middle, ...after];
  if (rows.length > MAX_DIFF_ROWS) {
    const edge = Math.floor(MAX_DIFF_ROWS / 2);
    const omitted = rows.length - edge * 2;
    rows = [
      ...rows.slice(0, edge),
      { kind: 'omitted', fromText: `${omitted.toLocaleString()} unchanged or changed lines omitted to keep this comparison responsive` },
      ...rows.slice(-edge),
    ];
    bounded = true;
  }
  return { rows, bounded };
}

export function DocsView({ store }: { store: AppStore }) {
  const { currentPid, snapshot, actions } = store;
  const [docs, setDocs] = useState<ApiProjectDoc[]>([]);
  const [archivedDocs, setArchivedDocs] = useState<ApiProjectDoc[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [versions, setVersions] = useState<ApiDocVersionSummary[]>([]);
  const [viewedVersion, setViewedVersion] = useState<ApiDocVersion | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareFrom, setCompareFrom] = useState<number | null>(null);
  const [compareTo, setCompareTo] = useState<number | null>(null);
  const [comparison, setComparison] = useState<{ from: ApiDocVersion; to: ApiDocVersion } | null>(null);
  const [compareError, setCompareError] = useState(false);
  const requestedVersion = useRef<{ docId: string; version: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [eName, setEName] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eBody, setEBody] = useState('');
  const [eFolder, setEFolder] = useState('');
  const [eTags, setETags] = useState('');

  const load = () => Promise.all([api.docs(currentPid), api.docs(currentPid, true)])
    .then(([active, archived]) => { setDocs(active.docs); setArchivedDocs(archived.docs); })
    .catch(() => {});
  const collapseInitFor = useRef<string | null>(null);
  useEffect(() => {
    // Deep link from the palette / task drawer (PLNR-186): open a specific doc on arrival.
    const hint = sessionStorage.getItem('noriq.openDoc');
    const versionHint = Number(sessionStorage.getItem('noriq.openDocVersion'));
    sessionStorage.removeItem('noriq.openDoc');
    sessionStorage.removeItem('noriq.openDocVersion');
    setSelected(hint || null);
    requestedVersion.current = hint && Number.isInteger(versionHint) && versionHint > 0 ? { docId: hint, version: versionHint } : null;
    setEditing(false);
    setShowArchived(false);
    setVersions([]);
    setViewedVersion(null);
    setCompareOpen(false);
    setComparison(null);
    setTagFilter(null);
    setCollapsed(new Set());
    collapseInitFor.current = null;
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [currentPid]);

  // Live updates (PLNR-193): the WS invalidation refreshes the snapshot; ride that
  // signal to re-fetch the docs list too, so agent-written docs appear without a
  // manual refresh. Selection survives (matched by id); the editor's local draft
  // state is untouched.
  useEffect(() => {
    if (snapshot) load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [snapshot]);

  // Exact deep links can target a retained archived doc. Once both lists arrive, switch to the
  // archive rather than presenting a blank reader for an id that still exists.
  useEffect(() => {
    if (selected && archivedDocs.some((doc) => doc.id === selected) && !docs.some((doc) => doc.id === selected)) {
      setShowArchived(true);
    }
  }, [archivedDocs, docs, selected]);

  // Past 5 docs, folders start collapsed so the list is navigable (PLNR-193) — once
  // per project, so user toggles (and folders born later) are respected afterward.
  // The selected doc's folder stays open so deep links land visible.
  useEffect(() => {
    if (!docs.length || collapseInitFor.current === currentPid) return;
    collapseInitFor.current = currentPid;
    if (docs.length > 5) {
      const selFolder = docs.find((d) => d.id === selected)?.folder;
      setCollapsed(new Set(docs.map((d) => d.folder).filter((f) => f && f !== selFolder)));
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [docs, currentPid]);

  const visibleDocs = showArchived ? archivedDocs : docs;
  const sel = visibleDocs.find((d) => d.id === selected) ?? null;
  const readDoc = viewedVersion ?? sel;
  const viewingHistory = !!viewedVersion && !!sel && viewedVersion.version !== sel.version;

  useEffect(() => {
    setViewedVersion(null);
    setVersions([]);
    setCompareOpen(false);
    setComparison(null);
    if (!selected) return;
    void api.docVersions(currentPid, selected).then((result) => setVersions(result.versions)).catch(() => {});
    const requested = requestedVersion.current;
    if (requested?.docId === selected) {
      requestedVersion.current = null;
      void api.docVersion(currentPid, selected, requested.version)
        .then((version) => setViewedVersion(version.version === version.currentVersion ? null : version))
        .catch(() => {});
    }
  }, [currentPid, selected]);

  useEffect(() => {
    if (!compareOpen || !selected || compareFrom == null || compareTo == null) return;
    let current = true;
    setComparison(null);
    setCompareError(false);
    void Promise.all([
      api.docVersion(currentPid, selected, compareFrom),
      api.docVersion(currentPid, selected, compareTo),
    ]).then(([from, to]) => {
      if (current) setComparison({ from, to });
    }).catch(() => {
      if (current) setCompareError(true);
    });
    return () => { current = false; };
  }, [compareFrom, compareOpen, compareTo, currentPid, selected]);
  // Tasks citing the selected doc (PLNR-182) — from the live snapshot's link pairs.
  const linkedTasks = sel
    ? (snapshot?.taskDocs ?? []).filter((l) => l.docId === sel.id)
        .map((l) => (snapshot?.tasks ?? []).find((t) => t.id === l.taskId))
        .filter((t): t is NonNullable<typeof t> => !!t)
    : [];

  const tagColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of snapshot?.tags ?? []) m.set(t.name, t.color);
    return m;
  }, [snapshot?.tags]);

  const tagsInUse = useMemo(() => [...new Set(visibleDocs.flatMap((d) => d.tags))].sort(), [visibleDocs]);
  const foldersInUse = useMemo(() => [...new Set(docs.map((d) => d.folder).filter(Boolean))].sort(), [docs]);

  // Folder groups, root ('') first, then paths alphabetically. Tag filter applies inside.
  const groups = useMemo(() => {
    const visible = tagFilter ? visibleDocs.filter((d) => d.tags.includes(tagFilter)) : visibleDocs;
    const byFolder = new Map<string, ApiProjectDoc[]>();
    for (const d of visible) {
      const list = byFolder.get(d.folder) ?? [];
      list.push(d);
      byFolder.set(d.folder, list);
    }
    return [...byFolder.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [visibleDocs, tagFilter]);
  const documentDiff = useMemo(() => comparison
    ? diffDocumentLines(comparableDocument(comparison.from), comparableDocument(comparison.to))
    : null, [comparison]);

  const startNew = () => { setSelected(null); setEName(''); setEDesc(''); setEBody(''); setEFolder(''); setETags(''); setEditing(true); };
  const startEdit = () => {
    if (!sel) return;
    setEName(sel.name); setEDesc(sel.description); setEBody(sel.body);
    setEFolder(sel.folder); setETags(sel.tags.join(', '));
    setEditing(true);
  };
  const save = async () => {
    if (!eName.trim()) return;
    const fields = {
      name: eName.trim(), description: eDesc.trim(), body: eBody,
      folder: eFolder.trim(), tags: eTags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    };
    if (sel && editing) await api.updateDoc(currentPid, sel.id, fields);
    else await api.createDoc(currentPid, fields);
    setEditing(false);
    load();
  };

  const docCard = (d: ApiProjectDoc, indent: boolean) => (
    <div
      key={d.id}
      data-doc-id={d.id}
      onClick={() => { requestedVersion.current = null; setSelected(d.id); setEditing(false); }}
      className="hover-border"
      style={{
        padding: '9px 12px', borderRadius: 10, cursor: 'pointer', marginLeft: indent ? 14 : 0,
        background: selected === d.id ? 'var(--w-045)' : 'var(--w-02)',
        border: `1px solid ${selected === d.id ? 'var(--w-18)' : 'var(--w-07)'}`,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{d.archivedAt ? '🗄 ' : ''}{d.name}</div>
      {d.description && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{d.description}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 4 }}>
        {d.tags.map((t) => (
          <MonoTag key={t} color={tagColor.get(t) ?? 'var(--text-mid)'} bg="var(--w-04)" size={8.5}>{t}</MonoTag>
        ))}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
          v{d.version} · {d.authorName} · {new Date(d.updatedAt).toLocaleDateString()}
        </span>
      </div>
    </div>
  );

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '320px 1fr', minHeight: 0 }} className="agents-grid">
      <div style={{ borderRight: '1px solid var(--line)', overflowY: 'auto', padding: '16px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <SectionLabel>{showArchived ? 'Archived docs' : 'Docs'} · {visibleDocs.length}</SectionLabel>
          <div style={{ flex: 1 }} />
          {archivedDocs.length > 0 && (
            <Button
              variant="ghost"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={() => { setShowArchived((value) => !value); setSelected(null); setEditing(false); setTagFilter(null); }}
            >
              {showArchived ? 'active' : `archive · ${archivedDocs.length}`}
            </Button>
          )}
          {!showArchived && <Button variant="ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={startNew}>+ new</Button>}
        </div>
        {tagsInUse.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
            {tagsInUse.map((t) => {
              const on = tagFilter === t;
              return (
                <button
                  key={t}
                  onClick={() => setTagFilter(on ? null : t)}
                  style={{
                    cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, borderRadius: 6, padding: '2px 8px',
                    color: on ? '#0a0b0d' : (tagColor.get(t) ?? 'var(--text-mid)'),
                    background: on ? (tagColor.get(t) ?? 'var(--accent)') : 'var(--w-04)',
                    border: `1px solid ${on ? (tagColor.get(t) ?? 'var(--accent)') : 'var(--w-1)'}`,
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {groups.map(([folder, list]) => folder === '' ? (
            list.map((d) => docCard(d, false))
          ) : (
            <div key={folder} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                onClick={() => setCollapsed((c) => {
                  const n = new Set(c);
                  n.has(folder) ? n.delete(folder) : n.add(folder);
                  return n;
                })}
                style={{
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, background: 'transparent',
                  border: 'none', padding: '3px 2px', color: 'var(--text-mid)', textAlign: 'left',
                }}
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{collapsed.has(folder) ? '▸' : '▾'}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '.03em' }}>📁 {folder}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{list.length}</span>
              </button>
              {!collapsed.has(folder) && list.map((d) => docCard(d, true))}
            </div>
          ))}
          {!visibleDocs.length && !editing && (
            <div style={{ padding: 30, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
              {showArchived ? 'no archived docs' : 'no docs yet — conventions, architecture notes, decisions live here'}
            </div>
          )}
          {visibleDocs.length > 0 && groups.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
              nothing tagged “{tagFilter}”
            </div>
          )}
        </div>
      </div>

      <div style={{ overflowY: 'auto', padding: '18px 24px' }}>
        {editing ? (
          <div style={{ maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <TextInput autoFocus placeholder="doc name" value={eName} onChange={(e) => setEName(e.target.value)} />
            <TextInput placeholder="one-line description (what a reader finds inside)" value={eDesc} onChange={(e) => setEDesc(e.target.value)} />
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <TextInput list="noriq-doc-folders" placeholder="folder — e.g. design/networking (empty = root)" value={eFolder} onChange={(e) => setEFolder(e.target.value)} />
                <datalist id="noriq-doc-folders">
                  {foldersInUse.map((f) => <option key={f} value={f} />)}
                </datalist>
              </div>
              <div style={{ flex: 1 }}>
                <TextInput placeholder="tags, comma-separated — shared with task tags" value={eTags} onChange={(e) => setETags(e.target.value)} />
              </div>
            </div>
            <textarea
              value={eBody}
              onChange={(e) => setEBody(e.target.value)}
              placeholder="markdown…"
              rows={20}
              style={{
                background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 10,
                padding: '12px 14px', color: 'var(--text)', fontSize: 13, lineHeight: 1.6,
                fontFamily: 'var(--mono)', outline: 'none', resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setEditing(false)}>cancel</Button>
              <Button onClick={() => void save()}>save</Button>
            </div>
          </div>
        ) : sel && readDoc ? (
          <div style={{ maxWidth: 780 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{readDoc.name}</h2>
              <MonoTag color={viewingHistory ? 'var(--amber)' : 'var(--accent)'} bg="var(--w-04)" size={9}>
                v{readDoc.version}{viewingHistory ? ' · HISTORY' : ''}
              </MonoTag>
              <div style={{ flex: 1 }} />
              {sel.archivedAt ? (
                <Button
                  variant="ghost"
                  style={{ padding: '5px 12px', fontSize: 11.5 }}
                  onClick={async () => {
                    await api.restoreDoc(currentPid, sel.id);
                    setSelected(null);
                    setShowArchived(false);
                    await load();
                  }}
                >restore</Button>
              ) : viewingHistory ? (
                <Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={() => setViewedVersion(null)}>current</Button>
              ) : (
                <>
                  <Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={startEdit}>edit</Button>
                  <Button
                    variant="ghost"
                    style={{ padding: '5px 12px', fontSize: 11.5 }}
                    onClick={async () => {
                      if (await confirm(`Archive doc "${sel.name}"? It will leave search and task context, but its version history will be retained.`, { confirmLabel: 'Archive' })) {
                        await api.archiveDoc(currentPid, sel.id);
                        setSelected(null);
                        await load();
                      }
                    }}
                  >archive</Button>
                </>
              )}
              <Button
                variant="danger"
                style={{ padding: '5px 12px', fontSize: 11.5 }}
                onClick={async () => {
                  if (await confirm(`Permanently delete doc "${sel.name}" and all ${sel.version} version${sel.version === 1 ? '' : 's'}?`, { confirmLabel: 'Delete permanently' })) {
                    await api.deleteDoc(currentPid, sel.id);
                    setSelected(null);
                    await load();
                  }
                }}
              >
                delete
              </Button>
            </div>
            {versions.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  version history
                </span>
                <select
                  aria-label="Document version"
                  value={readDoc.version}
                  onChange={(event) => {
                    const version = Number(event.target.value);
                    if (version === sel.version) setViewedVersion(null);
                    else void api.docVersion(currentPid, sel.id, version).then(setViewedVersion);
                  }}
                  style={{ background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 7, color: 'var(--text-soft)', padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10.5 }}
                >
                  {versions.map((item) => (
                    <option key={item.version} value={item.version}>
                      v{item.version}{item.version === sel.version ? ' · current' : ''} · {item.authorName} · {new Date(item.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
                {versions.length > 1 && (
                  <Button
                    variant="ghost"
                    style={{ padding: '4px 10px', fontSize: 10.5 }}
                    onClick={() => {
                      if (compareOpen) {
                        setCompareOpen(false);
                        setComparison(null);
                        return;
                      }
                      setCompareFrom(versions.find((item) => item.version !== sel.version)?.version ?? versions[0]!.version);
                      setCompareTo(sel.version);
                      setCompareOpen(true);
                    }}
                  >{compareOpen ? 'close compare' : 'compare'}</Button>
                )}
              </div>
            )}
            {compareOpen && compareFrom != null && compareTo != null && (
              <section
                data-testid="doc-version-compare"
                style={{ marginBottom: 18, border: '1px solid var(--w-1)', background: 'var(--w-015)', borderRadius: 10, overflow: 'hidden' }}
              >
                <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--w-08)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em' }}>compare</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                    from
                    <select
                      aria-label="Compare from revision"
                      value={compareFrom}
                      onChange={(event) => setCompareFrom(Number(event.target.value))}
                      style={{ background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 6, color: 'var(--text-soft)', padding: '3px 7px', fontFamily: 'var(--mono)', fontSize: 10.5 }}
                    >
                      {versions.map((item) => <option key={item.version} value={item.version}>v{item.version}</option>)}
                    </select>
                  </label>
                  <span style={{ color: 'var(--text-faint)' }}>→</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                    to
                    <select
                      aria-label="Compare to revision"
                      value={compareTo}
                      onChange={(event) => setCompareTo(Number(event.target.value))}
                      style={{ background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 6, color: 'var(--text-soft)', padding: '3px 7px', fontFamily: 'var(--mono)', fontSize: 10.5 }}
                    >
                      {versions.map((item) => <option key={item.version} value={item.version}>v{item.version}</option>)}
                    </select>
                  </label>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
                    name · description · folder · tags · body
                  </span>
                </div>
                {compareError ? (
                  <div style={{ padding: 14, color: 'var(--red)', fontSize: 11.5 }}>Could not load one of these retained revisions.</div>
                ) : !documentDiff ? (
                  <div style={{ padding: 14, color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>loading revisions…</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    {documentDiff.bounded && (
                      <div style={{ padding: '7px 10px', borderBottom: '1px solid rgba(245,166,35,.25)', background: 'rgba(245,166,35,.06)', color: 'var(--amber)', fontSize: 10.5 }}>
                        Large comparison · showing a bounded line result.
                      </div>
                    )}
                    <div style={{ minWidth: 620, fontFamily: 'var(--mono)', fontSize: 10.5, lineHeight: 1.45 }}>
                      {documentDiff.rows.map((row, index) => {
                        if (row.kind === 'omitted') return (
                          <div key={`omitted-${index}`} data-diff-kind="omitted" style={{ padding: '8px 12px', textAlign: 'center', color: 'var(--text-dim)', borderBottom: '1px solid var(--w-05)' }}>
                            ⋯ {row.fromText} ⋯
                          </div>
                        );
                        const changed = row.kind === 'changed';
                        const leftBg = row.kind === 'removed' ? 'rgba(255,88,105,.11)' : changed ? 'rgba(245,166,35,.09)' : 'transparent';
                        const rightBg = row.kind === 'added' ? 'rgba(63,217,139,.10)' : changed ? 'rgba(245,166,35,.09)' : 'transparent';
                        return (
                          <div
                            key={`${row.kind}-${row.fromLine ?? 'x'}-${row.toLine ?? 'x'}-${index}`}
                            data-diff-kind={row.kind}
                            style={{ display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr) 42px minmax(0, 1fr)', borderBottom: '1px solid var(--w-05)' }}
                          >
                            <span style={{ padding: '3px 7px', textAlign: 'right', color: 'var(--text-faint)', background: leftBg, userSelect: 'none' }}>{row.fromLine ?? ''}</span>
                            <span style={{ padding: '3px 8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: row.kind === 'removed' ? 'var(--red)' : changed ? 'var(--amber)' : 'var(--text-dim)', background: leftBg }}>{row.fromText ?? ''}</span>
                            <span style={{ padding: '3px 7px', textAlign: 'right', color: 'var(--text-faint)', background: rightBg, userSelect: 'none' }}>{row.toLine ?? ''}</span>
                            <span style={{ padding: '3px 8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: row.kind === 'added' ? 'var(--green)' : changed ? 'var(--amber)' : 'var(--text-dim)', background: rightBg }}>{row.toText ?? ''}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            )}
            {viewingHistory && (
              <div style={{ marginBottom: 12, border: '1px solid rgba(245,166,35,.3)', background: 'rgba(245,166,35,.07)', borderRadius: 8, padding: '8px 10px', color: 'var(--text-dim)', fontSize: 11.5 }}>
                Read-only historical snapshot. Return to v{sel.version} to edit the current document.
              </div>
            )}
            {sel.archivedAt && (
              <div style={{ marginBottom: 12, border: '1px solid var(--w-1)', background: 'var(--w-025)', borderRadius: 8, padding: '8px 10px', color: 'var(--text-dim)', fontSize: 11.5 }}>
                Archived · excluded from search and task context. Restore it before editing.
              </div>
            )}
            {(readDoc.folder || readDoc.tags.length > 0) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                {readDoc.folder && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>📁 {readDoc.folder}</span>}
                {readDoc.tags.map((t) => (
                  <MonoTag key={t} color={tagColor.get(t) ?? 'var(--text-mid)'} bg="var(--w-04)" size={9}>{t}</MonoTag>
                ))}
              </div>
            )}
            {linkedTasks.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 14 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  cited by {linkedTasks.length} task{linkedTasks.length === 1 ? '' : 's'}
                </span>
                {linkedTasks.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => actions.openTask(t.id)}
                    className="hover-border"
                    style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--w-02)', border: '1px solid var(--w-07)', borderRadius: 7, padding: '3px 9px', color: 'var(--text-soft)', fontSize: 11 }}
                  >
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{t.key}</span>
                    <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  </button>
                ))}
              </div>
            )}
            <Markdown source={readDoc.body || '_empty_'} />
          </div>
        ) : (
          <div style={{ padding: 60, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
            select a doc — or write one
          </div>
        )}
      </div>
    </div>
  );
}
