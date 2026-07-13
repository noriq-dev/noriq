// Workspace rail — project switcher, grouped (ungrouped first, then labeled groups).
import type { AppStore } from '../store';
import type { ProjectVM } from '../types';

export function Rail({ store }: { store: AppStore }) {
  const { data, currentPid, actions, groups } = store;
  const ungrouped = data.projects.filter((p) => !p.groupId);
  const grouped = groups
    .map((g) => ({ group: g, projects: data.projects.filter((p) => p.groupId === g.id) }))
    .filter((g) => g.projects.length > 0);

  return (
    <div
      style={{
        width: 62,
        flex: 'none',
        background: 'var(--bg-rail)',
        borderRight: '1px solid rgba(255,255,255,.06)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '14px 0',
        gap: 6,
        overflowY: 'auto',
      }}
    >
      <button
        title="planar · home"
        onClick={() => actions.goHome()}
        className="hover-bright"
        style={{
          cursor: 'pointer', width: 34, height: 34, borderRadius: 9, background: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8, flex: 'none',
        }}
      >
        <div style={{ width: 14, height: 14, background: 'var(--bg)', transform: 'rotate(45deg)' }} />
      </button>

      {ungrouped.map((p) => (
        <RailProject
          key={p.id}
          p={p}
          active={p.id === currentPid}
          hasLive={p.hasLive || (data.tasks[p.id] ?? []).some((t) => t.status === 'in_progress')}
          onSelect={() => actions.selectProject(p.id)}
        />
      ))}

      {grouped.map(({ group, projects }) => (
        <div key={group.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: '100%', flex: 'none' }}>
          <div title={group.name} style={{ width: 36, display: 'flex', alignItems: 'center', gap: 4, margin: '4px 0 0' }}>
            <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.1)' }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 7.5, letterSpacing: '.06em', color: 'var(--text-faint)', textTransform: 'uppercase' }}>
              {group.name.slice(0, 3)}
            </span>
            <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.1)' }} />
          </div>
          {projects.map((p) => (
            <RailProject
              key={p.id}
              p={p}
              active={p.id === currentPid}
              hasLive={p.hasLive || (data.tasks[p.id] ?? []).some((t) => t.status === 'in_progress')}
              onSelect={() => actions.selectProject(p.id)}
            />
          ))}
        </div>
      ))}

      <div style={{ flex: 1, minHeight: 12 }} />
      <button
        title="New project"
        onClick={() => actions.createProject()}
        className="rail-add"
        style={{
          cursor: 'pointer', width: 40, height: 40, borderRadius: 11, flex: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', fontSize: 20, border: '1px dashed rgba(255,255,255,.14)',
        }}
      >
        +
      </button>
      <button
        title="Settings"
        onClick={() => actions.setView('settings')}
        className="rail-add"
        style={{
          cursor: 'pointer', width: 34, height: 34, borderRadius: 10, flex: 'none', marginTop: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', fontSize: 15, border: '1px solid rgba(255,255,255,.08)',
        }}
      >
        ⚙
      </button>
      <div
        title={`${store.user?.name ?? 'you'} · supervisor`}
        style={{
          width: 32, height: 32, borderRadius: '50%', flex: 'none',
          background: 'linear-gradient(135deg,#c6f24e,#3fd98b)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, color: 'var(--bg)', fontWeight: 700, marginTop: 8,
        }}
      >
        {(store.user?.name ?? 'Y').slice(0, 1).toUpperCase()}
      </div>
    </div>
  );
}

function RailProject({ p, active, hasLive, onSelect }: { p: ProjectVM; active: boolean; hasLive: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      title={p.name}
      className="hover-bright"
      style={{
        cursor: 'pointer', position: 'relative', width: 40, height: 40, borderRadius: 11, flex: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
        background: active ? 'rgba(198,242,78,.12)' : 'rgba(255,255,255,.04)',
        color: active ? 'var(--accent)' : 'var(--text-soft)',
        border: `1px solid ${active ? 'rgba(198,242,78,.35)' : 'rgba(255,255,255,.07)'}`,
      }}
    >
      <span
        style={{
          position: 'absolute', left: -8, top: 9, bottom: 9, width: 3, borderRadius: 2,
          background: active ? 'var(--accent)' : 'transparent',
        }}
      />
      {p.badge}
      {hasLive && (
        <span
          style={{
            position: 'absolute', right: -2, top: -2, width: 9, height: 9, borderRadius: '50%',
            background: 'var(--accent)', border: '2px solid var(--bg-rail)',
          }}
        />
      )}
    </button>
  );
}
