import { useAppStore } from './store';
import { Rail } from './components/Rail';
import { TopBar } from './components/TopBar';
import { MissionControl } from './components/MissionControl';
import { Graph } from './components/Graph';
import { Board } from './components/Board';
import { Drawer } from './components/Drawer';
import { Login } from './components/Login';
import { Setup } from './components/Setup';
import { PlansView } from './components/PlansView';
import { AgentsView } from './components/AgentsView';
import { RunsView } from './components/RunsView';
import { ModalHost } from './components/modals';
import { SettingsView } from './components/SettingsView';
import { AdminView } from './components/AdminView';
import { Logo } from './components/Logo';
import { useState } from 'react';
import { useTheme } from './theme';
import { ThemeButton } from './components/ThemeButton';
import { Home } from './components/Home';
import { Invite } from './components/Invite';
import { ResetPassword } from './components/ResetPassword';

// Floating toggle for the unauthenticated screens (login / setup / invite) — no rail there.
function FloatingTheme() {
  const [theme, toggle] = useTheme();
  return (
    <button
      onClick={toggle}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{
        position: 'fixed', top: 12, right: 14, zIndex: 60,
        cursor: 'pointer', width: 30, height: 30, borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
        background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-mid)',
      }}
      className="hover-bright"
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

export function App() {
  const store = useAppStore();
  const [railOpen, setRailOpen] = useState(false);

  const inviteMatch = location.pathname.match(/^\/invite\/([^/]+)/);
  if (inviteMatch) {
    return <><FloatingTheme /><Invite token={inviteMatch[1]!} onDone={() => { location.href = '/'; }} /></>;
  }

  const resetMatch = location.pathname.match(/^\/reset\/([^/]+)/);
  if (resetMatch) {
    return <><FloatingTheme /><ResetPassword token={resetMatch[1]!} onDone={() => { location.href = '/'; }} /></>;
  }

  if (store.needsSetup) {
    return <><FloatingTheme /><Setup store={store} /></>;
  }
  if (!store.authChecked) {
    return <div style={{ height: '100vh', background: 'var(--bg)' }} />;
  }
  if (!store.user) {
    return <><FloatingTheme /><Login store={store} /></>;
  }

  const project = store.data.projects.find((p) => p.id === store.currentPid);
  const projectView = project && !['home', 'settings', 'admin'].includes(store.view);

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg)' }}>
      {railOpen && <div className="rail-backdrop" onClick={() => setRailOpen(false)} />}
      <Rail store={store} open={railOpen} onNavigate={() => setRailOpen(false)} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="mobile-topbar">
          <button
            onClick={() => setRailOpen(true)}
            aria-label="Menu"
            style={{ cursor: 'pointer', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, color: 'var(--text-soft)', borderRadius: 8 }}
          >
            ☰
          </button>
          <Logo size={22} radius={6} />
          <span style={{ fontWeight: 700, fontSize: 14.5, letterSpacing: '-.01em', color: 'var(--text)' }}>
            {project && projectView ? project.name : 'Noriq'}
          </span>
          <div style={{ flex: 1 }} />
          <ThemeButton size={34} />
        </div>
        {projectView && <TopBar store={store} />}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {(store.view === 'home' || (!project && store.view !== 'settings' && store.view !== 'admin')) && <Home store={store} />}
          {store.view === 'settings' && <SettingsView store={store} />}
          {store.view === 'admin' && <AdminView store={store} />}
          {projectView && (
            <>
              {store.view === 'control' && <MissionControl store={store} />}
              {store.view === 'graph' && <Graph store={store} />}
              {store.view === 'board' && <Board store={store} />}
              {store.view === 'plans' && <PlansView store={store} />}
              {store.view === 'runs' && <RunsView store={store} />}
              {store.view === 'agents' && <AgentsView store={store} />}
            </>
          )}
        </div>
      </div>
      <Drawer store={store} />
      <ModalHost store={store} />
    </div>
  );
}

