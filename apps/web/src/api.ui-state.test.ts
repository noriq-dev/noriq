import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('uiState client (PLNR-400)', () => {
  it('uses the surface endpoint and forwards cancellation without touching /snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ project: {}, tasks: [], events: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await api.uiState('prj one', 'memory', controller.signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/projects/prj one/ui-state?surface=memory');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET', signal: controller.signal });
    expect(fetchMock.mock.calls[0]![0]).not.toContain('/snapshot');
  });

  it('requests bounded task-body match pages only when the board searches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ taskIds: ['task_1'], nextCursor: '256' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.taskBodyMatches('prj_1', 'race & retry', '256');

    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/projects/prj_1/task-body-matches?q=race%20%26%20retry&limit=256&cursor=256',
    );
  });
});
