// RUN-161: the structured editor for an execution spec.
//
// RUN-137 shipped a JSON textarea and called it the human's lever on the pre-execution gate. It was
// a developer escape hatch: it gave the lever to someone who already knew the schema — camelCase
// field names, the nesting under `acceptance`, which fields are arrays of objects, and that saving
// replaces the whole document. A non-author reading a wrong scope could not correct it.
//
// Nothing in the schema resists a form; the claim that it did was wrong when it was written. Every
// field is either a list of strings or a list of small objects, so this is five repeaters and one
// select. JSON stays available as an advanced mode, because it is genuinely the fastest way to
// paste a spec an agent produced, and it round-trips.
//
// What the JSON editor did that a form must not lose, and does not:
//   - unknown field names are impossible rather than silently dropped (there is nowhere to type
//     one, which is a stronger version of RUN-137's warning);
//   - the server's rejection is shown verbatim — it owns the shape, and its message about a path
//     that leaves the repo is more specific than anything worth re-deriving here;
//   - the editor stays open when a save or its refresh fails, so the work is not lost;
//   - clearing is confirmed;
//   - editing a task that is already under way says so.
import { useState } from 'react';
import type { ExecutionSpec } from '@noriq-dev/shared';
import { Button, Select, TextArea, TextInput } from './ui';

/** A spec as the FORM holds it: every field present, so no row has to reason about absence. */
export type SpecDraft = ExecutionSpec;

const field: React.CSSProperties = { fontSize: 11.5, padding: '5px 8px' };
const rowBox: React.CSSProperties = {
  border: '1px solid var(--w-08)',
  borderRadius: 7,
  padding: '7px 9px',
  background: 'var(--w-02)',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
};

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
        {children}
      </div>
      {hint && <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="remove"
      style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--red-soft)', fontFamily: 'var(--mono)', fontSize: 10 }}
    >
      ✕
    </button>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rail-add"
      style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', border: '1px dashed var(--w-15)', padding: '3px 9px', borderRadius: 6, background: 'transparent', alignSelf: 'flex-start' }}
    >
      {children}
    </button>
  );
}

/** A list of plain strings — requirementIds, requiredReading, discretion, deferred, truths. */
function StringList({
  label,
  hint,
  placeholder,
  items,
  onChange,
}: {
  label: string;
  hint?: string;
  placeholder: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const set = (i: number, v: string) => onChange(items.map((x, j) => (j === i ? v : x)));
  return (
    <div style={{ marginBottom: 12 }}>
      <Label hint={hint}>{label}</Label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map((v, i) => (
          // Index keys: these rows are positional and the schema enforces no uniqueness, so a
          // value key would collide on two identical entries — which is valid data.
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <TextInput value={v} placeholder={placeholder} onChange={(e) => set(i, e.target.value)} style={{ ...field, flex: 1 }} />
            <RemoveButton onClick={() => onChange(items.filter((_, j) => j !== i))} />
          </div>
        ))}
        <AddButton onClick={() => onChange([...items, ''])}>+ add</AddButton>
      </div>
    </div>
  );
}

/** A list of objects, rendered by a caller-supplied row. */
function ObjectList<T>({
  label,
  hint,
  items,
  blank,
  onChange,
  row,
}: {
  label: string;
  hint?: string;
  items: T[];
  blank: () => T;
  onChange: (next: T[]) => void;
  row: (item: T, set: (patch: Partial<T>) => void) => React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Label hint={hint}>{label}</Label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} style={rowBox}>
            {row(item, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}
            <div style={{ display: 'flex' }}>
              <div style={{ flex: 1 }} />
              <RemoveButton onClick={() => onChange(items.filter((_, j) => j !== i))} />
            </div>
          </div>
        ))}
        <AddButton onClick={() => onChange([...items, blank()])}>+ add</AddButton>
      </div>
    </div>
  );
}

export function SpecForm({
  draft,
  onChange,
  onSave,
  onCancel,
  onClear,
  saving,
  error,
  canClear,
}: {
  draft: SpecDraft;
  onChange: (next: SpecDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onClear: () => void;
  saving: boolean;
  error: string;
  canClear: boolean;
}) {
  // JSON stays available, because it is the fastest way to paste a spec an agent produced — and
  // because a form nobody can escape is its own kind of trap.
  const [json, setJson] = useState<string | null>(null);
  const acc = draft.acceptance;
  const setAcc = (patch: Partial<SpecDraft['acceptance']>) =>
    onChange({ ...draft, acceptance: { ...acc, ...patch } });

  const applyJson = () => {
    try {
      const parsed = JSON.parse(json ?? '');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      // Merged onto the current draft rather than replacing it, so a paste that omits a field
      // leaves what the form already holds instead of quietly emptying it. Save is what replaces.
      onChange({ ...draft, ...(parsed as Partial<SpecDraft>), acceptance: { ...acc, ...((parsed as SpecDraft).acceptance ?? {}) } });
      setJson(null);
    } catch {
      // Left in the box for the user to fix — the same rule the rest of this form follows.
    }
  };

  if (json !== null) {
    return (
      <div>
        <TextArea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          spellCheck={false}
          style={{ fontFamily: 'var(--mono)', fontSize: 11, minHeight: 200, lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
          <Button onClick={applyJson}>Load into the form</Button>
          <Button variant="ghost" onClick={() => setJson(null)}>Back</Button>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
          Loads into the fields above so you can see what you pasted before it is saved. Fields you
          leave out keep what the form already has.
        </div>
      </div>
    );
  }

  return (
    <div>
      <StringList
        label="Requirements"
        hint="What this satisfies — task keys, or an external tracker's ids."
        placeholder="RUN-161"
        items={draft.requirementIds}
        onChange={(requirementIds) => onChange({ ...draft, requirementIds })}
      />

      <ObjectList
        label="Anticipated files"
        hint="The paths the work is expected to touch. Repo-relative, / separators, no `..`."
        items={draft.anticipatedFiles}
        blank={() => ({ path: '', change: 'modify' as const, why: '' })}
        onChange={(anticipatedFiles) => onChange({ ...draft, anticipatedFiles })}
        row={(f, set) => (
          <>
            <div style={{ display: 'flex', gap: 5 }}>
              <TextInput value={f.path} placeholder="src/thing.ts" onChange={(e) => set({ path: e.target.value })} style={{ ...field, flex: 1 }} />
              <Select value={f.change} onChange={(e) => set({ change: e.target.value as typeof f.change })} style={{ ...field, width: 92 }}>
                <option value="create">create</option>
                <option value="modify">modify</option>
                <option value="delete">delete</option>
              </Select>
            </div>
            <TextInput value={f.why} placeholder="why this file is in scope" onChange={(e) => set({ why: e.target.value })} style={field} />
          </>
        )}
      />

      <StringList
        label="Required reading"
        hint="Repo paths or Noriq doc ids, in the order they help."
        placeholder="THREAT-MODEL.md  ·  doc_xxx"
        items={draft.requiredReading}
        onChange={(requiredReading) => onChange({ ...draft, requiredReading })}
      />

      <ObjectList
        label="Locked decisions"
        hint="Already settled — the builder must not relitigate these. Give the reasoning: an agent that knows why can tell when a case falls outside it."
        items={draft.lockedDecisions}
        blank={() => ({ decision: '', because: '', source: '' })}
        onChange={(lockedDecisions) => onChange({ ...draft, lockedDecisions })}
        row={(d, set) => (
          <>
            <TextInput value={d.decision} placeholder="what is settled" onChange={(e) => set({ decision: e.target.value })} style={field} />
            <TextInput value={d.because} placeholder="because…" onChange={(e) => set({ because: e.target.value })} style={field} />
            <TextInput value={d.source} placeholder="where it was settled (doc id, task key, URL)" onChange={(e) => set({ source: e.target.value })} style={field} />
          </>
        )}
      />

      <StringList
        label="Yours to decide"
        hint="Say it out loud — without this, an agent reads every gap as an oversight."
        placeholder="which library to use for X"
        items={draft.discretion}
        onChange={(discretion) => onChange({ ...draft, discretion })}
      />

      <StringList
        label="Explicitly out of scope"
        hint="What stops the work growing, and stops a reviewer flagging a known gap."
        placeholder="the migration — that is its own task"
        items={draft.deferred}
        onChange={(deferred) => onChange({ ...draft, deferred })}
      />

      <StringList
        label="Done when these are true"
        hint="Truths, not steps. “a dispatch with no spec still runs” is a truth; “run the tests” is a step."
        placeholder="a task with no spec still dispatches"
        items={acc.observableTruths}
        onChange={(observableTruths) => setAcc({ observableTruths })}
      />

      <ObjectList
        label="Expected artifacts"
        hint="What must exist when it is done, and what it must offer."
        items={acc.artifacts}
        blank={() => ({ path: '', provides: '', exports: [] })}
        onChange={(artifacts) => setAcc({ artifacts })}
        row={(a, set) => (
          <>
            <TextInput value={a.path} placeholder="src/thing.ts" onChange={(e) => set({ path: e.target.value })} style={field} />
            <TextInput value={a.provides} placeholder="what it is for" onChange={(e) => set({ provides: e.target.value })} style={field} />
            <TextInput
              value={a.exports.join(', ')}
              placeholder="exported symbols, comma separated"
              onChange={(e) => set({ exports: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
              style={field}
            />
          </>
        )}
      />

      <ObjectList
        label="Wiring"
        hint="The criterion a half-done build passes without: every file present, nothing calling any of it."
        items={acc.links}
        blank={() => ({ from: '', to: '', via: '' })}
        onChange={(links) => setAcc({ links })}
        row={(l, set) => (
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <TextInput value={l.from} placeholder="from" onChange={(e) => set({ from: e.target.value })} style={{ ...field, flex: 1 }} />
            <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>→</span>
            <TextInput value={l.to} placeholder="to" onChange={(e) => set({ to: e.target.value })} style={{ ...field, flex: 1 }} />
            <TextInput value={l.via} placeholder="via" onChange={(e) => set({ via: e.target.value })} style={{ ...field, flex: 1 }} />
          </div>
        )}
      />

      {error && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red-soft)', marginTop: 6, whiteSpace: 'pre-wrap' }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 7, marginTop: 10, alignItems: 'center' }}>
        <Button onClick={onSave} disabled={saving}>Save spec</Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <button
          type="button"
          onClick={() => setJson(JSON.stringify(draft, null, 2))}
          style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 10 }}
        >
          edit as JSON
        </button>
        <div style={{ flex: 1 }} />
        {canClear && (
          <Button variant="danger" onClick={onClear} disabled={saving}>Clear</Button>
        )}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
        Saving REPLACES the whole spec — there is no field-level merge. Empty rows are dropped.
        {draft.steps.length > 0 && (
          // Said out loud because the sentence above is otherwise a half-truth: the spec holds a
          // field this form does not show. It is preserved on save, and a human who is not told it
          // exists has no way to know that.
          <>
            {' '}
            This spec also carries <strong>{draft.steps.length} planner-authored step(s)</strong>,
            which this form does not edit and does not discard.
          </>
        )}
      </div>
    </div>
  );
}

/** Drop the rows a human left blank. A form makes empty rows easy to create by accident, and an
 *  anticipated file with no path is a row the contract would refuse and a reader would puzzle at. */
export function pruneDraft(d: SpecDraft): SpecDraft {
  const nonBlank = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return {
    // Passed through untouched. `steps` (RUN-148) is the planner's decomposition and this form does
    // not edit it — but saving REPLACES the whole spec, so dropping the field here would have a
    // human silently destroy a decomposition by correcting a typo in an unrelated one.
    steps: d.steps,
    requirementIds: nonBlank(d.requirementIds),
    anticipatedFiles: d.anticipatedFiles.filter((f) => f.path.trim()).map((f) => ({ ...f, path: f.path.trim() })),
    requiredReading: nonBlank(d.requiredReading),
    lockedDecisions: d.lockedDecisions.filter((x) => x.decision.trim()),
    discretion: nonBlank(d.discretion),
    deferred: nonBlank(d.deferred),
    acceptance: {
      observableTruths: nonBlank(d.acceptance.observableTruths),
      artifacts: d.acceptance.artifacts.filter((a) => a.path.trim()).map((a) => ({ ...a, path: a.path.trim() })),
      links: d.acceptance.links.filter((l) => l.from.trim() && l.to.trim()),
    },
  };
}
