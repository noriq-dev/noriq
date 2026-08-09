import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiAskStreamHandlers, type ApiAskThread, type ApiAskThreadDetail } from '../api';
import type { AppStore } from '../store';
import { confirm } from './Dialog';
import { AskView } from './AskView';

vi.mock('./Dialog', () => ({ confirm: vi.fn() }));

let container: HTMLDivElement;
let root: Root | null = null;

const actions = {
  selectProject: vi.fn(),
  openTask: vi.fn(),
  setView: vi.fn(),
};

const now = '2026-08-09T12:00:00.000Z';
const activeThread: ApiAskThread = {
  id: 'chat_active', title: 'Release readiness', archivedAt: null, createdAt: now, updatedAt: now,
  messageCount: 2, lastMessage: 'Earlier answer',
};
const archivedThread: ApiAskThread = {
  id: 'chat_archived', title: 'Old investigation', archivedAt: now, createdAt: now, updatedAt: now,
  messageCount: 2, lastMessage: 'Archived answer',
};

const detailFor = (thread: ApiAskThread): ApiAskThreadDetail => ({
  ...thread,
  messages: [
    { id: `${thread.id}_u`, role: 'user', content: thread.id === activeThread.id ? 'Earlier question' : 'Archived question', sources: [], reasoning: '', trace: [], mode: null, model: null, createdAt: now },
    { id: `${thread.id}_a`, role: 'assistant', content: thread.lastMessage!, sources: [], reasoning: '', trace: [], mode: null, model: null, createdAt: now },
  ],
});

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const store = { user: { id: 'usr_ask' }, actions } as unknown as AppStore;
  act(() => root!.render(<AskView store={store} />));
}

const flush = async () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const mockEmptyHistory = () => vi.spyOn(api, 'askThreads').mockResolvedValue({ threads: [] });

const setTextarea = (value: string) => {
  const input = container.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label);
const ariaButton = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(confirm).mockReset();
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe('global Ask chat', () => {
  it('loads a durable thread, streams into it, and opens a graph-aware source', async () => {
    vi.spyOn(api, 'askThreads').mockResolvedValue({ threads: [activeThread] });
    vi.spyOn(api, 'askThread').mockResolvedValue(detailFor(activeThread));
    let handlers: ApiAskStreamHandlers | undefined;
    let finish: (() => void) | undefined;
    const ask = vi.spyOn(api, 'askStream').mockImplementation(async (_question, _threadId, callbacks) => {
      handlers = callbacks;
      await new Promise<void>((resolve) => { finish = resolve; });
    });

    mount();
    await flush();
    expect(container.textContent).toContain('Earlier question');
    expect(container.textContent).toContain('Release readiness');
    setTextarea('What is ready?');
    act(() => button('Send')!.click());

    expect(ask).toHaveBeenCalledWith('What is ready?', 'chat_active', expect.anything(), expect.any(AbortSignal));
    expect(container.textContent).toContain('Searching sources, memories, and graph…');

    act(() => {
      handlers!.onMeta({
        mode: 'semantic',
        model: '@cf/openai/gpt-oss-120b',
        graphEnhanced: true,
        sources: [{
          kind: 'task', id: 'task_2', key: 'PAY-2', title: 'Retry payments', score: 0.9,
          projectId: 'project_pay', projectKey: 'PAY', projectName: 'Payments', retrieval: 'hybrid',
        }],
      });
      handlers!.onStatus?.('generating');
      handlers!.onReasoning?.('I compared the retrieved project state.');
      handlers!.onDelta('The retry work ');
    });
    expect(container.textContent).toContain('The retry work');
    expect(container.textContent).toContain('I compared the retrieved project state.');
    expect(container.textContent).toContain('PAY-2');
    const reasoning = [...container.querySelectorAll<HTMLElement>('[data-testid="ask-reasoning"]')].at(-1)!;
    const sources = [...container.querySelectorAll<HTMLElement>('[data-testid="ask-sources"]')].at(-1)!;
    const answer = [...container.querySelectorAll<HTMLElement>('[data-testid="ask-answer"]')].at(-1)!;
    expect((reasoning as HTMLDetailsElement).open).toBe(false);
    expect(reasoning.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sources.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => {
      handlers!.onDelta('is ready.');
      finish!();
    });
    expect(container.textContent).toContain('The retry work is ready.');
    const source = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('PAY-2'))!;
    act(() => source.click());
    expect(actions.selectProject).toHaveBeenCalledWith('project_pay');
    expect(actions.openTask).toHaveBeenCalledWith('task_2');
  });

  it('creates a durable thread for the first streamed question', async () => {
    mockEmptyHistory();
    let handlers: ApiAskStreamHandlers | undefined;
    let finish: (() => void) | undefined;
    vi.spyOn(api, 'askStream').mockImplementation(async (_question, _threadId, callbacks) => {
      handlers = callbacks;
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    mount();
    await flush();
    setTextarea('Start durable chat');
    act(() => button('Send')!.click());
    act(() => handlers!.onThread?.({ id: 'chat_new', title: 'Start durable chat' }));
    expect(container.textContent).toContain('Start durable chat');
    expect(container.querySelector('[data-testid="ask-thread-chat_new"]')).toBeTruthy();
    await act(async () => { handlers!.onDelta('Stored answer'); finish!(); });
  });

  it('archives, views, restores, and permanently deletes chats', async () => {
    vi.spyOn(api, 'askThreads').mockImplementation(async (archived = false) => ({ threads: archived ? [archivedThread] : [activeThread] }));
    vi.spyOn(api, 'askThread').mockImplementation(async (id) => detailFor(id === archivedThread.id ? archivedThread : activeThread));
    const archive = vi.spyOn(api, 'archiveAskThread').mockResolvedValue({ ok: true, archived: true });
    const restore = vi.spyOn(api, 'restoreAskThread').mockResolvedValue({ ok: true, archived: false });
    const remove = vi.spyOn(api, 'deleteAskThread').mockResolvedValue({ ok: true });
    vi.mocked(confirm).mockResolvedValue(true);
    mount();
    await flush();

    await act(async () => ariaButton('Archive Release readiness')!.click());
    expect(archive).toHaveBeenCalledWith(activeThread.id);
    await act(async () => button('Archived')!.click());
    await flush();
    expect(container.textContent).toContain('Old investigation');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="ask-thread-chat_archived"] button')!.click());
    await flush();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.placeholder).toContain('Restore this chat');
    await act(async () => ariaButton('Restore Old investigation')!.click());
    expect(restore).toHaveBeenCalledWith(archivedThread.id);

    await act(async () => button('Archived')!.click());
    await flush();
    await act(async () => ariaButton('Delete Old investigation')!.click());
    expect(confirm).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(archivedThread.id);
  });

  it('stops following streamed output after the user scrolls up and resumes at the bottom', async () => {
    mockEmptyHistory();
    let handlers: ApiAskStreamHandlers | undefined;
    let finish: (() => void) | undefined;
    vi.spyOn(api, 'askStream').mockImplementation(async (_question, _threadId, callbacks) => {
      handlers = callbacks;
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    mount();
    await flush();
    const scroll = container.querySelector<HTMLElement>('[data-testid="ask-scroll"]')!;
    const end = container.querySelector<HTMLElement>('[data-testid="ask-end"]')!;
    const scrollIntoView = vi.fn();
    end.scrollIntoView = scrollIntoView;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 600 },
    });

    setTextarea('Stream a long answer');
    act(() => button('Send')!.click());
    scrollIntoView.mockClear();
    scroll.scrollTop = 100;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    act(() => handlers!.onDelta('First chunk'));
    expect(scrollIntoView).not.toHaveBeenCalled();

    scroll.scrollTop = 600;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    act(() => handlers!.onDelta(' second chunk'));
    expect(scrollIntoView).toHaveBeenCalled();
    await act(async () => finish!());
  });
});

describe('Ask SSE transport', () => {
  it('parses thread, metadata, reasoning, and answer events split across network chunks', async () => {
    const wire = [
      'event: thread\ndata: {"id":"chat_1","title":"Question"}\n\nevent: meta\ndata: {"sources":[],"mode":"semantic","model":"m","graphEnhanced":true}\n\nevent: status\nda',
      'ta: {"phase":"generating"}\n\nevent: reasoning\ndata: {"text":"Summary"}\n\nevent: delta\ndata: {"text":"Hello "}\n\nevent: del',
      'ta\ndata: {"text":"world"}\n\nevent: done\ndata: {}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of wire) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })));
    const seen: string[] = [];

    await api.askStream('question', null, {
      onThread: (thread) => seen.push(`thread:${thread.id}`),
      onMeta: (meta) => seen.push(`meta:${meta.model}:${meta.graphEnhanced}`),
      onStatus: (phase) => seen.push(`status:${phase}`),
      onReasoning: (text) => seen.push(`reasoning:${text}`),
      onDelta: (text) => seen.push(`delta:${text}`),
    });

    expect(seen).toEqual(['thread:chat_1', 'meta:m:true', 'status:generating', 'reasoning:Summary', 'delta:Hello ', 'delta:world']);
  });
});
