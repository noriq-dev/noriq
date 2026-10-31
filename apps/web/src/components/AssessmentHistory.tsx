import { useEffect, useState } from 'react';
import { api, type ApiValidationSubjectType } from '../api';
import { SectionLabel } from './bits';
import { Button, ErrorNote } from './ui';

export function AssessmentHistory({
  projectId,
  subjectType,
  subjectId,
}: {
  projectId: string;
  subjectType: ApiValidationSubjectType;
  subjectId: string;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.assessmentHistory>> | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api.assessmentHistory(projectId, subjectType, subjectId)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [projectId, subjectType, subjectId, retry]);

  if (error) {
    return (
      <div role="alert" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <ErrorNote>{error}</ErrorNote>
        <Button variant="ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setRetry((n) => n + 1)}>
          Retry history
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div role="status" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
        Loading evidence history…
      </div>
    );
  }

  return (
    <section style={{ marginTop: 10, display: 'grid', gap: 10 }}>
      <div>
        <SectionLabel>Recent evidence and exceptions</SectionLabel>
        <div style={{ color: 'var(--text-dim)', fontSize: 11.5, lineHeight: 1.5, marginTop: 6 }}>
          Up to {data.limit} of each, newest first. Actor-reported evidence; historical records do not establish current validity.
        </div>
      </div>

      {!data.assessments.length && (
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No structured assessments recorded.</div>
      )}

      {data.assessments.map((record) => (
        <details
          key={record.id}
          style={{
            border: '1px solid var(--w-07)',
            borderRadius: 9,
            background: 'var(--w-02)',
            padding: '8px 11px',
          }}
        >
          <summary style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-soft)' }}>
            {record.purpose} · {record.outcome} · {record.actorName} · {new Date(record.createdAt).toLocaleString()}
          </summary>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-mid)', lineHeight: 1.5, display: 'grid', gap: 6 }}>
            <p style={{ margin: 0 }}>{record.summary}</p>
            {record.reconciliation && (
              <p style={{ margin: 0 }}>
                Reconciled direction: {record.reconciliation.directionIds.join(', ')} — {record.reconciliation.summary}
              </p>
            )}
            <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
              {record.scope}
              {record.repositoryKey ? ` · ${record.repositoryKey}` : ''}
              {record.branch ? ` ${record.branch}` : ''}
              {record.baseId ? ` ${record.baseId}` : ''}
            </p>
            {record.evidence.map((item, index) => (
              <p key={index} style={{ margin: 0 }}>
                {item.kind}: {item.reference} — {item.result}
              </p>
            ))}
          </div>
        </details>
      ))}

      {data.overrides.map((record) => (
        <div
          key={record.id}
          style={{
            border: '1px solid var(--w-07)',
            borderRadius: 9,
            background: 'var(--w-02)',
            padding: '8px 11px',
            fontSize: 12,
            color: 'var(--text-mid)',
            lineHeight: 1.5,
          }}
        >
          Recorded {record.scope} exception · {record.actorName} · {record.reason} · expires {new Date(record.expiresAt).toLocaleString()}.
          Applies only while its recorded context matches.
        </div>
      ))}
    </section>
  );
}
