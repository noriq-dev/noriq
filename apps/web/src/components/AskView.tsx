// Global Ask — a durable, per-user multi-turn chat enriched with accessible project context.
import { useEffect, useRef, useState } from 'react';
import {
  api, ApiError, type ApiAskHistoryMessage, type ApiAskSource, type ApiAskStoredMessage, type ApiAskThread,
} from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel, WaveBars } from './bits';
import { confirm } from './Dialog';
import { Button } from './ui';
import { Markdown } from './Markdown';

const KIND_COLOR: Record<ApiAskSource['kind'], string> = {
  task: 'var(--blue)',
  doc: 'var(--green, var(--accent-ink))',
  plan: 'var(--amber)',
  memory: 'var(--purple, #a78bfa)',
  episode: 'var(--cyan, #67e8f9)',
};

const EXAMPLES = [
  'What needs my attention across all projects?',
  'Compare the release plans across my projects.',
  'What do our memories say about recent architectural decisions?',
];

interface ThreadMessage extends ApiAskHistoryMessage {
  id?: string;
  sources?: ApiAskSource[];
  mode?: 'semantic' | 'keyword';
  model?: string;
  reasoning?: string;
  trace?: string[];
}

const fromStoredMessage = (message: ApiAskStoredMessage): ThreadMessage => ({
  id: message.id,
  role: message.role,
  content: message.content,
  sources: message.sources,
  mode: message.mode ?? undefined,
  model: message.model ?? undefined,
  reasoning: message.reasoning,
  trace: message.trace,
});

const modelLabel = (model?: string) => model?.includes('gpt-oss-120b') ? 'GPT-OSS 120B · Cloudflare' : 'Cloudflare Workers AI';
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function GenerationActivity({ phase }: { phase: 'searching' | 'generating' }) {
  return (
    <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
      <WaveBars height={12} bars={3} />
      <span>{phase === 'searching' ? 'Searching sources, memories, and graph…' : 'Generating with GPT-OSS 120B…'}</span>
    </div>
  );
}

export function AskView({ store }: { store: AppStore }) {
  const { actions } = store;
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ApiAskThread[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<ApiAskThread[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [threadArchived, setThreadArchived] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [q, setQ] = useState('');
  const [phase, setPhase] = useState<'searching' | 'generating' | null>(null);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const followScrollRef = useRef(true);
  const openRequestRef = useRef(0);
  const loading = phase !== null;

  const loadThread = async (id: string) => {
    const request = ++openRequestRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase(null);
    setHistoryLoading(true);
    setError('');
    try {
      const detail = await api.askThread(id);
      if (request !== openRequestRef.current) return;
      setThreadId(detail.id);
      setThreadArchived(detail.archivedAt !== null);
      setMessages(detail.messages.map(fromStoredMessage));
      followScrollRef.current = true;
    } catch (e) {
      if (request !== openRequestRef.current) return;
      setError(e instanceof Error ? e.message : 'Could not load that chat.');
    } finally {
      if (request === openRequestRef.current) setHistoryLoading(false);
    }
  };

  const refreshThreadLists = async (includeArchived = showArchived) => {
    const [active, archived] = await Promise.all([
      api.askThreads(false),
      includeArchived ? api.askThreads(true) : Promise.resolve({ threads: archivedThreads }),
    ]);
    setThreads(active.threads);
    if (includeArchived) setArchivedThreads(archived.threads);
    return active.threads;
  };

  useEffect(() => {
    let cancelled = false;
    api.askThreads(false)
      .then(async ({ threads: initialThreads }) => {
        if (cancelled) return;
        setThreads(initialThreads);
        if (initialThreads[0]) await loadThread(initialThreads[0].id);
        else setHistoryLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load chat history.');
          setHistoryLoading(false);
        }
      });
    return () => { cancelled = true; abortRef.current?.abort(); };
    // Initial account-scoped history load only. `loadThread` deliberately stays event-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (followScrollRef.current) endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, loading, historyLoading]);

  const newChat = () => {
    ++openRequestRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    followScrollRef.current = true;
    setThreadId(null);
    setThreadArchived(false);
    setPhase(null);
    setHistoryLoading(false);
    setMessages([]);
    setQ('');
    setError('');
  };

  const ask = async (text?: string) => {
    const question = (text ?? q).trim();
    if (!question || loading || historyLoading) return;
    const activeThreadId = threadId;
    let streamedThreadId: string | null = null;
    const controller = new AbortController();
    abortRef.current = controller;
    setMessages((current) => [
      ...current,
      { role: 'user', content: question },
      { role: 'assistant', content: '', sources: [], trace: ['Searching accessible projects…'] },
    ]);
    setQ('');
    setPhase('searching');
    setError('');
    try {
      await api.askStream(question, activeThreadId, {
        onThread: (thread) => {
          streamedThreadId = thread.id;
          setThreadId(thread.id);
          setThreadArchived(false);
          setThreads((current) => {
            const existing = current.find((item) => item.id === thread.id);
            if (existing) return current;
            const now = new Date().toISOString();
            return [{ id: thread.id, title: thread.title, archivedAt: null, createdAt: now, updatedAt: now, messageCount: 1, lastMessage: question }, ...current];
          });
        },
        onMeta: (meta) => {
          const projectCount = new Set(meta.sources.map((source) => source.projectId)).size;
          const retrieval = `${meta.mode}${meta.graphEnhanced ? ' + graph' : ''}`;
          setMessages((current) => current.map((message, index) =>
            index === current.length - 1 && message.role === 'assistant'
              ? {
                  ...message,
                  sources: meta.sources,
                  mode: meta.mode,
                  model: meta.model,
                  trace: [`Selected ${meta.sources.length} ${retrieval} source${meta.sources.length === 1 ? '' : 's'} across ${projectCount} project${projectCount === 1 ? '' : 's'}.`],
                }
              : message));
        },
        onStatus: () => {
          setPhase('generating');
          setMessages((current) => current.map((message, index) =>
            index === current.length - 1 && message.role === 'assistant'
              ? { ...message, trace: [...(message.trace ?? []), 'Generating a grounded response…'] }
              : message));
        },
        onReasoning: (delta) => setMessages((current) => current.map((message, index) =>
          index === current.length - 1 && message.role === 'assistant'
            ? { ...message, reasoning: (message.reasoning ?? '') + delta }
            : message)),
        onDelta: (delta) => setMessages((current) => current.map((message, index) =>
          index === current.length - 1 && message.role === 'assistant'
            ? { ...message, content: message.content + delta }
            : message)),
      }, controller.signal);
      setMessages((current) => current.map((message, index) =>
        index === current.length - 1 && message.role === 'assistant'
          ? { ...message, trace: [...(message.trace ?? []), 'Response complete.'] }
          : message));
      await refreshThreadLists(false);
    } catch (e) {
      if (controller.signal.aborted) return;
      setMessages((current) => {
        const last = current.at(-1);
        if (last?.role !== 'assistant' || last.content) return current;
        return !activeThreadId && !streamedThreadId ? current.slice(0, -2) : current.slice(0, -1);
      });
      setError(
        e instanceof ApiError && e.status === 503
          ? 'This instance has no AI backend configured — Ask needs the Workers AI binding.'
          : e instanceof Error ? e.message : 'Something went wrong.',
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setPhase(null);
    }
  };

  const toggleArchiveView = async (archived: boolean) => {
    setShowArchived(archived);
    if (archived) {
      setHistoryLoading(true);
      try { setArchivedThreads((await api.askThreads(true)).threads); }
      catch (e) { setError(e instanceof Error ? e.message : 'Could not load archived chats.'); }
      finally { setHistoryLoading(false); }
    }
  };

  const archiveThread = async (id: string) => {
    setError('');
    try {
      await api.archiveAskThread(id);
      setThreads((current) => current.filter((thread) => thread.id !== id));
      if (threadId === id) newChat();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not archive that chat.');
    }
  };

  const restoreThread = async (id: string) => {
    setError('');
    try {
      await api.restoreAskThread(id);
      setArchivedThreads((current) => current.filter((thread) => thread.id !== id));
      setShowArchived(false);
      await refreshThreadLists(false);
      await loadThread(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore that chat.');
    }
  };

  const removeThread = async (thread: ApiAskThread) => {
    if (!(await confirm(`Permanently delete chat “${thread.title}”? This cannot be undone.`))) return;
    setError('');
    try {
      await api.deleteAskThread(thread.id);
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      setArchivedThreads((current) => current.filter((item) => item.id !== thread.id));
      if (threadId === thread.id) newChat();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete that chat.');
    }
  };

  const updateScrollFollow = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    followScrollRef.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 48;
  };

  const openSource = (source: ApiAskSource) => {
    actions.selectProject(source.projectId);
    if (source.kind === 'task') actions.openTask(source.id);
    else if (source.kind === 'doc') {
      sessionStorage.setItem('noriq.openDoc', source.id);
      actions.setView('docs');
    } else if (source.kind === 'plan') actions.setView('plans');
    else {
      if (source.kind === 'memory') sessionStorage.setItem('noriq.openMemory', source.id);
      actions.setView('memory');
    }
  };

  const visibleThreads = showArchived ? archivedThreads : threads;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ height: 54, flex: 'none', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', padding: '0 22px', background: 'var(--bg-raised)' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>Ask</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', marginTop: 1 }}>GLOBAL ASSISTANT</div>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={newChat} className="hover-bright" style={{ cursor: 'pointer', color: 'var(--text-mid)', fontSize: 11.5, padding: '6px 9px', borderRadius: 7 }}>
          + New chat
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <aside style={{ width: 224, flex: 'none', minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--line)', background: 'var(--bg-raised)' }}>
          <div style={{ display: 'flex', gap: 3, padding: 10, borderBottom: '1px solid var(--line)' }}>
            {([false, true] as const).map((archived) => (
              <button
                key={String(archived)}
                onClick={() => void toggleArchiveView(archived)}
                style={{ flex: 1, cursor: 'pointer', borderRadius: 6, padding: '5px 7px', fontSize: 10.5, background: showArchived === archived ? 'var(--w-1)' : 'transparent', color: showArchived === archived ? 'var(--text)' : 'var(--text-dim)' }}
              >
                {archived ? 'Archived' : 'Chats'}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 7 }}>
            {!historyLoading && visibleThreads.length === 0 && (
              <div style={{ padding: '18px 10px', color: 'var(--text-faint)', fontSize: 10.5, lineHeight: 1.5, textAlign: 'center' }}>
                {showArchived ? 'No archived chats.' : 'Your chats will appear here.'}
              </div>
            )}
            {visibleThreads.map((thread) => (
              <div key={thread.id} data-testid={`ask-thread-${thread.id}`} style={{ display: 'flex', gap: 3, alignItems: 'center', borderRadius: 8, background: thread.id === threadId ? 'var(--w-07)' : 'transparent', marginBottom: 3 }}>
                <button onClick={() => void loadThread(thread.id)} style={{ minWidth: 0, flex: 1, cursor: 'pointer', textAlign: 'left', padding: '8px 7px' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, color: 'var(--text-soft)' }}>{thread.title}</div>
                  <div style={{ marginTop: 3, fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--text-faint)' }}>{dayLabel(thread.updatedAt)} · {thread.messageCount}</div>
                </button>
                <button
                  title={showArchived ? 'Restore chat' : 'Archive chat'}
                  aria-label={showArchived ? `Restore ${thread.title}` : `Archive ${thread.title}`}
                  onClick={() => void (showArchived ? restoreThread(thread.id) : archiveThread(thread.id))}
                  style={{ cursor: 'pointer', padding: '5px', color: 'var(--text-faint)', fontSize: 11 }}
                >{showArchived ? '↥' : '↧'}</button>
                <button
                  title="Delete chat"
                  aria-label={`Delete ${thread.title}`}
                  onClick={() => void removeThread(thread)}
                  style={{ cursor: 'pointer', padding: '5px 7px 5px 3px', color: 'var(--text-faint)', fontSize: 12 }}
                >×</button>
              </div>
            ))}
          </div>
        </aside>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={scrollRef} data-testid="ask-scroll" onScroll={updateScrollFollow} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div className="content-pad" style={{ maxWidth: 800, margin: '0 auto', padding: messages.length ? '28px 28px 36px' : '68px 28px 36px' }}>
              {!historyLoading && messages.length === 0 && (
                <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
                  <div style={{ color: 'var(--accent)', fontSize: 28, lineHeight: 1, marginBottom: 16 }}>✦</div>
                  <h1 style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-.025em', margin: '0 0 8px' }}>How can I help?</h1>
                  <div style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>
                    Ask across tasks, docs, plans, durable memories, and their knowledge-graph connections.
                    Answers keep their grounding sources.
                  </div>
                  <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left' }}>
                    {EXAMPLES.map((example) => (
                      <button key={example} onClick={() => void ask(example)} className="hover-border" style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--text-mid)', background: 'var(--w-02)', border: '1px solid var(--w-08)', borderRadius: 10, padding: '10px 13px', textAlign: 'left' }}>
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message, index) => {
                const isStreaming = message.role === 'assistant' && index === messages.length - 1 && phase !== null;
                return (
                  <div key={message.id ?? index} style={{ marginBottom: 24 }}>
                    {message.role === 'user' ? (
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <div style={{ maxWidth: '82%', borderRadius: '14px 14px 4px 14px', background: 'var(--w-07)', border: '1px solid var(--w-08)', padding: '10px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                          {message.content}
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                        <div style={{ color: 'var(--accent)', fontSize: 16, lineHeight: 1.5, flex: 'none' }}>✦</div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          {(message.trace?.length || message.reasoning) && (
                            <details data-testid="ask-reasoning" style={{ borderLeft: '1px solid var(--w-1)', paddingLeft: 11 }}>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 9.5, userSelect: 'none' }}>
                                {isStreaming ? 'Thinking…' : 'Reasoning summary'}
                              </summary>
                              <div style={{ marginTop: 8, color: 'var(--text-mid)', fontSize: 11.5, lineHeight: 1.55 }}>
                                {message.trace?.map((item, traceIndex) => (
                                  <div key={traceIndex} style={{ display: 'flex', gap: 7, marginBottom: 4 }}>
                                    <span style={{ color: 'var(--accent)' }}>·</span><span>{item}</span>
                                  </div>
                                ))}
                                {message.reasoning && <div style={{ marginTop: 8 }}><Markdown source={message.reasoning} /></div>}
                              </div>
                            </details>
                          )}
                          {!!message.sources?.length && (
                            <div data-testid="ask-sources" style={{ marginTop: 12 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                <SectionLabel>Sources</SectionLabel>
                                {message.mode && (
                                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>
                                    {message.mode}{message.sources?.some((source) => source.retrieval === 'graph' || source.retrieval === 'hybrid') ? ' + graph' : ''} match
                                  </span>
                                )}
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {message.sources.map((source) => (
                                  <button key={`${source.kind}:${source.id}`} onClick={() => openSource(source)} className="hover-border" title={`${source.projectName} · ${source.retrieval}`} style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid var(--w-07)', borderRadius: 8, background: 'var(--w-02)', padding: '6px 9px', cursor: 'pointer', minWidth: 0 }}>
                                    <MonoTag color={KIND_COLOR[source.kind]} bg="var(--w-04)" size={8}>{source.kind.toUpperCase()}</MonoTag>
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{source.projectKey}</span>
                                    {source.key && <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{source.key}</span>}
                                    <span style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.title}</span>
                                    {(source.retrieval === 'graph' || source.retrieval === 'hybrid') && <span style={{ color: 'var(--accent)', fontSize: 9 }}>◇</span>}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          <div data-testid="ask-answer" style={{ fontSize: 13.5, lineHeight: 1.65, marginTop: message.trace?.length || message.reasoning || message.sources?.length ? 14 : 0 }}>
                            {message.content ? <Markdown source={message.content} /> : phase && isStreaming ? <GenerationActivity phase={phase} /> : null}
                            {message.content && phase && isStreaming && <div style={{ marginTop: 9 }}><GenerationActivity phase={phase} /></div>}
                          </div>
                          {(message.model || !isStreaming) && <div style={{ marginTop: 10, fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{modelLabel(message.model)}</div>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {error && <div style={{ margin: '0 0 20px 27px', fontSize: 12.5, color: 'var(--red-soft)', border: '1px solid rgba(255,92,92,.3)', borderRadius: 10, background: 'rgba(255,92,92,.05)', padding: '10px 12px', lineHeight: 1.5 }}>{error}</div>}
              <div ref={endRef} data-testid="ask-end" />
            </div>
          </div>

          <div style={{ flex: 'none', padding: '12px 24px 18px', background: 'linear-gradient(transparent, var(--bg) 22%)' }}>
            <div style={{ maxWidth: 800, margin: '0 auto', border: '1px solid var(--w-12)', borderRadius: 13, background: 'var(--card)', padding: '9px 10px 9px 13px', boxShadow: '0 10px 30px rgba(0,0,0,.12)' }}>
              <textarea value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder={threadArchived ? 'Restore this chat to continue…' : 'Message Ask…'} rows={2} disabled={loading || historyLoading || threadArchived} style={{ boxSizing: 'border-box', width: '100%', background: 'transparent', border: 0, padding: '2px 0 6px', color: 'var(--text)', fontSize: 13.5, lineHeight: 1.5, resize: 'none', outline: 'none', fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>GPT-OSS 120B · CF</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>Shift+Enter for newline</span>
                <Button onClick={() => void ask()} disabled={!q.trim() || loading || historyLoading || threadArchived}>{loading ? 'Thinking…' : 'Send'}</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
