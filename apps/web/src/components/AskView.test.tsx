import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiAskStreamHandlers } from '../api';
import type { AppStore } from '../store';
import { AskView } from './AskView';

let container: HTMLDivElement;
let root: Root | null = null;

const actions = {
  selectProject: vi.fn(),
  openTask: vi.fn(),
  setView: vi.fn(),
};

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const store = { user: { id: 'usr_ask' }, actions } as unknown as AppStore;
  act(() => root!.render(<AskView store={store} />));
}

const setTextarea = (value: string) => {
  const input = container.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe('global Ask chat', () => {
  it('sends prior turns, renders the answer, and opens a source in its own project', async () => {
    sessionStorage.setItem('noriq.ask.thread.usr_ask', JSON.stringify([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ]));
    let handlers: ApiAskStreamHandlers | undefined;
    let finish: (() => void) | undefined;
    const ask = vi.spyOn(api, 'askStream').mockImplementation(async (_question, _history, callbacks) => {
      handlers = callbacks;
      await new Promise<void>((resolve) => { finish = resolve; });
    });

    mount();
    setTextarea('What is ready?');
    act(() => button('Send')!.click());

    expect(ask).toHaveBeenCalledWith('What is ready?', [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ], expect.anything(), expect.any(AbortSignal));
    expect(container.textContent).toContain('Searching your projects…');

    act(() => {
      handlers!.onMeta({
        mode: 'semantic',
        model: '@cf/openai/gpt-oss-120b',
        sources: [{
          kind: 'task', id: 'task_2', key: 'PAY-2', title: 'Retry payments', score: 0.9,
          projectId: 'project_pay', projectKey: 'PAY', projectName: 'Payments',
        }],
      });
      handlers!.onStatus?.('generating');
      handlers!.onReasoning?.('I compared the retrieved project state.');
      handlers!.onDelta('The retry work ');
    });
    expect(container.textContent).toContain('The retry work');
    expect(container.textContent).toContain('Generating with GPT-OSS 120B…');
    expect(container.textContent).toContain('I compared the retrieved project state.');
    expect(container.textContent).toContain('PAY-2'); // sources arrive before completion
    expect(container.querySelector('details')?.open).toBe(true);

    await act(async () => {
      handlers!.onDelta('is ready.');
      finish!();
    });
    expect(container.textContent).toContain('The retry work is ready.');
    expect(container.textContent).toContain('GPT-OSS 120B · Cloudflare');
    expect(container.querySelector('details')?.open).toBe(false);
    act(() => container.querySelector('summary')!.click());
    expect(container.querySelector('details')?.open).toBe(true);

    const source = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('PAY-2'))!;
    act(() => source.click());
    expect(actions.selectProject).toHaveBeenCalledWith('project_pay');
    expect(actions.openTask).toHaveBeenCalledWith('task_2');
  });

  it('starts a fresh session thread without deleting project data', () => {
    sessionStorage.setItem('noriq.ask.thread.usr_ask', JSON.stringify([{ role: 'user', content: 'Old turn' }]));
    mount();
    expect(container.textContent).toContain('Old turn');
    act(() => button('+ New chat')!.click());
    expect(container.textContent).not.toContain('Old turn');
    expect(container.textContent).toContain('How can I help?');
  });
});

describe('Ask SSE transport', () => {
  it('parses events split across network chunks in arrival order', async () => {
    const wire = [
      'event: meta\ndata: {"sources":[],"mode":"semantic","model":"m"}\n\nevent: status\nda',
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

    await api.askStream('question', [], {
      onMeta: (meta) => seen.push(`meta:${meta.model}`),
      onStatus: (phase) => seen.push(`status:${phase}`),
      onReasoning: (text) => seen.push(`reasoning:${text}`),
      onDelta: (text) => seen.push(`delta:${text}`),
    });

    expect(seen).toEqual(['meta:m', 'status:generating', 'reasoning:Summary', 'delta:Hello ', 'delta:world']);
  });
});
