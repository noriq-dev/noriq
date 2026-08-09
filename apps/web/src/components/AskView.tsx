// Global Ask — a browser-session multi-turn chat, enriched with accessible project context.
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type ApiAskHistoryMessage, type ApiAskSource } from '../api';
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
  'What needs my attention across all projects?',
  'Compare the release plans across my projects.',
  'Help me think through a safe database cutover.',
];

interface ThreadMessage extends ApiAskHistoryMessage {
  sources?: ApiAskSource[];
  mode?: 'semantic' | 'keyword';
  model?: string;
}

function loadThread(key: string): ThreadMessage[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((m): m is ThreadMessage =>
      !!m && typeof m === 'object'
      && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string');
  } catch {
    return [];
  }
}

const modelLabel = (model?: string) => model?.includes('gpt-oss-120b') ? 'GPT-OSS 120B · Cloudflare' : 'Cloudflare Workers AI';

export function AskView({ store }: { store: AppStore }) {
  const { actions } = store;
  const storageKey = `noriq.ask.thread.${store.user?.id ?? 'current'}`;
  const [messages, setMessages] = useState<ThreadMessage[]>(() => loadThread(storageKey));
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(messages.slice(-30))); } catch { /* storage may be disabled */ }
  }, [messages, storageKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  const ask = async (text?: string) => {
    const question = (text ?? q).trim();
    if (!question || loading) return;
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, { role: 'user', content: question }]);
    setQ('');
    setLoading(true);
    setError('');
    try {
      const r = await api.ask(question, history);
      setMessages((current) => [...current, {
        role: 'assistant',
        content: r.answer || '_No answer was produced._',
        sources: r.sources,
        mode: r.mode,
        model: r.model,
      }]);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 503
          ? 'This instance has no AI backend configured — Ask needs the Workers AI binding.'
          : e instanceof Error ? e.message : 'Something went wrong.',
      );
    } finally {
      setLoading(false);
    }
  };

  const newChat = () => {
    setMessages([]);
    setQ('');
    setError('');
  };

  const openSource = (s: ApiAskSource) => {
    actions.selectProject(s.projectId);
    if (s.kind === 'task') actions.openTask(s.id);
    else if (s.kind === 'doc') {
      sessionStorage.setItem('noriq.openDoc', s.id);
      actions.setView('docs');
    } else actions.setView('plans');
  };

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ height: 54, flex: 'none', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', padding: '0 22px', background: 'var(--bg-raised)' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>Ask</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', marginTop: 1 }}>GLOBAL ASSISTANT</div>
        </div>
        <div style={{ flex: 1 }} />
        {messages.length > 0 && (
          <button onClick={newChat} className="hover-bright" style={{ cursor: 'pointer', color: 'var(--text-mid)', fontSize: 11.5, padding: '6px 9px', borderRadius: 7 }}>
            + New chat
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div className="content-pad" style={{ maxWidth: 800, margin: '0 auto', padding: messages.length ? '28px 28px 36px' : '68px 28px 36px' }}>
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
              <div style={{ color: 'var(--accent)', fontSize: 28, lineHeight: 1, marginBottom: 16 }}>✦</div>
              <h1 style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-.025em', margin: '0 0 8px' }}>How can I help?</h1>
              <div style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>
                Chat normally, or ask across the tasks, docs, and plans in every project you can access.
                Project answers include their sources.
              </div>
              <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left' }}>
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => void ask(ex)} className="hover-border" style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--text-mid)', background: 'var(--w-02)', border: '1px solid var(--w-08)', borderRadius: 10, padding: '10px 13px', textAlign: 'left' }}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) => (
            <div key={index} style={{ marginBottom: 24 }}>
              {message.role === 'user' ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <div style={{ maxWidth: '82%', borderRadius: '14px 14px 4px 14px', background: 'var(--w-07)', border: '1px solid var(--w-08)', padding: '10px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                    {message.content}
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                    <div style={{ color: 'var(--accent)', fontSize: 16, lineHeight: 1.5, flex: 'none' }}>✦</div>
                    <div style={{ fontSize: 13.5, lineHeight: 1.65, minWidth: 0, flex: 1 }}><Markdown source={message.content} /></div>
                  </div>
                  {!!message.sources?.length && (
                    <div style={{ margin: '16px 0 0 27px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <SectionLabel>Sources</SectionLabel>
                        {message.mode && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{message.mode} match</span>}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {message.sources.map((s) => (
                          <button key={`${s.kind}:${s.id}`} onClick={() => openSource(s)} className="hover-border" title={s.projectName} style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid var(--w-07)', borderRadius: 8, background: 'var(--w-02)', padding: '6px 9px', cursor: 'pointer', minWidth: 0 }}>
                            <MonoTag color={KIND_COLOR[s.kind]} bg="var(--w-04)" size={8}>{s.kind.toUpperCase()}</MonoTag>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{s.projectKey}</span>
                            {s.key && <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{s.key}</span>}
                            <span style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ margin: '10px 0 0 27px', fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{modelLabel(message.model)}</div>
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div style={{ display: 'flex', gap: 11, alignItems: 'center', marginBottom: 24, color: 'var(--text-dim)' }}>
              <div style={{ color: 'var(--accent)', fontSize: 16 }}>✦</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>thinking and searching your projects…</div>
            </div>
          )}
          {error && <div style={{ margin: '0 0 20px 27px', fontSize: 12.5, color: 'var(--red-soft)', border: '1px solid rgba(255,92,92,.3)', borderRadius: 10, background: 'rgba(255,92,92,.05)', padding: '10px 12px', lineHeight: 1.5 }}>{error}</div>}
          <div ref={endRef} />
        </div>
      </div>

      <div style={{ flex: 'none', padding: '12px 24px 18px', background: 'linear-gradient(transparent, var(--bg) 22%)' }}>
        <div style={{ maxWidth: 800, margin: '0 auto', border: '1px solid var(--w-12)', borderRadius: 13, background: 'var(--card)', padding: '9px 10px 9px 13px', boxShadow: '0 10px 30px rgba(0,0,0,.12)' }}>
          <textarea value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} placeholder="Message Ask…" rows={2} disabled={loading} style={{ boxSizing: 'border-box', width: '100%', background: 'transparent', border: 0, padding: '2px 0 6px', color: 'var(--text)', fontSize: 13.5, lineHeight: 1.5, resize: 'none', outline: 'none', fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>GPT-OSS 120B · CF</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>Shift+Enter for newline</span>
            <Button onClick={() => void ask()} disabled={!q.trim() || loading}>{loading ? 'Thinking…' : 'Send'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
