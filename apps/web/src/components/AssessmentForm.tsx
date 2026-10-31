import { useEffect, useState } from 'react';
import { AssessmentInput } from '@noriq-dev/shared';
import { api, type ApiValidationSubjectType } from '../api';
import { Button } from './ui';

/** Shared by the subject inspector and Review; never asserts evidence on a single click. */
export function AssessmentForm({ projectId, subjectType, subjectId, onSaved, onCancel }: {
  projectId: string; subjectType: ApiValidationSubjectType; subjectId: string;
  onSaved: () => void | Promise<void>; onCancel: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('repository');
  const [markers,setMarkers]=useState<Array<{id:string;reason:string}>>([]);
  const [contextReady,setContextReady]=useState(subjectType !== 'task');
  useEffect(()=>{let live=true;if(subjectType==='task') api.subjectFreshness(projectId,subjectType,subjectId).then(f=>{if(live){setMarkers(f.assessment?.directionMarkers ?? []);setContextReady(true);}}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[projectId,subjectType,subjectId]);
  return <form aria-label="Record verification evidence" style={{ display: 'grid', gap: 8, padding: 12 }} onSubmit={async e => {
    e.preventDefault(); setError('');
    const data = new FormData(e.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '');
    const parsed = AssessmentInput.safeParse({
      ...(markers.length && value('reconciliation').trim() ? {reconciliation:{directionIds:markers.map(m=>m.id),summary:value('reconciliation')}} : {}),
      purpose: value('purpose'), outcome: value('outcome'), scope, summary: value('summary'),
      ...(scope === 'repository' ? { repositoryKey: value('repositoryKey'), branch: value('branch'), baseId: value('baseId') } : {}),
      evidence: [{ kind: value('kind'), reference: value('reference'), result: value('result') }],
    });
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join('; ')); return; }
    setBusy(true);
    try {
      await api.recordValidation(projectId, { subjectType, subjectId, assessment: parsed.data });
      await onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }}>
    <strong>Record verification evidence</strong>
    <span>Record what you checked and what it showed. This is your assessment, not an automatically executed check.</span>
    <label>Purpose <select name="purpose" defaultValue={subjectType === 'task' ? 'readiness' : 'document'}>
      {subjectType === 'task' ? <><option value="readiness">Ready to start</option><option value="implementation">Implementation meets acceptance criteria</option></> : <option value="document">Document claims still hold</option>}
    </select></label>
    <label>Outcome <select name="outcome"><option value="passed">Passed</option><option value="failed">Failed</option><option value="inconclusive">Inconclusive</option></select></label>
    <label>Scope <select name="scope" value={scope} onChange={e => setScope(e.target.value)}><option value="repository">Repository</option><option value="non_code">Non-code work</option></select></label>
    {scope === 'repository' && <>
      <label>Repository <input name="repositoryKey" required /></label>
      <label>Branch <input name="branch" required /></label>
      <label>Revision checked <input name="baseId" required /></label>
    </>}
    {markers.length>0 && <fieldset><legend>Recheck before reclaiming</legend>{markers.map(m=><p key={m.id}>{m.reason}</p>)}<label>How current task intent reflects these changes <textarea name="reconciliation" minLength={10} maxLength={4000} /></label><small>Fill this for a passing readiness assessment to reconcile all listed markers. Failed checks remain in history.</small></fieldset>}
    <label>Assessment and scope <textarea name="summary" required minLength={10} maxLength={4000} placeholder="What assumptions or acceptance criteria did you check? For non-code work, explain why repository evidence is not applicable." /></label>
    <label>Evidence type <select name="kind"><option value="inspection">Code/document inspection</option><option value="test">Test results</option><option value="ci">CI result</option><option value="human_review">Human review</option></select></label>
    <label>Evidence reference <input name="reference" required placeholder="File and lines, test command, or CI/report URL" /></label>
    <label>Observed result <textarea name="result" required maxLength={2000} placeholder="What did the check establish? Include failures or limits." /></label>
    {error && <div role="alert">{error}</div>}
    <div><Button type="submit" disabled={busy || !contextReady}>{busy ? 'Saving…' : 'Save assessment'}</Button> <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
  </form>;
}
