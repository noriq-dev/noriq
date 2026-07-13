// Live store — REST snapshots + WebSocket invalidation. Replaces the Phase-0 mock.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiSnapshot } from './api';
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
    case 'dependency.added': verb = 'dep'; subject = `${p.key} depends on ${p.dependsOn}`; taskId = e.subjectId; break;
    default: subject = `${e.verb} ${e.subjectId}`;
  }
  return { id: e.id, t: timeOf(e.createdAt), actor, actorKind: e.actorKind, verb, subject, taskId };
}

const VIEWS: ViewId[] = ['home', 'control', 'graph', 'board', 'plans', 'agents', 'settings'];

function parseUrl(): { pid: string | null; view: ViewId; task: string | null } {
  const m = location.pathname.match(/^\/p\/([^/]+)(?:\/([a-z]+))?/);
  const view = location.pathname === '/settings' ? 'settings' : (m?.[2] as ViewId | undefined);
  return {
    pid: m?.[1] ? decodeURIComponent(m[1]) : null,
    view: view && VIEWS.includes(view) ? view : m ? 'control' : 'home',
    task: new URLSearchParams(location.search).get('task'),
  };
}

export function useAppStore() {
  const [user, setUser] = useState<UserVM | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [modal, setModal] = useState<null | 'project' | 'project-edit' | 'task' | 'group' | 'milestone' | 'tag'>(null);
  const [editMilestone, setEditMilestone] = useState<{ id: string; title: string; dueAt: string | null } | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const initialUrl = useRef(parseUrl());
  const [currentPid, setCurrentPid] = useState<string | null>(initialUrl.current.pid);
  const [view, setView] = useState<ViewId>(initialUrl.current.view);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialUrl.current.task);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [draftKind, setDraftKind] = useState<Exclude<CommentKind, 'reply'>>('question');
  const [draftText, setDraftText] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectVM[]>([]);
  const [snapshot, setSnapshot] = useState<ApiSnapshot | null>(null);
  const [comments, setComments] = useState<TaskVM['comments']>([]);
  const [tick, setTick] = useState(0);

  const pidRef = useRef(currentPid);
  pidRef.current = currentPid;
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
  const loadProjects = useCallback(async () => {
    const r = await api.projects();
    const vms = r.projects.map((p, i) => ({
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
    }));
    setProjects(vms);
    setCurrentPid((cur) => (cur && vms.some((p) => p.id === cur) ? cur : null));
  }, []);

  const loadSnapshot = useCallback(async (pid: string) => {
    const snap = await api.snapshot(pid);
    if (pidRef.current !== pid) return;
    setSnapshot(snap);
    lastSeq.current = Math.max(0, ...snap.events.map((e) => e.seq));
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

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws/projects/${currentPid}`);
      wsRef.current = socket;
      socket.onopen = () => {
        retry = 0;
        socket?.send(JSON.stringify({ type: 'subscribe', projectId: currentPid, sinceSeq: lastSeq.current }));
      };
      socket.onmessage = () => {
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
    connect();
    return () => {
      closed = true;
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
        deps: depsByTask.get(t.id) ?? [],
        milestoneId: t.milestoneId,
        tagIds: tagsByTask.get(t.id) ?? [],
        type: t.type,
        openComments: t.openComments,
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
    const tasksOf = (pid: string) => data.tasks[pid] ?? [];
    const agentById = (pid: string, id: string) => (data.agents[pid] ?? []).find((a) => a.id === id) ?? null;
    const isBlocked = (pid: string, t: TaskVM) =>
      t.deps.some((d) => {
        const dt = tasksOf(pid).find((x) => x.id === d);
        return dt !== undefined && dt.status !== 'done' && dt.status !== 'cancelled';
      });
    const effStatus = (pid: string, t: TaskVM): TaskStatus =>
      t.status === 'todo' && isBlocked(pid, t) ? 'blocked' : t.status;
    return { tasksOf, agentById, isBlocked, effStatus };
  }, [data]);

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
        setView((v) => (v === 'settings' || v === 'agents' || v === 'home' ? 'control' : v));
        refresh();
        return;
      }
      setCurrentPid(id);
      setSelectedTaskId(null);
      setSnapshot(null);
      setView((v) => (v === 'settings' || v === 'home' ? 'control' : v));
      lastSeq.current = 0;
    },
    setView,
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
      await api.createTask(pidRef.current, input);
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
    user, authChecked, needsSetup, modal, editMilestone, groups, snapshot,
    currentPid: currentPid ?? '', view, selectedTaskId, selectedAgentId, draftKind, draftText, draggedId,
    data, helpers, actions,
  };
}

export type AppStore = ReturnType<typeof useAppStore>;
