import { useAppStore } from './store';
import { Rail } from './components/Rail';
import { TopBar } from './components/TopBar';
import { MissionControl } from './components/MissionControl';
import { Graph } from './components/Graph';
import { Board } from './components/Board';
import { Drawer } from './components/Drawer';

export function App() {
  const store = useAppStore();
  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg)' }}>
      <Rail store={store} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TopBar store={store} />
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {store.view === 'control' && <MissionControl store={store} />}
          {store.view === 'graph' && <Graph store={store} />}
          {store.view === 'board' && <Board store={store} />}
        </div>
      </div>
      <Drawer store={store} />
    </div>
  );
}
