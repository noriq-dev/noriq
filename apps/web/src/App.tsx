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

export function App() {
  const store = useAppStore();

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

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg)' }}>
      <Rail store={store} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {project ? (
          <>
            <TopBar store={store} />
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              {store.view === 'control' && <MissionControl store={store} />}
              {store.view === 'graph' && <Graph store={store} />}
              {store.view === 'board' && <Board store={store} />}
              {store.view === 'plans' && <PlansView store={store} />}
              {store.view === 'agents' && <AgentsView store={store} />}
            </div>
          </>
        ) : (
          <EmptyState onCreate={() => store.actions.createProject()} />
        )}
      </div>
      <Drawer store={store} />
      <ModalHost store={store} />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)' }}>no projects yet</div>
      <button
        onClick={onCreate}
        className="hover-bright"
        style={{ cursor: 'pointer', background: 'var(--accent)', color: 'var(--bg)', fontWeight: 600, fontSize: 13, padding: '10px 18px', borderRadius: 9 }}
      >
        Create the first project
      </button>
      <div style={{ fontSize: 12, color: 'var(--text-mid)', maxWidth: 380, textAlign: 'center', lineHeight: 1.6 }}>
        …or point an agent at the MCP endpoint (<span style={{ fontFamily: 'var(--mono)' }}>/mcp</span>) and let it
        call <span style={{ fontFamily: 'var(--mono)' }}>create_project</span>.
      </div>
    </div>
  );
}
