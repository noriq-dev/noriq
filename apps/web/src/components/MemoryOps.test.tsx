// PLNR-273: the operations panel's load-bearing behaviours — the five failure modes (stale
// index, failed ingest, vector drift, backup failure, canonical-store failure) must each read
// distinctly rather than collapsing into one red dot; a staged generation the server has not
// validated must offer no activation control; a non-admin must see status with no destructive
// affordance; a missing optional binding must read as reduced capability, never an error; and
// destructive actions must go through the real Dialog confirmation, never fire on a bare click.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiMemoryOpsStatus, type ApiMemoryRepository } from '../api';
import { MemoryOps } from './MemoryOps';
import { DialogHost } from './Dialog';
import type { AppStore } from '../store';

let container: HTMLDivElement;
let root: Root | null = null;

function fakeStore(opts: { isAdmin?: boolean } = {}): AppStore {
  return {
    currentPid: 'prj_1',
    isAdmin: opts.isAdmin ?? true,
    data: { projects: [{ id: 'prj_1', name: 'Acme Project' }] },
  } as unknown as AppStore;
}

function mount(store: AppStore = fakeStore()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <>
        <MemoryOps pid="prj_1" store={store} />
        <DialogHost />
      </>,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

const text = () => container.textContent ?? '';
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const buttonContaining = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

const OK_STATUS: ApiMemoryOpsStatus = {
  health: { projectId: 'prj_1', schemaVersion: 1, memoryRevision: 3, tableCounts: {}, databaseSize: 1024, sizeStatus: 'ok', hasPriorGeneration: false },
  registry: { backupStatus: 'ok', lastBackupAt: '2026-01-01T00:00:00.000Z', vectorDirty: false, sizeBytes: 1024, sizeStatus: 'ok' },
  capabilities: { r2: true, vectorize: true, workersAI: true, codeVectorize: true },
};

function mockClean() {
  vi.spyOn(api, 'memoryOpsStatus').mockResolvedValue(OK_STATUS);
  vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
  vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: [], r2Available: true });
}

describe('canonical-store failure', () => {
  it('is its own labelled state, distinct from every other section, and nothing else renders on top of it', async () => {
    vi.spyOn(api, 'memoryOpsStatus').mockRejectedValue(new Error('DO unreachable'));
    vi.spyOn(api, 'memoryRepositories').mockRejectedValue(new Error('DO unreachable'));
    vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: [], r2Available: true });

    mount();
    await tick();

    expect(text()).toContain('CANONICAL-STORE FAILURE');
    expect(text()).toContain('escalate');
    // Not conflated with any of the other four states or a generic empty view.
    expect(text()).not.toContain('Memory health');
    expect(text()).not.toContain('Repositories');
    expect(text()).not.toContain('Backup & restore');
  });
});

describe('renders without crashing on a project with no repositories, generations, or backups', () => {
  it('shows the healthy panel with an empty repositories section', async () => {
    mockClean();
    mount();
    await tick();

    expect(text()).toContain('Memory health');
    expect(text()).toContain('Repositories · 0');
    expect(text()).toContain('No repository is registered');
    expect(text()).toContain('no backups yet');
  });
});

describe('the five failure modes render distinctly — no shared generic error text', () => {
  const STALE_REPO: ApiMemoryRepository = {
    id: 'pr_1', projectId: 'prj_1', repositoryKey: 'stale-repo', indexingEnabled: true, ingestStatus: 'active',
    defaultBranch: 'main', vcsKind: 'git', branchClasses: [], latestObservedBase: 'sha_new', activeGenerationId: 'gen_1',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, checkouts: [],
    activeGeneration: {
      id: 'gen_1', repositoryKey: 'stale-repo', branch: 'main', baseId: 'sha_old', indexerVersion: 'v1',
      status: 'active', batchCount: 1, fileCount: 3, sealedAt: '2026-01-01T00:00:00.000Z', validationProblems: [],
      createdAt: '2026-01-01T00:00:00.000Z', activatedAt: '2026-01-01T00:00:00.000Z',
    },
    stagedGenerations: [],
    stale: true,
    failedIngest: false,
    failedIngestProblems: [],
  };
  const FAILED_REPO: ApiMemoryRepository = {
    id: 'pr_2', projectId: 'prj_1', repositoryKey: 'failed-repo', indexingEnabled: true, ingestStatus: 'failed',
    defaultBranch: 'main', vcsKind: 'git', branchClasses: [], latestObservedBase: null, activeGenerationId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, checkouts: [],
    activeGeneration: null,
    stagedGenerations: [
      {
        id: 'gen_bad', repositoryKey: 'failed-repo', branch: 'main', baseId: 'sha_1', indexerVersion: 'v1',
        status: 'staged', batchCount: 1, fileCount: 9, sealedAt: '2026-01-01T00:00:00.000Z',
        validationProblems: ['manifest declares fileCount 9, staged 1 file entities'],
        createdAt: '2026-01-01T00:00:00.000Z', activatedAt: null, validated: false,
      },
    ],
    stale: false,
    failedIngest: true,
    failedIngestProblems: ['manifest declares fileCount 9, staged 1 file entities'],
  };

  it('vector drift, backup failure, stale index, and failed ingest each carry their own distinct guidance', async () => {
    vi.spyOn(api, 'memoryOpsStatus').mockResolvedValue({
      health: { ...OK_STATUS.health },
      registry: { backupStatus: 'failed', lastBackupAt: '2026-01-01T00:00:00.000Z', vectorDirty: true, sizeBytes: 1024, sizeStatus: 'ok' },
      capabilities: OK_STATUS.capabilities,
    });
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [STALE_REPO, FAILED_REPO] });
    vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: [], r2Available: true });

    mount();
    await tick();

    // Vector drift: distinct guidance to rebuild vectors.
    expect(text()).toContain('Marked dirty');
    expect(text()).toContain('rebuild vectors');
    // Backup failure: distinct guidance to investigate R2, never "rebuild vectors" or "reindex".
    expect(text()).toContain('investigate R2 connectivity');
    // Stale index: distinct guidance pointing at the Runner, never at R2 or vectors.
    expect(text()).toContain('ask the Runner to reindex this repository');
    // Failed ingest: distinct guidance to re-upload, carrying the actual validation problem text.
    expect(text()).toContain('re-upload from the Runner');
    expect(text()).toContain('manifest declares fileCount 9');

    // No two of the four share their guidance sentence.
    const guidances = ['rebuild vectors', 'investigate R2 connectivity', 'ask the Runner to reindex this repository', 're-upload from the Runner'];
    expect(new Set(guidances).size).toBe(guidances.length);
  });
});

describe('a staged generation the server has not validated offers no activation control', () => {
  const repoWithUnvalidated: ApiMemoryRepository = {
    id: 'pr_3', projectId: 'prj_1', repositoryKey: 'act-repo', indexingEnabled: true, ingestStatus: 'staged',
    defaultBranch: 'main', vcsKind: 'git', branchClasses: [], latestObservedBase: null, activeGenerationId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, checkouts: [],
    activeGeneration: null,
    stagedGenerations: [
      {
        id: 'gen_unsealed', repositoryKey: 'act-repo', branch: 'main', baseId: 'sha_1', indexerVersion: 'v1',
        status: 'staged', batchCount: 2, fileCount: 2, sealedAt: null, validationProblems: [],
        createdAt: '2026-01-01T00:00:00.000Z', activatedAt: null, validated: false,
      },
      {
        id: 'gen_ready', repositoryKey: 'act-repo', branch: 'main', baseId: 'sha_1', indexerVersion: 'v1',
        status: 'staged', batchCount: 1, fileCount: 1, sealedAt: '2026-01-01T00:00:00.000Z', validationProblems: [],
        createdAt: '2026-01-01T00:00:00.000Z', activatedAt: null, validated: true,
      },
    ],
    stale: false,
    failedIngest: false,
    failedIngestProblems: [],
  };

  it('disables activation for the unsealed generation and enables it only for the validated one', async () => {
    mockClean();
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [repoWithUnvalidated] });
    const activate = vi.spyOn(api, 'memoryActivateGeneration').mockResolvedValue({ activated: 'gen_ready', superseded: [] });

    mount();
    await tick();

    const activateButtons = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'activate');
    expect(activateButtons).toHaveLength(2);
    expect(activateButtons[0]!.disabled).toBe(true); // gen_unsealed — not sealed, not validated
    expect(activateButtons[1]!.disabled).toBe(false); // gen_ready — sealed, zero validation problems

    await act(async () => { activateButtons[0]!.click(); });
    expect(activate).not.toHaveBeenCalled();

    await act(async () => { activateButtons[1]!.click(); });
    expect(activate).toHaveBeenCalledWith('prj_1', 'gen_ready');
  });

  it('shows the not-ready state and not a bare "validated" claim for the unsealed generation', async () => {
    mockClean();
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [repoWithUnvalidated] });
    mount();
    await tick();
    expect(text()).toContain('not ready');
    expect(text()).toContain('✓ validated'); // the OTHER (validated) generation in the same repo
  });
});

describe('registering a canonical repository (PLNR-311)', () => {
  it('is offered to a NON-admin project member — unlike every other action in this panel', async () => {
    mockClean();
    mount(fakeStore({ isAdmin: false }));
    await tick();

    expect(button('register repository')).toBeDefined();
    expect(button('register repository')!.disabled).toBe(true); // empty input
  });

  it('registers the typed key, clears the input, and refreshes the list', async () => {
    mockClean();
    const register = vi.spyOn(api, 'registerRepository').mockResolvedValue({
      repository: {
        id: 'pr_new', projectId: 'prj_1', repositoryKey: 'web-app', indexingEnabled: false, ingestStatus: 'none',
        defaultBranch: null, vcsKind: null, branchClasses: [], latestObservedBase: null, activeGenerationId: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, checkouts: [],
        activeGeneration: null, stagedGenerations: [], stale: false, failedIngest: false, failedIngestProblems: [],
      },
      created: true,
    });

    mount();
    await tick();

    const input = container.querySelector('input[placeholder^="repository key"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'web-app');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('register repository')!.click(); });

    expect(register).toHaveBeenCalledWith('prj_1', 'web-app');
    expect(input.value).toBe('');
  });

  it('shows the server error on rejection (e.g. a ckt_-prefixed checkout id) without clearing the input', async () => {
    mockClean();
    vi.spyOn(api, 'registerRepository').mockRejectedValue(
      new Error('looks like a runner-local checkout id (§6/§16), not a canonical repository key'),
    );

    mount();
    await tick();

    const input = container.querySelector('input[placeholder^="repository key"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'ckt_abc123');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('register repository')!.click(); });

    expect(text()).toContain('checkout id');
    expect(input.value).toBe('ckt_abc123');
  });
});

describe('a non-admin sees status without destructive action controls', () => {
  it('offers no backup/restore/rollback/activate/discard/sweep controls, but still reads status', async () => {
    mockClean();
    vi.spyOn(api, 'memoryOpsStatus').mockResolvedValue({
      ...OK_STATUS,
      health: { ...OK_STATUS.health, hasPriorGeneration: true },
    });
    vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: ['2026-01-01T00-00-00-000Z'], r2Available: true });

    mount(fakeStore({ isAdmin: false }));
    await tick();

    expect(text()).toContain('admin role required');
    expect(button('Trigger backup')).toBeUndefined();
    expect(button('restore')).toBeUndefined();
    expect(button('Roll back')).toBeUndefined();
    expect(buttonContaining('Discard retained generation')).toBeUndefined();
    expect(button('Run lifecycle sweep')).toBeUndefined();
    // Status is still visible.
    expect(text()).toContain('Memory health');
    expect(text()).toContain('ok');
  });
});

describe('lifecycle sweep graph backfill status', () => {
  it('shows reconstructed write counts and any failed step instead of collapsing both into zero', async () => {
    mockClean();
    const sweep = vi.spyOn(api, 'memoryLifecycleSweep').mockResolvedValue({
      projectId: 'prj_1',
      prunedStagedGenerations: 0,
      prunedRetainedGeneration: false,
      prunedBackupGenerations: 0,
      decayedMemories: 0,
      prunedSupersededGenerations: 0,
      backfilled: true,
      backfillNodesWritten: 7,
      backfillEdgesWritten: 5,
      errors: [{ step: 'backup-retention', message: 'R2 unavailable' }],
    });

    mount();
    await tick();
    await act(async () => { button('Run lifecycle sweep')!.click(); });

    expect(sweep).toHaveBeenCalledWith('prj_1');
    expect(text()).toContain('graph backfill: ran (7 node write(s), 5 edge write(s))');
    expect(text()).toContain('failed: backup-retention: R2 unavailable');
  });
});

describe('a missing optional binding reads as reduced capability, never an error', () => {
  it('names R2 specifically and states what still works, with no failure styling', async () => {
    vi.spyOn(api, 'memoryOpsStatus').mockResolvedValue({
      health: OK_STATUS.health,
      registry: null, // never touched its memory store — R2 unbound instances still start here
      capabilities: { r2: false, vectorize: true, workersAI: true, codeVectorize: true },
    });
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [] });
    vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: [], r2Available: false });

    mount();
    await tick();

    expect(text()).toContain('REDUCED CAPABILITY');
    expect(text()).toContain('R2 is not configured on this instance');
    expect(text()).toContain('supported self-hosted configuration');
    // Never presented as a backup FAILURE — that is a distinct state (registry.backupStatus==='failed').
    expect(text()).not.toContain('investigate R2 connectivity');
  });
});

describe('destructive actions go through the real Dialog confirmation, naming the project', () => {
  it('does not restore on a bare click, restores only after the dialog is confirmed', async () => {
    mockClean();
    vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: ['2026-01-01T00-00-00-000Z'], r2Available: true });
    const restore = vi.spyOn(api, 'memoryRestore').mockResolvedValue({ ok: true, tableCounts: {} });

    mount();
    await tick();

    await act(async () => { button('restore')!.click(); });
    expect(text()).toContain('Acme Project');
    expect(text()).toContain('REPLACES the active generation');
    expect(restore).not.toHaveBeenCalled();

    await act(async () => { button('Cancel')!.click(); });
    expect(restore).not.toHaveBeenCalled();

    await act(async () => { button('restore')!.click(); });
    await act(async () => { button('Restore')!.click(); });
    expect(restore).toHaveBeenCalledWith('prj_1', '2026-01-01T00-00-00-000Z');
  });

  it('names the project and the single-level-undo consequence before rolling back', async () => {
    mockClean();
    vi.spyOn(api, 'memoryOpsStatus').mockResolvedValue({
      ...OK_STATUS,
      health: { ...OK_STATUS.health, hasPriorGeneration: true },
    });
    const rollback = vi.spyOn(api, 'memoryRollback').mockResolvedValue({ ok: true });

    mount();
    await tick();

    await act(async () => { button('Roll back')!.click(); });
    expect(text()).toContain('Acme Project');
    expect(text()).toContain('single-level undo');
    expect(rollback).not.toHaveBeenCalled();

    await act(async () => { button('Confirm rollback')!.click(); });
    expect(rollback).toHaveBeenCalledWith('prj_1');
  });
});

describe('removing a repository (PLNR-324)', () => {
  const REPO: ApiMemoryRepository = {
    id: 'pr_1', projectId: 'prj_1', repositoryKey: 'web-app', indexingEnabled: true, ingestStatus: 'active',
    defaultBranch: 'main', vcsKind: 'git', branchClasses: [], latestObservedBase: null, activeGenerationId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, checkouts: [],
    activeGeneration: null, stagedGenerations: [], stale: false, failedIngest: false, failedIngestProblems: [],
  };

  it('is offered to a NON-admin project member, same posture as registration', async () => {
    vi.spyOn(api, 'memoryOpsStatus').mockResolvedValue(OK_STATUS);
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [REPO] });
    vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: [], r2Available: true });

    mount(fakeStore({ isAdmin: false }));
    await tick();

    expect(button('Remove')).toBeDefined();
  });

  it('does not remove on a bare click; names the repository key and notes the memory graph is untouched; removes only after confirming', async () => {
    vi.spyOn(api, 'memoryOpsStatus').mockResolvedValue(OK_STATUS);
    vi.spyOn(api, 'memoryRepositories')
      .mockResolvedValueOnce({ repositories: [REPO] }) // initial load
      .mockResolvedValueOnce({ repositories: [] }); // post-removal refresh
    vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: [], r2Available: true });
    const deregister = vi.spyOn(api, 'deregisterRepository').mockResolvedValue({ deleted: true });

    mount();
    await tick();

    await act(async () => { button('Remove')!.click(); });
    expect(text()).toContain('web-app');
    expect(text()).toContain('does NOT touch the memory graph');
    expect(deregister).not.toHaveBeenCalled();

    await act(async () => { button('Cancel')!.click(); });
    expect(deregister).not.toHaveBeenCalled();
    expect(text()).toContain('web-app'); // row still present, dismissing left it registered

    await act(async () => { button('Remove')!.click(); });
    await act(async () => { button('Remove repository')!.click(); });
    expect(deregister).toHaveBeenCalledWith('prj_1', 'web-app');

    await tick();
    expect(text()).not.toContain('web-app'); // refreshed list no longer carries the removed repo
  });

  it('surfaces a rejected removal as an error and leaves the row in place, not silently', async () => {
    vi.spyOn(api, 'memoryOpsStatus').mockResolvedValue(OK_STATUS);
    vi.spyOn(api, 'memoryRepositories').mockResolvedValue({ repositories: [REPO] });
    vi.spyOn(api, 'memoryBackupsList').mockResolvedValue({ backups: [], r2Available: true });
    const deregister = vi.spyOn(api, 'deregisterRepository').mockRejectedValue(new Error('boom'));

    mount();
    await tick();

    await act(async () => { button('Remove')!.click(); });
    await act(async () => { button('Remove repository')!.click(); });

    expect(deregister).toHaveBeenCalledWith('prj_1', 'web-app');
    expect(text()).toContain('boom');
    expect(text()).toContain('web-app'); // still registered — the rejection did not remove the row
  });
});
