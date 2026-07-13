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
import { Home } from './components/Home';
import { Invite } from './components/Invite';

export function App() {
  const store = useAppStore();

  const inviteMatch = location.pathname.match(/^\/invite\/([^/]+)/);
  if (inviteMatch) {
    return <Invite token={inviteMatch[1]!} onDone={() => { location.href = '/'; }} />;
  }

  if (store.needsSetup) {
    return <Setup store={store} />;
  }
  if (!store.authChecked) {
    return <div style={{ height: '100vh', background: 'var(--bg)' }} />;
  }
  if (!store.user) {
    return <Login store={store} />;
  }

  const project = store.data.projects.find((p) => p.id === store.currentPid);
  const projectView = project && !['home', 'settings'].includes(store.view);

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg)' }}>
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

