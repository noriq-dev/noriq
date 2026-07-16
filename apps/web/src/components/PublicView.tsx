// Public read-only project page (PLNR-78) — what an anonymous visitor sees at /p/:pid
// when the owner flipped the project public. Deliberately self-contained: it feeds off
// the reduced public snapshot, holds no session, and offers no mutations — a status
// page, not a workspace.
import { useEffect, useState } from 'react';
import { api, type PublicSnapshot } from '../api';
import { Markdown } from './Markdown';
import { MonoTag, SectionLabel } from './bits';
import { Logo } from './Logo';

const COLUMNS: Array<[string, string]> = [
  ['todo', 'Todo'],
  ['in_progress', 'In progress'],
  ['review', 'Review'],
  ['done', 'Done'],
];

export function PublicView({ pid, onNotPublic }: { pid: string; onNotPublic: () => void }) {
  const [snap, setSnap] = useState<PublicSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.publicSnapshot(pid).then(setSnap).catch(() => setFailed(true));
  }, [pid]);

  useEffect(() => {
    if (failed) onNotPublic();
  }, [failed, onNotPublic]);

  if (failed) return null;
  if (!snap) return <div style={{ height: '100vh', background: 'var(--bg)' }} />;

  const tasks = snap.tasks.filter((t) => !t.archivedAt);
  const tagById = new Map(snap.tags.map((t) => [t.id, t]));
  const tagsByTask = new Map<string, string[]>();
  for (const tt of snap.taskTags) tagsByTask.set(tt.taskId, [...(tagsByTask.get(tt.taskId) ?? []), tt.tagId]);
  const done = tasks.filter((t) => t.status === 'done').length;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      <div style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-raised)', padding: '12px 22px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Logo size={26} radius={7} />
        <span style={{ fontWeight: 700, fontSize: 15 }}>{snap.project.name}</span>
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={10}>{snap.project.key}</MonoTag>
        <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9}>PUBLIC · READ-ONLY</MonoTag>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
          {done}/{tasks.length} tasks done
        </span>
        <a href="/" style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent-ink)', textDecoration: 'none' }}>
          sign in →
        </a>
      </div>

      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 22px 60px' }}>
        {snap.project.description && (
          <div style={{ fontSize: 13, color: 'var(--text-mid)', marginBottom: 18 }}>{snap.project.description}</div>
        )}

        {/* board, read-only */}
        <div style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 8 }}>
          {COLUMNS.map(([st, label]) => {
            const list = tasks.filter((t) => t.status === st).sort((a, b) => b.priority - a.priority);
            return (
              <div key={st} style={{ width: 250, flex: 'none' }}>
                <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', padding: '2px 2px 10px' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-soft)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{list.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {list.map((t) => {
                    const tTags = (tagsByTask.get(t.id) ?? []).map((id) => tagById.get(id)).filter(Boolean) as Array<{ id: string; name: string; color: string }>;
                    return (
                      <div key={t.id} style={{ background: 'var(--card)', border: '1px solid var(--w-06)', borderLeft: `3px solid ${tTags[0]?.color ?? 'var(--w-08)'}`, borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', marginBottom: 5 }}>{t.key}</div>
                        <div style={{ fontSize: 12, lineHeight: 1.45 }}>{t.title}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* plans, read-only */}
        {snap.plans.length > 0 && (
          <div style={{ marginTop: 28 }}>
            <div style={{ marginBottom: 12 }}><SectionLabel>Plans</SectionLabel></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {snap.plans.map((pl) => (
                <details key={pl.id} style={{ border: '1px solid var(--w-08)', borderRadius: 12, background: 'var(--w-02)', padding: '12px 16px' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}>
                    {pl.title}
                    {pl.description ? <span style={{ fontWeight: 400, color: 'var(--text-dim)', fontSize: 11.5 }}> — {pl.description}</span> : null}
                  </summary>
                  <div style={{ marginTop: 10 }}><Markdown source={pl.body} compact /></div>
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
