// Top bar — project identity, view tabs, live indicator, presence avatars.
import type { AppStore } from '../store';
import type { ViewId } from '../types';
import { AvatarChip, LiveDot } from './bits';

const TABS: Array<{ id: ViewId; label: string }> = [
  { id: 'control', label: 'Mission Control' },
  { id: 'graph', label: 'Orchestration' },
  { id: 'board', label: 'Board' },
  { id: 'plans', label: 'Plans' },
  { id: 'agents', label: 'Agents' },
];

export function TopBar({ store }: { store: AppStore }) {
  const { data, currentPid, view, helpers, actions } = store;
  const project = data.projects.find((p) => p.id === currentPid)!;
  const agents = data.agents[currentPid] ?? [];
  const tasks = helpers.tasksOf(currentPid);
  const activeCount = agents.filter(
    (a) => a.role === 'orch' || tasks.some((t) => t.claimedBy === a.id && t.status === 'in_progress'),
  ).length;

  return (
    <div
      className="topbar"
      style={{
        height: 54,
        flex: 'none',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        gap: 16,
        background: 'var(--bg-raised)',
      }}
    >
      <div
        onClick={() => actions.openModal('project-edit')}
        title="Edit project settings"
        className="hover-border topbar-project"
        style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, overflow: 'hidden', flexShrink: 1, cursor: 'pointer', padding: '4px 8px', margin: '-4px -8px', borderRadius: 8, border: '1px solid transparent' }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            fontWeight: 600,
            color: project.dotColor,
            background: 'var(--w-05)',
            padding: '2px 7px',
            borderRadius: 5,
            flex: 'none',
          }}
        >
          {project.key}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: '-.01em', whiteSpace: 'nowrap', flex: 'none' }}>
          {project.name}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--text-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
        >
          {project.phase}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 2,
          background: 'var(--w-04)',
          border: '1px solid var(--w-06)',
          borderRadius: 9,
          padding: 3,
          marginLeft: 6,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => actions.setView(t.id)}
            style={{
              cursor: 'pointer',
              padding: '5px 12px',
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 500,
              background: view === t.id ? 'var(--w-1)' : 'transparent',
              color: view === t.id ? 'var(--text)' : 'var(--text-mid)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <button
        onClick={() => actions.createTask()}
        className="hover-bright"
        title="New task"
        style={{
          cursor: 'pointer',
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          color: 'var(--accent-ink)',
          background: 'rgba(198,242,78,.1)',
          border: '1px solid rgba(198,242,78,.3)',
          padding: '5px 11px',
          borderRadius: 8,
        }}
      >
        + task
      </button>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          color: 'var(--green)',
        }}
      >
        <LiveDot />
        {activeCount} live · ws
      </div>

      <div style={{ display: 'flex', paddingLeft: 4 }}>
        {agents.slice(0, 5).map((a) => (
          <div key={a.id} style={{ marginLeft: -8, borderRadius: '50%', border: '2px solid var(--bg-raised)' }}>
            <AvatarChip name={a.name} color={a.color} size={26} radius={13} />
          </div>
        ))}
      </div>
    </div>
  );
}
