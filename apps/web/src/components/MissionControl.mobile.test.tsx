import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../store';
import { MissionControl } from './MissionControl';

function phoneMatchMedia() {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('767px') || query.includes('1023px'), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  } as MediaQueryList));
}

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  document.body.style.overflow = '';
  vi.restoreAllMocks();
});

function mobileStore(answerSignal = vi.fn()) {
  return {
    currentPid: 'p1', selectedAgentId: null, draftKind: 'comment', draftText: '',
    permissions: { canContribute: true },
    data: {
      agents: { p1: [{ id: 'a1', name: 'Worker', color: '#4c9dff' }] },
      events: { p1: [{ id: 'e1', t: '12:00:00', actor: 'Worker', actorKind: 'agent', verb: 'updated', subject: 'A subject that must remain fully visible and wrap naturally on a narrow phone.', createdAt: '2026-08-10T12:00:00.000Z' }] },
    },
    snapshot: { signals: [{ id: 's1', taskId: 't1', taskKey: 'PLNR-1', agentId: 'a1', agentName: 'Worker', type: 'input_request', severity: 'info', title: 'Choose', body: null, options: ['Ship it'], questions: null, followUpTo: null, createdAt: '2026-08-10T12:00:00.000Z' }] },
    actions: { openTask: vi.fn(), answerSignal, acknowledgeSignal: vi.fn(), cycleKind: vi.fn(), setDraftText: vi.fn(), postComment: vi.fn() },
  } as unknown as AppStore;
}

describe('MissionControl phone composition', () => {
  it('mounts only feed, wraps subjects, and answers an option directly from the decisions sheet', () => {
    phoneMatchMedia();
    const answerSignal = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => createRoot(container).render(<MissionControl store={mobileStore(answerSignal)} />));

    expect(container.textContent).not.toContain('Agents ·');
    expect(container.textContent).not.toContain('Who holds what');
    expect(container.textContent).toContain('1 decision waiting on you');
    expect(container.querySelector<HTMLElement>('[data-event-subject]')?.style.whiteSpace).toBe('normal');

    const review = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Review'))!;
    act(() => review.click());
    const option = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Ship it')!;
    expect(option.style.minHeight).toBe('44px');
    act(() => option.click());
    expect(answerSignal).toHaveBeenCalledWith('s1', 'Ship it');
  });

  it('follows new events only while the reader remains pinned to the bottom', () => {
    phoneMatchMedia();
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const store = mobileStore();
    act(() => root.render(<MissionControl store={store} />));
    const scroll = container.querySelector<HTMLElement>('[data-event-scroll]')!;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });

    scroll.scrollTop = 100;
    act(() => scroll.dispatchEvent(new Event('scroll', { bubbles: true })));
    store.data.events.p1!.unshift({ ...store.data.events.p1![0]!, id: 'e2', t: '12:01:00', createdAt: '2026-08-10T12:01:00.000Z' });
    act(() => root.render(<MissionControl store={store} />));
    expect(scroll.scrollTop).toBe(100);

    scroll.scrollTop = 700;
    act(() => scroll.dispatchEvent(new Event('scroll', { bubbles: true })));
    store.data.events.p1!.unshift({ ...store.data.events.p1![0]!, id: 'e3', t: '12:02:00', createdAt: '2026-08-10T12:02:00.000Z' });
    act(() => root.render(<MissionControl store={store} />));
    expect(scroll.scrollTop).toBe(1000);
  });
});
