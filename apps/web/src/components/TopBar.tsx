// Compact project navigation, human attention, and server-authored live presence.
import { useEffect, useRef, useState } from 'react';
import { api, type ApiAgent } from '../api';
import type { AppStore } from '../store';
import { PROJECT_NAV_GROUPS, projectNavigationContext, type ProjectViewId } from '../project-navigation';
import { AvatarChip, LiveDot } from './bits';

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

export function TopBar({ store }: { store: AppStore }) {
  const { currentPid, view, helpers, actions } = store;
  const tasks = helpers.tasksOf(currentPid);
  const reviewCount = tasks.filter((task) => task.status === 'review' && !task.archivedAt).length;
  const current = projectNavigationContext(view);
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [attnCount, setAttnCount] = useState(0);
  const [presence, setPresence] = useState<{ agents: ApiAgent[]; total: number } | null>(null);
  const [presenceUnavailable, setPresenceUnavailable] = useState(false);

  useEffect(() => {
    const load = () => api.attention().then((attention) => setAttnCount(attention.signals.length + attention.overdue.length)).catch(() => {});
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

  useEffect(() => {
    if (!navOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setNavOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [navOpen]);

  const selectView = (next: ProjectViewId) => {
    setNavOpen(false);
    actions.setView(next);
  };
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
        padding: '0 16px',
        gap: 10,
        background: 'var(--bg-raised)',
      }}
    >
      <div ref={navRef} style={{ position: 'relative', flex: 'none' }}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={navOpen}
          aria-label={`Switch project view, current ${current.item.label}`}
          onClick={() => setNavOpen((open) => !open)}
          className="hover-border"
          style={{
            minWidth: 176,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '5px 9px',
            border: '1px solid var(--w-09)',
            borderRadius: 8,
            background: 'var(--w-03)',
            textAlign: 'left',
          }}
        >
          <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
            {current.group.label}
          </span>
          <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)', whiteSpace: 'nowrap' }}>{current.item.label}</span>
          <span aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 10 }}>▾</span>
        </button>

        {navOpen && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="Project destinations"
            onKeyDown={(event) => {
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const nextIndex = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1)
                : event.key === 'ArrowUp' ? Math.max(0, index - 1)
                  : event.key === 'Home' ? 0
                    : event.key === 'End' ? items.length - 1
                      : -1;
              if (nextIndex >= 0) {
                event.preventDefault();
                items[nextIndex]?.focus();
              }
            }}
            style={{
              position: 'absolute',
              zIndex: 70,
              top: 'calc(100% + 8px)',
              left: 0,
              width: 'min(540px, calc(100vw - 28px))',
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 8,
              padding: 10,
              border: '1px solid var(--w-12)',
              borderRadius: 12,
              background: 'var(--bg-raised)',
              boxShadow: '0 18px 55px rgba(0,0,0,.5)',
            }}
          >
            {PROJECT_NAV_GROUPS.map((group) => (
              <div key={group.label} style={{ minWidth: 0, padding: 4 }}>
                <div style={{ padding: '2px 7px 6px', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const selected = item.id === view;
                  const itemReviewCount = item.id === 'review' ? reviewCount : 0;
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      aria-current={selected ? 'page' : undefined}
                      key={item.id}
                      onClick={() => selectView(item.id)}
                      style={{
                        width: '100%',
                        cursor: 'pointer',
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: '2px 8px',
                        padding: '7px 8px',
                        borderRadius: 7,
                        textAlign: 'left',
                        background: selected ? 'var(--w-08)' : 'transparent',
                        color: selected ? 'var(--text)' : 'var(--text-mid)',
                      }}
                    >
                      <span style={{ fontSize: 12.5, fontWeight: selected ? 650 : 500 }}>{item.label}</span>
                      {itemReviewCount > 0 && <span style={{ gridRow: '1 / span 2', gridColumn: 2, alignSelf: 'center', fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, color: 'var(--amber)', background: 'rgba(245,166,35,.14)', padding: '1px 6px', borderRadius: 8 }}>{itemReviewCount}</span>}
                      <span style={{ gridColumn: 1, fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{item.description}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {store.permissions.canManage && (
              <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--w-07)', padding: '7px 4px 0' }}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setNavOpen(false);
                    actions.openModal('project-edit');
                  }}
                  style={{ width: '100%', cursor: 'pointer', padding: '7px 8px', borderRadius: 7, textAlign: 'left', color: 'var(--text-mid)', fontFamily: 'var(--mono)', fontSize: 10.5 }}
                >
                  Project settings
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
        ⌘K
      </span>
      <div style={{ flex: 1 }} />

      {!store.permissions.canContribute && (
        <span title={store.permissions.cappedByReadOnly ? 'Your account is read-only' : 'Your project role is view-only'} style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)', border: '1px solid var(--w-1)', borderRadius: 7, padding: '4px 8px', whiteSpace: 'nowrap' }}>
          {store.permissions.cappedByReadOnly ? 'READ ONLY' : `${(store.permissions.effectiveRole ?? 'viewer').toUpperCase()}`}
        </span>
      )}

      {reviewCount > 0 && (
        <button type="button" onClick={() => actions.setView('review')} title={`${reviewCount} task${reviewCount === 1 ? '' : 's'} awaiting review in this project`} style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, color: 'var(--amber)', background: 'rgba(245,166,35,.1)', border: '1px solid rgba(245,166,35,.25)', borderRadius: 8, padding: '5px 9px', whiteSpace: 'nowrap' }}>
          Review {reviewCount}
        </button>
      )}

      {attnCount > 0 && (
        <button type="button" onClick={() => actions.setView('home')} title={`${attnCount} item(s) need you across all projects — open Home`} style={{ cursor: 'pointer', background: 'rgba(245,166,35,.1)', border: '1px solid rgba(245,166,35,.3)', borderRadius: 8, padding: '5px 9px', color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
          Attention {attnCount}
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
