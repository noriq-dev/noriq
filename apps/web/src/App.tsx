import { useAppStore, safeDecode } from './store';
import { Rail } from './components/Rail';
import { TopBar } from './components/TopBar';
import { MaintenanceBanner } from './components/MaintenanceBanner';
import { MissionControl } from './components/MissionControl';
import { Graph } from './components/Graph';
import { Board } from './components/Board';
import { Drawer } from './components/Drawer';
import { Login } from './components/Login';
import { Setup } from './components/Setup';
import { PlansView } from './components/PlansView';
import { ReviewView } from './components/ReviewView';
import { DocsView } from './components/DocsView';
import { CommandPalette } from './components/CommandPalette';
import { RoadmapView } from './components/RoadmapView';
import { AgentsView } from './components/AgentsView';
import { RunsView } from './components/RunsView';
import { ModalHost } from './components/modals';
import { DialogHost } from './components/Dialog';
import { SettingsView } from './components/SettingsView';
import { AdminView } from './components/AdminView';
import { Logo } from './components/Logo';
import { useState } from 'react';
import { useTheme } from './theme';
import { ThemeButton } from './components/ThemeButton';
import { Home } from './components/Home';
import { Invite } from './components/Invite';
import { ResetPassword } from './components/ResetPassword';
import { PublicView } from './components/PublicView';

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
  // Anonymous visitor on a project URL (PLNR-78): try the public read-only page before
  // falling back to Login. `publicFailed` flips when the project isn't public.
  const [publicFailed, setPublicFailed] = useState(false);

  // Invite / reset links now carry the token in the URL #fragment (PLNR-115), which is never
  // sent to the server or any proxy — so it stays out of access logs and Referer headers. The
  // token is read here client-side and POSTed in a request body. Older path-form links
  // (/invite/<token>) still resolve via the fallback capture group.
  const onboardMatch = location.pathname.match(/^\/(invite|reset)(?:\/([^/]+))?\/?$/);
  if (onboardMatch) {
    const token = location.hash.replace(/^#/, '') || onboardMatch[2] || '';
    const onDone = () => { location.href = '/'; };
    return onboardMatch[1] === 'invite'
      ? <><FloatingTheme /><Invite token={token} onDone={onDone} /></>
      : <><FloatingTheme /><ResetPassword token={token} onDone={onDone} /></>;
  }

  if (store.needsSetup) {
    return <><FloatingTheme /><Setup store={store} /></>;
  }
  if (!store.authChecked) {
    return <div style={{ height: '100vh', background: 'var(--bg)' }} />;
  }
  if (!store.user) {
    const pubMatch = location.pathname.match(/^\/p\/([^/]+)/);
    if (pubMatch && !publicFailed) {
      return <><FloatingTheme /><PublicView pid={safeDecode(pubMatch[1]!)} onNotPublic={() => setPublicFailed(true)} /></>;
    }
    return <><FloatingTheme /><Login store={store} /></>;
  }

  const project = store.data.projects.find((p) => p.id === store.currentPid);
  const projectView = project && !['home', 'settings', 'admin'].includes(store.view);

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg)' }}>
      <MaintenanceBanner />
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
              {store.view === 'review' && <ReviewView store={store} />}
              {store.view === 'docs' && <DocsView store={store} />}
              {store.view === 'roadmap' && <RoadmapView store={store} />}
              {store.view === 'runs' && <RunsView store={store} />}
              {store.view === 'agents' && <AgentsView store={store} />}
            </>
          )}
        </div>
      </div>
      <Drawer store={store} />
      <ModalHost store={store} />
      <DialogHost />
      <CommandPalette store={store} />
    </div>
  );
}

