import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
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
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe('global Ask chat', () => {
  it('sends prior turns, renders the answer, and opens a source in its own project', async () => {
    sessionStorage.setItem('noriq.ask.thread.usr_ask', JSON.stringify([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ]));
    const ask = vi.spyOn(api, 'ask').mockResolvedValue({
      answer: 'The retry work is ready.',
      mode: 'semantic',
      model: '@cf/openai/gpt-oss-120b',
      sources: [{
        kind: 'task', id: 'task_2', key: 'PAY-2', title: 'Retry payments', score: 0.9,
        projectId: 'project_pay', projectKey: 'PAY', projectName: 'Payments',
      }],
    });

    mount();
    setTextarea('What is ready?');
    await act(async () => button('Send')!.click());

    expect(ask).toHaveBeenCalledWith('What is ready?', [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ]);
    expect(container.textContent).toContain('The retry work is ready.');
    expect(container.textContent).toContain('GPT-OSS 120B · Cloudflare');

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
