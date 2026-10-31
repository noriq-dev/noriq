import { useEffect, useState } from 'react';
import { api, type ApiValidationSubjectType } from '../api';
import { Button } from './ui';
export function AssessmentHistory({ projectId, subjectType, subjectId }: { projectId: string; subjectType: ApiValidationSubjectType; subjectId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.assessmentHistory>> | null>(null);
  const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false; setData(null); setError('');
    api.assessmentHistory(projectId, subjectType, subjectId).then(r => { if (!cancelled) setData(r); })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, subjectType, subjectId, retry]);
  if (error) return <div role="alert">{error} <Button onClick={() => setRetry(n => n + 1)}>Retry history</Button></div>;
  if (!data) return <p role="status">Loading evidence history…</p>;
  return <section><h4>Recent evidence and exceptions</h4><p>Up to {data.limit} of each, newest first. Actor-reported evidence; historical records do not establish current validity.</p>
    {!data.assessments.length && <p>No structured assessments recorded.</p>}
    {data.assessments.map(r => <details key={r.id}><summary>{r.purpose} · {r.outcome} · {r.actorName} · {new Date(r.createdAt).toLocaleString()}</summary><p>{r.summary}</p>{r.reconciliation && <p>Reconciled direction: {r.reconciliation.directionIds.join(", ")} — {r.reconciliation.summary}</p>}<p>{r.scope} · {r.repositoryKey} {r.branch} {r.baseId}</p>{r.evidence.map((e, i) => <p key={i}>{e.kind}: {e.reference} — {e.result}</p>)}</details>)}
    {data.overrides.map(r => <p key={r.id}>Recorded {r.scope} exception · {r.actorName} · {r.reason} · expires {new Date(r.expiresAt).toLocaleString()}. Applies only while its recorded context matches.</p>)}
  </section>;
}
