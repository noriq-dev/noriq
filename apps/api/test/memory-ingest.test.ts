// PLNR-260: repository-index + episode ingest endpoint coverage — capability scope enforcement,
// replay-after-complete, oversized/malformed rejection before staging, the streaming (no
// Content-Length) case, and the bounded no-R2 path (this implementation never touches R2 at
// all, so it is exercised by every test here, matching the default workerd suite environment).
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { createUser, loginSession, mintTokenForUser, authorizeForAllProjects, projectRoom, SYSTEM_ACTOR } from './helpers';
import type { Actor } from '../src/do/ProjectRoom';
import type { Env } from '../src/env';
import { gzip, sha256HexBytes } from '../src/memory/backup';
import {
  canonicalStagedRowJson, computeStagedContentHash, ingestCompletionErrorStatus,
  OrderedStagedContentHasher,
} from '../src/memory/ingest';

const appEnv = env as unknown as Env;

let ownerToken: string;
let ownerCookie: string;
let projectId: string;
let runnerId: string;

interface RepoRpc {
  registerRepository(pid: string, actor: Actor, key: string): Promise<{ id: string }>;
  associateCheckout(pid: string, actor: Actor, input: { repositoryKey: string; runnerId: string; checkoutId: string }): Promise<{ associated: boolean }>;
  deleteProject(pid: string, actor: Actor): Promise<{ ok: true }>;
}

const createProject = (cookie: string, key: string, name: string) =>
  SELF.fetch('https://noriq.test/api/projects', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name }),
  });

const register = (token: string, body: unknown) =>
  SELF.fetch('https://noriq.test/api/runners', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mintCap = (token: string, body: unknown) =>
  SELF.fetch('https://noriq.test/api/runner-ingest/capability', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const begin = (ingestToken: string, body: unknown) =>
  SELF.fetch(`https://noriq.test/api/memory-ingest/${ingestToken}/begin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

const putBatch = (ingestToken: string, n: number, bytes: Uint8Array, hash: string, extraHeaders: Record<string, string> = {}) =>
  SELF.fetch(`https://noriq.test/api/memory-ingest/${ingestToken}/batch/${n}`, {
    method: 'PUT', headers: { 'X-Batch-Hash': hash, ...extraHeaders }, body: bytes as BodyInit,
  });

const complete = (ingestToken: string) =>
  SELF.fetch(`https://noriq.test/api/memory-ingest/${ingestToken}/complete`, { method: 'POST' });

const status = (ingestToken: string) => SELF.fetch(`https://noriq.test/api/memory-ingest/${ingestToken}/status`);

async function makeBatch(rows: Array<Record<string, unknown>>) {
  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n');
  const compressed = await gzip(jsonl);
  const hash = await sha256HexBytes(compressed);
  return { bytes: compressed, hash };
}

const baseManifest = { branch: 'main', baseId: 'deadbeef', indexerVersion: 'v1', batchCount: 1, fileCount: 1, contentHash: '0'.repeat(64), createdAt: new Date(0).toISOString() };
const indexManifest = async (rows: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  ...baseManifest,
  contentHash: await computeStagedContentHash(rows as never),
  ...over,
});

beforeAll(async () => {
  await createUser('ingest-owner@example.com', 'Ingest Owner', 'longenough1', 'member').catch(() => {});
  ownerToken = await mintTokenForUser('ingest-owner@example.com');
  ownerCookie = await loginSession('ingest-owner@example.com', 'longenough1');
  const p = await createProject(ownerCookie, 'INGX', 'ingx');
  projectId = ((await p.json()) as { id: string }).id;
  await authorizeForAllProjects(ownerToken);
  await projectRoom<RepoRpc>(projectId).registerRepository(projectId, SYSTEM_ACTOR as Actor, 'ingx-repo');
  const reg = await register(ownerToken, {
    label: 'ingest-runner',
    repos: [{ id: 'ckt_ingx', projectKey: 'INGX', repositoryKey: 'ingx-repo', name: 'ingx' }],
  });
  runnerId = ((await reg.json()) as { runner: { id: string } }).runner.id;
}, 60000);

describe('bounded generation completion helpers', () => {
  it('incrementally hashes canonically ordered rows without changing the wire digest', async () => {
    const rows = [
      { kind: 'node' as const, uri: 'noriq://file/INGX/ingx-repo/a.ts', type: 'file', label: 'a.ts', content: 'const a = 1;' },
      { kind: 'node' as const, uri: 'noriq://symbol/INGX/ingx-repo/a.ts#a', type: 'symbol', label: 'a', content: null },
      { kind: 'edge' as const, type: 'declares', from: 'noriq://file/INGX/ingx-repo/a.ts', to: 'noriq://symbol/INGX/ingx-repo/a.ts#a' },
    ];
    const hasher = new OrderedStagedContentHasher();
    for (const row of rows) hasher.update(row);
    const canonical = rows.map(canonicalStagedRowJson).join('\n');
    expect(hasher.digestHex()).toBe(await sha256HexBytes(new TextEncoder().encode(canonical)));
    expect(await computeStagedContentHash([...rows].reverse())).toBe(await sha256HexBytes(new TextEncoder().encode(canonical)));
  });

  it('marks only Durable Object storage resets as retryable', () => {
    expect(ingestCompletionErrorStatus(new Error(
      'Internal error in Durable Object storage caused object to be reset; reference = reset-1',
    ))).toBe(503);
    expect(ingestCompletionErrorStatus(new Error('generation is already active'))).toBe(409);
  });
});

describe('capability minting scope', () => {
  it('refuses a repositoryKey not registered in the project', async () => {
    const res = await mintCap(ownerToken, { projectId, repositoryKey: 'no-such-repo', purpose: 'index', scopeId: 'gen_a', runnerId });
    expect(res.status).toBe(404);
  });

  it('refuses a runner not owned by this connection', async () => {
    const res = await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_b', runnerId: 'rnr_not_mine' });
    expect(res.status).toBe(404);
  });

  it('mints for a valid (project, repository, runner)', async () => {
    const res = await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_c', runnerId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; maxBytes: number };
    expect(body.token).toContain('.');
  });

  it('does not let another OAuth connection owned by the same user borrow the runner id', async () => {
    const otherToken = await mintTokenForUser('ingest-owner@example.com');
    await authorizeForAllProjects(otherToken);
    const res = await mintCap(otherToken, {
      projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_other_connection', runnerId,
    });
    expect(res.status).toBe(404);
  });

  it('a capability minted before project deletion cannot recreate memory afterward', async () => {
    const p = await createProject(ownerCookie, 'INGDEL', 'ingest deletion');
    const deletedProjectId = ((await p.json()) as { id: string }).id;
    await authorizeForAllProjects(ownerToken);
    await projectRoom<RepoRpc>(deletedProjectId).registerRepository(
      deletedProjectId, SYSTEM_ACTOR as Actor, 'deleted-repo',
    );
    await projectRoom<RepoRpc>(deletedProjectId).associateCheckout(
      deletedProjectId, SYSTEM_ACTOR as Actor,
      { repositoryKey: 'deleted-repo', runnerId, checkoutId: 'ckt_deleted' },
    );
    const capRes = await mintCap(ownerToken, {
      projectId: deletedProjectId, repositoryKey: 'deleted-repo', purpose: 'index', scopeId: 'gen_deleted', runnerId,
    });
    expect(capRes.status).toBe(200);
    const cap = await capRes.json() as { token: string };

    await projectRoom<RepoRpc>(deletedProjectId).deleteProject(deletedProjectId, SYSTEM_ACTOR as Actor);
    expect((await begin(cap.token, { ...baseManifest, generationId: 'gen_deleted' })).status).toBe(401);
  });
});

describe('index generation ingest — full flow', () => {
  it('begins, uploads one batch, completes, and reports status', async () => {
    const rows = [{ kind: 'node', uri: 'noriq://file/INGX/ingx-repo/a.ts', type: 'file', label: 'a.ts' }];
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_full', runnerId })).json() as { token: string };
    expect((await begin(cap.token, await indexManifest(rows, { generationId: 'gen_full' }))).status).toBe(200);
    const { bytes, hash } = await makeBatch(rows);
    const putRes = await putBatch(cap.token, 0, bytes, hash);
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ ok: true, deduped: false });
    const completeRes = await complete(cap.token);
    expect(completeRes.status).toBe(200);
    expect(await completeRes.json()).toMatchObject({ ok: true, batchesReceived: 1, validation: { ok: true, problems: [] }, activation: { activated: 'gen_full' } });
    const st = await (await status(cap.token)).json() as { status: string; sealed: boolean; batchesReceived: number; batchesExpected: number };
    expect(st).toEqual({ status: 'active', sealed: true, batchesReceived: 1, batchesExpected: 1, validation: { ok: true, problems: [] } });
  });

  it('re-uploading the SAME batch of an in-flight generation is harmless and converges', async () => {
    const rows = [{ kind: 'node', uri: 'noriq://file/INGX/ingx-repo/x.ts', type: 'file', label: 'x.ts' }];
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_replay', runnerId })).json() as { token: string };
    await begin(cap.token, await indexManifest(rows, { generationId: 'gen_replay', batchCount: 2 }));
    const { bytes, hash } = await makeBatch(rows);
    const first = await (await putBatch(cap.token, 0, bytes, hash)).json() as { deduped: boolean };
    const second = await (await putBatch(cap.token, 0, bytes, hash)).json() as { deduped: boolean };
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
  });

  it('presenting a capability for a purpose that already completed is refused explicitly, not silently absorbed', async () => {
    const rows = [{ kind: 'node', uri: 'noriq://file/INGX/ingx-repo/x.ts', type: 'file', label: 'x.ts' }];
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_done', runnerId })).json() as { token: string };
    await begin(cap.token, await indexManifest(rows, { generationId: 'gen_done', batchCount: 1 }));
    const { bytes, hash } = await makeBatch(rows);
    await putBatch(cap.token, 0, bytes, hash);
    await complete(cap.token);
    // Same capability, same batch, after completion — refused, not idempotently accepted.
    const res = await putBatch(cap.token, 0, bytes, hash);
    expect(res.status).toBe(409);
  });

  it('a batch whose checksum does not match is rejected before its rows are parsed', async () => {
    const rows = [{ kind: 'node', uri: 'noriq://file/INGX/ingx-repo/x.ts', type: 'file', label: 'x.ts' }];
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_bad_hash', runnerId })).json() as { token: string };
    await begin(cap.token, await indexManifest(rows, { generationId: 'gen_bad_hash' }));
    const { bytes } = await makeBatch(rows);
    const res = await putBatch(cap.token, 0, bytes, 'deadbeef'.repeat(8));
    expect(res.status).toBe(413);
    const st = await (await status(cap.token)).json() as { batchesReceived: number };
    expect(st.batchesReceived).toBe(0); // nothing landed
  });

  it('an oversized batch is rejected — even streamed with no Content-Length', async () => {
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_oversized', runnerId, maxBytes: 32 })).json() as { token: string };
    await begin(cap.token, await indexManifest([], { generationId: 'gen_oversized' }));
    const big = new Uint8Array(1000).fill(65);
    const hash = await sha256HexBytes(big);
    // A Response body is a stream with no Content-Length header, mirroring the PLNR-98 technique.
    const stream = new Response(big).body!;
    const res = await SELF.fetch(`https://noriq.test/api/memory-ingest/${cap.token}/batch/0`, {
      method: 'PUT', headers: { 'X-Batch-Hash': hash }, body: stream, duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it('a forged repositoryKey/projectId/generationId in the begin body cannot smuggle a different scope — the token\'s own claims always win', async () => {
    await projectRoom<RepoRpc>(projectId).registerRepository(projectId, SYSTEM_ACTOR as Actor, 'ingx-repo-2');
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_scope', runnerId })).json() as { token: string };
    const res = await begin(cap.token, await indexManifest([], { generationId: 'attacker-chosen-id', repositoryKey: 'ingx-repo-2', projectId: 'prj_someone_else' }));
    expect(res.status).toBe(200);
    // The generation that actually landed is keyed by the TOKEN's scopeId, not the forged body —
    // status against the real scopeId reports it; the forged generationId was never created.
    expect((await (await status(cap.token)).json() as { status: string }).status).toBe('staged');
  });
});

describe('episode ingest — endpoint only (PLNR-263 owns real episode semantics)', () => {
  it('begins, uploads, completes an episode upload', async () => {
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'episode', scopeId: 'run_ep1', runnerId })).json() as { token: string };
    expect((await begin(cap.token, { batchCount: 1 })).status).toBe(200);
    const { bytes, hash } = await makeBatch([{ kind: 'episode', runId: 'run_ep1' }]);
    expect((await putBatch(cap.token, 0, bytes, hash)).status).toBe(200);
    expect((await complete(cap.token)).status).toBe(200);
  });

  it('resuming an interrupted begin (same scopeId, not yet completed) is idempotent, not an error', async () => {
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'episode', scopeId: 'run_ep2', runnerId })).json() as { token: string };
    expect((await begin(cap.token, { batchCount: 1 })).status).toBe(200);
    expect((await begin(cap.token, { batchCount: 1 })).status).toBe(200);
  });

  it('presenting an episode capability for a purpose that already completed is refused', async () => {
    const cap = await (await mintCap(ownerToken, { projectId, repositoryKey: 'ingx-repo', purpose: 'episode', scopeId: 'run_ep3', runnerId })).json() as { token: string };
    await begin(cap.token, { batchCount: 1 });
    const { bytes, hash } = await makeBatch([{ kind: 'episode' }]);
    await putBatch(cap.token, 0, bytes, hash);
    await complete(cap.token);
    expect((await putBatch(cap.token, 0, bytes, hash)).status).toBe(409);
  });
});

describe('cross-purpose and cross-project token refusal', () => {
  it('an invalid/garbage token is refused on every route', async () => {
    expect((await begin('not-a-real-token', {})).status).toBe(401);
    expect((await status('not-a-real-token')).status).toBe(401);
  });

  it('revokes an already-minted capability when its exact checkout association disappears', async () => {
    const capRes = await mintCap(ownerToken, {
      projectId, repositoryKey: 'ingx-repo', purpose: 'index', scopeId: 'gen_lost_checkout', runnerId,
    });
    expect(capRes.status).toBe(200);
    const cap = await capRes.json() as { token: string };
    await appEnv.DB.prepare('DELETE FROM repository_checkouts WHERE runner_id = ? AND checkout_id = ?')
      .bind(runnerId, 'ckt_ingx').run();
    expect((await begin(cap.token, await indexManifest([], { generationId: 'gen_lost_checkout' }))).status).toBe(401);
    await projectRoom<RepoRpc>(projectId).associateCheckout(
      projectId, SYSTEM_ACTOR as Actor,
      { repositoryKey: 'ingx-repo', runnerId, checkoutId: 'ckt_ingx' },
    );
  });
});
