import { useEffect, useState } from 'react';
import { api, type ApiProjectHealth } from '../api';
import type { AppStore } from '../store';
import { Button } from './ui';
import { IntelligenceHistoryView } from './IntelligenceHistoryView';
import { openReviewValidityTab } from './ReviewInboxChrome';

export function IntelligenceView({ store }: { store: AppStore }) {
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [packet, setPacket] = useState<ApiProjectHealth | null>(null);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(new URLSearchParams(location.search).has('lineage'));
  useEffect(() => { setOffset(0); }, [store.currentPid]);
  useEffect(() => {
    let cancelled = false; setPacket(null); setError('');
    api.projectHealth(store.currentPid, offset).then(value => { if (!cancelled) setPacket(value); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [store.currentPid, offset, refresh]);
  if (historyOpen) return <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 10 }}><Button onClick={() => setHistoryOpen(false)}>Back to Project health</Button></div>
    <div style={{ flex: 1, position: 'relative' }}><IntelligenceHistoryView store={store} /></div>
  </div>;
  return <main style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: 22 }}>
    <header style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      <div style={{ flex: 1 }}><h1>Project health</h1><p>What can we work on next, and what needs rechecking first?</p></div>
      <Button onClick={() => setRefresh(n => n + 1)}>Refresh</Button>
      <Button onClick={() => openReviewValidityTab(store.actions.setView)}>Open Review</Button>
      <Button variant="ghost" onClick={() => setHistoryOpen(true)}>Historical evidence and lineage</Button>
    </header>
    {error ? <div role="alert">Unable to load project health: {error} <Button onClick={() => setRefresh(n => n + 1)}>Retry</Button></div>
      : !packet ? <p role="status">Checking current readiness…</p> : <>
        <p>{packet.totalOpenTasks} open tasks · {packet.activeClaims} active claims · {packet.activeLocks} file locks</p>
        <p style={{ color: 'var(--text-dim)' }}>Observed {new Date(packet.observedAt).toLocaleString()}. Showing {packet.items.length ? packet.offset + 1 : 0}–{packet.offset + packet.items.length} of {packet.totalOpenTasks} open tasks, in priority order.</p>
        <p><strong>{packet.items.filter(t => t.claimability.claimable).length} claimable on this page</strong> · {packet.items.filter(t => t.readiness !== 'passed').length} without current passing readiness evidence. Claimable legacy work may still lack evidence.</p>
        {!packet.items.length && <p>No open tasks in this scope.</p>}
        <div style={{ display: 'grid', gap: 12 }}>
          {packet.items.map(task => <article key={task.id} style={{ padding: 16, border: '1px solid var(--line)', borderRadius: 10 }}>
            <Button variant="ghost" onClick={() => store.actions.openTask(task.id)}>{task.key} · {task.title}</Button>
            <p>{task.claimability.claimable ? 'Ready to claim' : task.claimability.reason}</p>
            <p>Readiness evidence: <strong>{task.readiness}</strong> · Implementation evidence: {task.implementation}
              {!task.evidenceRequired && ' · legacy policy'}</p>
            {task.checkedRevision && <p>Assessed revision: <code>{task.checkedRevision}</code></p>}
            {task.phases.map(phase => <p key={phase.id}>{phase.planTitle} · Phase {phase.phaseNumber}: {phase.title} · plan {phase.planStatus}</p>)}
            {task.overrides.map(o => <p key={o.id}>Explicit {o.scope} exception by {o.actorName}, expires {new Date(o.expiresAt).toLocaleString()}: {o.reason}</p>)}
            {!!task.blockingCauses.length && <p>Conditions requiring attention: {task.blockingCauses.join(', ')}</p>}
          </article>)}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - packet.pageSize))}>Previous</Button>
          <Button disabled={packet.nextOffset === null} onClick={() => setOffset(packet.nextOffset!)}>Next</Button>
        </div>
      </>}
  </main>;
}
