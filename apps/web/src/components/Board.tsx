// Board — kanban with composable milestone, task-attribute, plan, tag, and text filters.
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppStore } from '../store';
import type { TaskStatus } from '../types';
import { MIN_TOUCH_TARGET, useViewport } from '../viewport';
import { statusMeta } from '../design';
import { AvatarChip, MonoTag } from './bits';
import { Button, Select } from './ui';
import { confirm, prompt } from './Dialog';

const COLUMNS: Array<[TaskStatus, string]> = [
  // A run agent's proposed task (PLNR-230) sits BEFORE todo: it is not yet work, it is a
  // question — accept (→ todo) or reject (→ cancelled) from the card/drawer. Not a drop
  // target in either direction (store.moveTask refuses); the buttons are the only doors.
  ['proposed', 'Proposed'],
  ['todo', 'Todo'],
  ['in_progress', 'In progress'],
  // A gate-failed task (PLNR-178) gets its own column BEFORE review — the whole point is that
  // it is NOT "awaiting review". Underneath it is a re-armable todo; here it reads as needing a
  // human. Not a drop target (store.moveTask rejects a drag into 'failed').
  ['failed', 'Failed'],
  ['review', 'Review'],
  ['done', 'Done'],
];

const TYPE_ICON: Record<string, string> = { bug: '✕', chore: '⟳', research: '?', feature: '' };

export function Board({ store }: { store: AppStore }) {
  const { phone } = useViewport();
  const { currentPid, helpers, actions, draggedId, snapshot, showArchived, boardId } = store;
  const tasks = helpers.tasksOf(currentPid);
  // Milestone progress counts the *whole* milestone, archived work included — otherwise
  // finishing a milestone makes it read 0/0 as its done tasks auto-archive (PLNR-150).
  const allTasks = helpers.allTasksOf(currentPid);
  const milestones = snapshot?.milestones ?? [];
  const tags = snapshot?.tags ?? [];
  const boards = snapshot?.boards ?? [];
  const firstBoardId = boards[0]?.id ?? null;
  // Tasks holding one or more file locks (PLNR-212) → a 🔒 chip on the card.
  const lockedTaskIds = new Set((snapshot?.locks ?? []).map((l) => l.taskId).filter(Boolean) as string[]);
  const [msFilter, setMsFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // Tag row collapse (PLNR-196): null = default (open unless the vocabulary is large).
  const [tagsOpen, setTagsOpen] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [bodyMatches, setBodyMatches] = useState<Set<string>>(new Set());
  // Attribute filters (PLNR-161): the triage axes the milestone/tag/text bar didn't cover.
  const [prioFilter, setPrioFilter] = useState(5); // most-urgent-first scale: keep tasks with
  // priority <= this. 5 = any, since 0 is now P0, a real value (PLNR-231).
  const [typeFilter, setTypeFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<'' | 'unblocked' | 'grabbable' | 'overdue'>('');
  const [planFilter, setPlanFilter] = useState<'' | 'planned' | 'standalone'>('');
  // Multi-select for bulk triage (PLNR-125): shift/cmd-click gathers cards; a plain
  // click still opens the drawer, so the two gestures never fight.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeLane, setActiveLane] = useState<TaskStatus>('todo');
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const tagById = new Map(tags.map((c) => [c.id, c]));
  const msById = new Map(milestones.map((m) => [m.id, m]));
  const tagsExpanded = tagsOpen ?? tags.length <= 25;
  const activeTag = tagFilter ? tagById.get(tagFilter) ?? null : null;
  // Plan membership is represented by phase_tasks, not a task column. Keep this derived from
  // the snapshot so the filter follows the same canonical relationship as PlansView.
  const planTaskIds = new Set((snapshot?.phaseTasks ?? []).map((pt) => pt.taskId));

  // A task shows on the selected board; tasks with no board (shouldn't happen post-
  // migration) fall onto the default board so nothing ever disappears.
  const onBoard = (tBoardId: string | null) =>
    boardId === null || tBoardId === boardId || (tBoardId == null && boardId === firstBoardId);

  const q = query.trim().toLowerCase();
  useEffect(() => {
    const controller = new AbortController();
    setBodyMatches(new Set());
    if (!q) return () => controller.abort();
    const timer = setTimeout(() => {
      void (async () => {
        const ids = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await api.taskBodyMatches(currentPid, q, cursor, controller.signal);
          for (const id of page.taskIds) ids.add(id);
          if (!controller.signal.aborted) setBodyMatches(new Set(ids));
          cursor = page.nextCursor ?? undefined;
        } while (cursor && !controller.signal.aborted);
      })().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setBodyMatches(new Set());
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [currentPid, q]);

  const stateOk = (t: (typeof tasks)[number]): boolean => {
    if (!stateFilter) return true;
    const openish = t.status !== 'done' && t.status !== 'cancelled';
    if (stateFilter === 'overdue') return openish && !!t.dueAt && new Date(t.dueAt).getTime() < Date.now();
    const unblocked = helpers.effStatus(currentPid, t) !== 'blocked';
    if (stateFilter === 'unblocked') return openish && unblocked;
    // grabbable = what an agent could claim right now.
    return t.status === 'todo' && unblocked && !t.claimedBy;
  };
  const visible = tasks.filter(
    (t) =>
      onBoard(t.boardId) &&
      (msFilter === null || t.milestoneId === msFilter) &&
      (tagFilter === null || t.tagIds.includes(tagFilter)) &&
      (prioFilter >= 5 || t.priority <= prioFilter) &&
      (typeFilter === '' || t.type === typeFilter) &&
      (planFilter === '' || (planFilter === 'planned' ? planTaskIds.has(t.id) : !planTaskIds.has(t.id))) &&
      stateOk(t) &&
      (q === '' ||
        t.title.toLowerCase().includes(q) ||
        t.key.toLowerCase().includes(q) ||
        bodyMatches.has(t.id) ||
        t.tagIds.some((id) => tagById.get(id)?.name.toLowerCase().includes(q))),
  );

  const mobileColumns = COLUMNS.filter(([status]) =>
    status !== 'proposed' || visible.some((task) => task.status === 'proposed'));
  useEffect(() => {
    if (!mobileColumns.some(([status]) => status === activeLane)) setActiveLane('todo');
  }, [activeLane, mobileColumns]);

  if (phone) {
    const laneTasks = visible
      .filter((task) => task.status === activeLane)
      .sort((a, b) => a.priority - b.priority);
    return (
      <div data-testid="mobile-board" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
        <BoardTabs
          boards={boards}
          current={boardId}
          editable={store.permissions.canContribute}
          onSelect={(id) => actions.setBoard(id)}
          onCreate={async () => {
            const name = (await prompt('New board name:'))?.trim();
            if (name) void actions.createBoard(name);
          }}
          onRename={async (id, cur) => {
            const name = (await prompt('Rename board:', cur))?.trim();
            if (name && name !== cur) void actions.renameBoard(id, name);
          }}
          onDelete={async (id, name) => {
            if (await confirm(`Delete board "${name}"? Its tasks move to another board.`)) void actions.deleteBoard(id);
          }}
        />
        <nav aria-label="Board lanes" style={{ flex: 'none', display: 'flex', gap: 7, overflowX: 'auto', padding: '10px 12px 9px', borderBottom: '1px solid var(--line)' }}>
          {mobileColumns.map(([status, label]) => {
            const meta = statusMeta(status);
            const count = visible.filter((task) => task.status === status).length;
            const active = status === activeLane;
            return (
              <button
                key={status}
                type="button"
                aria-pressed={active}
                onClick={() => setActiveLane(status)}
                style={{ minHeight: MIN_TOUCH_TARGET, flex: 'none', display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', borderRadius: 999, cursor: 'pointer', background: active ? 'rgba(198,242,78,.1)' : 'var(--w-03)', color: active ? 'var(--accent)' : 'var(--text-mid)', border: `1px solid ${active ? 'rgba(198,242,78,.35)' : 'var(--w-08)'}`, fontSize: 12, fontWeight: 600 }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.dot }} />
                {label}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: active ? 'var(--accent)' : 'var(--text-faint)' }}>{count}</span>
              </button>
            );
          })}
        </nav>
        <div data-testid={`mobile-board-lane-${activeLane}`} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 12px 20px' }}>
          {laneTasks.length === 0 && <div style={{ padding: '36px 12px', textAlign: 'center', color: 'var(--text-faint)', fontSize: 12 }}>No tasks in this lane.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {laneTasks.map((task) => {
              const effective = helpers.effStatus(currentPid, task);
              const blocked = effective === 'blocked';
              const agent = task.claimedBy ? helpers.agentById(currentPid, task.claimedBy) : null;
              const taskTags = task.tagIds.map((id) => tagById.get(id)).filter(Boolean) as Array<{ id: string; name: string; color: string }>;
              const milestone = task.milestoneId ? msById.get(task.milestoneId) : null;
              const depKey = task.deps.map((id) => tasks.find((candidate) => candidate.id === id)?.key ?? '')[0] ?? '';
              const typeIcon = TYPE_ICON[task.type] ?? '';
              return (
                <article
                  key={task.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => actions.openTask(task.id)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') actions.openTask(task.id); }}
                  className="hover-border"
                  style={{ background: 'var(--card)', border: '1px solid var(--w-06)', borderLeft: `3px solid ${taskTags[0]?.color ?? 'var(--w-08)'}`, borderRadius: 11, padding: '13px 14px', cursor: 'pointer', opacity: task.archivedAt ? 0.5 : 1 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 20, marginBottom: 7, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: statusMeta(effective).color }}>{task.key}</span>
                    {task.archivedAt && <MonoTag color="var(--text-faint)" bg="var(--w-05)" size={8.5}>🗄</MonoTag>}
                    {typeIcon && <span title={task.type} style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: task.type === 'bug' ? 'var(--red-soft)' : 'var(--text-dim)' }}>{typeIcon} {task.type}</span>}
                    <div style={{ flex: 1 }} />
                    {task.priority !== 2 && <MonoTag color={task.priority <= 0 ? 'var(--red-soft)' : task.priority === 1 ? 'var(--amber)' : 'var(--text-faint)'} bg="var(--w-04)" size={9}>P{task.priority}</MonoTag>}
                    {task.estimate !== null && <MonoTag color="var(--text-faint)" bg="var(--w-04)" size={9}>{task.estimate}pt</MonoTag>}
                    {task.dueAt && task.status !== 'done' && task.status !== 'cancelled' && (() => {
                      const overdue = new Date(task.dueAt).getTime() < Date.now();
                      return <MonoTag color={overdue ? 'var(--red-soft)' : 'var(--text-faint)'} bg="var(--w-04)" size={9}>{overdue ? '⚠ ' : ''}{new Date(task.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</MonoTag>;
                    })()}
                    {task.openComments > 0 && <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{task.openComments} ?</MonoTag>}
                    {lockedTaskIds.has(task.id) && <MonoTag color="var(--blue)" bg="rgba(76,157,255,.12)" size={9.5}>🔒</MonoTag>}
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.45, color: 'var(--text)' }}>{task.title}</div>
                  {task.status === 'proposed' && store.permissions.canContribute && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <Button variant="primary" style={{ minHeight: MIN_TOUCH_TARGET, padding: '5px 13px' }} onClick={(event) => { event.stopPropagation(); void actions.acceptProposal(task.id); }}>✓ accept</Button>
                      <Button variant="danger" style={{ minHeight: MIN_TOUCH_TARGET, padding: '5px 13px' }} onClick={async (event) => { event.stopPropagation(); if (await confirm(`Reject proposal ${task.key}? The task is cancelled (its finding stays on record).`)) void actions.rejectProposal(task.id); }}>✕ reject</Button>
                    </div>
                  )}
                  {(taskTags.length > 0 || agent || blocked || milestone) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
                      {taskTags.map((tag) => <span key={tag.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--mono)', fontSize: 9.5, color: tag.color, border: `1px solid ${tag.color}44`, padding: '2px 7px', borderRadius: 5 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: tag.color }} />{tag.name}</span>)}
                      {agent && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><AvatarChip name={agent.name} color={agent.color} size={18} radius={4} fontSize={7.5} /><span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-mid)' }}>{agent.name}</span></span>}
                      <span style={{ flex: 1 }} />
                      {blocked ? <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)' }}>⟂ {depKey}</span> : milestone && <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{milestone.title}</span>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* board switcher (PLNR-80) */}
      <BoardTabs
        boards={boards}
        current={boardId}
        editable={store.permissions.canContribute}
        onSelect={(id) => actions.setBoard(id)}
        onCreate={async () => {
          const name = (await prompt('New board name:'))?.trim();
          if (name) void actions.createBoard(name);
        }}
        onRename={async (id, cur) => {
          const name = (await prompt('Rename board:', cur))?.trim();
          if (name && name !== cur) void actions.renameBoard(id, name);
        }}
        onDelete={async (id, name) => {
          if (await confirm(`Delete board "${name}"? Its tasks move to another board.`)) void actions.deleteBoard(id);
        }}
      />

      {/* filter bar — row 1: milestones (wrapping, wheel-scrollable when tall) + pinned search.
          PLNR-189: chips WRAP instead of overflowing horizontally — a horizontal overflow
          strip can't be wheel-scrolled and runs off the page. Past ~2 lines the area
          scrolls vertically, which the wheel handles natively. */}
      <div
        style={{
          flex: 'none', display: 'flex', alignItems: 'flex-start', gap: 8,
          padding: '12px 22px 8px',
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', maxHeight: 92, overflowY: 'auto' }}>
        <FilterChip label="All" active={msFilter === null} onClick={() => setMsFilter(null)} />
        {store.permissions.canContribute && <button
          onClick={() => actions.openModal('milestone')}
          title="New milestone"
          className="rail-add"
          style={{
            cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10.5,
            color: 'var(--text-dim)', border: '1px dashed var(--w-15)',
            padding: '4px 10px', borderRadius: 8, background: 'transparent',
          }}
        >
          + milestone
        </button>}
        {milestones.map((m) => {
          const total = allTasks.filter((t) => t.milestoneId === m.id).length;
          const done = allTasks.filter((t) => t.milestoneId === m.id && t.status === 'done').length;
          // Completed milestones stay out of the way unless actively selected.
          if (total > 0 && done === total && msFilter !== m.id) return null;
          return (
            <FilterChip
              key={m.id}
              label={m.title}
              meta={`${done}/${total}`}
              pct={total ? done / total : 0}
              active={msFilter === m.id}
              onClick={() => setMsFilter(msFilter === m.id ? null : m.id)}
            />
          );
        })}
        {msFilter !== null && store.permissions.canContribute && (
          <button
            onClick={() => {
              const m = msById.get(msFilter);
              if (m) actions.openMilestoneEditor({ id: m.id, title: m.title, dueAt: m.dueAt });
            }}
            title="Edit this milestone"
            style={{
              cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10.5,
              color: 'var(--accent-ink)', border: '1px solid rgba(198,242,78,.3)',
              padding: '4px 10px', borderRadius: 8, background: 'rgba(198,242,78,.06)',
            }}
          >
            ✎ edit
          </button>
        )}
        </div>
      </div>

      {/* filter bar — row 2 (PLNR-196): the attribute filters with archive + search on
          the same line, one consistent control strip above the tag chips. */}
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 22px 8px' }}>
        {/* Attribute filters (PLNR-161) — compose with milestone/tag/text and with
            multi-select: filter down, then shift-click + bulk act. */}
        {/* "at least this urgent" is now priority <= N (PLNR-231), and the any-sentinel is 5:
            0 is a real value (P0), so it can no longer stand for "no filter". */}
        <FilterSelect label="Priority filter" value={String(prioFilter)} onChange={(v) => setPrioFilter(Number(v))} active={prioFilter < 5}>
          <option value="5">priority: any</option>
          <option value="0">P0 only</option>
          <option value="1">P1 +</option>
          <option value="2">P2 +</option>
        </FilterSelect>
        <FilterSelect label="Task type filter" value={typeFilter} onChange={setTypeFilter} active={typeFilter !== ''}>
          <option value="">type: any</option>
          <option value="feature">feature</option>
          <option value="bug">bug</option>
          <option value="chore">chore</option>
          <option value="research">research</option>
        </FilterSelect>
        <FilterSelect label="Task state filter" value={stateFilter} onChange={(v) => setStateFilter(v as typeof stateFilter)} active={stateFilter !== ''}>
          <option value="">state: any</option>
          <option value="unblocked">unblocked</option>
          <option value="grabbable">up for grabs</option>
          <option value="overdue">overdue</option>
        </FilterSelect>
        <FilterSelect label="Plan filter" value={planFilter} onChange={(v) => setPlanFilter(v as typeof planFilter)} active={planFilter !== ''}>
          <option value="">plan: any</option>
          <option value="planned">in a plan</option>
          <option value="standalone">not in a plan</option>
        </FilterSelect>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => actions.toggleArchived()}
          title={showArchived ? 'Hide archived tasks' : 'Show archived tasks'}
          style={{
            cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10.5,
            padding: '4px 10px', borderRadius: 8, whiteSpace: 'nowrap',
            color: showArchived ? 'var(--accent-ink)' : 'var(--text-dim)',
            background: showArchived ? 'rgba(198,242,78,.1)' : 'transparent',
            border: `1px solid ${showArchived ? 'rgba(198,242,78,.35)' : 'var(--w-1)'}`,
          }}
        >
          🗄 archive
        </button>
        <SearchBox value={query} onChange={setQuery} />
      </div>

      {/* filter bar — row 3: tags, collapsible (PLNR-196). Even a curated vocabulary can
          be large, so past 25 tags the row starts collapsed; an active tag filter stays
          visible so hidden state never silently filters the board. */}
      <div
        style={{
          flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
          padding: '0 22px 10px', flexWrap: 'wrap', maxHeight: 96, overflowY: 'auto',
          borderBottom: '1px solid var(--w-05)',
        }}
      >
        <button
          onClick={() => setTagsOpen(!tagsExpanded)}
          title={tagsExpanded ? 'Collapse tags' : 'Expand tags'}
          style={{
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, flex: 'none',
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.07em', textTransform: 'uppercase',
            color: 'var(--text-faint)', background: 'transparent', border: 'none', padding: '2px 0',
          }}
        >
          <span>{tagsExpanded ? '▾' : '▸'}</span>
          <span>tags · {tags.length}</span>
        </button>
        {!tagsExpanded && activeTag && (
          <FilterChip
            label={activeTag.name}
            dot={activeTag.color}
            small
            active
            onClick={() => setTagFilter(null)}
          />
        )}
        {tagsExpanded && (
          <>
            {store.permissions.canContribute && <button
              onClick={() => actions.openModal('tag')}
              title="New tag"
              className="rail-add"
              style={{
                cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 10,
                color: 'var(--text-dim)', border: '1px dashed var(--w-15)',
                padding: '3px 9px', borderRadius: 8, background: 'transparent',
              }}
            >
              + tag
            </button>}
            {tags.map((c) => (
              <FilterChip
                key={c.id}
                label={c.name}
                dot={c.color}
                small
                active={tagFilter === c.id}
                onClick={() => setTagFilter(tagFilter === c.id ? null : c.id)}
                onDelete={store.permissions.canContribute ? async () => {
                  if (await confirm(`Delete tag "${c.name}"? It's removed from all tasks.`)) {
                    if (tagFilter === c.id) setTagFilter(null);
                    void actions.deleteTag(c.id);
                  }
                } : undefined}
              />
            ))}
          </>
        )}
      </div>

      {/* columns */}
      <div style={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', padding: '16px 22px 18px' }}>
        <div style={{ display: 'flex', gap: 18, height: '100%', minWidth: 'min-content' }}>
          {COLUMNS.filter(
            // The Proposed column exists only while there is a decision to make (PLNR-230) —
            // spin-offs are the exception, not a lane every board pays for.
            ([st]) => st !== 'proposed' || visible.some((t) => t.status === 'proposed'),
          ).map(([st, label]) => {
            const m = statusMeta(st);
            // Urgent first; the stable sort keeps board order within a priority band (PLNR-119).
            // Ascending, because 0 is the most urgent (PLNR-231).
            const list = visible.filter((t) => t.status === st).sort((a, b) => a.priority - b.priority);
            return (
              <div
                key={st}
                onDragOver={(e) => {
                  e.preventDefault();
                  // 'failed' is system-set (PLNR-178) — not a drop target; show the no-drop cursor.
                  e.dataTransfer.dropEffect = st === 'failed' ? 'none' : 'move';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (store.permissions.canContribute && draggedId != null && st !== 'failed') actions.moveTask(draggedId, st);
                }}
                className="board-col"
                style={{ width: 282, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}
              >
                <div style={{ padding: '2px 4px 12px', display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.dot }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-soft)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>{list.length}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--w-05)' }} />
                </div>
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 2 }}>
                  {list.map((t) => {
                    const ag = t.claimedBy ? helpers.agentById(currentPid, t.claimedBy) : null;
                    const eff = helpers.effStatus(currentPid, t);
                    const blocked = eff === 'blocked';
                    const taskTags = t.tagIds.map((id) => tagById.get(id)).filter(Boolean) as Array<{ id: string; name: string; color: string }>;
                    const ms = t.milestoneId ? msById.get(t.milestoneId) : null;
                    const depKey = t.deps.map((d) => tasks.find((x) => x.id === d)?.key ?? '')[0] ?? '';
                    const typeIcon = TYPE_ICON[t.type] ?? '';
                    return (
                      <div
                        key={t.id}
                        draggable={store.permissions.canContribute}
                        onDragStart={(e) => {
                          if (!store.permissions.canContribute) return;
                          actions.setDraggedId(t.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => actions.setDraggedId(null)}
                        onClick={(e) => {
                          if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelect(t.id);
                          else actions.openTask(t.id);
                        }}
                        className="hover-border"
                        style={{
                          background: selected.has(t.id) ? 'var(--w-06)' : 'var(--card)',
                          border: `1px solid ${selected.has(t.id) ? 'var(--accent)' : 'var(--w-06)'}`,
                          borderLeft: `3px solid ${selected.has(t.id) ? 'var(--accent)' : taskTags[0]?.color ?? 'var(--w-08)'}`,
                          borderRadius: 10,
                          padding: '12px 13px',
                          cursor: store.permissions.canContribute ? 'grab' : 'pointer',
                          opacity: draggedId === t.id ? 0.4 : t.archivedAt ? 0.5 : 1,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: statusMeta(eff).color }}>{t.key}</span>
                          {t.archivedAt && (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', border: '1px solid var(--w-1)', padding: '0 4px', borderRadius: 4 }}>🗄</span>
                          )}
                          {typeIcon && (
                            <span title={t.type} style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: t.type === 'bug' ? 'var(--red-soft)' : 'var(--text-dim)' }}>
                              {typeIcon} {t.type}
                            </span>
                          )}
                          <div style={{ flex: 1 }} />
                          {/* Default (P2) stays quiet — a badge on every card says nothing (PLNR-119). */}
                          {t.priority !== 2 && (
                            <span
                              title={`priority ${t.priority}`}
                              style={{
                                fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                                color: t.priority <= 0 ? 'var(--red-soft)' : t.priority === 1 ? 'var(--amber)' : 'var(--text-faint)',
                                border: `1px solid ${t.priority <= 0 ? 'rgba(255,92,92,.4)' : t.priority === 1 ? 'rgba(245,166,35,.35)' : 'var(--w-1)'}`,
                                padding: '0 5px', borderRadius: 4,
                              }}
                            >
                              P{t.priority}
                            </span>
                          )}
                          {t.estimate !== null && (
                            <span
                              title="estimate"
                              style={{
                                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)',
                                border: '1px solid var(--w-1)', padding: '0 5px', borderRadius: 4,
                              }}
                            >
                              {t.estimate}pt
                            </span>
                          )}
                          {t.dueAt && t.status !== 'done' && t.status !== 'cancelled' && (() => {
                            const overdue = new Date(t.dueAt).getTime() < Date.now();
                            return (
                              <span
                                title={`due ${new Date(t.dueAt).toLocaleString()}`}
                                style={{
                                  fontFamily: 'var(--mono)', fontSize: 9, fontWeight: overdue ? 700 : 400,
                                  color: overdue ? 'var(--red-soft)' : 'var(--text-faint)',
                                  border: `1px solid ${overdue ? 'rgba(255,92,92,.4)' : 'var(--w-1)'}`,
                                  padding: '0 5px', borderRadius: 4, whiteSpace: 'nowrap',
                                }}
                              >
                                {overdue ? '⚠ ' : ''}{new Date(t.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                              </span>
                            );
                          })()}
                          {t.openComments > 0 && (
                            <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{t.openComments} ?</MonoTag>
                          )}
                          {lockedTaskIds.has(t.id) && (
                            <MonoTag color="var(--blue)" bg="rgba(76,157,255,.12)" size={9.5}>🔒</MonoTag>
                          )}
                        </div>
                        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--text)' }}>{t.title}</div>
                        {/* The proposal decision (PLNR-230): accept → todo, reject → cancelled.
                            These buttons (and the drawer's) are the ONLY doors out of proposed. */}
                        {t.status === 'proposed' && store.permissions.canContribute && (
                          <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                            <Button
                              variant="primary"
                              style={{ fontSize: 10.5, padding: '3px 10px' }}
                              onClick={(e) => { e.stopPropagation(); void actions.acceptProposal(t.id); }}
                            >
                              ✓ accept
                            </Button>
                            <Button
                              variant="danger"
                              style={{ fontSize: 10.5, padding: '3px 10px' }}
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (await confirm(`Reject proposal ${t.key}? The task is cancelled (its finding stays on record).`)) {
                                  void actions.rejectProposal(t.id);
                                }
                              }}
                            >
                              ✕ reject
                            </Button>
                          </div>
                        )}
                        {(taskTags.length > 0 || ag || blocked || (ms && msFilter === null)) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                            {taskTags.map((tg) => (
                              <span
                                key={tg.id}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontFamily: 'var(--mono)', fontSize: 9, color: tg.color,
                                  border: `1px solid ${tg.color}44`, padding: '1px 6px', borderRadius: 5,
                                }}
                              >
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: tg.color }} />
                                {tg.name}
                              </span>
                            ))}
                            {ag && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <AvatarChip name={ag.name} color={ag.color} size={16} radius={4} fontSize={7.5} />
                                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-mid)' }}>{ag.name}</span>
                              </span>
                            )}
                            <span style={{ flex: 1 }} />
                            {blocked && (
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)' }}>⟂ {depKey}</span>
                            )}
                            {ms && msFilter === null && !blocked && (
                              <span
                                style={{
                                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)',
                                  border: '1px solid var(--w-08)', padding: '1px 6px', borderRadius: 4,
                                  whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
                                }}
                              >
                                {ms.title}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bulk-action bar (PLNR-125): floats only while a selection exists. */}
      {selected.size > 0 && store.permissions.canContribute && (
        <BulkBar
          count={selected.size}
          milestones={milestones}
          boards={boards}
          onStatus={async (st) => {
            for (const id of selected) await api.updateTask(currentPid, id, { status: st });
            setSelected(new Set());
          }}
          onMilestone={async (mid) => {
            for (const id of selected) await api.updateTask(currentPid, id, { milestoneId: mid });
            setSelected(new Set());
          }}
          onBoard={async (bid) => {
            for (const id of selected) await api.updateTask(currentPid, id, { boardId: bid });
            setSelected(new Set());
          }}
          onAddTag={async () => {
            const name = (await prompt('Add tag to selected tasks:'))?.trim();
            if (!name) return;
            // addTags keeps existing tags (PLNR-135) — bulk labelling can't clobber.
            for (const id of selected) await api.updateTask(currentPid, id, { addTags: [name] });
            setSelected(new Set());
          }}
          onArchive={async () => {
            if (!(await confirm(`Archive ${selected.size} task(s)?`))) return;
            for (const id of selected) await api.archiveTask(currentPid, id).catch(() => {});
            setSelected(new Set());
          }}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

function BulkBar({ count, milestones, boards, onStatus, onMilestone, onBoard, onAddTag, onArchive, onClear }: {
  count: number;
  milestones: Array<{ id: string; title: string }>;
  boards: Array<{ id: string; name: string }>;
  onStatus: (st: TaskStatus) => void;
  onMilestone: (mid: string) => void;
  onBoard: (bid: string) => void;
  onAddTag: () => void;
  onArchive: () => void;
  onClear: () => void;
}) {
  const sel: React.CSSProperties = {
    background: 'var(--w-06)', border: '1px solid var(--w-1)', borderRadius: 7,
    color: 'var(--text)', fontSize: 11.5, padding: '5px 8px', fontFamily: 'inherit', cursor: 'pointer',
  };
  return (
    <div
      className="bulk-bar"
      style={{
        position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px',
        background: 'var(--bg-raised)', border: '1px solid var(--w-18)', borderRadius: 12,
        boxShadow: '0 8px 28px rgba(0,0,0,.45)', zIndex: 40,
      }}
    >
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap' }}>
        {count} selected
      </span>
      <Select variant="micro" aria-label="Set selected task status" style={sel} defaultValue="" onChange={(e) => e.target.value && onStatus(e.target.value as TaskStatus)}>
        <option value="" disabled>status…</option>
        {(['todo', 'review', 'done', 'cancelled'] as TaskStatus[]).map((s) => <option key={s} value={s}>{s}</option>)}
      </Select>
      <Select variant="micro" aria-label="Set selected task milestone" style={sel} defaultValue="" onChange={(e) => e.target.value && onMilestone(e.target.value)}>
        <option value="" disabled>milestone…</option>
        {milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
      </Select>
      <Select variant="micro" aria-label="Set selected task board" style={sel} defaultValue="" onChange={(e) => e.target.value && onBoard(e.target.value)}>
        <option value="" disabled>board…</option>
        {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </Select>
      <button style={{ ...sel }} onClick={onAddTag}>+ tag</button>
      <button style={{ ...sel, color: 'var(--red-soft)' }} onClick={onArchive}>archive</button>
      <button style={{ ...sel, color: 'var(--text-dim)', border: 'none', background: 'transparent' }} onClick={onClear}>✕</button>
    </div>
  );
}

function FilterSelect({ label, value, onChange, active, children }: {
  label: string; value: string; onChange: (v: string) => void; active: boolean; children: React.ReactNode;
}) {
  return (
    <Select
      variant="micro"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        flex: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10,
        padding: '3px 6px', borderRadius: 8,
        color: active ? 'var(--accent-ink)' : 'var(--text-dim)',
        background: active ? 'rgba(198,242,78,.06)' : 'var(--w-03)',
        border: `1px solid ${active ? 'rgba(198,242,78,.35)' : 'var(--w-08)'}`,
        outline: 'none',
      }}
    >
      {children}
    </Select>
  );
}

function BoardTabs({ boards, current, editable, onSelect, onCreate, onRename, onDelete }: {
  boards: Array<{ id: string; name: string }>;
  current: string | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  return (
    <div
      style={{
        flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
        padding: '10px 22px 0', overflowX: 'auto',
      }}
    >
      {boards.map((b) => {
        const active = b.id === current;
        return (
          <div
            key={b.id}
            onClick={() => onSelect(b.id)}
            className="hover-border"
            style={{
              cursor: 'pointer', flex: 'none', display: 'flex', alignItems: 'center', gap: 7,
              padding: '6px 11px', borderRadius: '9px 9px 0 0',
              fontSize: 12.5, fontWeight: 600,
              color: active ? 'var(--text)' : 'var(--text-dim)',
              background: active ? 'var(--card)' : 'transparent',
              borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
            }}
          >
            {b.name}
            {active && editable && (
              <>
                <span
                  role="button"
                  title="Rename board"
                  onClick={(e) => { e.stopPropagation(); onRename(b.id, b.name); }}
                  className="hover-bright"
                  style={{ color: 'var(--text-faint)', fontSize: 10.5, lineHeight: 1, cursor: 'pointer' }}
                >
                  ✎
                </span>
                {boards.length > 1 && (
                  <span
                    role="button"
                    title="Delete board"
                    onClick={(e) => { e.stopPropagation(); onDelete(b.id, b.name); }}
                    className="hover-bright"
                    style={{ color: 'var(--text-faint)', fontSize: 11, lineHeight: 1, cursor: 'pointer' }}
                  >
                    🗑
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
      {editable && <button
        onClick={onCreate}
        title="New board"
        className="rail-add"
        style={{
          cursor: 'pointer', flex: 'none', fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text-dim)', border: '1px dashed var(--w-15)',
          padding: '5px 11px', borderRadius: 8, background: 'transparent', marginBottom: 2,
        }}
      >
        + board
      </button>}
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div
      style={{
        flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
        background: 'var(--w-03)', border: '1px solid var(--w-08)',
        borderRadius: 8, padding: '0 8px', height: 28, width: 210, maxWidth: '32vw',
      }}
    >
      <span style={{ color: 'var(--text-faint)', fontSize: 12, flex: 'none' }}>⌕</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search tasks…"
        style={{
          flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--text-soft)', fontSize: 12, fontFamily: 'inherit',
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          title="Clear search"
          style={{ cursor: 'pointer', flex: 'none', color: 'var(--text-faint)', fontSize: 13, background: 'transparent', border: 'none', padding: 0, lineHeight: 1 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function FilterChip({ label, meta, pct, dot, active, small, onClick, onDelete }: {
  label: string;
  meta?: string;
  pct?: number;
  dot?: string;
  active: boolean;
  small?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        cursor: 'pointer', flex: 'none', display: 'flex', alignItems: 'center', gap: 7,
        padding: small ? '3px 9px' : '5px 11px',
        borderRadius: 8,
        fontSize: small ? 10.5 : 11.5,
        fontWeight: 500,
        background: active ? 'rgba(198,242,78,.1)' : 'var(--w-03)',
        color: active ? 'var(--accent)' : 'var(--text-mid)',
        border: `1px solid ${active ? 'rgba(198,242,78,.35)' : 'var(--w-07)'}`,
        whiteSpace: 'nowrap',
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />}
      {label}
      {meta && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: active ? 'var(--accent)' : 'var(--text-faint)' }}>{meta}</span>
      )}
      {pct !== undefined && (
        <span style={{ width: 30, height: 3, borderRadius: 2, background: 'var(--w-1)', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${pct * 100}%`, background: pct === 1 ? 'var(--green)' : 'var(--blue)' }} />
        </span>
      )}
      {onDelete && (
        <span
          role="button"
          title="Delete tag"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={{ marginLeft: 1, color: 'var(--text-faint)', fontSize: 11, lineHeight: 1, cursor: 'pointer' }}
          className="hover-bright"
        >
          ✕
        </span>
      )}
    </button>
  );
}
