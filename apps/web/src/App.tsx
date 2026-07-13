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
import { ModalHost } from './components/modals';
import { SettingsView } from './components/SettingsView';
import { useState } from 'react';
import { resolveTheme, toggleTheme } from './theme';
import { Home } from './components/Home';
import { Invite } from './components/Invite';

function ThemeToggle() {
  const [theme, setTheme] = useState(resolveTheme());
  return (
    <button
      onClick={() => setTheme(toggleTheme())}
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

  const inviteMatch = location.pathname.match(/^\/invite\/([^/]+)/);
  if (inviteMatch) {
    return <><ThemeToggle /><Invite token={inviteMatch[1]!} onDone={() => { location.href = '/'; }} /></>;
  }

  if (store.needsSetup) {
    return <><ThemeToggle /><Setup store={store} /></>;
  }
  if (!store.authChecked) {
    return <div style={{ height: '100vh', background: 'var(--bg)' }} />;
  }
  if (!store.user) {
    return <><ThemeToggle /><Login store={store} /></>;
  }

  const project = store.data.projects.find((p) => p.id === store.currentPid);
  const projectView = project && !['home', 'settings'].includes(store.view);

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg)' }}>
      <ThemeToggle />
      <Rail store={store} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {projectView && <TopBar store={store} />}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {(store.view === 'home' || (!project && store.view !== 'settings')) && <Home store={store} />}
          {store.view === 'settings' && <SettingsView store={store} />}
          {projectView && (
            <>
              {store.view === 'control' && <MissionControl store={store} />}
              {store.view === 'graph' && <Graph store={store} />}
              {store.view === 'board' && <Board store={store} />}
              {store.view === 'plans' && <PlansView store={store} />}
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

