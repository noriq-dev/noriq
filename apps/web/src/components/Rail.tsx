// Sidebar — labeled project navigation that scales with groups and users.
// (Replaced the unreadable 62px icon rail — PLNR-49.)
import { useState } from 'react';
import type { AppStore } from '../store';
import type { ProjectVM } from '../types';
import { LiveDot } from './bits';

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('planar.sidebar.collapsed') ?? '{}');
  } catch {
    return {};
  }
}

export function Rail({ store }: { store: AppStore }) {
  const { data, currentPid, actions, groups } = store;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const ungrouped = data.projects.filter((p) => !p.groupId);
  const grouped = groups
    .map((g) => ({ group: g, projects: data.projects.filter((p) => p.groupId === g.id) }))
    .filter((g) => g.projects.length > 0);

  const toggle = (gid: string) => {
    setCollapsed((c) => {
      const next = { ...c, [gid]: !c[gid] };
      localStorage.setItem('planar.sidebar.collapsed', JSON.stringify(next));
      return next;
    });
  };

  return (
    <div
      style={{
        width: 216,
        flex: 'none',
        background: 'var(--bg-rail)',
        borderRight: '1px solid rgba(255,255,255,.06)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflowX: 'hidden',
      }}
    >
      {/* header / home */}
      <button
        onClick={() => actions.goHome()}
        className="hover-bright"
        style={{
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 14px 12px', flex: 'none', textAlign: 'left',
        }}
      >
        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <div style={{ width: 11, height: 11, background: 'var(--bg)', transform: 'rotate(45deg)' }} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5, letterSpacing: '-.01em', color: 'var(--text)' }}>planar</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', letterSpacing: '.06em' }}>MISSION CONTROL</div>
        </div>
      </button>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '2px 8px 8px', minHeight: 0 }}>
        {ungrouped.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '8px 8px 5px' }}>
              your projects
            </div>
            {ungrouped.map((p) => (
              <ProjectRow key={p.id} p={p} active={p.id === currentPid} onSelect={() => actions.selectProject(p.id)} />
            ))}
          </div>
        )}

        {grouped.map(({ group, projects }) => {
          const isCollapsed = collapsed[group.id] ?? false;
          const liveCount = projects.filter((p) => p.hasLive).length;
          return (
            <div key={group.id} style={{ marginBottom: 6 }}>
              <button
                onClick={() => toggle(group.id)}
                style={{
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  padding: '8px 8px 5px', textAlign: 'left', background: 'transparent',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--text-faint)',
                    transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform .12s', display: 'inline-block',
                  }}
                >
                  ▶
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                  {group.name}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{projects.length}</span>
                {isCollapsed && liveCount > 0 && <LiveDot size={5} />}
              </button>
              {!isCollapsed && projects.map((p) => (
                <ProjectRow key={p.id} p={p} active={p.id === currentPid} onSelect={() => actions.selectProject(p.id)} />
              ))}
            </div>
          );
        })}
      </div>

      {/* footer */}
      <div style={{ flex: 'none', borderTop: '1px solid rgba(255,255,255,.06)', padding: 8 }}>
        <FooterRow icon="+" label="New project" onClick={() => actions.createProject()} />
        <FooterRow icon="⚙" label="Settings" onClick={() => actions.setView('settings')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px' }}>
          <div
            style={{
              width: 24, height: 24, borderRadius: '50%', flex: 'none',
              background: 'linear-gradient(135deg,#c6f24e,#3fd98b)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10.5, color: 'var(--bg)', fontWeight: 700,
            }}
          >
            {(store.user?.name ?? 'Y').slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {store.user?.name ?? 'you'}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{store.user?.role ?? 'supervisor'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectRow({ p, active, onSelect }: { p: ProjectVM; active: boolean; onSelect: () => void }) {
  const pct = p.totalTasks ? p.doneTasks / p.totalTasks : 0;
  return (
    <button
      onClick={onSelect}
      className="hover-bright"
      style={{
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 8px', borderRadius: 8, textAlign: 'left',
        background: active ? 'rgba(198,242,78,.09)' : 'transparent',
        border: `1px solid ${active ? 'rgba(198,242,78,.25)' : 'transparent'}`,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, flex: 'none',
          color: active ? 'var(--accent)' : p.dotColor,
          background: 'rgba(255,255,255,.05)', padding: '2px 5px', borderRadius: 4, minWidth: 26, textAlign: 'center',
        }}
      >
        {p.key}
      </span>
      <span
        style={{
          fontSize: 12, fontWeight: 500, minWidth: 0, flex: 1,
          color: active ? 'var(--text)' : 'var(--text-soft)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {p.name}
      </span>
      {p.hasLive ? (
        <LiveDot size={6} />
      ) : p.totalTasks > 0 ? (
        <span style={{ width: 22, height: 3, borderRadius: 2, background: 'rgba(255,255,255,.08)', overflow: 'hidden', flex: 'none' }}>
          <span style={{ display: 'block', height: '100%', width: `${pct * 100}%`, background: pct === 1 ? 'var(--green)' : 'rgba(255,255,255,.25)' }} />
        </span>
      ) : null}
    </button>
  );
}

function FooterRow({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="hover-bright"
      style={{
        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, width: '100%',
        padding: '7px 8px', borderRadius: 8, textAlign: 'left', background: 'transparent',
      }}
    >
      <span style={{ width: 24, height: 24, borderRadius: 7, border: '1px dashed rgba(255,255,255,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--text-dim)', flex: 'none' }}>
        {icon}
      </span>
      <span style={{ fontSize: 12, color: 'var(--text-mid)' }}>{label}</span>
    </button>
  );
}
