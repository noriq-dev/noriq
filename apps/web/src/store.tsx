// Mock store — seed data and behaviors ported from the design prototype.
// This is a stand-in until the Phase 1 API lands; the UI reads everything
// through this hook so swapping in the live REST/WS adapter is contained here.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppData, CommentKind, TaskStatus, TaskVM, ViewId } from './types';
import { statusMeta } from './design';

function seed(): AppData {
  return {
    projects: [
      { id: 'coord', key: 'PLN', name: 'coordination-mvp', phase: 'Phase 1 · MCP + Coordination Core', dotColor: '#c6f24e', badge: 'CM' },
      { id: 'webapp', key: 'WEB', name: 'web-app-spa', phase: 'Phase 2 · Supervisor UI', dotColor: '#4c9dff', badge: 'WA' },
      { id: 'git', key: 'GIT', name: 'git-awareness', phase: 'Phase 4 · fast-follow', dotColor: '#b57bff', badge: 'GA' },
      { id: 'hard', key: 'HRD', name: 'hardening-v1', phase: 'Phase 5 · v1.0 release', dotColor: '#f5a623', badge: 'HV' },
    ],
    agents: {
      coord: [
        { id: 'atlas', name: 'atlas', role: 'orch', color: '#f5a623' },
        { id: 'nova', name: 'nova', role: 'worker', color: '#4c9dff' },
        { id: 'echo', name: 'echo', role: 'worker', color: '#b57bff' },
        { id: 'wren', name: 'wren', role: 'worker', color: '#3fd98b' },
        { id: 'pilot', name: 'pilot', role: 'worker', color: 'rgba(255,255,255,.16)' },
      ],
      webapp: [
        { id: 'atlas', name: 'atlas', role: 'orch', color: '#f5a623' },
        { id: 'iris', name: 'iris', role: 'worker', color: '#4c9dff' },
        { id: 'sol', name: 'sol', role: 'worker', color: '#3fd98b' },
      ],
      git: [
        { id: 'atlas', name: 'atlas', role: 'orch', color: '#f5a623' },
        { id: 'kite', name: 'kite', role: 'worker', color: '#b57bff' },
      ],
      hard: [
        { id: 'atlas', name: 'atlas', role: 'orch', color: '#f5a623' },
        { id: 'nova', name: 'nova', role: 'worker', color: '#4c9dff' },
      ],
    },
    tasks: {
      coord: [
        { id: 129, key: 'PLN-129', title: 'API-key auth middleware (hashed at rest)', body: 'Issue, scope and revoke agent keys. Middleware on the Worker validates a hashed key on every MCP + REST call.', status: 'done', claimedBy: null, deps: [], comments: [] },
        { id: 133, key: 'PLN-133', title: 'Append-only event log for every mutation', body: 'Foundation for audit + live UI. Every claim, status change, comment and message emits an immutable event row.', status: 'done', claimedBy: null, deps: [], comments: [] },
        { id: 131, key: 'PLN-131', title: 'D1 schema + migrations (§4 model)', body: 'Projects, tasks, subtasks, dependencies, claims, comments, messages, events. Migration + seed script.', status: 'review', claimedBy: 'wren', deps: [], comments: [] },
        {
          id: 142, key: 'PLN-142', title: 'Implement claim/lock arbiter in ProjectRoom DO', body: 'Single-writer claim arbiter inside the ProjectRoom Durable Object. Grants at most one live claim per task, with a TTL renewed by heartbeat; dependencies gate claimability.', status: 'in_progress', claimedBy: 'nova', ttl: 52, ttlMax: 90, deps: [],
          comments: [
            { id: 1, author: 'you', role: 'human', kind: 'question', body: 'Does the claim TTL cover a mid-heartbeat crash — i.e. an agent that dies between renewals?', status: 'addressed' },
            { id: 2, author: 'nova', role: 'agent', kind: 'reply', body: 'Yes — the heartbeat renews the TTL each interval. On a crash the TTL simply lapses and the DO auto-requeues the task for the next worker.', status: 'addressed' },
            { id: 3, author: 'you', role: 'human', kind: 'instruction', body: 'Log the requeue as its own event so the timeline shows why a task went back to todo.', status: 'open' },
          ],
        },
        { id: 138, key: 'PLN-138', title: 'MCP tool: claim_task / release_task / heartbeat', body: 'Expose the coordination primitives as MCP tools. claim_task returns a lock token used by heartbeat to renew the TTL.', status: 'in_progress', claimedBy: 'echo', ttl: 67, ttlMax: 90, deps: [], comments: [] },
        { id: 147, key: 'PLN-147', title: 'AgentSession DO: presence + per-agent inbox', body: 'One Durable Object per active agent. Tracks heartbeat/presence and holds a per-agent message inbox.', status: 'todo', claimedBy: null, deps: [], comments: [] },
        { id: 160, key: 'PLN-160', title: 'next_claimable resolver', body: 'Return the next dependency-unblocked, unclaimed task for a worker to pull — the core of the orchestrator→worker drain loop.', status: 'todo', claimedBy: null, deps: [138], comments: [] },
        { id: 155, key: 'PLN-155', title: 'WebSocket fanout from ProjectRoom to UI', body: 'Live channel: the ProjectRoom DO fans out every event to subscribed UIs and agents over WebSocket.', status: 'todo', claimedBy: null, deps: [142], comments: [] },
      ],
      webapp: [
        { id: 201, key: 'WEB-201', title: 'SPA scaffold + WS client', body: 'Lean, WS-friendly SPA shell with a live event socket.', status: 'in_progress', claimedBy: 'iris', ttl: 40, ttlMax: 90, deps: [], comments: [] },
        { id: 205, key: 'WEB-205', title: 'Threaded comment panel per task', body: 'Open-vs-resolved state, agent replies inline, unaddressed badge.', status: 'todo', claimedBy: null, deps: [], comments: [] },
        { id: 208, key: 'WEB-208', title: 'Board + list + timeline views', body: 'Three project views sharing one live store.', status: 'review', claimedBy: 'sol', deps: [], comments: [] },
        { id: 210, key: 'WEB-210', title: 'Force-release a stale claim (human action)', body: 'A human is just another actor — let them reap a dead agent’s claim.', status: 'done', claimedBy: null, deps: [], comments: [] },
      ],
      git: [
        { id: 301, key: 'GIT-301', title: 'Link tasks ↔ branches / PRs / commits', body: 'repo_url + default_branch on project; task-level refs.', status: 'in_progress', claimedBy: 'kite', ttl: 58, ttlMax: 90, deps: [], comments: [] },
        { id: 305, key: 'GIT-305', title: 'Ingest GitHub webhooks → reflect PR state', body: '“in review / merged” flows back onto task status.', status: 'todo', claimedBy: null, deps: [301], comments: [] },
      ],
      hard: [
        { id: 401, key: 'HRD-401', title: 'Load-test the claim arbiter', body: 'Hammer the single-writer path under concurrent claims.', status: 'todo', claimedBy: null, deps: [], comments: [] },
        { id: 405, key: 'HRD-405', title: 'Quickstart: deploy to your CF account', body: 'One-command self-host docs.', status: 'in_progress', claimedBy: 'nova', ttl: 71, ttlMax: 90, deps: [], comments: [] },
      ],
    },
    events: {
      coord: [
        { id: 'e6', t: '14:23:55', actor: 'system', verb: 'done', subject: 'PLN-129 · API-key auth middleware merged' },
        { id: 'e5', t: '14:23:37', actor: 'echo', verb: 'msg', subject: '→ nova · “claim_task returns a lock token — use it in heartbeat”' },
        { id: 'e4', t: '14:23:19', actor: 'wren', verb: 'status →review', subject: 'PLN-131 · D1 schema + migrations', taskId: 131 },
        { id: 'e3', t: '14:23:02', actor: 'atlas', verb: 'subtask', subject: 'created PLN-160 · next_claimable resolver', taskId: 160 },
        { id: 'e2', t: '14:22:31', actor: 'you', verb: 'question', subject: 'on PLN-142 · “does the TTL cover a mid-heartbeat crash?”', taskId: 142 },
        { id: 'e1', t: '14:22:08', actor: 'nova', verb: 'claimed', subject: 'PLN-142 · Implement claim/lock arbiter in ProjectRoom DO', taskId: 142 },
      ],
      webapp: [
        { id: 'w2', t: '11:04:12', actor: 'sol', verb: 'status →review', subject: 'WEB-208 · board + list + timeline views', taskId: 208 },
        { id: 'w1', t: '11:01:40', actor: 'iris', verb: 'claimed', subject: 'WEB-201 · SPA scaffold + WS client', taskId: 201 },
      ],
      git: [
        { id: 'g1', t: '09:47:22', actor: 'kite', verb: 'claimed', subject: 'GIT-301 · link tasks ↔ branches / PRs', taskId: 301 },
      ],
      hard: [
        { id: 'h1', t: '16:20:05', actor: 'nova', verb: 'claimed', subject: 'HRD-405 · quickstart deploy docs', taskId: 405 },
      ],
    },
  };
}

const nowT = () => {
  const n = new Date();
  return [n.getHours(), n.getMinutes(), n.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
};

export function useAppStore() {
  const [currentPid, setCurrentPid] = useState('coord');
  const [view, setView] = useState<ViewId>('control');
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [draftKind, setDraftKind] = useState<Exclude<CommentKind, 'reply'>>('question');
  const [draftText, setDraftText] = useState('');
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [data, setData] = useState<AppData>(seed);
  const [, setTick] = useState(0);
  const pidRef = useRef(currentPid);
  pidRef.current = currentPid;

  // Simulated live claim-TTL countdown (design parity; the WS feed replaces this).
  useEffect(() => {
    const iv = setInterval(() => {
      setData((d) => {
        const tasks = d.tasks[pidRef.current] ?? [];
        let changed = false;
        const next = tasks.map((t) => {
          if (t.status === 'in_progress' && typeof t.ttl === 'number') {
            changed = true;
            return { ...t, ttl: t.ttl <= 4 ? (t.ttlMax ?? 90) : t.ttl - 1 };
          }
          return t;
        });
        return changed ? { ...d, tasks: { ...d.tasks, [pidRef.current]: next } } : d;
      });
      setTick((x) => x + 1);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const helpers = useMemo(() => {
    const tasksOf = (pid: string) => data.tasks[pid] ?? [];
    const agentById = (pid: string, id: string) => (data.agents[pid] ?? []).find((a) => a.id === id) ?? null;
    const isBlocked = (pid: string, t: TaskVM) =>
      t.deps.some((d) => {
        const dt = tasksOf(pid).find((x) => x.id === d);
        return dt !== undefined && dt.status !== 'done';
      });
    const effStatus = (pid: string, t: TaskVM): TaskStatus =>
      t.status === 'todo' && isBlocked(pid, t) ? 'blocked' : t.status;
    return { tasksOf, agentById, isBlocked, effStatus };
  }, [data]);

  function emit(d: AppData, pid: string, actor: string, verb: string, subject: string, taskId?: number): AppData {
    const ev = { id: 'x' + Date.now() + Math.random(), t: nowT(), actor, verb, subject, taskId };
    return { ...d, events: { ...d.events, [pid]: [ev, ...(d.events[pid] ?? [])].slice(0, 50) } };
  }

  function mutateTask(d: AppData, pid: string, taskId: number, fn: (t: TaskVM) => TaskVM): AppData {
    const tasks = (d.tasks[pid] ?? []).map((t) => (t.id === taskId ? fn({ ...t, comments: [...t.comments] }) : t));
    return { ...d, tasks: { ...d.tasks, [pid]: tasks } };
  }

  const actions = {
    selectProject(id: string) {
      setCurrentPid(id);
      setSelectedTaskId(null);
    },
    setView,
    openTask: (id: number) => setSelectedTaskId(id),
    closeTask: () => setSelectedTaskId(null),
    setDraftText,
    setDraggedId,
    cycleKind() {
      const order = ['question', 'instruction', 'comment'] as const;
      setDraftKind((k) => order[(order.indexOf(k) + 1) % order.length]!);
    },

    claimToggle(taskId: number) {
      const pid = currentPid;
      setData((d) => {
        const t = (d.tasks[pid] ?? []).find((x) => x.id === taskId);
        if (!t) return d;
        if (t.claimedBy) {
          const who = t.claimedBy;
          let next = mutateTask(d, pid, taskId, (x) => ({
            ...x,
            claimedBy: null,
            status: x.status === 'in_progress' || x.status === 'claimed' ? 'todo' : x.status,
            ttl: undefined,
          }));
          return emit(next, pid, 'you', 'released', `${t.key} · claim by ${who} force-released`, t.id);
        }
        let next = mutateTask(d, pid, taskId, (x) => ({ ...x, claimedBy: 'pilot', status: 'in_progress', ttl: 90, ttlMax: 90 }));
        return emit(next, pid, 'pilot', 'claimed', `${t.key} · ${t.title}`, t.id);
      });
    },

    moveTask(taskId: number, status: TaskStatus) {
      const pid = currentPid;
      setData((d) => {
        const t = (d.tasks[pid] ?? []).find((x) => x.id === taskId);
        if (!t || t.status === status) return d;
        if (helpers.effStatus(pid, t) === 'blocked' && ['in_progress', 'review', 'done'].includes(status)) return d;
        let next = mutateTask(d, pid, taskId, (x) => ({
          ...x,
          status,
          claimedBy: status === 'in_progress' && !x.claimedBy ? 'pilot' : x.claimedBy,
          ttl: status === 'done' ? undefined : status === 'in_progress' && !x.claimedBy ? 90 : x.ttl,
          ttlMax: status === 'in_progress' && !x.claimedBy ? 90 : x.ttlMax,
        }));
        return emit(next, pid, 'you', `status →${statusMeta(status).label}`, `${t.key} · ${t.title}`, t.id);
      });
      setDraggedId(null);
    },

    postComment() {
      const text = draftText.trim();
      if (!text) return;
      const pid = currentPid;
      const kind = draftKind;
      const tasks = data.tasks[pid] ?? [];
      const target =
        (selectedTaskId != null ? tasks.find((x) => x.id === selectedTaskId) : null) ??
        tasks.find((x) => x.status === 'in_progress') ??
        tasks[0];
      if (!target) return;
      const cid = Date.now();
      setData((d) => {
        let next = mutateTask(d, pid, target.id, (x) => ({
          ...x,
          comments: [...x.comments, { id: cid, author: 'you', role: 'human' as const, kind, body: text, status: 'open' as const }],
        }));
        const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
        return emit(next, pid, 'you', kind, `on ${target.key} · “${preview}”`, target.id);
      });
      setDraftText('');

      // Simulated agent ack + resolve (design parity; the live agent does this via MCP).
      const replier = target.claimedBy ? helpers.agentById(pid, target.claimedBy)?.name ?? 'nova' : 'nova';
      setTimeout(() => {
        setData((d) => {
          let next = mutateTask(d, pid, target.id, (x) => ({
            ...x,
            comments: x.comments.map((c) => (c.id === cid && c.status === 'open' ? { ...c, status: 'acknowledged' as const } : c)),
          }));
          return emit(next, pid, replier, 'acknowledged', `your ${kind} on ${target.key}`, target.id);
        });
      }, 1300);
      setTimeout(() => {
        setData((d) => {
          const replyBody =
            kind === 'question'
              ? 'Good question — handling it now and keeping the claim.'
              : kind === 'instruction'
                ? 'Understood. Adjusting the approach and will note it in the next commit.'
                : 'Noted, thanks.';
          let next = mutateTask(d, pid, target.id, (x) => ({
            ...x,
            comments: [
              ...x.comments.map((c) => (c.id === cid ? { ...c, status: 'addressed' as const } : c)),
              { id: cid + 1, author: replier, role: 'agent' as const, kind: 'reply' as const, body: replyBody, status: 'addressed' as const },
            ],
          }));
          return emit(next, pid, replier, 'resolved', `${target.key} · ${kind} addressed`, target.id);
        });
      }, 3000);
    },
  };

  return { currentPid, view, selectedTaskId, draftKind, draftText, draggedId, data, helpers, actions };
}

export type AppStore = ReturnType<typeof useAppStore>;
