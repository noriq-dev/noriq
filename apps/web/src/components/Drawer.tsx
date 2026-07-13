// Task detail drawer — meta grid, claim/release action, comment thread, composer.
import type { AppStore } from '../store';
import { KIND_META, statusMeta } from '../design';
import { AvatarChip, MonoTag, SectionLabel } from './bits';
import { Composer } from './Composer';

export function Drawer({ store }: { store: AppStore }) {
  const { currentPid, selectedTaskId, helpers, actions } = store;
  const tasks = helpers.tasksOf(currentPid);
  const task = selectedTaskId != null ? tasks.find((t) => t.id === selectedTaskId) : null;
  if (!task) return null;

  const eff = helpers.effStatus(currentPid, task);
  const m = statusMeta(eff);
  const ag = task.claimedBy ? helpers.agentById(currentPid, task.claimedBy) : null;
  const depNames = task.deps.map((d) => {
    const dt = tasks.find((x) => x.id === d);
    return dt ? `${dt.key}${dt.status !== 'done' ? ' ⟂' : ' ✓'}` : `#${d}`;
  });
  const canClaim = !task.claimedBy && eff !== 'blocked' && task.status !== 'done';
  const canRelease = !!task.claimedBy;
  const openCount = task.comments.filter((c) => c.status === 'open').length;
  const holder = ag ? ag.name : eff === 'blocked' ? '— (blocked)' : '— (unclaimed)';

  return (
    <>
      <div onClick={actions.closeTask} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 40 }} />
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 460,
          background: 'var(--bg-raised)',
          borderLeft: '1px solid rgba(255,255,255,.1)',
          zIndex: 41,
          display: 'flex',
          flexDirection: 'column',
          animation: 'pl-drawer .28s cubic-bezier(.22,1,.36,1) both',
          boxShadow: '-20px 0 60px rgba(0,0,0,.5)',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', flex: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <MonoTag color={m.color} bg={m.bg} size={11}>{task.key}</MonoTag>
            <MonoTag color={m.color} bg={m.bg} size={10.5}>{m.label}</MonoTag>
            <div style={{ flex: 1 }} />
            <button
              onClick={actions.closeTask}
              className="drawer-x"
              style={{
                cursor: 'pointer',
                color: 'var(--text-dim)',
                fontSize: 18,
                width: 26,
                height: 26,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 6,
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35, letterSpacing: '-.01em' }}>{task.title}</div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: '#a9adb4', marginBottom: 18 }}>{task.body}</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
            <MetaCell label="Claimed by">
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                {ag && <AvatarChip name={ag.name} color={ag.color} size={20} radius={5} fontSize={9} />}
                <span style={{ fontSize: 12.5, fontWeight: 500, color: ag ? 'var(--text)' : 'var(--text-mid)' }}>{holder}</span>
              </div>
            </MetaCell>
            <MetaCell label="Dependencies">
              <div style={{ fontSize: 12.5, fontWeight: 500, color: depNames.length ? (eff === 'blocked' ? 'var(--red-soft)' : 'var(--text-mid)') : 'var(--text-mid)' }}>
                {depNames.length ? depNames.join(', ') : 'none'}
              </div>
            </MetaCell>
          </div>

          {(canClaim || canRelease) && (
            <button
              onClick={() => actions.claimToggle(task.id)}
              className="hover-bright"
              style={{
                cursor: 'pointer',
                boxSizing: 'border-box',
                width: '100%',
                textAlign: 'center',
                padding: 11,
                borderRadius: 10,
                background: canRelease ? 'transparent' : 'var(--accent)',
                color: canRelease ? 'var(--red-soft)' : 'var(--bg)',
                fontSize: 13,
                fontWeight: 600,
                marginBottom: 20,
                border: `1px solid ${canRelease ? 'rgba(255,92,92,.4)' : 'transparent'}`,
                display: 'block',
              }}
            >
              {canRelease ? `Force-release ${ag!.name}’s claim` : 'Claim as pilot'}
            </button>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
            <SectionLabel>Comments &amp; questions</SectionLabel>
            {openCount > 0 && <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{openCount} open</MonoTag>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 6 }}>
            {task.comments.map((c) => {
              const isHuman = c.author === 'you';
              const cag = c.role === 'agent' ? helpers.agentById(currentPid, c.author) : null;
              const kind = KIND_META[c.kind];
              const statusColor =
                c.status === 'addressed' ? 'var(--green)' : c.status === 'acknowledged' ? 'var(--text-mid)' : c.status === 'wont_do' ? 'var(--red-soft)' : 'var(--amber)';
              return (
                <div key={c.id} style={{ display: 'flex', gap: 10 }}>
                  <AvatarChip name={c.author} color={isHuman ? 'you' : cag?.color ?? '#4c9dff'} size={26} radius={7} fontSize={10} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{c.author}</span>
                      <MonoTag color={kind.color} bg={kind.bg} size={9}>{c.kind}</MonoTag>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: statusColor }}>{c.status}</span>
                    </div>
                    <div
                      style={{
                        fontSize: 12.5,
                        lineHeight: 1.55,
                        color: 'var(--text-soft)',
                        background: c.role === 'agent' ? 'rgba(76,157,255,.06)' : 'rgba(255,255,255,.03)',
                        border: `1px solid ${c.role === 'agent' ? 'rgba(76,157,255,.18)' : 'rgba(255,255,255,.07)'}`,
                        borderRadius: 10,
                        padding: '9px 12px',
                      }}
                    >
                      {c.body}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--line)', padding: '14px 20px', flex: 'none', background: 'var(--bg)' }}>
          <Composer store={store} placeholder={`Steer ${holder}…`} compact />
        </div>
      </div>
    </>
  );
}

function MetaCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.06)', borderRadius: 9, padding: '10px 12px' }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '.07em',
          color: 'var(--text-dim)',
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
