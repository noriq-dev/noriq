import { useMemo, useState } from 'react';
import type { AppStore } from '../store';
import type { ProjectVM, ViewId } from '../types';
import { LIST_ROW_HEIGHT, MIN_INPUT_FONT_SIZE, MIN_TOUCH_TARGET } from '../viewport';
import { LiveDot } from './bits';
import { Sheet } from './Sheet';

export function ProjectSheet({ store, preserveView, onClose }: {
  store: AppStore;
  preserveView: ViewId;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const matches = (project: ProjectVM) => !normalized
    || project.name.toLowerCase().includes(normalized)
    || project.key.toLowerCase().includes(normalized);
  const ungrouped = store.data.projects.filter((project) => !project.groupId && matches(project));
  const grouped = useMemo(() => store.groups
    .map((group) => ({ group, projects: store.data.projects.filter((project) => project.groupId === group.id && matches(project)) }))
    .filter(({ projects }) => projects.length), [store.groups, store.data.projects, normalized]);
  const current = store.data.projects.find((project) => project.id === store.currentPid);
  const liveAgents = current?.liveAgentCount ?? store.data.agents[store.currentPid]?.length ?? 0;
  const claims = store.helpers.tasksOf(store.currentPid).filter((task) => task.claimedBy).length;
  const locks = store.snapshot?.locks?.length ?? 0;

  const select = (project: ProjectVM) => {
    store.actions.selectProject(project.id);
    store.actions.setView(preserveView);
    onClose();
  };

  return (
    <Sheet title="Projects" subtitle="switch scope without leaving this view" onClose={onClose}>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search projects"
        aria-label="Search projects"
        autoFocus
        style={{
          boxSizing: 'border-box', width: '100%', height: MIN_TOUCH_TARGET, padding: '0 13px',
          borderRadius: 10, background: 'var(--w-05)', border: '1px solid var(--w-1)',
          color: 'var(--text)', fontSize: MIN_INPUT_FONT_SIZE, outline: 'none', marginBottom: 10,
        }}
      />
      <div style={{ maxHeight: '48dvh', overflowY: 'auto' }}>
        {ungrouped.length > 0 && <ProjectGroup label="Your projects" projects={ungrouped} currentPid={store.currentPid} onSelect={select} />}
        {grouped.map(({ group, projects }) => (
          <ProjectGroup key={group.id} label={group.name} projects={projects} currentPid={store.currentPid} onSelect={select} />
        ))}
        {!ungrouped.length && !grouped.length && (
          <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>No projects match “{query}”.</div>
        )}
      </div>
      {current && (
        <div style={{ borderTop: '1px solid var(--w-07)', paddingTop: 12, marginTop: 8 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-faint)', marginBottom: 8 }}>
            This project
          </div>
          <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 2 }}>
            <ProjectChip label="Agents" count={liveAgents} onClick={() => { store.actions.setView('agents'); onClose(); }} />
            <ProjectChip label="Who holds what" count={claims} onClick={() => { store.actions.setView('control'); onClose(); }} />
            <ProjectChip label="File locks" count={locks} onClick={() => { store.actions.setView('control'); onClose(); }} />
          </div>
        </div>
      )}
    </Sheet>
  );
}

function ProjectGroup({ label, projects, currentPid, onSelect }: {
  label: string;
  projects: ProjectVM[];
  currentPid: string;
  onSelect: (project: ProjectVM) => void;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-faint)', padding: '8px 4px 4px' }}>
        {label} · {projects.length}
      </div>
      {projects.map((project) => <ProjectSheetRow key={project.id} project={project} active={project.id === currentPid} onClick={() => onSelect(project)} />)}
    </div>
  );
}

function ProjectSheetRow({ project, active, onClick }: { project: ProjectVM; active: boolean; onClick: () => void }) {
  const progress = project.totalTasks ? project.doneTasks / project.totalTasks : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%', minHeight: LIST_ROW_HEIGHT, padding: '6px 10px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', borderRadius: 10,
        background: active ? 'rgba(198,242,78,.09)' : 'transparent',
        border: `1px solid ${active ? 'rgba(198,242,78,.25)' : 'transparent'}`,
      }}
    >
      <span style={{ minWidth: 34, padding: '3px 6px', boxSizing: 'border-box', borderRadius: 5, background: 'var(--w-05)', color: active ? 'var(--accent)' : project.dotColor, fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, textAlign: 'center' }}>
        {project.key}
      </span>
      <span style={{ minWidth: 0, flex: 1, color: active ? 'var(--text)' : 'var(--text-soft)', fontSize: 14.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {project.name}
      </span>
      {project.hasLive ? <LiveDot size={7} /> : project.totalTasks > 0 ? (
        <span style={{ width: 26, height: 4, borderRadius: 3, background: 'var(--w-08)', overflow: 'hidden' }}>
          <span style={{ display: 'block', width: `${progress * 100}%`, height: '100%', background: progress === 1 ? 'var(--green)' : 'var(--w-25)' }} />
        </span>
      ) : null}
    </button>
  );
}

function ProjectChip({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ minHeight: 38, padding: '0 12px', borderRadius: 9, whiteSpace: 'nowrap', cursor: 'pointer', background: 'var(--w-04)', border: '1px solid var(--w-09)', color: 'var(--text-mid)', fontSize: 12 }}>
      {label} <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)', marginLeft: 3 }}>{count}</span>
    </button>
  );
}
