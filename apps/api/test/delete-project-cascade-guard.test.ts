// PLNR-560: every D1 table carrying project_id must be covered by deleteProject.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { findDeleteProjectCoverageGaps } from '../src/do/project-room/delete-project';

describe('deleteProject cascade guard (PLNR-560)', () => {
  it('covers every project-scoped D1 table', async () => {
    const gaps = await findDeleteProjectCoverageGaps(env.DB);
    expect(gaps, gaps.join('\n')).toEqual([]);
  });
});
