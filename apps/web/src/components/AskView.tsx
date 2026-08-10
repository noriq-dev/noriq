// Global Ask — a durable, per-user multi-turn chat enriched with accessible project context.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  api, ApiError, type ApiAskAction, type ApiAskHistoryMessage, type ApiAskModelDefinition, type ApiAskSource,
  type ApiAskContextUsage, type ApiAskInputReference, type ApiAskStoredMessage, type ApiAskThread, type ApiTaskSearchResult,
} from '../api';
import type { AppStore } from '../store';
import { MonoTag, WaveBars } from './bits';
import { confirm } from './Dialog';
import { Button, Select } from './ui';
import { Markdown } from './Markdown';
import { Sheet } from './Sheet';
import { MIN_INPUT_FONT_SIZE, MIN_TOUCH_TARGET, useViewport } from '../viewport';

const KIND_COLOR: Record<ApiAskSource['kind'], string> = {
  project: 'var(--text-mid)',
  task: 'var(--blue)',
  run: 'var(--cyan, #67e8f9)',
  signal: 'var(--red, #f87171)',
  comment: 'var(--text-mid)',
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

const EMPTY_CONTEXT: ApiAskContextUsage = {
  usedChars: 0, limitChars: 32_000, percent: 0, compacted: false, omittedMessages: 0,
};

export const askProjectTag = (name: string): string => `@${name
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')}`;

interface ThreadMessage extends ApiAskHistoryMessage {
  id?: string;
  sources?: ApiAskSource[];
  mode?: 'semantic' | 'keyword';
  model?: string;
  reasoning?: string;
  trace?: string[];
  generationId?: string;
  generationStatus?: ApiAskStoredMessage['generationStatus'];
  generationError?: string;
  actions?: ApiAskAction[];
}

const fromStoredMessage = (message: ApiAskStoredMessage): ThreadMessage => ({
  id: message.id,
  role: message.role,
  content: message.content,
  references: message.references,
  sources: message.sources,
  mode: message.mode ?? undefined,
  model: message.model ?? undefined,
  reasoning: message.reasoning,
  trace: message.trace,
  generationId: message.generationId ?? undefined,
  generationStatus: message.generationStatus,
  generationError: message.generationError ?? undefined,
  actions: message.actions,
});

const modelLabel = (model: string | undefined, models: ApiAskModelDefinition[]) =>
  models.find((candidate) => candidate.id === model)?.label ?? model ?? 'Model pending';
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function GenerationActivity({ phase, model, trace }: {
  phase: 'searching' | 'generating'; model: string; trace?: string[];
}) {
  const latest = trace?.at(-1);
  return (
    <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
      <WaveBars height={12} bars={3} />
      <span>
        {phase === 'searching' ? 'Searching workspace and selecting tools…' : `Generating with ${model}…`}
        {latest && <span style={{ display: 'block', marginTop: 3, color: 'var(--text-faint)' }}>{latest}</span>}
      </span>
    </div>
  );
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const displayValue = (value: unknown) => value === undefined ? 'unchanged' : JSON.stringify(value);

function ActionCard({ action, busy, onSettle }: {
  action: ApiAskAction;
  busy: boolean;
  onSettle: (action: ApiAskAction, decision: 'approve' | 'reject') => void;
}) {
  const args = record(action.arguments);
  const expected = record(action.expected);
  const set = record(args.set);
  const before = record(expected.before);
  const after = record(expected.after);
  const isUpdate = action.type === 'update_task';
  const changes = isUpdate
    ? Object.keys(set).map((field) => ({ field, before: before[field], after: after[field] }))
    : Object.entries(args).filter(([field]) => field !== 'projectId').map(([field, value]) => ({ field, before: undefined, after: value }));
  const statusColor = action.status === 'approved' ? 'var(--green, var(--accent-ink))'
    : action.status === 'failed' ? 'var(--red-soft)'
      : action.status === 'rejected' ? 'var(--text-faint)' : 'var(--amber)';
  return (
    <section aria-label={`Ask action: ${action.summary}`} data-testid={`ask-action-${action.id}`} style={{ marginTop: 12, border: '1px solid var(--w-12)', borderRadius: 10, background: 'var(--w-025, var(--w-02))', padding: '11px 12px' }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
        <MonoTag color={statusColor} bg="var(--w-05)" size={8.5}>{busy ? 'SETTLING' : action.status.toUpperCase()}</MonoTag>
        <strong style={{ fontSize: 12.5 }}>{action.summary}</strong>
      </div>
      <div style={{ marginTop: 7, fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>
        Project {action.projectId}{isUpdate && typeof args.taskId === 'string' ? ` · Task ${args.taskId}` : ''}
      </div>
      <div style={{ marginTop: 9, display: 'grid', gridTemplateColumns: 'minmax(90px, .5fr) minmax(0, 1fr)', gap: '5px 10px', fontSize: 11.5 }}>
        {changes.map((change) => (
          <div key={change.field} style={{ display: 'contents' }}>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{change.field}</span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {isUpdate && <span style={{ color: 'var(--text-faint)' }}>{displayValue(change.before)} → </span>}
              {displayValue(change.after)}
            </span>
          </div>
        ))}
      </div>
      <details style={{ marginTop: 9 }}>
        <summary style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>Exact stored payload</summary>
        <pre style={{ margin: '7px 0 0', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 9.5, color: 'var(--text-dim)' }}>
          {JSON.stringify({ arguments: action.arguments, expected: action.expected }, null, 2)}
        </pre>
      </details>
      {action.error && <div role="alert" style={{ marginTop: 8, color: 'var(--red-soft)', fontSize: 11.5 }}>{action.error}</div>}
      {action.status === 'approved' && <div style={{ marginTop: 8, color: 'var(--text-dim)', fontSize: 11 }}>Applied as your human action.</div>}
      {action.status === 'rejected' && <div style={{ marginTop: 8, color: 'var(--text-dim)', fontSize: 11 }}>Rejected without changing Noriq.</div>}
      {action.status === 'pending' && (
        <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', marginTop: 11 }}>
          <Button variant="ghost" disabled={busy} aria-label={`Reject ${action.summary}`} onClick={() => onSettle(action, 'reject')}>Reject</Button>
          <Button disabled={busy} aria-label={`Confirm ${action.summary}`} onClick={() => onSettle(action, 'approve')}>Confirm</Button>
        </div>
      )}
    </section>
  );
}

export function AskView({ store }: { store: AppStore }) {
  const { actions } = store;
  const { phone } = useViewport();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ApiAskThread[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<ApiAskThread[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadArchived, setThreadArchived] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [q, setQ] = useState('');
  const [contextUsage, setContextUsage] = useState<ApiAskContextUsage>(EMPTY_CONTEXT);
  const [selectedReferences, setSelectedReferences] = useState<ApiAskInputReference[]>([]);
  const [activeProjectSuggestion, setActiveProjectSuggestion] = useState(0);
  const [taskSuggestions, setTaskSuggestions] = useState<ApiTaskSearchResult[]>([]);
  const [activeTaskSuggestion, setActiveTaskSuggestion] = useState(0);
  const [taskSuggestionsLoading, setTaskSuggestionsLoading] = useState(false);
  const [models, setModels] = useState<ApiAskModelDefinition[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(true);
  const [phase, setPhase] = useState<'searching' | 'generating' | null>(null);
  const [error, setError] = useState('');
  const [settlingActions, setSettlingActions] = useState<Set<string>>(new Set());
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const settlingActionsRef = useRef<Set<string>>(new Set());
  const followScrollRef = useRef(true);
  const openRequestRef = useRef(0);
  const loading = phase !== null;
  const mention = q.match(/(?:^|\s)@([a-z0-9_-]*)$/i);
  const mentionQuery = mention?.[1]?.toLowerCase() ?? null;
  const taskMention = q.match(/(?:^|\s)#([a-z0-9_-]*)$/i);
  const taskMentionQuery = taskMention?.[1] ?? null;
  const projectDirectory = store.data?.projects ?? [];
  const nameTags = projectDirectory.map((project) => askProjectTag(project.name));
  const nameTagCounts = new Map<string, number>();
  for (const tag of nameTags) nameTagCounts.set(tag, (nameTagCounts.get(tag) ?? 0) + 1);
  const projectSuggestions = mentionQuery === null ? [] : projectDirectory
    .map((project, index) => ({
      project,
      tag: nameTagCounts.get(nameTags[index]!)! > 1 ? `@${project.key.toLowerCase()}` : nameTags[index]!,
    }))
    .filter(({ project, tag }) => tag.slice(1).startsWith(mentionQuery) || project.key.toLowerCase().startsWith(mentionQuery))
    .slice(0, 6);
  const selectedProjectSuggestion = Math.min(activeProjectSuggestion, Math.max(0, projectSuggestions.length - 1));

  useEffect(() => {
    setActiveProjectSuggestion(0);
  }, [mentionQuery]);

  useEffect(() => {
    setActiveTaskSuggestion(0);
    if (taskMentionQuery === null) {
      setTaskSuggestions([]);
      setTaskSuggestionsLoading(false);
      return;
    }
    setTaskSuggestions([]);
    setTaskSuggestionsLoading(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.searchTasks({ text: taskMentionQuery, limit: 6 }, controller.signal)
        .then(({ tasks }) => setTaskSuggestions(tasks))
        .catch((cause: unknown) => {
          if (!(cause instanceof DOMException && cause.name === 'AbortError')) setTaskSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setTaskSuggestionsLoading(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [taskMentionQuery]);

  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    const style = window.getComputedStyle(textarea);
    const fontSize = Number.parseFloat(style.fontSize) || 13.5;
    const parsedLineHeight = Number.parseFloat(style.lineHeight);
    const lineHeight = style.lineHeight.endsWith('px') && Number.isFinite(parsedLineHeight)
      ? parsedLineHeight
      : fontSize * 1.5;
    const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const minHeight = lineHeight * 2 + verticalPadding;
    const maxHeight = lineHeight * 6 + verticalPadding;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [q]);

  const addSelectedReference = (reference: ApiAskInputReference) => {
    setSelectedReferences((current) => current.some((item) => item.kind === reference.kind && item.id === reference.id)
      ? current
      : [...current, reference]);
  };

  const insertProjectTag = (project: { id: string }, tag: string) => {
    if (!mention) return;
    const at = q.lastIndexOf('@');
    setQ(`${q.slice(0, at)}${tag} `);
    addSelectedReference({ kind: 'project', id: project.id, token: tag });
  };

  const insertTaskReference = (task: ApiTaskSearchResult) => {
    if (!taskMention) return;
    const hash = q.lastIndexOf('#');
    const token = `#${task.key}`;
    setQ(`${q.slice(0, hash)}${token} `);
    addSelectedReference({ kind: 'task', id: task.id, key: task.key, token });
  };

  const updateQuestion = (value: string) => {
    setQ(value);
    setSelectedReferences((current) => current.filter((reference) => value.includes(reference.token)));
  };

  const removeSelectedReference = (reference: ApiAskInputReference) => {
    setSelectedReferences((current) => current.filter((item) => !(item.kind === reference.kind && item.id === reference.id)));
    setQ((current) => current.replace(reference.token, '').replace(/ {2,}/g, ' '));
  };

  const patchGeneration = (generationId: string, patch: (message: ThreadMessage) => ThreadMessage) => {
    setMessages((current) => current.map((message, index) =>
      message.role === 'assistant'
      && (message.generationId === generationId || (!message.generationId && index === current.length - 1))
        ? patch(message)
        : message));
  };

  const generationHandlers = (
    generationRef: { current: string },
    onThread?: (thread: { id: string; title: string }) => void,
  ) => ({
    onThread,
    onGeneration: ({ id }: { id: string }) => {
      generationRef.current = id;
      patchGeneration(id, (message) => ({ ...message, generationId: id }));
    },
    onMeta: (meta: import('../api').ApiAskStreamMeta) => patchGeneration(generationRef.current, (message) => ({
      ...message,
      sources: meta.sources,
      mode: meta.mode ?? undefined,
      model: meta.model ?? undefined,
      trace: meta.trace ?? message.trace,
      actions: meta.actions ?? message.actions,
    })),
    onStatus: (next: 'searching' | 'generating') => {
      setPhase(next);
      patchGeneration(generationRef.current, (message) => ({ ...message, generationStatus: next }));
    },
    onReasoning: (delta: string) => patchGeneration(generationRef.current, (message) => ({
      ...message,
      reasoning: (message.reasoning ?? '') + delta,
    })),
    onDelta: (delta: string) => patchGeneration(generationRef.current, (message) => ({
      ...message,
      content: message.content + delta,
    })),
    onCancelled: () => patchGeneration(generationRef.current, (message) => ({
      ...message,
      generationStatus: 'failed',
      generationError: 'Response cancelled.',
    })),
    onDone: () => patchGeneration(generationRef.current, (message) => ({
      ...message,
      generationStatus: 'completed',
    })),
  });

  const resumeGeneration = async (message: ThreadMessage) => {
    if (!message.generationId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const generationRef = { current: message.generationId };
    try {
      await api.resumeAskStream(message.generationId, {
        answer: message.content.length,
        reasoning: message.reasoning?.length ?? 0,
      }, generationHandlers(generationRef), controller.signal);
      await refreshThreadLists(false);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not resume this response.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setPhase(null);
      }
    }
  };

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
      setContextUsage(detail.context);
      const storedMessages = detail.messages.map(fromStoredMessage);
      setMessages(storedMessages);
      followScrollRef.current = true;
      const active = [...storedMessages].reverse().find((message) =>
        message.generationId && ['pending', 'searching', 'generating'].includes(message.generationStatus ?? ''));
      if (active) {
        setPhase(active.generationStatus === 'generating' ? 'generating' : 'searching');
        void resumeGeneration(active);
      }
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
    let cancelled = false;
    api.askModels()
      .then((catalog) => {
        if (cancelled) return;
        setModels(catalog.models);
        setSelectedModel(catalog.defaultModel);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load configured Ask models.');
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
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
    setContextUsage(EMPTY_CONTEXT);
    setSelectedReferences([]);
    setError('');
  };

  const ask = async (text?: string) => {
    const question = (text ?? q).trim();
    if (!question || !selectedModel || loading || historyLoading) return;
    const activeThreadId = threadId;
    let streamedThreadId: string | null = null;
    const controller = new AbortController();
    const generationRef = { current: '' };
    const references = text === undefined ? selectedReferences : [];
    abortRef.current = controller;
    setMessages((current) => [
      ...current,
      { role: 'user', content: question, references },
      { role: 'assistant', content: '', sources: [], trace: ['Preparing response…'], model: selectedModel, generationStatus: 'pending' },
    ]);
    setQ('');
    setSelectedReferences([]);
    setPhase('searching');
    setError('');
    try {
      await api.askStream(question, activeThreadId, generationHandlers(generationRef, (thread) => {
          streamedThreadId = thread.id;
          setThreadId(thread.id);
          setThreadArchived(false);
          setThreads((current) => {
            const existing = current.find((item) => item.id === thread.id);
            if (existing) return current;
            const now = new Date().toISOString();
            return [{ id: thread.id, title: thread.title, archivedAt: null, createdAt: now, updatedAt: now, messageCount: 1, lastMessage: question }, ...current];
          });
        }), controller.signal, selectedModel, ...(references.length ? [references] : []));
      await refreshThreadLists(false);
      const completedThreadId = activeThreadId ?? streamedThreadId;
      if (completedThreadId) {
        try { setContextUsage(await api.askThreadContext(completedThreadId)); }
        catch { /* A completed answer remains valid if this secondary meter refresh fails. */ }
      }
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

  const cancelGeneration = async () => {
    const active = [...messages].reverse().find((message) =>
      message.generationId && ['pending', 'searching', 'generating'].includes(message.generationStatus ?? ''));
    if (!active?.generationId) return;
    setError('');
    try {
      await api.cancelAskGeneration(active.generationId);
      abortRef.current?.abort();
      abortRef.current = null;
      patchGeneration(active.generationId, (message) => ({
        ...message,
        generationStatus: 'failed',
        generationError: 'Response cancelled.',
      }));
      setPhase(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel this response.');
    }
  };

  const copyMessage = async (message: ThreadMessage, key: string) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessage(key);
    } catch {
      setError('Could not copy this message.');
    }
  };

  const openSource = (source: ApiAskSource) => {
    actions.selectProject(source.projectId);
    if (source.kind === 'task') actions.openTask(source.id);
    else if (source.kind === 'doc') {
      sessionStorage.setItem('noriq.openDoc', source.id);
      actions.setView('docs');
    } else if (source.kind === 'plan') actions.setView('plans');
    else if (source.kind === 'memory' || source.kind === 'episode') {
      if (source.kind === 'memory') sessionStorage.setItem('noriq.openMemory', source.id);
      actions.setView('memory');
    } else if (source.kind === 'run') actions.setView('runs');
    else if (source.kind === 'signal') actions.setView('control');
  };

  const replaceAction = (updated: ApiAskAction) => {
    setMessages((current) => current.map((message) => ({
      ...message,
      actions: message.actions?.map((candidate) => candidate.id === updated.id ? updated : candidate),
    })));
  };

  const settleAction = async (action: ApiAskAction, decision: 'approve' | 'reject') => {
    if (settlingActionsRef.current.has(action.id)) return;
    settlingActionsRef.current.add(action.id);
    setError('');
    setSettlingActions((current) => new Set(current).add(action.id));
    try {
      const updated = decision === 'approve'
        ? await api.approveAskAction(action.id)
        : await api.rejectAskAction(action.id);
      replaceAction(updated);
      if (updated.status === 'approved') {
        actions.refreshNow();
        if (updated.type === 'update_task') {
          const args = record(updated.arguments);
          actions.selectProject(updated.projectId);
          if (typeof args.taskId === 'string') actions.openTask(args.taskId);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${decision} that action.`);
    } finally {
      settlingActionsRef.current.delete(action.id);
      setSettlingActions((current) => {
        const next = new Set(current);
        next.delete(action.id);
        return next;
      });
    }
  };

  const visibleThreads = showArchived ? archivedThreads : threads;
  const activeGeneration = [...messages].reverse().find((message) =>
    message.generationId && ['pending', 'searching', 'generating'].includes(message.generationStatus ?? ''));
  const contextPercent = Math.min(100, Math.round(
    ((contextUsage.usedChars + q.length) / Math.max(1, contextUsage.limitChars)) * 100,
  ));

  const threadPanel = (
    <>
      <div style={{ display: 'flex', gap: 3, padding: 10, borderBottom: '1px solid var(--line)' }}>
        {([false, true] as const).map((archived) => (
          <button
            key={String(archived)}
            onClick={() => void toggleArchiveView(archived)}
            style={{ minHeight: phone ? MIN_TOUCH_TARGET : undefined, flex: 1, cursor: 'pointer', borderRadius: 6, padding: '5px 7px', fontSize: 10.5, background: showArchived === archived ? 'var(--w-1)' : 'transparent', color: showArchived === archived ? 'var(--text)' : 'var(--text-dim)' }}
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
            <button onClick={() => { setThreadsOpen(false); void loadThread(thread.id); }} style={{ minWidth: 0, minHeight: phone ? MIN_TOUCH_TARGET : undefined, flex: 1, cursor: 'pointer', textAlign: 'left', padding: '8px 7px' }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, color: 'var(--text-soft)' }}>{thread.title}</div>
              <div style={{ marginTop: 3, fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--text-faint)' }}>{dayLabel(thread.updatedAt)} · {thread.messageCount}</div>
            </button>
            <button
              title={showArchived ? 'Restore chat' : 'Archive chat'}
              aria-label={showArchived ? `Restore ${thread.title}` : `Archive ${thread.title}`}
              onClick={() => void (showArchived ? restoreThread(thread.id) : archiveThread(thread.id))}
              style={{ cursor: 'pointer', minWidth: phone ? MIN_TOUCH_TARGET : undefined, minHeight: phone ? MIN_TOUCH_TARGET : undefined, padding: '5px', color: 'var(--text-faint)', fontSize: 11 }}
            >{showArchived ? '↥' : '↧'}</button>
            <button
              title="Delete chat"
              aria-label={`Delete ${thread.title}`}
              onClick={() => void removeThread(thread)}
              style={{ cursor: 'pointer', minWidth: phone ? MIN_TOUCH_TARGET : undefined, minHeight: phone ? MIN_TOUCH_TARGET : undefined, padding: '5px 7px 5px 3px', color: 'var(--text-faint)', fontSize: 12 }}
            >×</button>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ height: 54, flex: 'none', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', padding: phone ? '0 12px' : '0 22px', background: 'var(--bg-raised)' }}>
        {phone ? (
          <button type="button" onClick={() => setThreadsOpen(true)} style={{ minHeight: MIN_TOUCH_TARGET, padding: '0 10px', cursor: 'pointer', color: 'var(--text-mid)', fontSize: 12 }}>☰ Threads</button>
        ) : <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>Ask</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', marginTop: 1 }}>GLOBAL ASSISTANT</div>
        </div>}
        <div style={{ flex: 1 }} />
        <button onClick={newChat} className="hover-bright" style={{ cursor: 'pointer', minHeight: phone ? MIN_TOUCH_TARGET : undefined, color: 'var(--text-mid)', fontSize: 11.5, padding: '6px 9px', borderRadius: 7 }}>
          + New chat
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {!phone && <aside style={{ width: 224, flex: 'none', minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--line)', background: 'var(--bg-raised)' }}>{threadPanel}</aside>}

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={scrollRef} data-testid="ask-scroll" onScroll={updateScrollFollow} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div className="content-pad" style={{ maxWidth: 800, margin: '0 auto', padding: phone ? (messages.length ? '20px 15px 24px' : '36px 16px 24px') : (messages.length ? '28px 28px 36px' : '68px 28px 36px') }}>
              {!historyLoading && messages.length === 0 && (
                <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
                  <div style={{ color: 'var(--accent)', fontSize: 28, lineHeight: 1, marginBottom: 16 }}>✦</div>
                  <h1 style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-.025em', margin: '0 0 8px' }}>How can I help?</h1>
                  <div style={{ fontSize: 13, color: 'var(--text-mid)', lineHeight: 1.6 }}>
                    Chat normally, or ask about your tasks, docs, plans, durable memories, and graph connections.
                    Ask searches Noriq only when the conversation needs current project evidence.
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
                const messageKey = message.id ?? message.generationId ?? `local-${index}`;
                const copyLabel = `Copy ${message.role} message`;
                const displayedModel = modelLabel(message.model, models);
                const coverageNotices = message.trace?.filter((item) => /truncat|server limit|capped|returned \d+ of/i.test(item)) ?? [];
                const taggedProjects = message.sources?.filter((source) => source.kind === 'project' && source.tag) ?? [];
                const evidenceSources = message.sources?.filter((source) => !(source.kind === 'project' && source.tag)) ?? [];
                return (
                  <div key={messageKey} style={{ marginBottom: 24 }}>
                    {message.role === 'user' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                        <div style={{ maxWidth: '82%', borderRadius: '14px 14px 4px 14px', background: 'var(--w-07)', border: '1px solid var(--w-08)', padding: '10px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                          {message.content}
                        </div>
                        <button
                          type="button"
                          aria-label={copyLabel}
                          title="Copy message"
                          onClick={() => void copyMessage(message, messageKey)}
                          style={{ marginTop: 5, cursor: 'pointer', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 8.5, padding: '2px 4px' }}
                        >{copiedMessage === messageKey ? 'Copied' : 'Copy'}</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                        <div style={{ color: 'var(--accent)', fontSize: 16, lineHeight: 1.5, flex: 'none' }}>✦</div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          {taggedProjects.length > 0 && (
                            <div aria-label="Tagged project scope" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                              {taggedProjects.map((source) => (
                                <button key={source.id} onClick={() => openSource(source)} title={`Open ${source.projectName}`} style={{ cursor: 'pointer', border: '1px solid rgba(198,242,78,.24)', borderRadius: 7, background: 'rgba(198,242,78,.07)', padding: '4px 8px', color: 'var(--accent-ink)', fontFamily: 'var(--mono)', fontSize: 9.5 }}>
                                  {source.tag} · {source.projectKey}
                                </button>
                              ))}
                            </div>
                          )}
                          {(message.trace?.length || message.reasoning) && (
                            <details data-testid="ask-reasoning" style={{ borderLeft: '1px solid var(--w-1)', paddingLeft: 11 }}>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 9.5, userSelect: 'none' }}>
                                {isStreaming ? 'Live activity…' : 'Activity and reasoning'}
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
                          {evidenceSources.length > 0 && (
                            <details data-testid="ask-sources" style={{ marginTop: 12, borderLeft: '1px solid var(--w-1)', paddingLeft: 11 }}>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 9.5, userSelect: 'none' }}>
                                Sources · {evidenceSources.length}
                                {message.mode && (
                                  <span style={{ marginLeft: 8, color: 'var(--text-faint)' }}>
                                    {message.mode}{evidenceSources.some((source) => source.retrieval === 'graph' || source.retrieval === 'hybrid') ? ' + graph' : ''}
                                  </span>
                                )}
                              </summary>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                                {evidenceSources.map((source) => (
                                  <button key={`${source.kind}:${source.id}`} aria-label={`Open ${source.citation ?? source.key ?? source.title}`} onClick={() => openSource(source)} className="hover-border" title={`${source.projectName} · ${source.retrieval}${source.updatedAt ? ` · updated ${source.updatedAt}` : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid var(--w-07)', borderRadius: 8, background: 'var(--w-02)', padding: '6px 9px', cursor: 'pointer', minWidth: 0 }}>
                                    <MonoTag color={KIND_COLOR[source.kind]} bg="var(--w-04)" size={8}>{source.kind.toUpperCase()}</MonoTag>
                                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)' }}>{source.citation ?? [source.projectKey, source.key].filter(Boolean).join(' / ')}</span>
                                    {source.historical && <MonoTag color="var(--text-faint)" bg="var(--w-04)" size={8}>HISTORICAL</MonoTag>}
                                    {source.isLead && <MonoTag color="var(--amber)" bg="var(--w-04)" size={8}>LEAD</MonoTag>}
                                    <span style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.title}</span>
                                    {(source.retrieval === 'graph' || source.retrieval === 'hybrid') && <span style={{ color: 'var(--accent)', fontSize: 9 }}>◇</span>}
                                  </button>
                                ))}
                              </div>
                            </details>
                          )}
                          {coverageNotices.map((notice) => (
                            <div key={notice} role="note" style={{ marginTop: 10, borderLeft: '2px solid var(--amber)', paddingLeft: 9, color: 'var(--text-dim)', fontSize: 11.5 }}>
                              Coverage notice: {notice}
                            </div>
                          ))}
                          <div data-testid="ask-answer" style={{ fontSize: 13.5, lineHeight: 1.65, marginTop: message.trace?.length || message.reasoning || message.sources?.length ? 14 : 0 }}>
                            {message.content ? <Markdown source={message.content} /> : phase && isStreaming ? <GenerationActivity phase={phase} model={displayedModel} trace={message.trace} /> : null}
                            {message.content && phase && isStreaming && <div style={{ marginTop: 9 }}><GenerationActivity phase={phase} model={displayedModel} trace={message.trace} /></div>}
                          </div>
                          {message.generationStatus === 'failed' && message.generationError && (
                            <div style={{ marginTop: 9, color: message.generationError.toLowerCase().includes('cancelled') ? 'var(--text-dim)' : 'var(--red-soft)', fontSize: 11.5 }}>
                              {message.generationError.toLowerCase().includes('cancelled') ? 'Response cancelled.' : message.generationError}
                            </div>
                          )}
                          {message.actions?.map((action) => (
                            <ActionCard key={action.id} action={action} busy={settlingActions.has(action.id)} onSettle={(candidate, decision) => void settleAction(candidate, decision)} />
                          ))}
                          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                            {(message.model || !isStreaming) && (
                              <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', overflowWrap: 'anywhere' }}>
                                {displayedModel}{message.model && displayedModel !== message.model ? ` · ${message.model}` : ''}
                              </div>
                            )}
                            <div style={{ flex: 1 }} />
                            <button
                              type="button"
                              aria-label={copyLabel}
                              title="Copy message"
                              disabled={!message.content}
                              onClick={() => void copyMessage(message, messageKey)}
                              style={{ cursor: message.content ? 'pointer' : 'default', opacity: message.content ? 1 : 0.45, color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 8.5, padding: '2px 4px' }}
                            >{copiedMessage === messageKey ? 'Copied' : 'Copy'}</button>
                          </div>
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

          <div style={{ flex: 'none', padding: phone ? '8px 10px 10px' : '12px 24px 18px', background: 'linear-gradient(transparent, var(--bg) 22%)' }}>
            <div style={{ position: 'relative', maxWidth: 800, margin: '0 auto', border: '1px solid var(--w-12)', borderRadius: 13, background: 'var(--card)', padding: '9px 10px 9px 13px', boxShadow: '0 10px 30px rgba(0,0,0,.12)' }}>
              {projectSuggestions.length > 0 && (
                <div role="listbox" aria-label="Tag a project" aria-activedescendant={`ask-project-option-${projectSuggestions[selectedProjectSuggestion]!.project.id}`} style={{ position: 'absolute', left: 12, bottom: 'calc(100% + 7px)', width: 300, maxWidth: 'calc(100vw - 48px)', border: '1px solid var(--w-12)', borderRadius: 10, background: 'var(--bg-raised)', padding: 5, boxShadow: '0 14px 34px rgba(0,0,0,.3)', zIndex: 5 }}>
                  {projectSuggestions.map(({ project, tag }, index) => (
                    <button id={`ask-project-option-${project.id}`} key={project.id} role="option" aria-selected={index === selectedProjectSuggestion} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveProjectSuggestion(index)} onClick={() => insertProjectTag(project, tag)} style={{ cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', gap: 9, borderRadius: 7, padding: '7px 9px', color: 'var(--text)', textAlign: 'left', background: index === selectedProjectSuggestion ? 'var(--w-07)' : 'transparent' }} className="hover-border">
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent-ink)' }}>{tag}</span>
                      <span style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
                      <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{project.key}</span>
                    </button>
                  ))}
                </div>
              )}
              {taskMentionQuery !== null && (taskSuggestionsLoading || taskSuggestions.length > 0) && (
                <div role="listbox" aria-label="Reference a task" aria-activedescendant={taskSuggestions[activeTaskSuggestion] ? `ask-task-option-${taskSuggestions[activeTaskSuggestion]!.id}` : undefined} style={{ position: 'absolute', left: 12, bottom: 'calc(100% + 7px)', width: 420, maxWidth: 'calc(100vw - 48px)', maxHeight: 280, overflowY: 'auto', border: '1px solid var(--w-12)', borderRadius: 10, background: 'var(--bg-raised)', padding: 5, boxShadow: '0 14px 34px rgba(0,0,0,.3)', zIndex: 5 }}>
                  {taskSuggestionsLoading && <div style={{ padding: '7px 9px', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9 }}>searching…</div>}
                  {taskSuggestions.map((task, index) => (
                    <button id={`ask-task-option-${task.id}`} key={task.id} role="option" aria-selected={index === activeTaskSuggestion} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveTaskSuggestion(index)} onClick={() => insertTaskReference(task)} style={{ cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', gap: 9, borderRadius: 7, padding: '7px 9px', color: 'var(--text)', textAlign: 'left', background: index === activeTaskSuggestion ? 'var(--w-07)' : 'transparent' }} className="hover-border">
                      <span style={{ flex: 'none', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)' }}>#{task.key}</span>
                      <span style={{ minWidth: 0, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                      <span style={{ marginLeft: 'auto', flex: 'none', fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{task.projectKey} · {task.status}</span>
                    </button>
                  ))}
                </div>
              )}
              {selectedReferences.length > 0 && (
                <div aria-label="Selected references" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 0 7px' }}>
                  {selectedReferences.map((reference) => (
                    <button key={`${reference.kind}:${reference.id}`} type="button" aria-label={`Remove ${reference.token}`} title="Remove reference" onClick={() => removeSelectedReference(reference)} style={{ cursor: 'pointer', border: `1px solid ${reference.kind === 'project' ? 'rgba(198,242,78,.24)' : 'var(--w-12)'}`, borderRadius: 7, background: reference.kind === 'project' ? 'rgba(198,242,78,.07)' : 'var(--w-05)', padding: '3px 7px', color: reference.kind === 'project' ? 'var(--accent-ink)' : 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 9.5 }}>
                      {reference.token} <span aria-hidden="true" style={{ color: 'var(--text-faint)' }}>×</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea ref={composerRef} value={q} maxLength={4000} onChange={(event) => updateQuestion(event.target.value)} onKeyDown={(event) => {
                if (taskSuggestions.length > 0 && taskMentionQuery !== null && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                  event.preventDefault();
                  setActiveTaskSuggestion((current) => event.key === 'ArrowDown'
                    ? (current + 1) % taskSuggestions.length
                    : (current - 1 + taskSuggestions.length) % taskSuggestions.length);
                  return;
                }
                if (projectSuggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                  event.preventDefault();
                  setActiveProjectSuggestion((current) => event.key === 'ArrowDown'
                    ? (current + 1) % projectSuggestions.length
                    : (current - 1 + projectSuggestions.length) % projectSuggestions.length);
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  const taskSuggestion = taskMentionQuery !== null ? taskSuggestions[activeTaskSuggestion] : undefined;
                  if (taskSuggestion) {
                    insertTaskReference(taskSuggestion);
                    return;
                  }
                  const suggestion = projectSuggestions[selectedProjectSuggestion];
                  if (suggestion) insertProjectTag(suggestion.project, suggestion.tag);
                  else if (!loading) void ask();
                }
              }} placeholder={threadArchived ? 'Restore this chat to continue…' : 'Message Ask… Use @project to focus.'} rows={2} disabled={historyLoading || threadArchived} style={{ boxSizing: 'border-box', width: '100%', background: 'transparent', border: 0, padding: '2px 0 6px', color: 'var(--text)', fontSize: phone ? MIN_INPUT_FONT_SIZE : 13.5, lineHeight: 1.5, resize: 'none', outline: 'none', fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>
                  Model
                  <Select
                    variant="micro"
                    side={phone ? 'top' : 'bottom'}
                    aria-label="Ask model"
                    value={selectedModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                    disabled={modelsLoading || models.length === 0 || loading || threadArchived}
                    style={{ maxWidth: 220, background: 'var(--w-04)', border: '1px solid var(--w-1)', borderRadius: 6, color: 'var(--text-dim)', padding: '3px 22px 3px 6px', fontFamily: 'var(--mono)', fontSize: 9.5 }}
                  >
                    {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                  </Select>
                </label>
                <div style={{ flex: 1 }} />
                {!phone && <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>Shift+Enter for newline</span>}
                <div
                  role="meter"
                  aria-label={`Context ${contextPercent}%`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={contextPercent}
                  title={`Context ${contextPercent}% of the automatic compaction budget${contextUsage.compacted ? ` · ${contextUsage.omittedMessages} earlier messages compacted` : ''}`}
                  style={{ width: 27, height: 27, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: '50%', background: `conic-gradient(${contextPercent >= 80 ? 'var(--amber)' : 'var(--accent)'} ${contextPercent}%, var(--w-08) 0)`, fontFamily: 'var(--mono)', fontSize: 7.5, color: 'var(--text-dim)' }}
                >
                  <span style={{ width: 21, height: 21, display: 'grid', placeItems: 'center', borderRadius: '50%', background: 'var(--card)' }}>{contextPercent}%</span>
                </div>
                {loading && <Button variant="ghost" onClick={() => void cancelGeneration()} disabled={!activeGeneration?.generationId}>Cancel</Button>}
                <Button onClick={() => void ask()} disabled={!q.trim() || !selectedModel || loading || historyLoading || modelsLoading || threadArchived}>Send</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {phone && threadsOpen && <Sheet title="Threads" subtitle="Your Ask conversations" onClose={() => setThreadsOpen(false)}><div style={{ minHeight: 260, maxHeight: '65dvh', display: 'flex', flexDirection: 'column' }}>{threadPanel}</div></Sheet>}
    </div>
  );
}
