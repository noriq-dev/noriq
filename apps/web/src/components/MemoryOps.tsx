// Project Memory operations panel (PLNR-273) — the Operations sub-tab MemoryView.tsx (PLNR-271)
// reserved. Shows repository index / generation / backup / vector-index / canonical-store status
// and the authorized controls that operate them.
//
// Five distinct failure modes (locked decision, acceptance): stale index, failed ingest, vector
// drift, backup failure, and canonical-store failure NEVER collapse into one generic error badge
// — each is its own labelled state with its own guidance, because the right response to each is
// different (reindex / re-upload / rebuild vectors / investigate R2 / escalate). Every number and
// status rendered here is read straight from the server (ops-status, repositories, backups) —
// this file computes none of staleness, drift, or storage itself.
//
// READ-then-ACT: GET routes are reachable by any project member; POST routes 403 server-side for
// a non-admin. This view mirrors that server line with `store.isAdmin` so a non-admin sees status
// with no action affordance they cannot use, rather than a control that fails on click.
import { useCallback, useEffect, useState } from 'react';
import { api, type ApiMemoryOpsStatus, type ApiMemoryRepository, type ApiStagedGeneration } from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { Section } from './SettingsView';
import { Button } from './ui';
import { confirm } from './Dialog';

const shortId = (id: string) => id.slice(-8);
const fmtBytes = (n: number | null): string => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
};
const fmtWhen = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : 'never');

type SignalTone = 'ok' | 'warn' | 'bad' | 'muted';
const TONE_META: Record<SignalTone, { icon: string; color: string; bg: string; border: string }> = {
  ok: { icon: '●', color: 'var(--green)', bg: 'rgba(63,217,139,.10)', border: 'rgba(63,217,139,.3)' },
  warn: { icon: '◐', color: 'var(--amber)', bg: 'rgba(245,166,35,.10)', border: 'rgba(245,166,35,.3)' },
  bad: { icon: '✕', color: 'var(--red-soft)', bg: 'rgba(255,92,92,.08)', border: 'rgba(255,92,92,.35)' },
  muted: { icon: '○', color: 'var(--text-dim)', bg: 'var(--w-03)', border: 'var(--w-08)' },
};

/** One always-visible failure-mode card: a name, a tone, and what-to-do guidance text that never
 *  shares wording with any other card (acceptance: "no two share a generic error presentation"). */
function SignalCard({ label, tone, detail, guidance }: { label: string; tone: SignalTone; detail: string; guidance: string }) {
  const m = TONE_META[tone];
  return (
    <div style={{ flex: '1 1 200px', minWidth: 200, padding: '11px 13px', borderRadius: 11, background: m.bg, border: `1px solid ${m.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
        <span style={{ color: m.color, fontSize: 12 }}>{m.icon}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-soft)', lineHeight: 1.6, marginBottom: tone === 'ok' ? 0 : 5 }}>{detail}</div>
      {tone !== 'ok' && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: m.color, lineHeight: 1.6 }}>→ {guidance}</div>}
    </div>
  );
}

function CanonicalStoreFailureCard({ detail }: { detail?: string }) {
  return (
    <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center', padding: '20px 24px', borderRadius: 12, background: 'rgba(255,92,92,.06)', border: '1px solid rgba(255,92,92,.3)' }}>
      <div style={{ fontSize: 20, marginBottom: 8 }}>⚠</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--red-soft)', marginBottom: 6 }}>CANONICAL-STORE FAILURE</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.7 }}>
        The project's memory store did not answer. This is not "no memory exists" — nothing else on
        this panel (repositories, backups, vectors) can be trusted until it does.
        {'\n'}→ escalate: this is not self-serviceable from here.
        {detail && <div style={{ marginTop: 8, color: 'var(--text-faint)' }}>{detail}</div>}
      </div>
    </div>
  );
}

function CapabilitiesStrip({ capabilities }: { capabilities: ApiMemoryOpsStatus['capabilities'] }) {
  const rows: Array<{ label: string; on: boolean; whenOff: string }> = [
    { label: 'R2 (portable backups)', on: capabilities.r2, whenOff: 'backup/restore are unavailable — live coordination, reads, and writes are unaffected' },
    { label: 'Vectorize (semantic search)', on: capabilities.vectorize, whenOff: 'retrieval falls back to exact/keyword lookup and graph expansion' },
    { label: 'Workers AI (embeddings)', on: capabilities.workersAI, whenOff: 'nothing can be embedded — semantic search and vector rebuild are inert' },
    { label: 'Code-intelligence index', on: capabilities.codeVectorize, whenOff: 'code search falls back to exact/keyword lookup' },
  ];
  const reduced = rows.filter((r) => !r.on);
  if (reduced.length === 0) {
    return <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>All optional bindings configured — no reduced capability.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {reduced.map((r) => (
        <div key={r.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9.5}>REDUCED CAPABILITY</MonoTag>
          <span style={{ fontSize: 11.5 }}>
            <b>{r.label}</b> not configured — {r.whenOff}. This is a supported configuration, not an error.
          </span>
        </div>
      ))}
    </div>
  );
}

export function MemoryOps({ pid, store }: { pid: string; store: AppStore }) {
  const isAdmin = store.isAdmin;
  const projectName = store.data.projects.find((p) => p.id === pid)?.name ?? 'this project';

  const [reachable, setReachable] = useState<boolean | null>(null);
  const [reachError, setReachError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<ApiMemoryOpsStatus | null>(null);
  const [repositories, setRepositories] = useState<ApiMemoryRepository[]>([]);
  const [backups, setBackups] = useState<{ backups: string[]; r2Available: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSweep, setLastSweep] = useState<Awaited<ReturnType<typeof api.memoryLifecycleSweep>> | null>(null);
  const [lastBackup, setLastBackup] = useState<{ manifestKey: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null); // which control is in flight

  const refresh = useCallback(() => {
    setLoading(true);
    setReachError(undefined);
    Promise.all([api.memoryOpsStatus(pid), api.memoryRepositories(pid), api.memoryBackupsList(pid)])
      .then(([s, r, b]) => {
        setStatus(s);
        setRepositories(r.repositories);
        setBackups(b);
        setReachable(true);
      })
      .catch((err) => {
        setReachable(false);
        setReachError(err instanceof Error ? err.message : undefined);
      })
      .finally(() => setLoading(false));
  }, [pid]);

  useEffect(() => { refresh(); }, [refresh]);

  const runAction = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setActionBusy(key);
    setActionError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, [refresh]);

  if (reachable === false) {
    return (
      <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '20px 26px' }}>
        <CanonicalStoreFailureCard detail={reachError} />
      </div>
    );
  }

  if (reachable === null && loading) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>loading memory status…</div>
      </div>
    );
  }
  if (!status) return null;

  const { health, registry, capabilities } = status;
  const vectorDirty = registry?.vectorDirty ?? false;
  const backupStatus = registry?.backupStatus ?? 'none';

  return (
    <div className="content-pad" style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '18px 24px' }}>
      <div style={{ maxWidth: 1020, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Operations</div>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>
            schema v{health.schemaVersion} · revision {health.memoryRevision} · {fmtBytes(health.databaseSize)} ({health.sizeStatus})
          </span>
          <button
            onClick={refresh}
            disabled={loading}
            className="hover-border"
            style={{ cursor: loading ? 'default' : 'pointer', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--w-04)', border: '1px solid var(--w-08)', borderRadius: 7, padding: '4px 10px' }}
          >
            {loading ? 'refreshing…' : '↻ refresh'}
          </button>
        </div>

        {!isAdmin && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--w-03)', border: '1px solid var(--w-08)', borderRadius: 8, padding: '7px 10px' }}>
            Read-only view — operator actions (backup, restore, activation, cleanup) require the admin role.
          </div>
        )}
        {actionError && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red-soft)', background: 'rgba(255,92,92,.06)', border: '1px solid rgba(255,92,92,.25)', borderRadius: 8, padding: '8px 12px' }}>
            {actionError}
          </div>
        )}

        <Section title="Memory health">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <SignalCard
              label="Canonical store"
              tone="ok"
              detail="Reachable — the source of every number on this panel."
              guidance=""
            />
            <SignalCard
              label="Vector index"
              tone={vectorDirty ? 'warn' : 'ok'}
              detail={vectorDirty ? 'Marked dirty — a restore or rollback ran since the last rebuild; search results may miss recent changes.' : 'In sync with canonical memory.'}
              guidance="rebuild vectors (below)"
            />
            <SignalCard
              label="Backup"
              tone={backupStatus === 'failed' ? 'bad' : backupStatus === 'ok' ? 'ok' : backupStatus === 'pending' ? 'warn' : 'muted'}
              detail={
                backupStatus === 'none'
                  ? 'No backup has been taken yet for this project.'
                  : `${backupStatus} · last attempt ${fmtWhen(registry?.lastBackupAt ?? null)}`
              }
              guidance={backupStatus === 'failed' ? 'investigate R2 connectivity/quota, then retry' : 'trigger a backup (below)'}
            />
          </div>
          <SectionLabel>Optional bindings</SectionLabel>
          <div style={{ marginTop: 8 }}>
            <CapabilitiesStrip capabilities={capabilities} />
          </div>
        </Section>

        <Section title={`Repositories · ${repositories.length}`}>
          {repositories.length === 0 ? (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
              No repository is registered against this project's memory yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {repositories.map((r) => (
                <RepositoryCard
                  key={r.id}
                  repo={r}
                  isAdmin={isAdmin}
                  busy={actionBusy}
                  onActivate={(genId) => runAction(`activate:${genId}`, () => api.memoryActivateGeneration(pid, genId))}
                  onAbort={(genId) => runAction(`abort:${genId}`, () => api.memoryAbortGeneration(pid, genId))}
                />
              ))}
            </div>
          )}
        </Section>

        <BackupRestoreSection
          projectName={projectName}
          isAdmin={isAdmin}
          backups={backups}
          busy={actionBusy}
          lastBackup={lastBackup}
          onTriggerBackup={() =>
            runAction('backup', () =>
              api.memoryTriggerBackup(pid).then((r) => {
                if (r.ok) setLastBackup({ manifestKey: r.manifestKey });
                else throw new Error(r.reason);
              }),
            )
          }
          onRestore={(exportedAt) =>
            runAction(`restore:${exportedAt}`, () =>
              api.memoryRestore(pid, exportedAt).then((r) => {
                if (!r.ok) throw new Error(r.reason);
              }),
            )
          }
        />

        <RollbackSection
          isAdmin={isAdmin}
          projectName={projectName}
          hasPriorGeneration={health.hasPriorGeneration}
          busy={actionBusy}
          onRollback={() => runAction('rollback', () => api.memoryRollback(pid))}
          onDiscard={() => runAction('discard-retained', () => api.memoryPruneRetainedGeneration(pid))}
        />

        <Section title="Maintenance">
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.7, marginBottom: 10 }}>
            Runs the same idempotent cleanup the daily sweep performs for this project alone:
            abandoned staged generations, an expired retained rollback generation, backups beyond
            retention, superseded generations, and low-authority memory decay. Safe to re-run —
            nothing left to prune reports zero, not an error.
          </div>
          {isAdmin ? (
            <Button
              variant="ghost"
              disabled={actionBusy === 'sweep'}
              onClick={() => void runAction('sweep', () => api.memoryLifecycleSweep(pid).then((r) => setLastSweep(r)))}
            >
              {actionBusy === 'sweep' ? 'sweeping…' : 'Run lifecycle sweep'}
            </Button>
          ) : (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>admin role required</div>
          )}
          {lastSweep && (
            <div style={{ marginTop: 10, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-mid)', lineHeight: 1.8 }}>
              swept: {lastSweep.prunedStagedGenerations} staged generation(s), {lastSweep.prunedSupersededGenerations} superseded generation(s),{' '}
              {lastSweep.prunedRetainedGeneration ? '1' : '0'} expired retained generation, {lastSweep.prunedBackupGenerations} backup(s) over retention,{' '}
              {lastSweep.decayedMemories} decayed hypothesis(es)
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Repository card — active/staged generation state, and the two per-repository failure modes.
// ---------------------------------------------------------------------------------------------

function RepositoryCard({
  repo, isAdmin, busy, onActivate, onAbort,
}: {
  repo: ApiMemoryRepository;
  isAdmin: boolean;
  busy: string | null;
  onActivate: (generationId: string) => void;
  onAbort: (generationId: string) => void;
}) {
  return (
    <div style={{ border: '1px solid var(--w-07)', borderRadius: 10, padding: '12px 14px', background: 'var(--w-01)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600 }}>{repo.repositoryKey}</span>
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9}>{repo.indexingEnabled ? 'indexing enabled' : 'indexing disabled'}</MonoTag>
        {repo.defaultBranch && <MonoTag color="var(--text-dim)" bg="var(--w-04)" size={9}>{repo.defaultBranch}</MonoTag>}
        {repo.vcsKind && <MonoTag color="var(--text-dim)" bg="var(--w-04)" size={9}>{repo.vcsKind}</MonoTag>}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)' }}>{repo.checkouts.length} checkout(s)</span>
        <div style={{ flex: 1 }} />
        <StateChip tone={repo.stale ? 'warn' : 'ok'} label="stale index" />
        <StateChip tone={repo.failedIngest ? 'bad' : 'ok'} label="failed ingest" />
      </div>

      {/* Visible guidance, not a hover-only tooltip — a state a human can only discover by
       *  hovering is not "distinguishable" in any meaningful sense. Only rendered for the two
       *  states that are actually triggered, so a healthy repository stays uncluttered. */}
      {repo.stale && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', lineHeight: 1.6, marginBottom: 6 }}>
          ◐ stale index — active generation base {repo.activeGeneration?.baseId.slice(0, 10)} is behind the repository's current base ({repo.latestObservedBase?.slice(0, 10)}).
          {' '}→ ask the Runner to reindex this repository — indexing runs from the Runner, not this panel.
        </div>
      )}
      {repo.failedIngest && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red-soft)', lineHeight: 1.6, marginBottom: 6 }}>
          ✕ failed ingest — {repo.failedIngestProblems.join('; ') || `ingest status: ${repo.ingestStatus}`}.
          {' '}→ re-upload from the Runner once the underlying problem is fixed.
        </div>
      )}

      {repo.activeGeneration && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>
          active: {shortId(repo.activeGeneration.id)} · base {repo.activeGeneration.baseId.slice(0, 10)} · indexer {repo.activeGeneration.indexerVersion} ·{' '}
          {repo.activeGeneration.fileCount} file(s) · activated {fmtWhen(repo.activeGeneration.activatedAt)}
        </div>
      )}
      {!repo.activeGeneration && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', marginBottom: 6 }}>no active generation</div>
      )}

      {repo.stagedGenerations.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <SectionLabel>Staged generations · {repo.stagedGenerations.length}</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {repo.stagedGenerations.map((g) => (
              <StagedGenerationRow key={g.id} gen={g} isAdmin={isAdmin} busy={busy} onActivate={() => onActivate(g.id)} onAbort={() => onAbort(g.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StateChip({ tone, label }: { tone: SignalTone; label: string }) {
  const m = TONE_META[tone];
  return <MonoTag color={m.color} bg={m.bg} size={9}>{m.icon} {label}</MonoTag>;
}

/** A staged generation offers activation ONLY when the server reports it validated
 *  (`sealedAt` set and zero validationProblems) — disable-and-explain, never offer-then-fail
 *  (locked decision). The button is absent-but-explained, never present-but-erroring. */
function StagedGenerationRow({
  gen, isAdmin, busy, onActivate, onAbort,
}: {
  gen: ApiStagedGeneration;
  isAdmin: boolean;
  busy: string | null;
  onActivate: () => void;
  onAbort: () => void;
}) {
  const activating = busy === `activate:${gen.id}`;
  const aborting = busy === `abort:${gen.id}`;
  const notReadyReason = !gen.sealedAt
    ? 'still receiving/validating batches — not sealed yet'
    : gen.validationProblems.length > 0
      ? `failed validation: ${gen.validationProblems.join('; ')}`
      : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '7px 10px', borderRadius: 8, background: 'var(--w-02)', border: '1px solid var(--w-06)' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>{shortId(gen.id)}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>base {gen.baseId.slice(0, 10)}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>{gen.fileCount} file(s)</span>
      {gen.validated ? (
        <MonoTag color="var(--green)" bg="rgba(63,217,139,.12)" size={9}>✓ validated</MonoTag>
      ) : (
        <span title={notReadyReason ?? ''}>
          <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9}>◐ not ready</MonoTag>
        </span>
      )}
      <div style={{ flex: 1 }} />
      {isAdmin && (
        <>
          <button
            disabled={!gen.validated || activating || aborting}
            title={gen.validated ? 'activate this generation' : notReadyReason ?? ''}
            onClick={onActivate}
            className="hover-bright"
            style={{
              cursor: gen.validated && !activating ? 'pointer' : 'default',
              opacity: gen.validated ? 1 : 0.45,
              fontSize: 10.5, padding: '3px 10px', borderRadius: 6,
              background: 'var(--accent)', color: 'var(--bg)', border: '1px solid transparent',
            }}
          >
            {activating ? 'activating…' : 'activate'}
          </button>
          <button
            disabled={activating || aborting}
            onClick={onAbort}
            className="hover-bright"
            style={{ cursor: 'pointer', fontSize: 10.5, padding: '3px 10px', borderRadius: 6, background: 'transparent', color: 'var(--red-soft)', border: '1px solid rgba(255,92,92,.35)' }}
          >
            {aborting ? 'discarding…' : 'discard'}
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------------------------

function BackupRestoreSection({
  projectName, isAdmin, backups, busy, lastBackup, onTriggerBackup, onRestore,
}: {
  projectName: string;
  isAdmin: boolean;
  backups: { backups: string[]; r2Available: boolean } | null;
  busy: string | null;
  lastBackup: { manifestKey: string } | null;
  onTriggerBackup: () => void;
  onRestore: (exportedAt: string) => void;
}) {
  const r2Available = backups?.r2Available ?? true;

  return (
    <Section title="Backup & restore">
      {!r2Available ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 10 }}>
          <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9.5}>REDUCED CAPABILITY</MonoTag>
          <span style={{ fontSize: 11.5 }}>R2 is not configured on this instance — portable backup and restore are unavailable. This is a supported self-hosted configuration; live coordination and memory reads/writes are unaffected.</span>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            {isAdmin ? (
              <Button variant="ghost" disabled={busy === 'backup'} onClick={onTriggerBackup}>
                {busy === 'backup' ? 'backing up…' : 'Trigger backup'}
              </Button>
            ) : (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>admin role required to trigger a backup</span>
            )}
            {lastBackup && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>last: {lastBackup.manifestKey}</span>
            )}
          </div>

          <SectionLabel>Backups · {backups?.backups.length ?? 0}</SectionLabel>
          {backups && backups.backups.length === 0 && (
            <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>no backups yet</div>
          )}
          {backups && backups.backups.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {backups.backups.map((exportedAt) => (
                <div key={exportedAt} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 8, background: 'var(--w-02)', border: '1px solid var(--w-06)' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-soft)' }}>{exportedAt}</span>
                  <div style={{ flex: 1 }} />
                  {isAdmin && (
                    <button
                      disabled={busy === `restore:${exportedAt}`}
                      onClick={async () => {
                        const ok = await confirm(
                          `Restore ${projectName}'s memory from the ${exportedAt} backup?\n\nThis REPLACES the active generation with the restored one. The current generation is retained for a single rollback, but any generation more than one restore back is gone.`,
                          { title: 'Restore memory generation', danger: true, confirmLabel: 'Restore' },
                        );
                        if (ok) onRestore(exportedAt);
                      }}
                      className="hover-bright"
                      style={{ cursor: 'pointer', fontSize: 10.5, padding: '3px 10px', borderRadius: 6, background: 'transparent', color: 'var(--red-soft)', border: '1px solid rgba(255,92,92,.35)' }}
                    >
                      {busy === `restore:${exportedAt}` ? 'restoring…' : 'restore'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Rollback / discard retained generation — both gated on hasPriorGeneration (disable-and-explain,
// same principle activation uses): calling either with nothing retained is a real no-op the
// server itself reports, but the control never invites that click in the first place.
// ---------------------------------------------------------------------------------------------

function RollbackSection({
  isAdmin, projectName, hasPriorGeneration, busy, onRollback, onDiscard,
}: {
  isAdmin: boolean;
  projectName: string;
  hasPriorGeneration: boolean;
  busy: string | null;
  onRollback: () => void;
  onDiscard: () => void;
}) {
  return (
    <Section title="Retained rollback generation">
      {!hasPriorGeneration ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
          No retained generation — nothing to roll back to. A restore or rollback creates one automatically.
        </div>
      ) : (
        <>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.7, marginBottom: 10 }}>
            A prior generation is retained from the last restore or rollback — one level of undo only.
          </div>
          {isAdmin ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant="ghost"
                disabled={busy === 'rollback'}
                onClick={async () => {
                  const ok = await confirm(
                    `Roll ${projectName}'s memory back to the generation active before the last restore?\n\nThis is a single-level undo — the generation currently active is discarded, not retained.`,
                    { title: 'Roll back memory generation', danger: true, confirmLabel: 'Confirm rollback' },
                  );
                  if (ok) onRollback();
                }}
              >
                {busy === 'rollback' ? 'rolling back…' : 'Roll back'}
              </Button>
              <Button
                variant="danger"
                disabled={busy === 'discard-retained'}
                onClick={async () => {
                  const ok = await confirm(
                    `Discard the retained rollback generation for ${projectName}?\n\nThis gives up the ability to roll back at all — it does not affect the currently active generation.`,
                    { title: 'Discard retained generation', confirmLabel: 'Discard' },
                  );
                  if (ok) onDiscard();
                }}
              >
                {busy === 'discard-retained' ? 'discarding…' : 'Discard retained generation'}
              </Button>
            </div>
          ) : (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)' }}>admin role required</span>
          )}
        </>
      )}
    </Section>
  );
}
