import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiAskAction, type ApiAskStreamHandlers, type ApiAskThread, type ApiAskThreadDetail } from '../api';
import type { AppStore } from '../store';
import { confirm } from './Dialog';
import { AskView, askProjectTag } from './AskView';

vi.mock('./Dialog', () => ({ confirm: vi.fn() }));

let container: HTMLDivElement;
let root: Root | null = null;
const originalMatchMedia = window.matchMedia;

function mockPhoneViewport() {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('767px') || query.includes('1023px'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const actions = {
  selectProject: vi.fn(),
  openTask: vi.fn(),
  setView: vi.fn(),
  refreshNow: vi.fn(),
};

const defaultModel = '@cf/openai/gpt-oss-120b';

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

function mount(projects: Array<{ id: string; key: string; name: string }> = []) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const store = { user: { id: 'usr_ask' }, actions, data: { projects } } as unknown as AppStore;
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

beforeEach(() => {
  vi.spyOn(api, 'askModels').mockResolvedValue({
    defaultModel,
    models: [{ id: defaultModel, label: 'GPT-OSS 120B', capabilities: { tools: true, streaming: true, reasoningSummary: true } }],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  window.matchMedia = originalMatchMedia;
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(confirm).mockReset();
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe('global Ask chat', () => {
  it('moves threads into a phone sheet and opens the model menu above the composer', async () => {
    mockPhoneViewport();
    vi.spyOn(api, 'askThreads').mockResolvedValue({ threads: [activeThread] });
    vi.spyOn(api, 'askThread').mockResolvedValue(detailFor(activeThread));

    mount();
    await flush();

    expect(container.querySelector('aside')).toBeNull();
    const threads = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('Threads'))!;
    act(() => threads.click());
    expect(container.querySelector('[data-sheet-backdrop]')).toBeTruthy();
    expect(container.querySelector('[data-testid="ask-thread-chat_active"]')).toBeTruthy();

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Ask model"]')!.click());
    expect(container.querySelector('.dd-menu')?.getAttribute('data-side')).toBe('top');
    expect(container.querySelector('textarea')?.style.fontSize).toBe('16px');
  });

  it('suggests accessible projects, inserts a normalized tag, and sends it intact', async () => {
    mockEmptyHistory();
    const ask = vi.spyOn(api, 'askStream').mockImplementation(async (_question, _threadId, handlers) => {
      handlers.onDelta('Scoped answer');
      handlers.onDone?.({ finishReason: 'stop', truncated: false });
    });
    mount([{ id: 'project_noriq', key: 'PLNR', name: 'Noriq Mission Control' }]);
    await flush();

    setTextarea('What is active in @nori');
    expect(container.querySelector('[role="listbox"][aria-label="Tag a project"]')).toBeTruthy();
    expect(container.textContent).toContain('@noriq-mission-control');
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(textarea.value).toBe('What is active in @noriq-mission-control ');
    expect(ask).not.toHaveBeenCalled();

    await act(async () => button('Send')!.click());
    expect(ask).toHaveBeenCalledWith(
      'What is active in @noriq-mission-control', null, expect.anything(), expect.any(AbortSignal), defaultModel,
    );
  });

  it('renders tagged project scope separately from evidence and opens the project', async () => {
    vi.spyOn(api, 'askThreads').mockResolvedValue({ threads: [activeThread] });
    const detail = detailFor(activeThread);
    detail.messages[1] = {
      ...detail.messages[1]!,
      sources: [{
        kind: 'project', id: 'project_noriq', title: 'Noriq', score: 1,
        projectId: 'project_noriq', projectKey: 'PLNR', projectName: 'Noriq',
        citation: 'PLNR / project:project_noriq', tag: '@noriq', retrieval: 'live',
      }],
    };
    vi.spyOn(api, 'askThread').mockResolvedValue(detail);

    mount();
    await flush();
    expect(container.querySelector('[aria-label="Tagged project scope"]')?.textContent).toContain('@noriq · PLNR');
    expect(container.querySelector('[data-testid="ask-sources"]')).toBeNull();
    act(() => button('@noriq · PLNR')!.click());
    expect(actions.selectProject).toHaveBeenCalledWith('project_noriq');
    expect(actions.openTask).not.toHaveBeenCalled();
  });

  it('uses project keys when normalized project names would be ambiguous', async () => {
    mockEmptyHistory();
    mount([
      { id: 'project_one', key: 'ONE', name: 'Shared Name' },
      { id: 'project_two', key: 'TWO', name: 'Shared Name' },
    ]);
    await flush();
    setTextarea('@');
    expect([...container.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual([
      '@oneShared NameONE', '@twoShared NameTWO',
    ]);
  });

  it('navigates project tag suggestions with arrow keys and selects the active option', async () => {
    mockEmptyHistory();
    mount([
      { id: 'project_noriq', key: 'PLNR', name: 'Noriq Mission Control' },
      { id: 'project_nod', key: 'NOD', name: 'Project Nod' },
    ]);
    await flush();
    setTextarea('@');

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false']);

    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-activedescendant')).toBe('ask-project-option-project_nod');

    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(textarea.value).toBe('@project-nod ');
  });

  it('searches the authorized workspace for task references and supports keyboard selection', async () => {
    mockEmptyHistory();
    const fields = { status: 'todo', priority: 2, type: 'feature', projectId: 'project_noriq', projectKey: 'PLNR', boardId: 'board_1', updatedAt: now };
    const search = vi.spyOn(api, 'searchTasks').mockResolvedValue({
      tasks: [
        { ...fields, id: 'task_421', key: 'PLNR-421', title: 'Project keyboard navigation' },
        { ...fields, id: 'task_422', key: 'PLNR-422', title: 'Task reference search' },
      ],
      matched: 2,
      returned: 2,
    });
    mount();
    await flush();
    setTextarea('Compare #PLNR-42');
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 210)); });

    expect(search).toHaveBeenCalledWith({ text: 'PLNR-42', limit: 6 }, expect.any(AbortSignal));
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(container.querySelector('[role="listbox"][aria-label="Reference a task"]')).toBeTruthy();
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(textarea.value).toBe('Compare #PLNR-422 ');
  });

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

    expect(ask).toHaveBeenCalledWith('What is ready?', 'chat_active', expect.anything(), expect.any(AbortSignal), defaultModel);
    expect(container.textContent).toContain('Searching workspace and selecting tools…');

    act(() => {
      handlers!.onMeta({
        mode: 'semantic',
        model: '@cf/openai/gpt-oss-120b',
        graphEnhanced: true,
        trace: ['Ask read live workspace status.', 'Response truncated (token limit).'],
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
    expect(container.textContent).toContain('Coverage notice: Response truncated');
    const reasoning = [...container.querySelectorAll<HTMLElement>('[data-testid="ask-reasoning"]')].at(-1)!;
    const sources = [...container.querySelectorAll<HTMLElement>('[data-testid="ask-sources"]')].at(-1)!;
    const answer = [...container.querySelectorAll<HTMLElement>('[data-testid="ask-answer"]')].at(-1)!;
    expect((reasoning as HTMLDetailsElement).open).toBe(false);
    expect((sources as HTMLDetailsElement).open).toBe(false);
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

  it('offers exactly the server catalog, sends the selected model, and keeps stored attribution', async () => {
    const fastModel = '@cf/meta/fast-model';
    vi.mocked(api.askModels).mockResolvedValue({
      defaultModel,
      models: [
        { id: defaultModel, label: 'Large model', capabilities: { tools: true, streaming: true, reasoningSummary: true } },
        { id: fastModel, label: 'Fast model', capabilities: { tools: true, streaming: true, reasoningSummary: false } },
      ],
    });
    const detail = detailFor(activeThread);
    detail.messages[1] = { ...detail.messages[1]!, model: fastModel };
    vi.spyOn(api, 'askThreads').mockResolvedValue({ threads: [activeThread] });
    vi.spyOn(api, 'askThread').mockResolvedValue(detail);
    const ask = vi.spyOn(api, 'askStream').mockImplementation(async (_question, _threadId, handlers) => {
      handlers.onDelta('Selected model answer');
      handlers.onDone?.({ finishReason: 'stop', truncated: false });
    });

    mount();
    await flush();
    const selector = container.querySelector<HTMLButtonElement>('button[aria-label="Ask model"]')!;
    act(() => selector.click());
    expect([...container.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => [option.dataset.value, option.querySelector('span span')?.textContent])).toEqual([
      [defaultModel, 'Large model'], [fastModel, 'Fast model'],
    ]);
    expect(container.textContent).toContain('Fast model');
    expect(container.textContent).toContain(fastModel);
    const fastOption = container.querySelector<HTMLElement>(`[role="option"][data-value="${fastModel}"]`)!;
    act(() => fastOption.click());
    setTextarea('Use the fast model');
    await act(async () => button('Send')!.click());
    expect(ask).toHaveBeenCalledWith('Use the fast model', activeThread.id, expect.anything(), expect.any(AbortSignal), fastModel);
  });

  it('restores exact action cards, prevents double confirmation, and opens the affected task after success', async () => {
    const pending: ApiAskAction = {
      id: 'askact_update', threadId: activeThread.id, messageId: `${activeThread.id}_a`, generationId: 'askgen_action',
      projectId: 'project_pay', type: 'update_task', summary: 'Update PAY-2: body, priority',
      arguments: { projectId: 'project_pay', taskId: 'task_2', set: { body: 'New body', priority: 0 } },
      expected: {
        projectId: 'project_pay', taskId: 'task_2', updatedAt: now,
        before: { body: 'Old body', priority: 2 }, after: { body: 'New body', priority: 0 },
      },
      requiredAction: 'contribute', operationKey: 'op_update', status: 'pending', result: null, error: null,
      createdAt: now, updatedAt: now, settledAt: null,
    };
    const detail = detailFor(activeThread);
    detail.messages[1] = { ...detail.messages[1]!, model: defaultModel, actions: [pending] };
    vi.spyOn(api, 'askThreads').mockResolvedValue({ threads: [activeThread] });
    vi.spyOn(api, 'askThread').mockResolvedValue(detail);
    let settle!: (value: ApiAskAction) => void;
    const approve = vi.spyOn(api, 'approveAskAction').mockImplementation(() => new Promise((resolve) => { settle = resolve; }));

    mount();
    await flush();
    expect(container.textContent).toContain('Update PAY-2: body, priority');
    expect(container.textContent).toContain('Old body');
    expect(container.textContent).toContain('New body');
    expect(container.textContent).toContain('Exact stored payload');
    const confirmAction = ariaButton('Confirm Update PAY-2: body, priority')!;
    act(() => { confirmAction.click(); confirmAction.click(); });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(confirmAction.disabled).toBe(true);

    await act(async () => settle({ ...pending, status: 'approved', result: { ok: true, key: 'PAY-2' }, settledAt: now }));
    expect(container.textContent).toContain('Applied as your human action.');
    expect(actions.selectProject).toHaveBeenCalledWith('project_pay');
    expect(actions.refreshNow).toHaveBeenCalled();
    expect(actions.openTask).toHaveBeenCalledWith('task_2');
  });

  it('rejects a restored pending action without opening a task and renders persisted failures', async () => {
    const pending: ApiAskAction = {
      id: 'askact_create', threadId: activeThread.id, messageId: `${activeThread.id}_a`, generationId: 'askgen_action_2',
      projectId: 'project_pay', type: 'create_task', summary: 'Create task “Retry docs” in PAY',
      arguments: { projectId: 'project_pay', title: 'Retry docs', tags: ['payments'] },
      expected: { projectId: 'project_pay' }, requiredAction: 'contribute', operationKey: 'op_create',
      status: 'pending', result: null, error: null, createdAt: now, updatedAt: now, settledAt: null,
    };
    const detail = detailFor(activeThread);
    detail.messages[1] = { ...detail.messages[1]!, actions: [pending, {
      ...pending, id: 'askact_failed', summary: 'Update PAY-9: body', status: 'failed', error: 'PAY-9 changed since this action was proposed',
    }] };
    vi.spyOn(api, 'askThreads').mockResolvedValue({ threads: [activeThread] });
    vi.spyOn(api, 'askThread').mockResolvedValue(detail);
    vi.spyOn(api, 'rejectAskAction').mockResolvedValue({ ...pending, status: 'rejected', settledAt: now });

    mount();
    await flush();
    expect(container.textContent).toContain('PAY-9 changed since this action was proposed');
    await act(async () => ariaButton('Reject Create task “Retry docs” in PAY')!.click());
    expect(container.textContent).toContain('Rejected without changing Noriq.');
    expect(actions.openTask).not.toHaveBeenCalled();
  });

  it('reconnects to an in-flight stored response from its persisted offsets', async () => {
    const detail = detailFor(activeThread);
    detail.messages[1] = {
      ...detail.messages[1]!,
      content: 'Persisted ',
      reasoning: 'Summary ',
      generationId: 'askgen_live',
      generationStatus: 'generating',
    };
    vi.spyOn(api, 'askThreads').mockResolvedValue({ threads: [activeThread] });
    vi.spyOn(api, 'askThread').mockResolvedValue(detail);
    const resume = vi.spyOn(api, 'resumeAskStream').mockImplementation(async (_id, _offsets, handlers) => {
      handlers.onDelta('continuation');
      handlers.onDone?.({ finishReason: 'stop', truncated: false });
    });

    mount();
    await flush();
    expect(resume).toHaveBeenCalledWith(
      'askgen_live',
      { answer: 'Persisted '.length, reasoning: 'Summary '.length },
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(container.textContent).toContain('Persisted continuation');
  });

  it('keeps the composer editable, cancels the active generation, and copies full messages', async () => {
    mockEmptyHistory();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const cancel = vi.spyOn(api, 'cancelAskGeneration').mockResolvedValue({ ok: true, cancelled: true });
    vi.spyOn(api, 'askStream').mockImplementation(async (_question, _threadId, handlers, signal) => {
      handlers.onGeneration?.({ id: 'askgen_cancel' });
      handlers.onStatus?.('generating');
      handlers.onDelta('Partial assistant response');
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });

    mount();
    await flush();
    setTextarea('Original user prompt');
    act(() => button('Send')!.click());
    await flush();

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.disabled).toBe(false);
    setTextarea('Draft the next prompt');
    expect(textarea.value).toBe('Draft the next prompt');
    expect(button('Send')?.hasAttribute('disabled')).toBe(true);
    expect(button('Cancel')).toBeTruthy();

    await act(async () => button('Cancel')!.click());
    await flush();
    expect(cancel).toHaveBeenCalledWith('askgen_cancel');
    expect(container.textContent).toContain('Response cancelled.');
    expect(textarea.value).toBe('Draft the next prompt');

    await act(async () => ariaButton('Copy user message')!.click());
    await act(async () => ariaButton('Copy assistant message')!.click());
    expect(writeText.mock.calls).toEqual([
      ['Original user prompt'],
      ['Partial assistant response'],
    ]);
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
      'ta\ndata: {"text":"world"}\n\nevent: done\ndata: {"finishReason":"stop","truncated":false}\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of wire) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];

    await api.askStream('question', null, {
      onThread: (thread) => seen.push(`thread:${thread.id}`),
      onMeta: (meta) => seen.push(`meta:${meta.model}:${meta.graphEnhanced}`),
      onStatus: (phase) => seen.push(`status:${phase}`),
      onReasoning: (text) => seen.push(`reasoning:${text}`),
      onDelta: (text) => seen.push(`delta:${text}`),
      onDone: (result) => seen.push(`done:${result.finishReason}:${result.truncated}`),
    }, undefined, '@cf/test/selected');

    expect(seen).toEqual(['thread:chat_1', 'meta:m:true', 'status:generating', 'reasoning:Summary', 'delta:Hello ', 'delta:world', 'done:stop:false']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({ question: 'question', model: '@cf/test/selected' });
  });

  it('treats cancellation as a normal terminal stream event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'event: generation\ndata: {"id":"askgen_1"}\n\nevent: cancelled\ndata: {}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));
    const cancelled = vi.fn();
    await api.resumeAskStream('askgen_1', { answer: 0, reasoning: 0 }, {
      onMeta: () => {}, onDelta: () => {}, onCancelled: cancelled,
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe('askProjectTag', () => {
  it('normalizes project names into stable @ tokens', () => {
    expect(askProjectTag('  Project NOD: Prototype  ')).toBe('@project-nod-prototype');
  });
});
