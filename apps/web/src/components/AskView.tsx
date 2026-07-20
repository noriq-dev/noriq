// AskView (PLNR-219) — "ask the project": a read-only RAG box for the humans. The question
// is matched against this project's tasks/docs/plans (semantic → keyword) and answered by
// Workers AI grounded ONLY on those hits, which are shown as clickable sources. Ephemeral
// local state — nothing is created, nothing touches the live snapshot/WS store (same shape
// as Home's AttentionSection and the command-palette search).
import { useState } from 'react';
import { api, ApiError, type ApiAskSource } from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Button } from './ui';
import { Markdown } from './Markdown';

const KIND_COLOR: Record<ApiAskSource['kind'], string> = {
  task: 'var(--blue)',
  doc: 'var(--green, var(--accent-ink))',
  plan: 'var(--amber)',
};

const EXAMPLES = [
  'How do we handle DB cutovers without losing writes?',
  'What is left before the next release?',
  'How does agent authentication work?',
];

export function AskView({ store }: { store: AppStore }) {
  const { currentPid, actions } = store;
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<ApiAskSource[]>([]);
  const [mode, setMode] = useState<'semantic' | 'keyword' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ask = async (text?: string) => {
    const question = (text ?? q).trim();
    if (!question || loading) return;
    if (text) setQ(text);
    setLoading(true);
    setError('');
    setAnswer('');
    setSources([]);
    setMode(null);
    setAsked(question);
    try {
      const r = await api.ask(currentPid, question);
      setAnswer(r.answer || '_No answer was produced._');
      setSources(r.sources);
      setMode(r.mode);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 503
          ? 'This instance has no AI backend configured — asking questions needs the Workers AI binding.'
          : e instanceof Error ? e.message : 'Something went wrong.',
      );
    } finally {
      setLoading(false);
    }
  };

  const openSource = (s: ApiAskSource) => {
    if (s.kind === 'task') actions.openTask(s.id);
    else if (s.kind === 'doc') { sessionStorage.setItem('noriq.openDoc', s.id); actions.setView('docs'); }
    else actions.setView('plans');
  };

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}>
      <div className="content-pad" style={{ maxWidth: 760, margin: '0 auto', padding: '44px 28px 60px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.02em', margin: '0 0 6px' }}>Ask this project</h1>
        <div style={{ fontSize: 12.5, color: 'var(--text-mid)', marginBottom: 22, lineHeight: 1.55 }}>
          Answered from this project's tasks, docs and plans — grounded on the sources shown, nothing invented. Read-only; it creates nothing.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); }}
            placeholder="Ask a question about this project…"
            rows={3}
            style={{
              boxSizing: 'border-box', width: '100%', background: 'var(--w-03)', border: '1px solid var(--w-1)',
              borderRadius: 10, padding: '11px 13px', color: 'var(--text)', fontSize: 13.5, lineHeight: 1.5,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button onClick={() => ask()} disabled={!q.trim() || loading}>{loading ? 'Thinking…' : 'Ask'}</Button>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>⌘↵ to send</span>
          </div>
        </div>

        {!asked && !loading && (
          <div style={{ marginTop: 22, display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => ask(ex)}
                className="hover-bright"
                style={{
                  cursor: 'pointer', fontSize: 11.5, color: 'var(--text-mid)', background: 'var(--w-03)',
                  border: '1px solid var(--w-08)', borderRadius: 20, padding: '5px 12px', textAlign: 'left',
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div style={{ marginTop: 20, fontSize: 12.5, color: 'var(--red-soft)', border: '1px solid rgba(255,92,92,.3)', borderRadius: 10, background: 'rgba(255,92,92,.05)', padding: '11px 13px', lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        {(loading || answer) && !error && (
          <div style={{ marginTop: 26 }}>
            {asked && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 12, lineHeight: 1.5 }}>{asked}</div>}
            <div style={{ border: '1px solid var(--w-08)', borderRadius: 12, background: 'var(--card)', padding: '16px 18px' }}>
              {loading ? (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-dim)' }}>searching the project and drafting an answer…</div>
              ) : (
                <div style={{ fontSize: 13.5, lineHeight: 1.6 }}><Markdown source={answer} /></div>
              )}
            </div>

            {!loading && sources.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <SectionLabel>Sources</SectionLabel>
                  {mode && <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{mode} match</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {sources.map((s) => (
                    <div
                      key={`${s.kind}:${s.id}`}
                      onClick={() => openSource(s)}
                      className="hover-border"
                      style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--w-07)', borderRadius: 9, background: 'var(--w-02)', padding: '8px 11px', cursor: 'pointer' }}
                    >
                      <MonoTag color={KIND_COLOR[s.kind]} bg="var(--w-04)" size={8.5}>{s.kind.toUpperCase()}</MonoTag>
                      {s.key && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', flex: 'none' }}>{s.key}</span>}
                      <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
