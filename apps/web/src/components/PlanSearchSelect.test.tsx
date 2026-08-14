import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { PlanSearchSelect, type PlanSearchOption } from './PlanSearchSelect';

let container: HTMLDivElement;
let root: Root | null = null;

const plan = {
  id: 'plan_target', title: 'Runner landing rollout', description: 'Ship durable landing', status: 'active',
  projectId: 'project_1', projectKey: 'RUN', createdAt: '2026-08-13T00:00:00.000Z',
} satisfies PlanSearchOption & { projectId: string; projectKey: string; createdAt: string };

function render() {
  function Harness() {
    const [value, setValue] = useState('');
    return <PlanSearchSelect projectId="project_1" value={value} onChange={setValue} status="active" label="Plan" />;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
}

function inputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PlanSearchSelect', () => {
  it('loads active plans without a snapshot and searches by typed text', async () => {
    const search = vi.spyOn(api, 'searchPlans').mockResolvedValue({ plans: [plan], matched: 1, returned: 1 });
    render();

    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => input.focus());
    act(() => inputValue(input, 'landing'));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(search).toHaveBeenCalledWith(
      { projectId: 'project_1', status: 'active', text: 'landing', limit: 25 },
      expect.any(AbortSignal),
    );
    const option = container.querySelector<HTMLElement>('[role="option"]')!;
    expect(option.textContent).toContain('Runner landing rollout');
    act(() => option.click());
    expect(input.value).toBe('Runner landing rollout');
  });
});
