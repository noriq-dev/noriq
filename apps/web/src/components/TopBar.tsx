// Compact project navigation, human attention, and server-authored live presence.
import { useEffect, useState } from 'react';
import { api, type ApiAgent } from '../api';
import type { AppStore } from '../store';
import { PROJECT_NAV_GROUPS, PROJECT_NAV_ITEMS, type ProjectViewId } from '../project-navigation';
import { AvatarChip, LiveDot } from './bits';
import { Dropdown } from './Dropdown';

const PINNED_VIEWS: ProjectViewId[] = ['control', 'board', 'plans', 'review'];

const AGENT_COLORS = ['#4c9dff', '#b57bff', '#3fd98b', '#ff8a8a', '#c6f24e', '#f5a623'];
const MAX_VISIBLE_AGENTS = 4;

function agentColor(agent: ApiAgent): string {
  if (agent.role === 'orchestrator') return '#f5a623';
  let hash = 0;
  for (let index = 0; index < agent.id.length; index++) hash = (hash * 31 + agent.id.charCodeAt(index)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length]!;
}

/** Defensive filtering keeps a malformed or stale roster row out of the live presence surface. */
export function orderedLiveAgents(agents: ApiAgent[]): ApiAgent[] {
  return agents
    .filter((agent) => agent.live && agent.lifecycle === 'live')
    .sort((left, right) => {
      const work = Number(right.heldTasks > 0) - Number(left.heldTasks > 0);
      if (work) return work;
      const activity = Date.parse(right.activityAt) - Date.parse(left.activityAt);
      return activity || left.name.localeCompare(right.name);
    });
}

function agentTitle(agent: ApiAgent): string {
  return agent.heldTasks > 0
    ? `${agent.name} — working · ${agent.heldTasks} held task${agent.heldTasks === 1 ? '' : 's'}`
    : `${agent.name} — live, idle`;
}

const microLabel: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 7.5, letterSpacing: '.1em',
  textTransform: 'uppercase', color: 'var(--text-faint)', paddingLeft: 10,
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
    padding: '3px 10px', borderRadius: 6, fontSize: 12.5, whiteSpace: 'nowrap',
    fontWeight: active ? 650 : 500,
    color: active ? 'var(--text)' : 'var(--text-mid)',
    background: active ? 'rgba(198,242,78,.09)' : 'transparent',
    border: `1px solid ${active ? 'rgba(198,242,78,.25)' : 'transparent'}`,
  };
}

/** One GROUPS trigger + its menu. Menus list only the group's non-pinned views. */
function GroupMenu({
  label, items, activeView, onSelect,
}: {
  label: string;
  items: { id: ProjectViewId; label: string; description: string }[];
  activeView: string;
  onSelect: (id: ProjectViewId) => void;
}) {
  const containsActive = items.some((item) => item.id === activeView);
  return (
    <Dropdown
      value={containsActive ? activeView as ProjectViewId : null}
      options={items.map((item) => ({ value: item.id, label: item.label, description: item.description }))}
      onChange={onSelect}
      variant="inline"
      label={`${label} views`}
      displayValue={label}
      menuWidth={240}
      triggerStyle={{
        ...tabStyle(false),
        ...(containsActive ? { color: 'var(--text)', fontWeight: 650 } : null),
        gap: 5,
      }}
    />
  );
}

export function TopBar({ store }: { store: AppStore }) {
  const { currentPid, view, helpers, actions } = store;
  const tasks = helpers.tasksOf(currentPid);
  // Metadata carries the count even on surfaces that intentionally load no task rows.
  const reviewCount = store.snapshot?.project.reviewTasks
    ?? tasks.filter((task) => task.status === 'review' && !task.archivedAt).length;
  const [attnCount, setAttnCount] = useState(0);
  const [presence, setPresence] = useState<{ agents: ApiAgent[]; total: number } | null>(null);
  const [presenceUnavailable, setPresenceUnavailable] = useState(false);

  const pinned = PINNED_VIEWS
    .map((id) => PROJECT_NAV_ITEMS.find((item) => item.id === id))
    .filter((item): item is (typeof PROJECT_NAV_ITEMS)[number] => Boolean(item));
  const menuGroups = PROJECT_NAV_GROUPS
    .map((group) => ({ label: group.label, items: group.items.filter((item) => !PINNED_VIEWS.includes(item.id)) }))
    .filter((group) => group.items.length > 0);

  useEffect(() => {
    const load = () => api.attention().then((attention) => setAttnCount(attention.signals.length + attention.proposed.length + attention.overdue.length)).catch(() => {});
    load();
    const interval = setInterval(load, 45_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let currentRequest = true;
    setPresence(null);
    setPresenceUnavailable(false);
    const load = () => api.agents(currentPid, undefined, { lifecycle: 'live', limit: 100 })
      .then((roster) => {
        if (!currentRequest) return;
        setPresence({ agents: orderedLiveAgents(roster.agents), total: roster.counts.live });
        setPresenceUnavailable(false);
      })
      .catch(() => {
        if (currentRequest) setPresenceUnavailable(true);
      });
    void load();
    const interval = setInterval(() => void load(), 15_000);
    return () => {
      currentRequest = false;
      clearInterval(interval);
    };
  }, [currentPid]);

  const visibleAgents = presence?.agents.slice(0, MAX_VISIBLE_AGENTS) ?? [];
  const overflow = Math.max(0, (presence?.total ?? 0) - visibleAgents.length);
  const presenceLabel = presence
    ? presence.total === 0 ? 'No agents live' : `${presence.total} live`
    : presenceUnavailable ? 'Agents unavailable' : 'Checking agents';
  const presenceAria = presence
    ? presence.total === 0 ? 'No agents live; open Agents' : `${presence.total} live agent${presence.total === 1 ? '' : 's'}; open Agents`
    : presenceUnavailable ? 'Agent presence unavailable; open Agents' : 'Checking live agents; open Agents';

  return (
    <div
      className="topbar"
      style={{
        height: 48,
        flex: 'none',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        gap: 12,
        background: 'var(--bg-raised)',
      }}
    >
      {/* PINNED — the four core views, always flat */}
      <nav aria-label="Pinned views" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
        <span style={microLabel}>Pinned</span>
        <div style={{ display: 'flex', gap: 2 }}>
          {pinned.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === view ? 'page' : undefined}
              className="topbar-tab"
              onClick={() => actions.setView(item.id)}
              style={tabStyle(item.id === view)}
            >
              {item.label}
              {item.id === 'review' && reviewCount > 0 && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, color: 'var(--amber)', background: 'rgba(245,166,35,.14)', padding: '0 5px', borderRadius: 7, lineHeight: '14px' }}>
                  {reviewCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      <span style={{ width: 1, height: 26, background: 'var(--w-06)', flex: 'none' }} />

      {/* GROUPS — everything else, one click away */}
      <nav aria-label="View groups" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
        <span style={microLabel}>Groups</span>
        <div style={{ display: 'flex', gap: 2 }}>
          {menuGroups.map((group) => (
            <GroupMenu key={group.label} label={group.label} items={group.items} activeView={view} onSelect={(id) => actions.setView(id)} />
          ))}
        </div>
      </nav>

      <div style={{ flex: 1 }} />

      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>⌘F</span>

      <button
        type="button"
        onClick={() => actions.setView('project-settings')}
        aria-label="Project settings"
        aria-current={view === 'project-settings' ? 'page' : undefined}
        title="Project settings"
        className="hover-border"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, minHeight: 30, padding: '4px 8px', borderRadius: 8, border: `1px solid ${view === 'project-settings' ? 'rgba(198,242,78,.25)' : 'var(--w-07)'}`, background: view === 'project-settings' ? 'rgba(198,242,78,.09)' : 'var(--w-02)', color: view === 'project-settings' ? 'var(--text)' : 'var(--text-mid)', whiteSpace: 'nowrap' }}
      >
        <span aria-hidden="true" style={{ fontSize: 12 }}>⚙</span>
        <span style={{ fontSize: 11.5 }}>Settings</span>
      </button>

      {!store.permissions.canContribute && (
        <span title={store.permissions.cappedByReadOnly ? 'Your account is read-only' : 'Your project role is view-only'} style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', border: '1px solid var(--w-1)', borderRadius: 7, padding: '4px 8px', whiteSpace: 'nowrap' }}>
          {store.permissions.cappedByReadOnly ? 'READ ONLY' : `${(store.permissions.effectiveRole ?? 'viewer').toUpperCase()}`}
        </span>
      )}

      {attnCount > 0 && (
        <button type="button" onClick={() => actions.setView('home')} aria-label={`${attnCount} item(s) need attention across all projects`} className="hover-bright" title={`${attnCount} item(s) need you across all projects — open Home`} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(245,166,35,.1)', border: '1px solid rgba(245,166,35,.3)', borderRadius: 8, padding: '5px 9px', color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
          <span aria-hidden="true">🔔</span> {attnCount}
        </button>
      )}

      {store.permissions.canContribute && (
        <button type="button" onClick={() => actions.createTask()} className="hover-bright" title="New task" style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent-ink)', background: 'rgba(198,242,78,.1)', border: '1px solid rgba(198,242,78,.3)', padding: '5px 11px', borderRadius: 8, whiteSpace: 'nowrap' }}>
          + task
        </button>
      )}

      <button
        type="button"
        onClick={() => actions.setView('agents')}
        aria-label={presenceAria}
        title={presenceUnavailable ? 'The live-agent roster could not be refreshed' : 'Open live agents'}
        className="hover-border"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, padding: '3px 7px', borderRadius: 9, border: '1px solid var(--w-07)', background: 'var(--w-02)', color: presenceUnavailable ? 'var(--amber)' : presence?.total ? 'var(--green)' : 'var(--text-dim)' }}
      >
        {Boolean(presence?.total) && <LiveDot />}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, whiteSpace: 'nowrap' }}>{presenceLabel}</span>
        {visibleAgents.length > 0 && (
          <span style={{ display: 'flex', paddingLeft: 5 }}>
            {visibleAgents.map((agent) => (
              <span key={agent.id} style={{ marginLeft: -7, borderRadius: '50%', border: '2px solid var(--bg-raised)' }}>
                <AvatarChip name={agent.name} color={agentColor(agent)} size={24} radius={12} fontSize={9} dot={agent.heldTasks > 0 ? 'var(--blue)' : 'var(--green)'} title={agentTitle(agent)} />
              </span>
            ))}
            {overflow > 0 && (
              <span title={`${overflow} more live agent${overflow === 1 ? '' : 's'}`} style={{ width: 24, height: 24, marginLeft: -7, borderRadius: '50%', border: '2px solid var(--bg-raised)', background: 'var(--w-12)', color: 'var(--text-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 8.5, fontWeight: 700 }}>
                +{overflow}
              </span>
            )}
          </span>
        )}
      </button>
    </div>
  );
}
