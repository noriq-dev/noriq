import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppStore } from '../store';
import { LIST_ROW_HEIGHT, MIN_TOUCH_TARGET } from '../viewport';
import { AvatarChip } from './bits';
import { DESKTOP_ONLY_VIEWS, type DesktopOnlyView } from './DesktopOnly';
import { ThemeButton } from './ThemeButton';

const NOTIFICATION_KEY = 'noriq.mobile.notifications';
const appVersion = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;

function initialNotifications(): { decisions: boolean; runFailures: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(NOTIFICATION_KEY) ?? '{}') as Record<string, unknown>;
    return { decisions: stored.decisions !== false, runFailures: stored.runFailures !== false };
  } catch {
    return { decisions: true, runFailures: true };
  }
}

export function MoreView({ store }: { store: AppStore }) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const [pendingUsers, setPendingUsers] = useState(0);
  const project = store.data.projects.find((candidate) => candidate.id === store.currentPid) ?? store.data.projects[0];

  useEffect(() => {
    if (!store.isAdmin) return;
    api.users().then(({ users }) => setPendingUsers(users.filter((user) => !!user.pending).length)).catch(() => {});
  }, [store.isAdmin]);

  const updateNotification = (key: keyof typeof notifications) => {
    setNotifications((current) => {
      const next = { ...current, [key]: !current[key] };
      localStorage.setItem(NOTIFICATION_KEY, JSON.stringify(next));
      return next;
    });
  };
  const openProjectTool = (view: DesktopOnlyView) => {
    if (!store.currentPid && project) store.actions.selectProject(project.id);
    store.actions.setView(view);
  };

  return (
    <main data-testid="more-view" style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '14px 14px 24px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <section style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 10px 18px' }}>
          <AvatarChip name={store.user?.name ?? 'You'} color="you" size={42} radius={21} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{store.user?.name ?? 'You'}</div>
            <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 9.5, marginTop: 3 }}>{store.user?.accessMode === 'read_only' ? 'read only' : store.user?.role ?? 'member'}</div>
          </div>
        </section>

        <MoreSection title="Workspace">
          <MoreRow icon="⚙" label="Settings" detail="Account, password, and groups" onClick={() => store.actions.setView('settings')} />
          {store.isAdmin && <MoreRow icon="◈" label="Admin" detail="Instance projects and access" count={pendingUsers} onClick={() => store.actions.openAdmin()} />}
          <div style={{ minHeight: LIST_ROW_HEIGHT, display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px' }}>
            <span style={iconStyle}>◐</span><div style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>Appearance</div><ThemeButton size={MIN_TOUCH_TARGET} label />
          </div>
        </MoreSection>

        <MoreSection title="Notifications">
          <ToggleRow label="Decisions" detail="Questions waiting for your answer" checked={notifications.decisions} onToggle={() => updateNotification('decisions')} />
          <ToggleRow label="Run failures" detail="Runs that stop without landing" checked={notifications.runFailures} onToggle={() => updateNotification('runFailures')} />
          <div style={{ padding: '5px 10px 10px', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9 }}>Preferences only · notification delivery is not enabled yet.</div>
        </MoreSection>

        {project && <MoreSection title={`Project tools · ${project.key}`}>
          <MoreRow
            icon="☷"
            label="Plans"
            detail="Review phases, tasks, gates, and plan documents"
            onClick={() => {
              if (!store.currentPid) store.actions.selectProject(project.id);
              store.actions.setView('plans');
            }}
          />
        </MoreSection>}

        {project && <MoreSection title={`Desktop tools · ${project.key}`}>
          {(Object.keys(DESKTOP_ONLY_VIEWS) as DesktopOnlyView[]).map((view) => <MoreRow key={view} icon="▱" label={DESKTOP_ONLY_VIEWS[view][0]} detail="Open the desktop handoff card" onClick={() => openProjectTool(view)} />)}
        </MoreSection>}

        <footer style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px 4px', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5 }}>
          <span style={{ alignSelf: 'center' }}>v{appVersion}</span><a href="https://noriq.dev" target="_blank" rel="noreferrer" style={{ minHeight: MIN_TOUCH_TARGET, display: 'flex', alignItems: 'center', color: 'inherit', textDecoration: 'none' }}>noriq.dev →</a>
        </footer>
      </div>
    </main>
  );
}

const iconStyle = { width: 34, height: 34, borderRadius: 9, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--w-04)', border: '1px solid var(--w-08)', color: 'var(--text-dim)', fontSize: 14 } as const;

function MoreSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={{ marginBottom: 18 }}><h2 style={{ margin: '0 0 6px 10px', color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.08em' }}>{title}</h2><div style={{ overflow: 'hidden', borderRadius: 12, background: 'var(--card)', border: '1px solid var(--w-07)' }}>{children}</div></section>;
}

function MoreRow({ icon, label, detail, count, onClick }: { icon: string; label: string; detail: string; count?: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} style={{ width: '100%', minHeight: LIST_ROW_HEIGHT, display: 'flex', alignItems: 'center', gap: 12, padding: '7px 10px', cursor: 'pointer', textAlign: 'left', borderBottom: '1px solid var(--w-05)' }}><span style={iconStyle}>{icon}</span><span style={{ flex: 1, minWidth: 0 }}><b style={{ display: 'block', fontSize: 13.5 }}>{label}</b><small style={{ display: 'block', marginTop: 2, color: 'var(--text-dim)', fontSize: 10.5 }}>{detail}</small></span>{count !== undefined && count > 0 && <span aria-label={`${count} pending`} style={{ minWidth: 20, height: 20, padding: '0 5px', borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--amber)', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 800 }}>{count}</span>}<span aria-hidden="true" style={{ color: 'var(--text-faint)' }}>›</span></button>;
}

function ToggleRow({ label, detail, checked, onToggle }: { label: string; detail: string; checked: boolean; onToggle: () => void }) {
  return <label style={{ minHeight: LIST_ROW_HEIGHT, display: 'flex', alignItems: 'center', gap: 12, padding: '7px 11px', borderBottom: '1px solid var(--w-05)' }}><span style={{ flex: 1 }}><b style={{ display: 'block', fontSize: 13.5 }}>{label}</b><small style={{ color: 'var(--text-dim)', fontSize: 10.5 }}>{detail}</small></span><input type="checkbox" checked={checked} onChange={onToggle} style={{ width: 22, height: 22, accentColor: 'var(--accent)' }} /></label>;
}
