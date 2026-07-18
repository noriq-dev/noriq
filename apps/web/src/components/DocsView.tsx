// Project docs (PLNR-158) — reference material agents and humans share: conventions,
// architecture notes, decisions. Humans edit here; agents read/write over MCP.
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppStore } from '../store';
import { Markdown } from './Markdown';
import { SectionLabel } from './bits';
import { Button, TextInput } from './ui';
import { confirm } from './Dialog';

interface Doc { id: string; name: string; description: string; body: string; authorKind: string; authorName: string; updatedAt: string }

export function DocsView({ store }: { store: AppStore }) {
  const { currentPid, snapshot, actions } = store;
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eBody, setEBody] = useState('');

  const load = () => api.docs(currentPid).then((r) => { setDocs(r.docs); }).catch(() => {});
  useEffect(() => {
    // Deep link from the palette / task drawer (PLNR-186): open a specific doc on arrival.
    const hint = sessionStorage.getItem('noriq.openDoc');
    sessionStorage.removeItem('noriq.openDoc');
    setSelected(hint || null);
    setEditing(false);
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [currentPid]);

  const sel = docs.find((d) => d.id === selected) ?? null;
  // Tasks citing the selected doc (PLNR-182) — from the live snapshot's link pairs.
  const linkedTasks = sel
    ? (snapshot?.taskDocs ?? []).filter((l) => l.docId === sel.id)
        .map((l) => (snapshot?.tasks ?? []).find((t) => t.id === l.taskId))
        .filter((t): t is NonNullable<typeof t> => !!t)
    : [];
  const startNew = () => { setSelected(null); setEName(''); setEDesc(''); setEBody(''); setEditing(true); };
  const startEdit = () => { if (!sel) return; setEName(sel.name); setEDesc(sel.description); setEBody(sel.body); setEditing(true); };
  const save = async () => {
    if (!eName.trim()) return;
    if (sel && editing) await api.updateDoc(currentPid, sel.id, { name: eName.trim(), description: eDesc.trim(), body: eBody });
    else await api.createDoc(currentPid, { name: eName.trim(), description: eDesc.trim(), body: eBody });
    setEditing(false);
    load();
  };

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '300px 1fr', minHeight: 0 }} className="agents-grid">
      <div style={{ borderRight: '1px solid var(--line)', overflowY: 'auto', padding: '16px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <SectionLabel>Docs · {docs.length}</SectionLabel>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={startNew}>+ new</Button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {docs.map((d) => (
            <div
              key={d.id}
              onClick={() => { setSelected(d.id); setEditing(false); }}
              className="hover-border"
              style={{
                padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                background: selected === d.id ? 'var(--w-045)' : 'var(--w-02)',
                border: `1px solid ${selected === d.id ? 'var(--w-18)' : 'var(--w-07)'}`,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</div>
              {d.description && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{d.description}</div>}
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', marginTop: 4 }}>
                {d.authorName} · {new Date(d.updatedAt).toLocaleDateString()}
              </div>
            </div>
          ))}
          {!docs.length && !editing && (
            <div style={{ padding: 30, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
              no docs yet — conventions, architecture notes, decisions live here
            </div>
          )}
        </div>
      </div>

      <div style={{ overflowY: 'auto', padding: '18px 24px' }}>
        {editing ? (
          <div style={{ maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <TextInput autoFocus placeholder="doc name" value={eName} onChange={(e) => setEName(e.target.value)} />
            <TextInput placeholder="one-line description (what a reader finds inside)" value={eDesc} onChange={(e) => setEDesc(e.target.value)} />
            <textarea
              value={eBody}
              onChange={(e) => setEBody(e.target.value)}
              placeholder="markdown…"
              rows={22}
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
        ) : sel ? (
          <div style={{ maxWidth: 780 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{sel.name}</h2>
              <div style={{ flex: 1 }} />
              <Button variant="ghost" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={startEdit}>edit</Button>
              <Button
                variant="danger"
                style={{ padding: '5px 12px', fontSize: 11.5 }}
                onClick={async () => {
                  if (await confirm(`Delete doc "${sel.name}"?`)) {
                    await api.deleteDoc(currentPid, sel.id);
                    setSelected(null);
                    load();
                  }
                }}
              >
                delete
              </Button>
            </div>
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
            <Markdown source={sel.body || '_empty_'} />
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
