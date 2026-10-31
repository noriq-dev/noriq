import { useEffect, useState, type CSSProperties } from 'react';
import { AssessmentInput } from '@noriq-dev/shared';
import { api, type ApiValidationSubjectType } from '../api';
import { Button, ErrorNote, Field, TextArea, TextInput } from './ui';

const controlStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  background: 'var(--w-05)',
  border: '1px solid var(--w-1)',
  borderRadius: 9,
  padding: '9px 12px',
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
};

/** Shared by the subject inspector and Review; never asserts evidence on a single click. */
export function AssessmentForm({
  projectId,
  subjectType,
  subjectId,
  onSaved,
  onCancel,
}: {
  projectId: string;
  subjectType: ApiValidationSubjectType;
  subjectId: string;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('repository');
  const [markers, setMarkers] = useState<Array<{ id: string; reason: string }>>([]);
  const [contextReady, setContextReady] = useState(subjectType !== 'task');

  useEffect(() => {
    let live = true;
    if (subjectType === 'task') {
      api.subjectFreshness(projectId, subjectType, subjectId)
        .then((freshness) => {
          if (live) {
            setMarkers(freshness.assessment?.directionMarkers ?? []);
            setContextReady(true);
          }
        })
        .catch((err) => {
          if (live) setError(String(err));
        });
    }
    return () => { live = false; };
  }, [projectId, subjectType, subjectId]);

  return (
    <form
      aria-label="Record verification evidence"
      style={{
        display: 'grid',
        gap: 4,
        marginTop: 8,
        padding: '12px 14px',
        border: '1px solid var(--w-08)',
        borderRadius: 10,
        background: 'var(--w-02)',
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        setError('');
        const data = new FormData(event.currentTarget);
        const value = (key: string) => String(data.get(key) ?? '');
        const parsed = AssessmentInput.safeParse({
          ...(markers.length && value('reconciliation').trim()
            ? { reconciliation: { directionIds: markers.map((marker) => marker.id), summary: value('reconciliation') } }
            : {}),
          purpose: value('purpose'),
          outcome: value('outcome'),
          scope,
          summary: value('summary'),
          ...(scope === 'repository'
            ? { repositoryKey: value('repositoryKey'), branch: value('branch'), baseId: value('baseId') }
            : {}),
          evidence: [{ kind: value('kind'), reference: value('reference'), result: value('result') }],
        });
        if (!parsed.success) {
          setError(parsed.error.issues.map((issue) => issue.message).join('; '));
          return;
        }
        setBusy(true);
        try {
          await api.recordValidation(projectId, { subjectType, subjectId, assessment: parsed.data });
          await onSaved();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
        Record verification evidence
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 10 }}>
        Record what you checked and what it showed. This is your assessment, not an automatically executed check.
      </div>

      <Field label="Purpose">
        <select name="purpose" defaultValue={subjectType === 'task' ? 'readiness' : 'document'} style={controlStyle}>
          {subjectType === 'task' ? (
            <>
              <option value="readiness">Ready to start</option>
              <option value="implementation">Implementation meets acceptance criteria</option>
            </>
          ) : (
            <option value="document">Document claims still hold</option>
          )}
        </select>
      </Field>

      <Field label="Outcome">
        <select name="outcome" defaultValue="passed" style={controlStyle}>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
          <option value="inconclusive">Inconclusive</option>
        </select>
      </Field>

      <Field label="Scope">
        <select
          name="scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          style={controlStyle}
        >
          <option value="repository">Repository</option>
          <option value="non_code">Non-code work</option>
        </select>
      </Field>

      {scope === 'repository' && (
        <>
          <Field label="Repository">
            <TextInput name="repositoryKey" required aria-label="Repository" />
          </Field>
          <Field label="Branch">
            <TextInput name="branch" required aria-label="Branch" />
          </Field>
          <Field label="Revision checked">
            <TextInput name="baseId" required aria-label="Revision checked" />
          </Field>
        </>
      )}

      {markers.length > 0 && (
        <fieldset style={{
          border: '1px solid var(--w-08)',
          borderRadius: 9,
          padding: '10px 12px',
          margin: '0 0 14px',
        }}>
          <legend style={{
            fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase',
            letterSpacing: '.07em', color: 'var(--text-dim)', padding: '0 4px',
          }}>
            Recheck before reclaiming
          </legend>
          <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
            {markers.map((marker) => (
              <div key={marker.id} style={{ fontSize: 12, color: 'var(--text-mid)', lineHeight: 1.45 }}>
                {marker.reason}
              </div>
            ))}
          </div>
          <Field label="How current task intent reflects these changes">
            <TextArea name="reconciliation" minLength={10} maxLength={4000} />
          </Field>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', lineHeight: 1.5, marginTop: -6 }}>
            Fill this for a passing readiness assessment to reconcile all listed markers. Failed checks remain in history.
          </div>
        </fieldset>
      )}

      <Field label="Assessment and scope">
        <TextArea
          name="summary"
          required
          minLength={10}
          maxLength={4000}
          placeholder="What assumptions or acceptance criteria did you check? For non-code work, explain why repository evidence is not applicable."
        />
      </Field>

      <Field label="Evidence type">
        <select name="kind" defaultValue="inspection" style={controlStyle}>
          <option value="inspection">Code/document inspection</option>
          <option value="test">Test results</option>
          <option value="ci">CI result</option>
          <option value="human_review">Human review</option>
        </select>
      </Field>

      <Field label="Evidence reference">
        <TextInput
          name="reference"
          required
          aria-label="Evidence reference"
          placeholder="File and lines, test command, or CI/report URL"
        />
      </Field>

      <Field label="Observed result">
        <TextArea
          name="result"
          required
          maxLength={2000}
          placeholder="What did the check establish? Include failures or limits."
        />
      </Field>

      {error && <div role="alert" style={{ marginBottom: 10 }}><ErrorNote>{error}</ErrorNote></div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || !contextReady}>
          {busy ? 'Saving…' : 'Save assessment'}
        </Button>
      </div>
    </form>
  );
}
