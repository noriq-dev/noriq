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
import { AskView } from './components/AskView';
import { CommandPalette } from './components/CommandPalette';
import { RoadmapView } from './components/RoadmapView';
import { AgentsView } from './components/AgentsView';
import { RunsView } from './components/RunsView';
import { IntelligenceView } from './components/IntelligenceView';
import { MemoryView } from './components/MemoryView';
import { ModalHost } from './components/modals';
import { DialogHost } from './components/Dialog';
import { SettingsView } from './components/SettingsView';
import { ProjectSettingsView } from './components/ProjectSettingsView';
import { AdminView } from './components/AdminView';
import { Logo } from './components/Logo';
import { useState } from 'react';
import { useTheme } from './theme';
import { Home } from './components/Home';
import { Invite } from './components/Invite';
import { ResetPassword } from './components/ResetPassword';
import { PublicView } from './components/PublicView';
import { MobileTabBar } from './components/MobileTabBar';
import { ProjectSheet } from './components/ProjectSheet';
import { AvatarChip, LiveDot } from './components/bits';
import { MOBILE_TAB_BAR_HEIGHT, useViewport } from './viewport';
import { DesktopOnly, isDesktopOnlyView } from './components/DesktopOnly';
import { MoreView } from './components/MoreView';

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
  const { phone } = useViewport();
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
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
  const projectView = project && !['home', 'settings', 'admin', 'ask', 'more'].includes(store.view);
  const desktopOnlyView = phone && projectView && isDesktopOnlyView(store.view) ? store.view : null;
  const signalCount = store.snapshot?.signals?.length ?? 0;
  const liveCount = project?.liveAgentCount ?? store.data.agents[store.currentPid]?.length ?? 0;
  const navigateMobile = (view: Parameters<typeof store.actions.setView>[0]) => {
    if (!store.currentPid && !['ask', 'more'].includes(view)) {
      const firstProject = store.data.projects[0];
      if (firstProject) store.actions.selectProject(firstProject.id);
    }
    store.actions.setView(view);
  };

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg)' }}>
      <MaintenanceBanner />
      {!phone && <Rail store={store} />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {phone && (
          <div className="mobile-topbar">
            {store.view === 'ask' || store.view === 'more' ? (
              <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-.01em' }}>{store.view === 'ask' ? 'Ask' : 'More'}</span>
            ) : project ? (
              <button type="button" onClick={() => setProjectSheetOpen(true)} style={{ minWidth: 0, maxWidth: 240, height: 38, padding: '0 9px', borderRadius: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--w-025)', border: '1px solid var(--w-08)', textAlign: 'left' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700, color: 'var(--accent)', background: 'var(--w-05)', borderRadius: 5, padding: '3px 5px' }}>{project.key}</span>
                <span style={{ minWidth: 0, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.5, fontWeight: 600 }}>{project.name}</span>
                <span aria-hidden="true" style={{ color: 'var(--text-faint)', fontSize: 10 }}>▾</span>
              </button>
            ) : <Logo size={24} radius={7} />}
            <div style={{ flex: 1 }} />
            {project && store.view !== 'ask' && store.view !== 'more' && <><LiveDot size={6} /><span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-mid)' }}>{liveCount} live</span></>}
            <AvatarChip name={store.user.name} color="you" size={34} radius={17} />
          </div>
        )}
        {!phone && projectView && <TopBar store={store} />}
        <div
          data-mobile-content-frame={phone || undefined}
          style={{ flex: 1, minHeight: 0, position: 'relative', marginBottom: phone ? MOBILE_TAB_BAR_HEIGHT : 0 }}
        >
          {(store.view === 'home' || (!project && !['settings', 'admin', 'ask'].includes(store.view))) && <Home store={store} />}
          {store.view === 'settings' && <SettingsView store={store} />}
          {store.view === 'admin' && <AdminView store={store} />}
          {store.view === 'ask' && <AskView store={store} />}
          {store.view === 'more' && <MoreView store={store} />}
          {projectView && (
            <>
              {desktopOnlyView ? <DesktopOnly projectId={store.currentPid} view={desktopOnlyView} /> : <>
                {store.view === 'control' && <MissionControl store={store} />}
                {store.view === 'graph' && <Graph store={store} />}
                {store.view === 'intelligence' && <IntelligenceView store={store} />}
                {store.view === 'board' && <Board store={store} />}
                {store.view === 'plans' && <PlansView store={store} />}
                {store.view === 'review' && <ReviewView store={store} />}
                {store.view === 'docs' && <DocsView store={store} />}
                {store.view === 'roadmap' && <RoadmapView store={store} />}
                {store.view === 'runs' && <RunsView store={store} />}
                {store.view === 'agents' && <AgentsView store={store} />}
                {store.view === 'memory' && <MemoryView store={store} />}
                {store.view === 'project-settings' && <ProjectSettingsView key={store.currentPid} store={store} />}
              </>}
            </>
          )}
        </div>
      </div>
      {phone && <MobileTabBar view={store.view} signalCount={signalCount} onNavigate={navigateMobile} />}
      {phone && projectSheetOpen && <ProjectSheet store={store} preserveView={store.view} onClose={() => setProjectSheetOpen(false)} />}
      <Drawer store={store} />
      <ModalHost store={store} />
      <DialogHost />
      <CommandPalette store={store} />
    </div>
  );
}
