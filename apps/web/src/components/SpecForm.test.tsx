// RUN-161: the structured spec editor.
//
// RUN-137 shipped a JSON textarea and defended it with a claim that a form could not express locked
// decisions and links. That was false, and these are the properties a form has to hold to be an
// improvement rather than a rewrite: a non-author can fill it in, a blank row cannot become a
// stored one, and nothing the JSON editor did for correctness is lost.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionSpec } from '@noriq-dev/shared';
import { SpecForm, pruneDraft } from './SpecForm';

let container: HTMLDivElement;

const draft = (over: Partial<ExecutionSpec> = {}): ExecutionSpec => ({
  requirementIds: [],
  anticipatedFiles: [],
  requiredReading: [],
  lockedDecisions: [],
  discretion: [],
  deferred: [],
  acceptance: { observableTruths: [], artifacts: [], links: [] },
  ...over,
});

function mount(props: Partial<Parameters<typeof SpecForm>[0]> = {}) {
  const onChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() =>
    createRoot(container).render(
      <SpecForm
        draft={draft()}
        onChange={onChange}
        onSave={() => {}}
        onCancel={() => {}}
        onClear={() => {}}
        saving={false}
        error=""
        canClear={false}
        {...props}
      />,
    ),
  );
  return { onChange };
}
const text = () => container.textContent ?? '';
const buttons = (label: string) =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes(label));
afterEach(() => container?.remove());

describe('what a non-author can see without knowing the schema', () => {
  it('labels every field in words, not camelCase', () => {
    mount();
    for (const label of [
      'Requirements',
      'Anticipated files',
      'Required reading',
      'Locked decisions',
      'Yours to decide',
      'Explicitly out of scope',
      'Done when these are true',
      'Expected artifacts',
      'Wiring',
    ]) {
      expect(text()).toContain(label);
    }
    // …and none of the field names a JSON editor made you already know.
    expect(text()).not.toContain('observableTruths');
    expect(text()).not.toContain('anticipatedFiles');
  });

  // The distinction that decides whether acceptance criteria are worth anything.
  it('says what a truth is, since that is the field people get wrong', () => {
    mount();
    expect(text()).toMatch(/Truths, not steps/);
  });

  it('warns that saving replaces the whole spec', () => {
    mount();
    expect(text()).toMatch(/REPLACES the whole spec/);
  });
});

describe('editing', () => {
  it('adds a row and reports the change', () => {
    const { onChange } = mount({ draft: draft() });
    act(() => buttons('+ add')[0]!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ requirementIds: [''] }));
  });

  it('removes the row it was asked to, not the last one', () => {
    const { onChange } = mount({ draft: draft({ requirementIds: ['a', 'b', 'c'] }) });
    act(() => buttons('✕')[1]!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ requirementIds: ['a', 'c'] }));
  });

  // The field a form can express and the first cut claimed it could not.
  it('edits a locked decision’s reasoning, not just its text', () => {
    const { onChange } = mount({ draft: draft({ lockedDecisions: [{ decision: 'ESM only', because: '', source: '' }] }) });
    const inputs = [...container.querySelectorAll('input')];
    const because = inputs.find((i) => i.placeholder === 'because…')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(because, 'the whole repo is');
      because.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ lockedDecisions: [{ decision: 'ESM only', because: 'the whole repo is', source: '' }] }),
    );
  });

  it('offers the three change kinds as a choice rather than free text', () => {
    mount({ draft: draft({ anticipatedFiles: [{ path: 'src/a.ts', change: 'modify', why: '' }] }) });
    const select = container.querySelector('select')!;
    expect([...select.options].map((o) => o.value)).toEqual(['create', 'modify', 'delete']);
  });

  it('shows Clear only when there is something to clear', () => {
    mount({ canClear: false });
    expect(buttons('Clear')).toHaveLength(0);
    container.remove();
    mount({ canClear: true });
    expect(buttons('Clear')).toHaveLength(1);
  });
});

// A form makes empty rows easy to create by accident. An anticipated file with no path is a row
// the contract refuses and a reader puzzles at.
describe('pruning what a human left blank', () => {
  it('drops blank strings and whitespace-only ones', () => {
    const out = pruneDraft(draft({ requirementIds: ['R-1', '', '   '], discretion: ['  naming  '] }));
    expect(out.requirementIds).toEqual(['R-1']);
    expect(out.discretion).toEqual(['naming']);
  });

  it('drops an anticipated file with no path, and an artifact with none', () => {
    const out = pruneDraft(
      draft({
        anticipatedFiles: [
          { path: '', change: 'modify', why: 'a row somebody started' },
          { path: ' src/a.ts ', change: 'create', why: '' },
        ],
        acceptance: { observableTruths: [], artifacts: [{ path: '', provides: 'x', exports: [] }], links: [] },
      }),
    );
    expect(out.anticipatedFiles).toEqual([{ path: 'src/a.ts', change: 'create', why: '' }]);
    expect(out.acceptance.artifacts).toEqual([]);
  });

  it('drops a decision with no decision, and a link missing either end', () => {
    const out = pruneDraft(
      draft({
        lockedDecisions: [{ decision: '', because: 'orphaned reasoning', source: '' }],
        acceptance: {
          observableTruths: [],
          artifacts: [],
          links: [
            { from: 'a', to: '', via: '' },
            { from: 'a', to: 'b', via: 'import' },
          ],
        },
      }),
    );
    expect(out.lockedDecisions).toEqual([]);
    expect(out.acceptance.links).toEqual([{ from: 'a', to: 'b', via: 'import' }]);
  });

  it('keeps a complete row untouched', () => {
    const full = draft({
      requirementIds: ['R'],
      anticipatedFiles: [{ path: 'src/a.ts', change: 'delete', why: 'gone' }],
    });
    expect(pruneDraft(full)).toEqual(full);
  });
});

// JSON stays available: it is the fastest way to paste a spec an agent produced, and a form nobody
// can escape is its own kind of trap.
describe('the advanced JSON mode', () => {
  const openJson = () => act(() => buttons('edit as JSON')[0]!.click());

  it('is reachable, and shows the current draft', () => {
    mount({ draft: draft({ discretion: ['naming'] }) });
    openJson();
    expect(container.querySelector('textarea')!.value).toContain('naming');
  });

  it('loads a paste back into the FORM rather than saving it blind', () => {
    const { onChange } = mount();
    openJson();
    const t = container.querySelector('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(t, '{"requirementIds":["PASTED"]}');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => buttons('Load into the form')[0]!.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ requirementIds: ['PASTED'] }));
  });

  it('keeps invalid JSON in the box instead of discarding what was typed', () => {
    const { onChange } = mount();
    openJson();
    const t = container.querySelector('textarea')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(t, '{not json');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => buttons('Load into the form')[0]!.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')!.value).toBe('{not json');
  });
});
