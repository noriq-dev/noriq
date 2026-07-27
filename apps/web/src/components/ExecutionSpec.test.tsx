// RUN-137: the execution spec panel. A spec a human cannot read or correct is a spec they cannot
// trust, and the three states it has to keep distinct are the whole point: a real spec, no spec,
// and a stored spec that could not be read.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionSpec } from '@noriq-dev/shared';
import { ExecutionSpecPanel } from './ExecutionSpec';
import { api } from '../api';
import { DialogHost, confirm as _confirm } from './Dialog';

let container: HTMLDivElement;

const spec = (over: Partial<ExecutionSpec> = {}): ExecutionSpec => ({
  requirementIds: [],
  anticipatedFiles: [],
  requiredReading: [],
  lockedDecisions: [],
  discretion: [],
  deferred: [],
  acceptance: { observableTruths: [], artifacts: [], links: [] },
  ...over,
});

function mount(props: Partial<Parameters<typeof ExecutionSpecPanel>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() =>
    createRoot(container).render(
      <>
        <ExecutionSpecPanel pid="prj_1" taskId="task_1" spec={null} onSaved={() => {}} {...props} />
        {/* Clear goes through the confirm() singleton — destructive and irreversible. */}
        <DialogHost />
      </>,
    ),
  );
}
const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
const textarea = () => container.querySelector('textarea')!;
const type = async (value: string) =>
  act(async () => {
    const t = textarea();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(t, value);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => vi.restoreAllMocks());
afterEach(() => container?.remove());

describe('reading a spec', () => {
  it('renders every populated section, and none of the empty ones', () => {
    mount({
      spec: spec({
        requirementIds: ['RUN-137'],
        anticipatedFiles: [{ path: 'src/a.ts', change: 'create', why: 'the panel' }],
        lockedDecisions: [{ decision: 'JSON editor, not a form', because: 'a form cannot express links', source: 'RUN-137' }],
        acceptance: {
          observableTruths: ['a human can correct a wrong scope'],
          artifacts: [{ path: 'src/b.ts', provides: 'the panel', exports: ['ExecutionSpecPanel'] }],
          links: [{ from: 'Drawer.tsx', to: 'ExecutionSpec.tsx', via: 'import' }],
        },
      }),
    });
    expect(text()).toContain('RUN-137');
    expect(text()).toContain('src/a.ts');
    expect(text()).toContain('create');
    expect(text()).toContain('JSON editor, not a form');
    expect(text()).toContain('because a form cannot express links');
    expect(text()).toContain('a human can correct a wrong scope');
    expect(text()).toContain('exports ExecutionSpecPanel');
    expect(text()).toContain('Drawer.tsx → ExecutionSpec.tsx');
    // Sections with nothing in them are absent, not empty-headed.
    expect(text()).not.toContain('Required reading');
    expect(text()).not.toContain('Yours to decide');
  });

  it('says what having no spec COSTS, rather than just saying "none"', () => {
    mount({ spec: null });
    expect(text()).toContain('No spec');
    expect(text()).toMatch(/works out its scope/);
    expect(button('+ add spec')).toBeTruthy();
  });

  // A spec that exists and says nothing is unplanned, exactly as `hasExecutionSpec` reads it
  // server-side — otherwise the panel claims a plan it has not got.
  it('treats a present-but-empty spec as no spec', () => {
    mount({ spec: spec() });
    expect(text()).toContain('No spec');
    expect(button('+ add spec')).toBeTruthy();
  });
});

// The state this panel exists to keep separate. Absence reads as permission to re-plan; corruption
// must not.
describe('an unreadable stored spec', () => {
  it('warns loudly and does not present as an empty spec', () => {
    mount({ spec: null, unreadable: true });
    expect(text()).toContain('Stored spec is unreadable');
    expect(text()).toContain('not the same as having no spec');
    expect(text()).not.toContain('No spec.');
  });

  // "+ add spec" would be a lie: there IS something stored, and the job is to replace it.
  it('offers a rewrite rather than an add', () => {
    mount({ spec: null, unreadable: true });
    expect(button('rewrite')).toBeTruthy();
    expect(button('+ add spec')).toBeUndefined();
  });

  it('offers Clear even though the spec reads as empty, so a corrupt row can be dropped', async () => {
    const update = vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
    mount({ spec: null, unreadable: true });
    await act(async () => button('rewrite')!.click());
    await act(async () => button('Clear')!.click());
    await act(async () => button('Confirm')!.click());
    expect(update).toHaveBeenCalledWith('prj_1', 'task_1', { executionSpec: null });
  });
});

describe('correcting a spec', () => {
  it('seeds the editor with the current spec and saves what was typed', async () => {
    const update = vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
    const onSaved = vi.fn();
    mount({ spec: spec({ discretion: ['naming'] }), onSaved });

    await act(async () => button('edit')!.click());
    expect(textarea().value).toContain('"discretion"');
    expect(textarea().value).toContain('naming');

    await act(async () => {
      const t = textarea();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(t, '{"requirementIds":["EDITED"]}');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save spec')!.click());

    expect(update).toHaveBeenCalledWith('prj_1', 'task_1', { executionSpec: { requirementIds: ['EDITED'] } });
    expect(onSaved).toHaveBeenCalled();
  });

  it('refuses to send invalid JSON, and says so without losing the draft', async () => {
    const update = vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
    mount({ spec: spec({ discretion: ['naming'] }) });
    await act(async () => button('edit')!.click());
    await act(async () => {
      const t = textarea();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(t, '{not json');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save spec')!.click());

    expect(update).not.toHaveBeenCalled();
    expect(text()).toContain('not valid JSON');
    expect(textarea().value).toBe('{not json'); // the draft survives the error
  });

  // The server owns the shape (a path that leaves the repo, an unknown change kind). Its message
  // is more specific than anything worth re-deriving here, so it is shown raw.
  it('surfaces the server’s rejection verbatim and stays in the editor', async () => {
    vi.spyOn(api, 'updateTask').mockRejectedValue(new Error('must not contain a `..` segment'));
    mount({ spec: null });
    await act(async () => button('+ add spec')!.click());
    await act(async () => {
      const t = textarea();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(t, '{"anticipatedFiles":[{"path":"../x"}]}');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save spec')!.click());

    expect(text()).toContain('must not contain a `..` segment');
    expect(textarea()).toBeTruthy(); // still editing, so the draft can be fixed
  });

  it('clears with an explicit null, which is how a spec is removed', async () => {
    const update = vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
    mount({ spec: spec({ discretion: ['naming'] }) });
    await act(async () => button('edit')!.click());
    await act(async () => button('Clear')!.click());
    await act(async () => button('Confirm')!.click());
    expect(update).toHaveBeenCalledWith('prj_1', 'task_1', { executionSpec: null });
  });

  it('does not clear when the confirmation is declined', async () => {
    const update = vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
    mount({ spec: spec({ discretion: ['naming'] }) });
    await act(async () => button('edit')!.click());
    await act(async () => button('Clear')!.click());
    await act(async () => button('Cancel')!.click());
    expect(update).not.toHaveBeenCalled();
  });

  it('offers no Clear when there is nothing to clear', async () => {
    mount({ spec: null });
    await act(async () => button('+ add spec')!.click());
    expect(button('Clear')).toBeUndefined();
  });

  it('warns that saving replaces the whole spec', async () => {
    mount({ spec: spec({ discretion: ['naming'] }) });
    await act(async () => button('edit')!.click());
    expect(text()).toContain('REPLACES the whole spec');
  });
});

// "we do not know yet" and "we could not ask" are NOT "there is no spec". Collapsing them is what
// makes a human click "+ add spec" on a task that already has one and overwrite it with `{}`.
describe('not knowing yet', () => {
  it('shows nothing conclusive while loading, and offers no editor', () => {
    mount({ load: 'loading', spec: null });
    expect(text()).toContain('loading');
    expect(text()).not.toContain('No spec');
    expect(button('+ add spec')).toBeUndefined();
  });

  it('says the read failed rather than claiming the task is unplanned', () => {
    mount({ load: 'error', spec: null });
    expect(text()).toMatch(/Could not load/);
    expect(text()).toMatch(/may or may not have one/);
    expect(text()).not.toContain('No spec');
    expect(button('+ add spec')).toBeUndefined();
  });
});

// zod strips unknown keys, so a misspelled field saves cleanly and then is not there. The server
// cannot catch it; the editor has to.
describe('guarding the edit against the schema it cannot see', () => {
  it('names misspelled fields instead of letting them be silently dropped', async () => {
    const update = vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
    mount({ spec: null });
    await act(async () => button('+ add spec')!.click());
    await type('{"requirementID":["X"],"lockedDecision":[]}');
    await act(async () => button('Save spec')!.click());

    expect(update).not.toHaveBeenCalled();
    expect(text()).toContain('requirementID');
    expect(text()).toContain('lockedDecision');
    expect(text()).toContain('would be dropped');
  });

  it('refuses an array or a scalar, which are valid JSON and not specs', async () => {
    const update = vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
    mount({ spec: null });
    await act(async () => button('+ add spec')!.click());
    await type('[]');
    await act(async () => button('Save spec')!.click());
    expect(update).not.toHaveBeenCalled();
    expect(text()).toContain('a spec is a JSON object');
  });
});

// Errors are rendered inside the editor, so closing it before the refresh lands would leave a
// failed reload showing stale content with no explanation.
describe('a save whose refresh fails', () => {
  it('keeps the editor open and shows why', async () => {
    vi.spyOn(api, 'updateTask').mockResolvedValue({ ok: true } as never);
    mount({ spec: null, onSaved: () => { throw new Error('refresh failed'); } });
    await act(async () => button('+ add spec')!.click());
    await type('{"discretion":["x"]}');
    await act(async () => button('Save spec')!.click());
    expect(textarea()).toBeTruthy();
    expect(text()).toContain('refresh failed');
  });
});

// Editing after the work started is legitimate — a human correcting a genuinely wrong scope — but
// it changes what a reviewer judges against, and nothing tells the agent it moved.
describe('a task already under way', () => {
  it('warns before the human edits a contract someone is already working to', () => {
    mount({ spec: spec({ discretion: ['naming'] }), inFlight: true });
    expect(text()).toMatch(/already under way/);
    expect(text()).toMatch(/changes what a reviewer will judge against/);
  });

  it('says nothing when there is no contract to move', () => {
    mount({ spec: null, inFlight: true });
    expect(text()).not.toMatch(/already under way/);
  });
});
