// Live store — REST snapshots + WebSocket invalidation. Replaces the Phase-0 mock.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiProject, type ApiSnapshot } from './api';
import type { AppData, CommentKind, EventVM, ProjectVM, TaskStatus, TaskVM, UserVM, ViewId } from './types';

const PALETTE = ['#4c9dff', '#b57bff', '#3fd98b', '#ff8a8a', '#c6f24e', '#f5a623'];
const PROJECT_COLORS = ['#c6f24e', '#4c9dff', '#b57bff', '#f5a623', '#3fd98b', '#ff8a8a'];

function hashIdx(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

/** Map raw events to the feed's visual vocabulary. */
function eventToVM(e: ApiSnapshot['events'][number]): EventVM {
  const p = e.payload;
  const actor = (p.actorName as string) ?? e.actorId;
  let verb = e.verb;
  let subject = '';
  let taskId: string | undefined;
  let dot: string | undefined;
  switch (e.verb) {
    case 'task.claimed': verb = 'claimed'; subject = `${p.key} · ${p.title}`; taskId = e.subjectId; break;
    case 'task.released': verb = 'released'; subject = `${p.key} · was held by ${p.previousHolder ?? '—'} → ${p.toStatus}`; taskId = e.subjectId; break;
    case 'task.requeued': verb = 'requeued'; subject = `${p.key} · ${p.reason}`; taskId = e.subjectId; break;
    case 'task.created': verb = p.parentTaskId ? 'subtask' : 'task'; subject = `created ${p.key} · ${p.title}`; taskId = e.subjectId; break;
    case 'task.status_changed': verb = `status →${p.to}`; subject = `${p.key} · ${p.title ?? ''}`; taskId = e.subjectId; break;
    case 'task.updated': verb = 'updated'; subject = `${p.key} · ${(p.fields as string[] | undefined)?.join(', ') ?? ''}`; taskId = e.subjectId; break;
    case 'comment.posted': verb = String(p.kind ?? 'comment'); subject = `on ${p.taskKey} · “${p.body}”`; taskId = String(p.taskId ?? ''); break;
    case 'comment.resolved': verb = 'resolved'; subject = `${p.taskKey} · ${p.resolution}`; taskId = String(p.taskId ?? ''); break;
    case 'comment.acknowledged': verb = 'acknowledged'; subject = `comments on ${p.taskKey}`; taskId = e.subjectId; break;
    case 'message.sent': verb = 'msg'; subject = `→ ${p.to} · “${p.body}”`; break;
    case 'milestone.created': verb = 'milestone'; subject = String(p.title ?? ''); break;
    case 'board.created': verb = 'board'; subject = `created ${p.name ?? ''}`; break;
    case 'board.updated': verb = 'board'; subject = `renamed → ${p.name ?? ''}`; break;
    case 'board.deleted': verb = 'board'; subject = 'deleted'; break;
    case 'dependency.added': verb = 'dep'; subject = `${p.key} depends on ${p.dependsOn}`; taskId = e.subjectId; break;
    case 'dependency.removed': verb = 'dep'; subject = `${p.key} no longer depends on ${p.dependsOn}`; taskId = e.subjectId; break;
    case 'task.moved': verb = 'moved'; subject = `${p.key} → ${p.toKey} (another project)`; break;
    case 'task.handed_off': verb = 'handoff'; subject = `${p.key} → ${p.toName ?? p.toAgentId}`; taskId = e.subjectId; break;
    case 'task.moved_in': verb = 'moved in'; subject = `${p.key} · ${p.title ?? ''}`; taskId = e.subjectId; break;
    // The payload has carried name+color all along — the feed just fell through to the
    // raw-id default (PLNR-130).
    case 'tag.created': verb = 'tag'; subject = `created ${p.name ?? ''}`; dot = typeof p.color === 'string' ? p.color : undefined; break;
    case 'tag.deleted': verb = 'tag'; subject = `deleted ${p.name ?? ''}`; break;
    case 'doc.created': verb = 'doc'; subject = `wrote "${p.name ?? ''}"`; break;
    case 'doc.updated': verb = 'doc'; subject = `revised "${p.name ?? ''}"`; break;
    case 'doc.deleted': verb = 'doc'; subject = `deleted "${p.name ?? ''}"`; break;
    case 'plan_doc.created': verb = 'plan doc'; subject = `wrote "${p.name ?? ''}"`; break;
    case 'plan_doc.updated': verb = 'plan doc'; subject = `revised "${p.name ?? ''}"`; break;
    case 'plan_doc.deleted': verb = 'plan doc'; subject = `deleted "${p.name ?? ''}"`; break;
    case 'lock.acquired': verb = 'lock'; subject = `held ${(p.paths as string[] | undefined)?.join(', ') ?? ''}${p.taskKey ? ` for ${p.taskKey}` : ''}`; break;
    case 'lock.released': verb = 'lock'; subject = `released ${(p.paths as string[] | undefined)?.join(', ') ?? ''}`; break;
    case 'lock.denied': verb = 'lock'; subject = `blocked ${(p.requested as string[] | undefined)?.join(', ') ?? ''} — held by another`; break;
    case 'lock.force_released': verb = 'lock'; subject = `force-released ${p.path ?? ''}`; break;
    case 'lock.expired': verb = 'lock'; subject = `${p.count ?? ''} lock(s) expired`; break;
    case 'lock.renewed': verb = 'lock'; subject = 'renewed a lock'; break;
    default: subject = `${e.verb} ${e.subjectId}`;
  }
  return { id: e.id, t: timeOf(e.createdAt), actor, actorKind: e.actorKind, verb, subject, taskId, dot };
}

const VIEWS: ViewId[] = ['home', 'control', 'graph', 'board', 'plans', 'roadmap', 'review', 'docs', 'ask', 'agents', 'runs', 'settings', 'admin'];

/** decodeURIComponent throws URIError on malformed %-encoding (e.g. `/p/%`).
 *  Unhandled during render/popstate this blanks the app (PLNR-113); fall back to the raw value. */
export function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function parseUrl(): { pid: string | null; view: ViewId; task: string | null } {
  const m = location.pathname.match(/^\/p\/([^/]+)(?:\/([a-z]+))?/);
  const view = location.pathname === '/settings' ? 'settings' : (m?.[2] as ViewId | undefined);
  return {
    pid: m?.[1] ? safeDecode(m[1]) : null,
    view: view && VIEWS.includes(view) ? view : m ? 'control' : 'home',
    task: new URLSearchParams(location.search).get('task'),
  };
}

/** Reload the tab once when the server reports a newer deploy than this bundle
 *  (PLNR-193). Guarded per server-version in sessionStorage so a cached index.html
 *  can't cause a reload loop. */
function maybeReloadForNewVersion(serverVersion: string | undefined) {
  if (!serverVersion || serverVersion === __APP_VERSION__) return;
  const key = 'noriq.reloadedFor';
  if (sessionStorage.getItem(key) === serverVersion) return;
  sessionStorage.setItem(key, serverVersion);
  location.reload();
}

export function useAppStore() {
  const [user, setUser] = useState<UserVM | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [modal, setModal] = useState<null | 'project' | 'project-edit' | 'task' | 'group' | 'milestone' | 'tag'>(null);
  const [editMilestone, setEditMilestone] = useState<{ id: string; title: string; dueAt: string | null } | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; name: string; description: string; canEdit: number }>>([]);
  const initialUrl = useRef(parseUrl());
  const [currentPid, setCurrentPid] = useState<string | null>(initialUrl.current.pid);
  const [view, setView] = useState<ViewId>(initialUrl.current.view);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialUrl.current.task);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [draftKind, setDraftKind] = useState<Exclude<CommentKind, 'reply'>>('question');
  const [draftText, setDraftText] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectVM[]>([]);
  const [adminProjects, setAdminProjects] = useState<ProjectVM[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [snapshot, setSnapshot] = useState<ApiSnapshot | null>(null);
  const [comments, setComments] = useState<TaskVM['comments']>([]);
  const [tick, setTick] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [boardId, setBoardId] = useState<string | null>(null); // PLNR-80: which board the board view shows

  const pidRef = useRef(currentPid);
  pidRef.current = currentPid;
  const boardRef = useRef(boardId);
  boardRef.current = boardId;
  const selRef = useRef(selectedTaskId);
  selRef.current = selectedTaskId;
  const lastSeq = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- auth + first-run setup ---------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const status = await api.setupStatus();
        if (status.needsSetup) {
          setNeedsSetup(true);
          return;
        }
        const r = await api.me();
        setUser(r.user);
      } catch {
        /* not signed in */
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  const pendingSetupUser = useRef<UserVM | null>(null);
  const completeSetupDeferred = useCallback(async (email: string, name: string, password: string) => {
    const r = await api.setup(email, name, password);
    pendingSetupUser.current = r.user; // session cookie is set; enter after the passkey step
  }, []);
  const finishSetup = useCallback(() => {
    setNeedsSetup(false);
    if (pendingSetupUser.current) setUser(pendingSetupUser.current);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    setUser(r.user);
  }, []);

  // --- data loading -----------------------------------------------------------
  const toProjectVM = (p: ApiProject, i: number): ProjectVM => ({
    id: p.id,
    key: p.key,
    name: p.name,
    phase: p.description || '',
    dotColor: PROJECT_COLORS[i % PROJECT_COLORS.length]!,
    badge: p.key.slice(0, 2),
    hasLive: p.liveTasks > 0,
    groupId: p.groupId,
    openTasks: p.openTasks,
    totalTasks: p.totalTasks,
    doneTasks: p.doneTasks,
    ownerName: p.ownerName,
    agentCount: p.agentCount,
    isPublic: !!p.public,
  });

  const loadProjects = useCallback(async () => {
    const r = await api.projects();
    const vms = r.projects.map(toProjectVM);
    setProjects(vms);
    setIsAdmin(r.admin);
    setCurrentPid((cur) => (cur && vms.some((p) => p.id === cur) ? cur : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PLNR-83: the admin-wide project list (all projects), loaded on demand for the Admin view.
  const loadAdminProjects = useCallback(async () => {
    const r = await api.projects('all');
    setAdminProjects(r.projects.map(toProjectVM));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSnapshot = useCallback(async (pid: string) => {
    const snap = await api.snapshot(pid);
    maybeReloadForNewVersion(snap.version);
    if (pidRef.current !== pid) return;
    // PLNR-112: overlapping /snapshot fetches (a WS-triggered refresh racing an
    // action refresh(), or two rapid WS events) can resolve out of order. Drop any
    // response whose newest event seq is older than what we've already applied —
    // otherwise a stale snapshot overwrites newer state AND regresses lastSeq, which
    // is then sent as sinceSeq on the next WS resubscribe. seq is monotonic per
    // project, so max-seq is a reliable freshness cursor. (A project switch resets
    // lastSeq to 0 in selectProject, so a new project's first snapshot always applies.)
    const maxSeq = Math.max(0, ...snap.events.map((e) => e.seq));
    if (maxSeq < lastSeq.current) return;
    setSnapshot(snap);
    lastSeq.current = maxSeq;
  }, []);

  // A new deploy bumps the server's package version (see /api/health): reload the tab
  // ONCE so everyone runs the latest bundle (PLNR-193). The sessionStorage guard stops
  // a reload loop if a cached index.html still serves the old bundle after reloading.
  // Checked on every snapshot (active tabs) and on a slow health poll (idle tabs).
  useEffect(() => {
    const t = setInterval(() => {
      api.health().then((h) => maybeReloadForNewVersion(h.version)).catch(() => {});
    }, 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  const loadComments = useCallback(async (tid: string) => {
    const detail = await api.taskDetail(tid);
    if (selRef.current !== tid) return;
    setComments(
      detail.comments.map((c) => ({
        id: c.id,
        author: c.authorId,
        role: c.authorKind === 'agent' ? ('agent' as const) : ('human' as const),
        kind: c.kind as CommentKind,
        body: c.body,
        status: c.status as TaskVM['comments'][number]['status'],
      })),
    );
  }, []);

  useEffect(() => {
    if (user) {
      void loadProjects();
      api.groups().then((r) => setGroups(r.groups)).catch(() => {});
    }
  }, [user, loadProjects]);

  useEffect(() => {
    if (user && currentPid) void loadSnapshot(currentPid);
  }, [user, currentPid, loadSnapshot]);

  // Keep the selected board valid: default to the first board, and re-home if the
  // current one vanished (project switch or board deletion).
  useEffect(() => {
    const boards = snapshot?.boards ?? [];
    if (!boards.length) { setBoardId(null); return; }
    setBoardId((cur) => (cur && boards.some((b) => b.id === cur) ? cur : boards[0]!.id));
  }, [snapshot?.boards]);

  useEffect(() => {
    if (selectedTaskId) void loadComments(selectedTaskId);
    else setComments([]);
  }, [selectedTaskId, loadComments]);

  // --- live channel -------------------------------------------------------------
  useEffect(() => {
    if (!user || !currentPid) return;
    let closed = false;
    let retry = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Liveness (PLNR-162): reconnect used to hinge entirely on `onclose`, but a socket
    // killed by laptop sleep, a network change, or a proxy idle-timeout often dies
    // WITHOUT a close frame — the tab believed it was live and went silently stale
    // forever. Track real activity (any frame, incl. pong replies to our pings) and
    // treat a quiet-too-long socket as dead.
    let lastActivity = Date.now();
    const PING_MS = 45_000;
    const STALE_MS = PING_MS * 2 + 10_000; // two missed pongs + slack

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws/projects/${currentPid}`);
      wsRef.current = socket;
      socket.onopen = () => {
        retry = 0;
        lastActivity = Date.now();
        // sinceSeq resume: the backlog replays anything missed while disconnected.
        socket?.send(JSON.stringify({ type: 'subscribe', projectId: currentPid, sinceSeq: lastSeq.current }));
      };
      socket.onmessage = (ev) => {
        lastActivity = Date.now();
        try {
          if ((JSON.parse(ev.data as string) as { type?: string }).type === 'pong') return; // liveness only
        } catch { /* non-JSON frame — treat as an event */ }
        // Any event (or backlog) → debounced snapshot refresh; comments too if drawer open.
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          if (pidRef.current) void loadSnapshot(pidRef.current);
          if (selRef.current) void loadComments(selRef.current);
        }, 250);
      };
      socket.onclose = () => {
        if (closed) return;
        retry += 1;
        reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 15000));
      };
    };

    /** If the socket is gone or has been quiet past the pong deadline, tear it down —
     *  `onclose` then drives the normal backoff reconnect. */
    const ensureLive = () => {
      if (closed) return;
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        if (!reconnectTimer) connect();
      } else if (socket.readyState === WebSocket.OPEN && Date.now() - lastActivity > STALE_MS) {
        socket.close(); // silent corpse — bury it and let onclose reconnect
      }
    };

    // Heartbeat: ping while visible. Background tabs throttle this interval — fine;
    // the wake-up path below owns the resync when the tab comes back.
    const heartbeat = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      ensureLive();
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, PING_MS);

    // Wake-up resync: on returning to the tab (or the network returning), verify the
    // socket AND refetch the snapshot outright — even a healthy socket can have had
    // its debounced refresh throttled away while backgrounded.
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      ensureLive();
      if (pidRef.current) void loadSnapshot(pidRef.current);
      if (selRef.current) void loadComments(selRef.current);
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);

    connect();
    return () => {
      closed = true;
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [user, currentPid, loadSnapshot, loadComments]);

  // --- URL <-> state sync (PLNR-36) ---------------------------------------------
  const popping = useRef(false);
  useEffect(() => {
    if (!user) return;
    const path = view === 'settings' ? '/settings' : view === 'home' || !currentPid ? '/' : `/p/${encodeURIComponent(currentPid)}/${view}`;
    const search = selectedTaskId ? `?task=${encodeURIComponent(selectedTaskId)}` : '';
    const target = path + search;
    if (location.pathname + location.search !== target) {
      if (popping.current) {
        popping.current = false;
      } else {
        history.pushState(null, '', target);
      }
    }
  }, [user, currentPid, view, selectedTaskId]);

  useEffect(() => {
    const onPop = () => {
      popping.current = true;
      const u = parseUrl();
      if (u.pid) setCurrentPid(u.pid);
      setView(u.view);
      setSelectedTaskId(u.task);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // TTL countdown repaint.
  useEffect(() => {
    const iv = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  // --- derive the AppData shape the components consume ----------------------------
  const data: AppData = useMemo(() => {
    const pid = currentPid ?? '';
    const now = Date.now();
    const ttlMax = snapshot?.project.claimTtlSeconds ?? 300;
    const depsByTask = new Map<string, string[]>();
    for (const d of snapshot?.dependencies ?? []) {
      depsByTask.set(d.taskId, [...(depsByTask.get(d.taskId) ?? []), d.dependsOnTaskId]);
    }
    const tagsByTask = new Map<string, string[]>();
    for (const tt of snapshot?.taskTags ?? []) {
      tagsByTask.set(tt.taskId, [...(tagsByTask.get(tt.taskId) ?? []), tt.tagId]);
    }
    // Phase-order gating (PLNR-163): a task is blocked by every task in an earlier phase
    // of its (non-rejected) plan — computed from phase membership, no dependency edges.
    const phaseById = new Map((snapshot?.phases ?? []).map((p) => [p.id, p]));
    const rejectedPlans = new Set((snapshot?.plans ?? []).filter((p) => p.status === 'rejected').map((p) => p.id));
    const tasksByPhase = new Map<string, string[]>();
    const phaseOfTask = new Map<string, string>();
    for (const pt of snapshot?.phaseTasks ?? []) {
      tasksByPhase.set(pt.phaseId, [...(tasksByPhase.get(pt.phaseId) ?? []), pt.taskId]);
      phaseOfTask.set(pt.taskId, pt.phaseId);
    }
    const phaseDepsOf = (tid: string): string[] => {
      const ph = phaseById.get(phaseOfTask.get(tid) ?? '');
      if (!ph || rejectedPlans.has(ph.planId)) return [];
      const out: string[] = [];
      for (const [id, p] of phaseById) {
        if (p.planId === ph.planId && p.order < ph.order) out.push(...(tasksByPhase.get(id) ?? []));
      }
      return out;
    };
    const tasks: TaskVM[] = (snapshot?.tasks ?? []).map((t) => {
      const expires = t.claimExpiresAt ? new Date(t.claimExpiresAt).getTime() : null;
      const ttl = expires !== null ? Math.max(0, Math.round((expires - now) / 1000)) : undefined;
      return {
        id: t.id,
        key: t.key,
        title: t.title,
        body: t.body,
        status: t.status as TaskStatus,
        claimedBy: t.claimedBy,
        claimExpiresAt: t.claimExpiresAt,
        ttl,
        ttlMax,
        priority: t.priority,
        estimate: t.estimate,
        dueAt: t.dueAt,
        deps: depsByTask.get(t.id) ?? [],
        phaseDeps: phaseDepsOf(t.id),
        milestoneId: t.milestoneId,
        boardId: t.boardId,
        tagIds: tagsByTask.get(t.id) ?? [],
        type: t.type,
        openComments: t.openComments,
        archivedAt: t.archivedAt,
        comments: t.id === selectedTaskId ? comments : [],
      };
    });
    const agents = (snapshot?.agents ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role === 'orchestrator' ? ('orch' as const) : ('worker' as const),
      color: a.role === 'orchestrator' ? '#f5a623' : PALETTE[hashIdx(a.id, PALETTE.length)]!,
      lastSeenAt: a.lastSeenAt,
      ownerName: a.ownerName,
      parentAgentId: a.parentAgentId,
    }));
    const events = (snapshot?.events ?? []).map(eventToVM);
    return {
      projects,
      agents: { [pid]: agents },
      tasks: { [pid]: tasks },
      events: { [pid]: events },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick drives the live TTL countdown
  }, [projects, snapshot, comments, currentPid, selectedTaskId, tick]);

  const helpers = useMemo(() => {
    // PLNR-150: two lists, deliberately. `allTasksOf` is the truth — every task in the
    // project, archived or not — and anything that *counts* (milestone chips, plan phase
    // progress) must use it, or completed-and-archived work vanishes from both sides of
    // the ratio and a finished milestone reads 0/0. `tasksOf` is the display list the
    // board renders, which hides archived tasks unless the archive switch is on.
    const allTasksOf = (pid: string) => data.tasks[pid] ?? [];
    const tasksOf = (pid: string) =>
      showArchived ? allTasksOf(pid) : allTasksOf(pid).filter((t) => t.archivedAt === null);
    const agentById = (pid: string, id: string) => (data.agents[pid] ?? []).find((a) => a.id === id) ?? null;
    // Resolve deps against the full list: a dependency satisfied by a task that has since
    // been archived is still satisfied, not unresolvable.
    const isBlocked = (pid: string, t: TaskVM) =>
      [...t.deps, ...t.phaseDeps].some((d) => {
        const dt = allTasksOf(pid).find((x) => x.id === d);
        return dt !== undefined && dt.status !== 'done' && dt.status !== 'cancelled';
      });
    const effStatus = (pid: string, t: TaskVM): TaskStatus =>
      t.status === 'todo' && isBlocked(pid, t) ? 'blocked' : t.status;
    return { tasksOf, allTasksOf, agentById, isBlocked, effStatus };
  }, [data, showArchived]);

  const refresh = useCallback(() => {
    if (pidRef.current) void loadSnapshot(pidRef.current);
    if (selRef.current) void loadComments(selRef.current);
  }, [loadSnapshot, loadComments]);

  const actions = {
    login,
    goHome() {
      setView('home');
      setSelectedTaskId(null);
    },

    selectProject(id: string) {
      if (id === pidRef.current) {
        // Re-selecting the current project (e.g. from Settings): don't blank the
        // snapshot — the load effect won't re-fire for an unchanged pid (PLNR-37).
        setView((v) => (v === 'settings' || v === 'admin' || v === 'agents' || v === 'home' ? 'control' : v));
        refresh();
        return;
      }
      setCurrentPid(id);
      setSelectedTaskId(null);
      setSnapshot(null);
      setView((v) => (v === 'settings' || v === 'admin' || v === 'home' ? 'control' : v));
      lastSeq.current = 0;
    },
    setView,
    openAdmin() {
      setView('admin');
      setSelectedTaskId(null);
      void loadAdminProjects();
    },
    async refreshAdmin() {
      await loadAdminProjects();
    },
    openTask: (id: string) => setSelectedTaskId(id),
    refreshNow: refresh,
    selectAgent: (id: string | null) => setSelectedAgentId(id),

    async sendMessage(body: string, toAgentId?: string) {
      if (!pidRef.current || !body.trim()) return;
      await api.sendMessage(pidRef.current, body.trim(), toAgentId);
      refresh();
    },
    closeTask: () => setSelectedTaskId(null),
    setDraftText,
    setDraggedId,
    cycleKind() {
      const order = ['question', 'instruction', 'comment'] as const;
      setDraftKind((k) => order[(order.indexOf(k) + 1) % order.length]!);
    },

    completeSetupDeferred,
    finishSetup,
    openModal: setModal,
    closeModal: () => { setModal(null); setEditMilestone(null); },

    createProject: () => setModal('project'),
    createTask: () => setModal('task'),

    async submitProject(input: { key: string; name: string; description?: string; groupId?: string }) {
      const r = await api.createProject(input.key, input.name, input.description);
      if (input.groupId) await api.setProjectMeta(r.id, { groupId: input.groupId });
      await loadProjects();
      setModal(null);
      setCurrentPid(r.id);
      setSnapshot(null);
      lastSeq.current = 0;
    },

    async submitTask(input: { title: string; body?: string; priority?: number; milestoneId?: string; tags?: string[]; type?: string }) {
      if (!pidRef.current) return;
      // New tasks land on the board you're currently viewing (falls back to default server-side).
      await api.createTask(pidRef.current, { ...input, ...(boardRef.current ? { boardId: boardRef.current } : {}) });
      setModal(null);
      refresh();
    },

    openMilestoneEditor(m: { id: string; title: string; dueAt: string | null }) {
      setEditMilestone(m);
      setModal('milestone');
    },

    async submitMilestone(title: string, dueAt?: string) {
      if (!pidRef.current) return;
      if (editMilestone) {
        await api.updateMilestone(pidRef.current, editMilestone.id, { title, dueAt: dueAt ?? null });
        setEditMilestone(null);
        setModal(null);
      } else {
        await api.createMilestone(pidRef.current, title, dueAt);
        setModal('task'); // return to the task dialog with the new milestone available
      }
      refresh();
    },

    async submitProjectMeta(meta: { name?: string; description?: string; groupId?: string | null; claimTtlSeconds?: number }) {
      if (!pidRef.current) return;
      await api.setProjectMeta(pidRef.current, meta);
      await loadProjects();
      setModal(null);
      refresh();
    },

    async submitTag(name: string) {
      if (!pidRef.current) return;
      await api.createTag(pidRef.current, name);
      setModal(null);
      refresh();
    },

    async submitGroup(name: string, description?: string) {
      await api.createGroup(name, description);
      const r = await api.groups();
      setGroups(r.groups);
      setModal(null);
    },

    async claimToggle(taskId: string) {
      // Human action: force-release a stale claim (requeue to todo).
      if (!pidRef.current) return;
      await api.releaseTask(pidRef.current, taskId, 'todo');
      refresh();
    },

    async moveTask(taskId: string, status: TaskStatus) {
      if (!pidRef.current) return;
      setDraggedId(null);
      // 'failed' is a derived, system-set status (PLNR-178) — you can't drag a task INTO it.
      // Dropping on the Failed column is a no-op; moving a failed task OUT (to any real column)
      // clears its failure marker server-side.
      if (status === 'failed') return;
      const t = (data.tasks[pidRef.current] ?? []).find((x) => x.id === taskId);
      if (!t || t.status === status) return;
      if (helpers.effStatus(pidRef.current, t) === 'blocked' && ['in_progress', 'review', 'done'].includes(status)) return;
      await api.updateTask(pidRef.current, taskId, { status });
      refresh();
    },

    async resolveComment(commentId: string, resolution: 'addressed' | 'wont_do') {
      if (!pidRef.current) return;
      await api.resolveComment(pidRef.current, commentId, resolution);
      refresh();
    },

    async deleteTask(taskId: string) {
      if (!pidRef.current) return;
      await api.deleteTask(pidRef.current, taskId);
      setSelectedTaskId(null);
      refresh();
    },
    async archiveTask(taskId: string) {
      if (!pidRef.current) return;
      await api.archiveTask(pidRef.current, taskId);
      setSelectedTaskId(null);
      refresh();
    },
    async restoreTask(taskId: string) {
      if (!pidRef.current) return;
      await api.restoreTask(pidRef.current, taskId);
      refresh();
    },
    // Pure client-side now — the snapshot already carries archived tasks, so the switch
    // is instant and costs no round-trip (PLNR-150).
    toggleArchived() {
      setShowArchived((v) => !v);
    },
    async deleteMilestone(milestoneId: string) {
      if (!pidRef.current) return;
      await api.deleteMilestone(pidRef.current, milestoneId);
      refresh();
    },
    async deletePlan(planId: string) {
      if (!pidRef.current) return;
      await api.deletePlan(pidRef.current, planId);
      refresh();
    },
    async approvePlan(planId: string) {
      if (!pidRef.current) return;
      await api.approvePlan(pidRef.current, planId);
      refresh();
    },
    async rejectPlan(planId: string) {
      if (!pidRef.current) return;
      await api.rejectPlan(pidRef.current, planId);
      refresh();
    },
    async createPlanDoc(planId: string, input: { name: string; description?: string; body?: string }) {
      if (!pidRef.current) return;
      await api.createPlanDoc(pidRef.current, planId, input);
      refresh();
    },
    async updatePlanDoc(planId: string, docId: string, patch: { name?: string; description?: string; body?: string }) {
      if (!pidRef.current) return;
      await api.updatePlanDoc(pidRef.current, planId, docId, patch);
      refresh();
    },
    async deletePlanDoc(planId: string, docId: string) {
      if (!pidRef.current) return;
      await api.deletePlanDoc(pidRef.current, planId, docId);
      refresh();
    },
    async deleteTag(tagId: string) {
      if (!pidRef.current) return;
      await api.deleteTag(pidRef.current, tagId);
      refresh();
    },
    // File locks (PLNR-213): a human force-releases a stuck hold; the WS event refetches the panel.
    async forceReleaseLock(lockId: string) {
      if (!pidRef.current) return;
      await api.forceReleaseLock(pidRef.current, lockId);
      refresh();
    },
    async setFileLocking(fileLocking: boolean, lockTtlSeconds?: number | null) {
      if (!pidRef.current) return;
      await api.setProjectMeta(pidRef.current, { fileLocking, ...(lockTtlSeconds !== undefined ? { lockTtlSeconds } : {}) });
      refresh();
    },
    async deleteProject(projectId: string) {
      await api.deleteProject(projectId);
      setSelectedTaskId(null);
      setCurrentPid(null);
      setView('home');
      await loadProjects(); // refetches without the deleted project
    },

    // --- boards (PLNR-80) ---
    setBoard(id: string) {
      setBoardId(id);
    },
    async createBoard(name: string) {
      if (!pidRef.current || !name.trim()) return;
      const b = await api.createBoard(pidRef.current, name.trim());
      setBoardId(b.id); // jump to the board you just made
      refresh();
    },
    async renameBoard(id: string, name: string) {
      if (!pidRef.current || !name.trim()) return;
      await api.renameBoard(pidRef.current, id, name.trim());
      refresh();
    },
    async deleteBoard(id: string) {
      if (!pidRef.current) return;
      const r = await api.deleteBoard(pidRef.current, id);
      setBoardId(r.movedTo); // follow the tasks to where they landed
      refresh();
    },
    async moveTaskToBoard(taskId: string, targetBoardId: string) {
      if (!pidRef.current) return;
      await api.updateTask(pidRef.current, taskId, { boardId: targetBoardId });
      refresh();
    },

    async answerSignal(signalId: string, response: string, answers?: import('./api').ApiSignalAnswer[]) {
      if (!pidRef.current || (!response.trim() && !answers?.length)) return;
      await api.answerSignal(pidRef.current, signalId, response.trim(), answers);
      refresh();
    },

    async acknowledgeSignal(signalId: string, dismiss = false) {
      if (!pidRef.current) return;
      await api.acknowledgeSignal(pidRef.current, signalId, dismiss);
      refresh();
    },

    async addDependency(taskId: string, dependsOnTaskId: string) {
      if (!pidRef.current) return;
      await api.addDependency(pidRef.current, taskId, dependsOnTaskId);
      refresh();
    },

    async removeDependency(taskId: string, dependsOnTaskId: string) {
      if (!pidRef.current) return;
      await api.removeDependency(pidRef.current, taskId, dependsOnTaskId);
      refresh();
    },

    async postComment() {
      const text = draftText.trim();
      if (!text || !pidRef.current) return;
      if (selectedTaskId != null) {
        // Drawer context: a comment on the open task.
        await api.postComment(pidRef.current, selectedTaskId, draftKind, text);
      } else {
        // Feed context: broadcast — any agent should pick it up (kind prefixed for intent).
        const prefix = draftKind === 'comment' ? '' : `[${draftKind}] `;
        await api.sendMessage(pidRef.current, prefix + text);
      }
      setDraftText('');
      refresh();
    },
  };

  return {
    user, authChecked, needsSetup, modal, editMilestone, groups, snapshot, showArchived, boardId,
    isAdmin, adminProjects,
    currentPid: currentPid ?? '', view, selectedTaskId, selectedAgentId, draftKind, draftText, draggedId,
    data, helpers, actions,
  };
}

export type AppStore = ReturnType<typeof useAppStore>;
