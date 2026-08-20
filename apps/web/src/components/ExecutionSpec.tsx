// RUN-137: a task's execution spec, read and corrected by a human.
//
// The point where a wrong scope is cheapest to fix, because the work has not been done yet. A spec
// nobody can read is a spec nobody trusts, and one nobody can correct is one they have to accept.
//
// Reading is a rendered view. Correcting is a JSON editor, and that is a SHIP-NOW choice rather
// than the right end state: nothing in the schema resists a form — anticipated files, locked
// decisions, artifacts and links are all repeatable rows — it is simply several repeaters plus
// validation, and it is filed as its own task. What is here is honest about its limits: it seeds
// the editor with the current spec, names the fields, warns about keys the contract will drop, and
// shows the server's rejection verbatim. It suits an engineer supervising agents; it does not suit
// someone who has never seen the schema.
//
// The server validates shape (RUN-135's write seam), so a bad VALUE comes back as an error. It does
// NOT protect spelling: zod strips unknown keys, so `requirementID` would save and vanish. That is
// why the editor checks the key names itself before sending.
import { useEffect, useState } from 'react';
import { hasExecutionSpec, type ExecutionSpec } from '@noriq-dev/shared';
import { api } from '../api';
import { MonoTag } from './bits';
import { Button } from './ui';
import { type SpecDraft, SpecForm, pruneDraft } from './SpecForm';
import { confirm } from './Dialog';

/** The shape the form edits: every field present, so no row reasons about absence. */
const EMPTY_DRAFT: SpecDraft = {
  steps: [],
  requirementIds: [],
  anticipatedFiles: [],
  requiredReading: [],
  lockedDecisions: [],
  discretion: [],
  deferred: [],
  acceptance: { observableTruths: [], artifacts: [], links: [] },
};

const CHANGE_COLOR: Record<string, string> = {
  create: 'var(--green, #6ee7a8)',
  modify: 'var(--blue, #7cc4ff)',
  delete: 'var(--red-soft)',
};

/** How the panel found out what it is showing. Distinct from the spec's own three states: "we do
 *  not know yet" and "we could not ask" must never render as "there is no spec", which is the one
 *  reading that invites someone to write over a plan that already exists. */
export type SpecLoad = 'loading' | 'loaded' | 'error';


function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function quantity(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// Index keys throughout: the schema enforces no uniqueness anywhere — two anticipated files may
// share a path with different reasons, two decisions may share wording with different sources —
// so a "domain identity" key would be a duplicate React key on perfectly valid data. These rows
// hold no state of their own, so position is the honest key.
function Bullets({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {items.map((t, i) => (
        <li key={i} style={{ fontSize: 12, color: 'var(--text-mid)', lineHeight: 1.5 }}>{t}</li>
      ))}
    </ul>
  );
}

/** The rendered spec. Exported because the acceptance criteria belong on the REVIEW surface too,
 *  read-only: "accept this work" is a judgement against the contract, and a reviewer who cannot
 *  see the contract is judging against memory. */
export function SpecView({ spec, only }: { spec: ExecutionSpec; only?: 'acceptance' }) {
  const { acceptance } = spec;
  const full = only !== 'acceptance';
  return (
    <div style={{ borderRadius: 8, background: 'var(--w-02)', border: '1px solid var(--w-06)', padding: '10px 12px', marginBottom: 12 }}>
      {full && spec.requirementIds.length > 0 && (
        <Row label="Requirements">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {spec.requirementIds.map((r, i) => (
              <MonoTag key={i} color="var(--text-mid)" bg="var(--w-05)" size={9.5}>{r}</MonoTag>
            ))}
          </div>
        </Row>
      )}

      {full && spec.anticipatedFiles.length > 0 && (
        <Row label={`Anticipated files · ${spec.anticipatedFiles.length}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {spec.anticipatedFiles.map((f, i) => (
              <div key={i} data-execution-spec-file style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
                  <span style={{ flex: 'none' }}>
                    <MonoTag color={CHANGE_COLOR[f.change] ?? 'var(--text-mid)'} bg="var(--w-05)" size={8.5}>
                      {f.change}
                    </MonoTag>
                  </span>
                  <span data-execution-spec-file-path style={{ minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', overflowWrap: 'anywhere' }}>{f.path}</span>
                </div>
                {f.why && <span data-execution-spec-file-reason style={{ display: 'block', width: '100%', fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.45 }}>{f.why}</span>}
              </div>
            ))}
          </div>
        </Row>
      )}

      {full && spec.requiredReading.length > 0 && (
        <Row label="Required reading">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {spec.requiredReading.map((r, i) => (
              <span key={i} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-mid)', wordBreak: 'break-all' }}>{r}</span>
            ))}
          </div>
        </Row>
      )}

      {full && spec.lockedDecisions.length > 0 && (
        <Row label="Locked decisions · do not relitigate">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {spec.lockedDecisions.map((d, i) => (
              <div key={i} style={{ borderLeft: '2px solid var(--w-15)', paddingLeft: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text)' }}>{d.decision}</div>
                {d.because && <div style={{ fontSize: 11, color: 'var(--text-mid)', lineHeight: 1.5 }}>because {d.because}</div>}
                {d.source && <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{d.source}</div>}
              </div>
            ))}
          </div>
        </Row>
      )}

      {full && spec.discretion.length > 0 && <Row label="Yours to decide"><Bullets items={spec.discretion} /></Row>}
      {full && spec.deferred.length > 0 && <Row label="Explicitly out of scope"><Bullets items={spec.deferred} /></Row>}

      {acceptance.observableTruths.length > 0 && (
        <Row label="Done when these are true"><Bullets items={acceptance.observableTruths} /></Row>
      )}

      {acceptance.artifacts.length > 0 && (
        <Row label="Expected artifacts">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {acceptance.artifacts.map((a, i) => (
              <div key={i} data-execution-spec-artifact style={{ minWidth: 0 }}>
                <span data-execution-spec-artifact-path style={{ display: 'block', width: '100%', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', overflowWrap: 'anywhere' }}>{a.path}</span>
                {a.provides && <span data-execution-spec-artifact-description style={{ display: 'block', width: '100%', fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.45, marginTop: 2 }}>{a.provides}</span>}
                {a.exports.length > 0 && (
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-mid)', marginTop: 2 }}>
                    exports {a.exports.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Row>
      )}

      {acceptance.links.length > 0 && (
        <Row label="Wiring">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {acceptance.links.map((l, i) => (
              <div key={i} style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-mid)', wordBreak: 'break-all' }}>
                {l.from} → {l.to}
                {l.via && <span style={{ color: 'var(--text-faint)' }}> · {l.via}</span>}
              </div>
            ))}
          </div>
        </Row>
      )}
    </div>
  );
}

export function ExecutionSpecPanel({
  pid,
  taskId,
  load = 'loaded',
  spec,
  unreadable,
  /** True once the task has been claimed or moved on. Editing then MOVES THE GOALPOSTS: whoever
   *  is working has already been handed the old contract, and the reviewer will judge against the
   *  new one. Not forbidden — a human correcting a genuinely wrong scope mid-run is a legitimate
   *  and useful act — but it must not happen by accident. */
  inFlight,
  onSaved,
}: {
  pid: string;
  taskId: string;
  load?: SpecLoad;
  spec: ExecutionSpec | null;
  /** The stored spec could not be parsed (RUN-135). NOT the same as having none. */
  unreadable?: boolean;
  inFlight?: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SpecDraft>(EMPTY_DRAFT);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Never carry one task's draft to another. The drawer also remounts this on task change, and
  // both are wanted: the key handles the drawer, this handles any other caller.
  useEffect(() => {
    setEditing(false);
    setError('');
  }, [taskId]);

  const startEdit = () => {
    setDraft(spec ?? EMPTY_DRAFT);
    setError('');
    setEditing(true);
  };

  const save = async () => {
    // Blank rows are dropped rather than sent: a form makes them easy to create by accident, and
    // an anticipated file with no path is a row the contract refuses and a reader puzzles at.
    const pruned = pruneDraft(draft);
    setSaving(true);
    try {
      // The server is still the authority on shape (a path that leaves the repo, a change kind
      // that does not exist). Its message is more specific than anything worth re-deriving here.
      await api.updateTask(pid, taskId, { executionSpec: pruned });
      // Close only once the reload has succeeded too: errors render inside the editor, so closing
      // first would leave a failed refresh showing stale content and no explanation.
      await onSaved();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!(await confirm('Clear this task’s execution spec? The anticipated files, decisions and acceptance criteria are removed, and there is no undo.'))) return;
    setSaving(true);
    try {
      await api.updateTask(pid, taskId, { executionSpec: null });
      await onSaved();
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not clear');
    } finally {
      setSaving(false);
    }
  };

  // `hasExecutionSpec` is the contract's own predicate, imported rather than re-implemented: it is
  // built from an exhaustive keyed map so a new field is a type error there, and a local copy
  // would quietly call a populated spec empty the day one is added.
  const empty = !hasExecutionSpec(spec);
  const editable = load === 'loaded';
  const summary = load === 'loading'
    ? 'loading'
    : load === 'error'
      ? 'unavailable'
      : unreadable
        ? 'stored value unreadable'
        : empty
          ? 'no execution plan'
          : `${quantity(spec?.requirementIds.length ?? 0, 'requirement')} · ${quantity(spec?.anticipatedFiles.length ?? 0, 'file')} · ${quantity(spec?.acceptance.observableTruths.length ?? 0, 'check')}`;

  return (
    <details
      data-execution-spec
      style={{ border: '1px solid var(--w-1)', borderRadius: 10, background: 'var(--w-025)', margin: '12px 0' }}
    >
      <summary style={{ cursor: 'pointer', padding: '11px 13px', fontWeight: 650, fontSize: 12 }}>
        Execution spec{' '}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 400, color: unreadable || load === 'error' ? 'var(--red-soft)' : 'var(--text-dim)' }}>
          {summary}
        </span>
      </summary>
      <div style={{ padding: '0 13px 13px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>builder contract · expand only when needed</div>
          <div style={{ flex: 1 }} />
          {!editing && editable && (
            <button
              onClick={startEdit}
              className="rail-add"
              style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', border: '1px dashed var(--w-15)', padding: '3px 9px', borderRadius: 6, background: 'transparent' }}
            >
              {/* "+ add spec" would be a lie on a corrupt row: there IS something stored, it just
                  cannot be read, and the human's job is to replace it rather than author a first. */}
              {unreadable ? 'rewrite' : empty ? '+ add spec' : 'edit'}
            </button>
          )}
        </div>

      {/* "we do not know yet" and "we could not ask" must not render as "there is no spec" — that
          reading invites someone to write over a plan that already exists. */}
      {load === 'loading' && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>loading…</div>
      )}
      {load === 'error' && (
        <div style={{ fontSize: 11.5, color: 'var(--amber, #e5b567)', lineHeight: 1.5 }}>
          Could not load this task’s spec. It may or may not have one — reopen the task to try again
          rather than assuming it is unplanned.
        </div>
      )}

      {editable && (
        <>
          {/* Corruption is a THIRD state, not "no spec" — absence reads as permission to re-plan
              (RUN-135), so this has to look visibly different from an empty panel. */}
          {unreadable && (
            <div style={{ borderRadius: 8, border: '1px solid rgba(255,92,92,.4)', borderLeft: '3px solid var(--red-soft)', background: 'rgba(255,92,92,.06)', padding: '9px 11px', marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red-soft)' }}>Stored spec is unreadable</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-mid)', lineHeight: 1.5, marginTop: 3 }}>
                The saved value is not a valid spec — corrupt content, or a shape the contract no
                longer accepts. It is <strong>not</strong> the same as having no spec: something was
                written here. Rewrite it below, or clear it deliberately.
              </div>
            </div>
          )}

          {inFlight && !empty && (
            <div style={{ fontSize: 11, color: 'var(--amber, #e5b567)', lineHeight: 1.5, marginBottom: 8 }}>
              This task is already under way. Whoever is working on it was handed the current spec —
              changing it now changes what a reviewer will judge against, and nothing tells them it
              moved.
            </div>
          )}

          {editing ? (
            <SpecForm
              draft={draft}
              onChange={setDraft}
              onSave={() => void save()}
              onCancel={() => setEditing(false)}
              onClear={() => void clear()}
              saving={saving}
              error={error}
              canClear={!empty || Boolean(unreadable)}
            />
          ) : empty && !unreadable ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              No spec. Whoever picks this up works out its scope, required reading and definition of
              done from the title and body alone — and may work them out differently from you.
            </div>
          ) : spec ? (
            <SpecView spec={spec} />
          ) : null}
        </>
      )}
      </div>
    </details>
  );
}
