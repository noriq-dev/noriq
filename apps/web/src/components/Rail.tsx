// Workspace rail — project switcher (left edge).
import type { AppStore } from '../store';

export function Rail({ store }: { store: AppStore }) {
  const { data, currentPid, actions } = store;
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
      }}
    >
      <div
        title="planar"
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          background: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
        }}
      >
        <div style={{ width: 14, height: 14, background: 'var(--bg)', transform: 'rotate(45deg)' }} />
      </div>

      {data.projects.map((p) => {
        const active = p.id === currentPid;
        const hasLive = (data.tasks[p.id] ?? []).some((t) => t.status === 'in_progress');
        return (
          <button
            key={p.id}
            onClick={() => actions.selectProject(p.id)}
            title={p.name}
            className="hover-bright"
            style={{
              cursor: 'pointer',
              position: 'relative',
              width: 40,
              height: 40,
              borderRadius: 11,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              fontWeight: 700,
              background: active ? 'rgba(198,242,78,.12)' : 'rgba(255,255,255,.04)',
              color: active ? 'var(--accent)' : 'var(--text-soft)',
              border: `1px solid ${active ? 'rgba(198,242,78,.35)' : 'rgba(255,255,255,.07)'}`,
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: -8,
                top: 9,
                bottom: 9,
                width: 3,
                borderRadius: 2,
                background: active ? 'var(--accent)' : 'transparent',
              }}
            />
            {p.badge}
            {hasLive && (
              <span
                style={{
                  position: 'absolute',
                  right: -2,
                  top: -2,
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  border: '2px solid var(--bg-rail)',
                }}
              />
            )}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />
      <button
        title="New project"
        className="rail-add"
        style={{
          cursor: 'pointer',
          width: 40,
          height: 40,
          borderRadius: 11,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-dim)',
          fontSize: 20,
          border: '1px dashed rgba(255,255,255,.14)',
        }}
      >
        +
      </button>
      <div
        title="you · supervisor"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'linear-gradient(135deg,#c6f24e,#3fd98b)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          color: 'var(--bg)',
          fontWeight: 700,
          marginTop: 8,
        }}
      >
        Y
      </div>
    </div>
  );
}
