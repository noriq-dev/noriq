import { describe, expect, it } from 'vitest';
import { projectActionForRequest } from '../src/lib/rest-project-access';

describe('projectActionForRequest (human go/no-go vs manager)', () => {
  it('classifies proposed-plan approve/reject as contribute — not manage', () => {
    expect(projectActionForRequest('POST', '/api/projects/prj_x/plans/pln_y/approve')).toBe('contribute');
    expect(projectActionForRequest('POST', '/api/projects/prj_x/plans/pln_y/reject')).toBe('contribute');
  });

  it('keeps plan dispatch and memory decision approve as manage', () => {
    expect(projectActionForRequest('POST', '/api/projects/prj_x/plans/pln_y/dispatch')).toBe('manage');
    expect(projectActionForRequest('POST', '/api/projects/prj_x/memory/items/mem_y/approve')).toBe('manage');
  });

  it('classifies task proposal accept/reject as contribute', () => {
    expect(projectActionForRequest('POST', '/api/projects/prj_x/tasks/task_y/proposal/accept')).toBe('contribute');
    expect(projectActionForRequest('POST', '/api/projects/prj_x/tasks/task_y/proposal/reject')).toBe('contribute');
  });
});
