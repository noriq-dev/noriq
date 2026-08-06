// PLNR-260: unit coverage for the upload-token primitive — none existed before this task, for
// EITHER flavour. Expiry is tested via an injected `nowSec`, never a mocked clock (sign/verify
// take it explicitly precisely so this is possible).
import { describe, expect, it } from 'vitest';
import {
  signUploadToken, verifyUploadToken, signIngestToken, verifyIngestToken,
  type AttachmentUploadClaims, type IngestClaims,
} from '../src/lib/upload-token';

const SECRET = 'test-secret-abc';
const OTHER_SECRET = 'a-different-secret';

const attachmentClaims = (over: Partial<AttachmentUploadClaims> = {}): AttachmentUploadClaims => ({
  typ: 'attachment', aid: 'att_1', tid: 'task_1', pid: 'prj_1', fn: 'f.png', ct: 'image/png',
  agentId: 'agt_1', max: 1000, exp: 1_700_000_000, ...over,
});

const ingestClaims = (over: Partial<IngestClaims> = {}): IngestClaims => ({
  typ: 'ingest', pid: 'prj_1', repositoryKey: 'repo-one', purpose: 'index', scopeId: 'gen_1',
  runnerId: 'rnr_1', max: 1000, exp: 1_700_000_000, ...over,
});

describe('attachment upload token', () => {
  it('round-trips claims', async () => {
    const token = await signUploadToken(SECRET, attachmentClaims());
    const claims = await verifyUploadToken(SECRET, token, 1_600_000_000);
    expect(claims).toEqual(attachmentClaims());
  });

  it('rejects an expired token via an injected nowSec, not a mocked clock', async () => {
    const token = await signUploadToken(SECRET, attachmentClaims({ exp: 1000 }));
    expect(await verifyUploadToken(SECRET, token, 1001)).toBeNull();
    expect(await verifyUploadToken(SECRET, token, 999)).not.toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signUploadToken(OTHER_SECRET, attachmentClaims());
    expect(await verifyUploadToken(SECRET, token, 1_600_000_000)).toBeNull();
  });

  it('rejects a token whose signature was altered by one character, with the same flat error as a malformed one', async () => {
    const token = await signUploadToken(SECRET, attachmentClaims());
    const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
    expect(await verifyUploadToken(SECRET, tampered, 1_600_000_000)).toBeNull();
    expect(await verifyUploadToken(SECRET, 'not-a-real-token', 1_600_000_000)).toBeNull();
  });
});

describe('ingest capability token', () => {
  it('round-trips claims', async () => {
    const token = await signIngestToken(SECRET, ingestClaims());
    expect(await verifyIngestToken(SECRET, token, 1_600_000_000)).toEqual(ingestClaims());
  });

  it('rejects an expired token via injected nowSec', async () => {
    const token = await signIngestToken(SECRET, ingestClaims({ exp: 1000 }));
    expect(await verifyIngestToken(SECRET, token, 1001)).toBeNull();
    expect(await verifyIngestToken(SECRET, token, 999)).not.toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signIngestToken(OTHER_SECRET, ingestClaims());
    expect(await verifyIngestToken(SECRET, token, 1_600_000_000)).toBeNull();
  });
});

describe('cross-purpose (typ) rejection — mutual, both directions', () => {
  it('an attachment token is refused by ingest verification', async () => {
    const token = await signUploadToken(SECRET, attachmentClaims());
    expect(await verifyIngestToken(SECRET, token, 1_600_000_000)).toBeNull();
  });

  it('an ingest token is refused by attachment verification', async () => {
    const token = await signIngestToken(SECRET, ingestClaims());
    expect(await verifyUploadToken(SECRET, token, 1_600_000_000)).toBeNull();
  });
});
