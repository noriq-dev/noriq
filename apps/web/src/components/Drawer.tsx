// Task detail drawer — view/edit, tags, comments, attachments, event timeline.
import { useEffect, useRef, useState } from 'react';
import type { AppStore } from '../store';
import { api, type ApiAgentEvent } from '../api';
import { KIND_META, statusMeta, verbColors } from '../design';
import { AvatarChip, MonoTag, SectionLabel } from './bits';
import { Composer } from './Composer';
import { Button, Select, TextArea, TextInput } from './ui';

export function Drawer({ store }: { store: AppStore }) {
  const { currentPid, selectedTaskId, helpers, actions, snapshot } = store;
  const tasks = helpers.tasksOf(currentPid);
  const task = selectedTaskId != null ? tasks.find((t) => t.id === selectedTaskId) : null;

  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eBody, setEBody] = useState('');
  const [eType, setEType] = useState('feature');
  const [ePriority, setEPriority] = useState(2);
  const [eTags, setETags] = useState('');
  const [eMilestone, setEMilestone] = useState('');
  const [eBoard, setEBoard] = useState('');
  const [timeline, setTimeline] = useState<ApiAgentEvent[]>([]);
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [addingDep, setAddingDep] = useState(false);
  const [depError, setDepError] = useState('');
  const [attachments, setAttachments] = useState<Array<{ id: string; filename: string; size: number; contentType?: string; createdAt: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const allTags = snapshot?.tags ?? [];
  const tagById = new Map(allTags.map((t) => [t.id, t]));

  useEffect(() => {
    setEditing(false);
    if (selectedTaskId) {
      api.taskEvents(selectedTaskId).then((r) => setTimeline(r.events)).catch(() => setTimeline([]));
      api.taskDetail(selectedTaskId).then((r) => setAttachments(r.attachments)).catch(() => setAttachments([]));
    }
  }, [selectedTaskId]);

  if (!task) return null;

  const eff = helpers.effStatus(currentPid, task);
  const m = statusMeta(eff);
  const ag = task.claimedBy ? helpers.agentById(currentPid, task.claimedBy) : null;
  const deps = task.deps.map((d) => {
    const dt = tasks.find((x) => x.id === d);
    return dt
      ? { id: dt.id, key: dt.key, title: dt.title, status: helpers.effStatus(currentPid, dt), found: true as const }
      : { id: d, key: `#${d.slice(0, 8)}`, title: '', status: 'todo' as const, found: false as const };
  });
  // Tasks eligible as a new dependency: same project, not self, not already a dep.
  const eligibleDeps = tasks.filter((t) => t.id !== task.id && !task.deps.includes(t.id));
  const canRelease = !!task.claimedBy;
  const holder = ag ? ag.name : eff === 'blocked' ? '— (blocked)' : '— (unclaimed)';
  const taskTags = task.tagIds.map((id) => tagById.get(id)).filter(Boolean) as Array<{ id: string; name: string; color: string }>;
  const milestone = task.milestoneId ? (snapshot?.milestones ?? []).find((mm) => mm.id === task.milestoneId) : null;
  const taskSignals = (snapshot?.signals ?? []).filter((s) => s.taskId === task.id);

  const startEdit = () => {
    setETitle(task.title);
    setEBody(task.body);
    setEType(task.type);
    setEPriority(0); // priority isn't in the VM snapshot list; leave unchanged unless touched
    setETags(taskTags.map((t) => t.name).join(', '));
    setEMilestone(task.milestoneId ?? '');
    setEBoard(task.boardId ?? '');
    setEditing(true);
  };

  const saveEdit = async () => {
    await api.updateTask(currentPid, task.id, {
      title: eTitle.trim() || task.title,
      body: eBody,
      type: eType,
      tags: eTags.split(',').map((t) => t.trim()).filter(Boolean),
      milestoneId: eMilestone || null,
      ...(eBoard ? { boardId: eBoard } : {}),
      ...(ePriority > 0 ? { priority: ePriority } : {}),
    });
    setEditing(false);
    actions.refreshNow();
  };

  const upload = async (file: File) => {
    await api.uploadAttachment(task.id, file);
    const detail = await api.taskDetail(task.id);
    setAttachments(detail.attachments);
    actions.refreshNow();
  };

  return (
    <>
      <div onClick={actions.closeTask} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 40 }} />
      <div
        className="task-drawer"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 480, maxWidth: '100vw',
          background: 'var(--bg-raised)', borderLeft: '1px solid var(--w-1)', zIndex: 41,
          display: 'flex', flexDirection: 'column',
          animation: 'pl-drawer .28s cubic-bezier(.22,1,.36,1) both',
          boxShadow: '-20px 0 60px rgba(0,0,0,.5)',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', flex: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <MonoTag color={m.color} bg={m.bg} size={11}>{task.key}</MonoTag>
            <MonoTag color={m.color} bg={m.bg} size={10.5}>{m.label}</MonoTag>
            <MonoTag color={task.type === 'bug' ? 'var(--red-soft)' : 'var(--text-mid)'} bg="var(--w-05)" size={10}>{task.type}</MonoTag>
            {milestone && <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={10}>{milestone.title}</MonoTag>}
            {taskTags.map((t) => (
              <MonoTag key={t.id} color={t.color} bg="var(--w-04)" size={10}>{t.name}</MonoTag>
            ))}
            {addingTag ? (
              <input
                autoFocus
                list="noriq-tags-quick"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onBlur={() => { setAddingTag(false); setNewTag(''); }}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') { setAddingTag(false); setNewTag(''); }
                  if (e.key === 'Enter' && newTag.trim()) {
                    await api.updateTask(currentPid, task.id, { tags: [...taskTags.map((t) => t.name), newTag.trim().toLowerCase()] });
                    setAddingTag(false);
                    setNewTag('');
                    actions.refreshNow();
                  }
                }}
                placeholder="tag…"
                style={{
                  width: 90, background: 'var(--w-06)', border: '1px solid var(--w-15)',
                  borderRadius: 5, padding: '2px 7px', color: 'var(--text)', fontSize: 10.5,
                  fontFamily: 'var(--mono)', outline: 'none',
                }}
              />
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                title="Add tag"
                style={{
                  cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)',
                  border: '1px dashed var(--w-18)', padding: '1px 7px', borderRadius: 5, background: 'transparent',
                }}
                className="rail-add"
              >
                + tag
              </button>
            )}
            <datalist id="noriq-tags-quick">
              {allTags.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
            <div style={{ flex: 1 }} />
            {!editing && (
              <button
                onClick={startEdit}
                title="Edit task"
                className="drawer-x"
                style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 13, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
              >
                ✎
              </button>
            )}
            {!editing && (
              <button
                onClick={() => void (task.archivedAt ? actions.restoreTask(task.id) : actions.archiveTask(task.id))}
                title={task.archivedAt ? 'Restore from archive' : 'Archive task'}
                className="drawer-x"
                style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 13, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
              >
                {task.archivedAt ? '⤴' : '🗄'}
              </button>
            )}
            {!editing && (
              <button
                onClick={() => {
                  if (confirm(`Delete ${task.key} "${task.title}"? This removes its comments, attachments and dependency links. Child tasks are kept.`)) {
                    void actions.deleteTask(task.id);
                  }
                }}
                title="Delete task"
                className="drawer-x"
                style={{ cursor: 'pointer', color: 'var(--red-soft)', fontSize: 13, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
              >
                🗑
              </button>
            )}
            <button
              onClick={actions.closeTask}
              className="drawer-x"
              style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 18, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
            >
              ✕
            </button>
          </div>
          {editing ? (
            <TextInput value={eTitle} onChange={(e) => setETitle(e.target.value)} style={{ fontSize: 15, fontWeight: 600 }} />
          ) : (
            <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.35, letterSpacing: '-.01em' }}>{task.title}</div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
          {editing ? (
            <div style={{ marginBottom: 18 }}>
              <TextArea value={eBody} onChange={(e) => setEBody(e.target.value)} style={{ minHeight: 110 }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                <Select value={eType} onChange={(e) => setEType(e.target.value)}>
                  <option value="feature">feature</option>
                  <option value="bug">bug</option>
                  <option value="chore">chore</option>
                  <option value="research">research</option>
                </Select>
                <Select value={ePriority} onChange={(e) => setEPriority(Number(e.target.value))}>
                  <option value={0}>priority — keep</option>
                  <option value={4}>P4 · urgent</option>
                  <option value={3}>P3 · high</option>
                  <option value={2}>P2 · normal</option>
                  <option value={1}>P1 · low</option>
                </Select>
              </div>
              <div style={{ marginTop: 10 }}>
                <Select value={eMilestone} onChange={(e) => setEMilestone(e.target.value)}>
                  <option value="">— no milestone —</option>
                  {(snapshot?.milestones ?? []).map((mm) => (
                    <option key={mm.id} value={mm.id}>{mm.title}</option>
                  ))}
                </Select>
              </div>
              {(snapshot?.boards ?? []).length > 1 && (
                <div style={{ marginTop: 10 }}>
                  <Select value={eBoard} onChange={(e) => setEBoard(e.target.value)}>
                    {(snapshot?.boards ?? []).map((b) => (
                      <option key={b.id} value={b.id}>board: {b.name}</option>
                    ))}
                  </Select>
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <TextInput value={eTags} onChange={(e) => setETags(e.target.value)} placeholder="tags, comma, separated" list="noriq-tags-drawer" />
                <datalist id="noriq-tags-drawer">
                  {allTags.map((t) => (
                    <option key={t.id} value={t.name} />
                  ))}
                </datalist>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button variant="ghost" onClick={() => setEditing(false)}>cancel</Button>
                <div style={{ flex: 1 }} />
                <Button onClick={saveEdit}>Save changes</Button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, lineHeight: 1.6, color: '#a9adb4', marginBottom: 18, whiteSpace: 'pre-wrap' }}>{task.body}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
            <MetaCell label="Claimed by">
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                {ag && <AvatarChip name={ag.name} color={ag.color} size={20} radius={5} fontSize={9} />}
                <span style={{ fontSize: 12.5, fontWeight: 500, color: ag ? 'var(--text)' : 'var(--text-mid)' }}>{holder}</span>
              </div>
            </MetaCell>
            <MetaCell label="Dependencies">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                {deps.map((d) => {
                  const sm = statusMeta(d.status);
                  const done = d.status === 'done';
                  return (
                    <span
                      key={d.id}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        fontFamily: 'var(--mono)', fontSize: 10.5, color: sm.color,
                        background: 'var(--w-03)', border: `1px solid ${sm.color}44`,
                        padding: '2px 4px 2px 7px', borderRadius: 6,
                      }}
                    >
                      <button
                        onClick={() => d.found && actions.openTask(d.id)}
                        disabled={!d.found}
                        title={d.found ? `${d.title} — ${sm.label}${done ? '' : ' (blocking)'}` : 'task not in this view'}
                        className={d.found ? 'hover-bright' : undefined}
                        style={{ cursor: d.found ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent', color: 'inherit', border: 'none', padding: 0, font: 'inherit' }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: sm.dot, flex: 'none' }} />
                        {d.key}
                        <span style={{ color: 'var(--text-faint)' }}>{done ? '✓' : '⟂'}</span>
                      </button>
                      <button
                        onClick={() => void actions.removeDependency(task.id, d.id)}
                        title="Remove dependency"
                        style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text-faint)', padding: '0 1px', fontSize: 11, lineHeight: 1 }}
                        className="hover-bright"
                      >
                        ✕
                      </button>
                    </span>
                  );
                })}
                {addingDep ? (
                  <select
                    autoFocus
                    defaultValue=""
                    onChange={async (e) => {
                      const depId = e.target.value;
                      if (!depId) return;
                      setDepError('');
                      try {
                        await actions.addDependency(task.id, depId);
                        setAddingDep(false);
                      } catch (err) {
                        setDepError(err instanceof Error ? err.message : 'could not add dependency');
                      }
                    }}
                    onBlur={() => setAddingDep(false)}
                    style={{ fontFamily: 'var(--mono)', fontSize: 10.5, maxWidth: 180, padding: '2px 4px', borderRadius: 6 }}
                  >
                    <option value="" disabled>depends on…</option>
                    {eligibleDeps.map((t) => (
                      <option key={t.id} value={t.id}>{t.key} — {t.title.slice(0, 40)}</option>
                    ))}
                  </select>
                ) : (
                  <button
                    onClick={() => { setDepError(''); setAddingDep(true); }}
                    disabled={eligibleDeps.length === 0}
                    title={eligibleDeps.length ? 'Add a dependency' : 'no other tasks to depend on'}
                    className="rail-add"
                    style={{ cursor: eligibleDeps.length ? 'pointer' : 'default', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', border: '1px dashed var(--w-15)', padding: '2px 7px', borderRadius: 6, background: 'transparent' }}
                  >
                    {deps.length ? '+ dep' : '+ add dependency'}
                  </button>
                )}
              </div>
              {depError && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)', marginTop: 4 }}>{depError}</div>
              )}
            </MetaCell>
          </div>

          {canRelease && (
            <button
              onClick={() => actions.claimToggle(task.id)}
              className="hover-bright"
              style={{
                cursor: 'pointer', boxSizing: 'border-box', width: '100%', textAlign: 'center', padding: 11,
                borderRadius: 10, background: 'transparent', color: 'var(--red-soft)', fontSize: 13, fontWeight: 600,
                marginBottom: 20, border: '1px solid rgba(255,92,92,.4)', display: 'block',
              }}
            >
              {`Force-release ${ag?.name ?? 'agent'}’s claim (requeue)`}
            </button>
          )}

          {/* open signals (decision gates / alerts) on this task */}
          {taskSignals.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ marginBottom: 8 }}><SectionLabel>Needs attention · {taskSignals.length}</SectionLabel></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {taskSignals.map((s) => {
                  const gate = s.type === 'input_request';
                  const accent = gate ? 'var(--accent)' : s.severity === 'critical' ? 'var(--red-soft)' : s.severity === 'warning' ? 'var(--amber)' : 'var(--blue)';
                  return (
                    <div key={s.id} style={{ border: `1px solid ${accent}44`, borderLeft: `3px solid ${accent}`, borderRadius: 8, background: 'var(--w-02)', padding: '9px 11px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                        <MonoTag color={accent} bg={`${accent}1a`} size={8.5}>{gate ? 'DECISION' : s.severity.toUpperCase()}</MonoTag>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{s.agentName}</span>
                      </div>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{s.title}</div>
                      {s.body && <div style={{ fontSize: 11.5, color: 'var(--text-mid)', marginTop: 3, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{s.body}</div>}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {gate ? (
                          <>
                            {(s.options ?? []).map((opt) => (
                              <button key={opt} onClick={() => void actions.answerSignal(s.id, opt)} style={{ cursor: 'pointer', fontSize: 11, color: 'var(--accent-ink)', background: 'rgba(198,242,78,.08)', border: '1px solid rgba(198,242,78,.35)', borderRadius: 6, padding: '3px 9px' }}>{opt}</button>
                            ))}
                            <SignalAnswer onAnswer={(v) => void actions.answerSignal(s.id, v)} />
                          </>
                        ) : (
                          <button onClick={() => void actions.acknowledgeSignal(s.id)} style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-soft)', background: 'var(--w-04)', border: '1px solid var(--w-1)', borderRadius: 6, padding: '3px 10px' }}>Acknowledge</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* attachments */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
            <SectionLabel>Attachments · {attachments.length}</SectionLabel>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => fileRef.current?.click()}
              style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', border: '1px dashed var(--w-15)', padding: '3px 9px', borderRadius: 6, background: 'transparent' }}
              className="rail-add"
            >
              + upload
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = '';
              }}
            />
          </div>
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 18 }}>
              {attachments.map((att) => {
                const url = `/api/attachments/${att.id}`;
                const isImage = (att.contentType ?? '').startsWith('image/');
                return (
                  <div key={att.id} style={{ borderRadius: 8, background: 'var(--w-02)', border: '1px solid var(--w-06)', overflow: 'hidden' }}>
                    {isImage && (
                      // Inline preview — click to open full size in a new tab.
                      <a href={url} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
                        <img
                          src={url}
                          alt={att.filename}
                          loading="lazy"
                          style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'contain', background: 'rgba(0,0,0,.25)' }}
                        />
                      </a>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                      <span style={{ fontSize: 12 }}>{isImage ? '🖼️' : '📎'}</span>
                      <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 12, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {att.filename}
                      </a>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{(att.size / 1024).toFixed(0)} KB</span>
                      <div style={{ flex: 1 }} />
                      <button
                        onClick={async () => {
                          await api.deleteAttachment(att.id);
                          setAttachments((l) => l.filter((x) => x.id !== att.id));
                        }}
                        style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)', background: 'transparent' }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* comments */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
            <SectionLabel>Comments &amp; questions</SectionLabel>
            {task.openComments > 0 && <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{task.openComments} open</MonoTag>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18 }}>
            {task.comments.map((c) => {
              const isHuman = c.role === 'human';
              const cag = c.role === 'agent' ? helpers.agentById(currentPid, c.author) : null;
              const kind = KIND_META[c.kind];
              const statusColor =
                c.status === 'addressed' ? 'var(--green)' : c.status === 'acknowledged' ? 'var(--text-mid)' : c.status === 'wont_do' ? 'var(--red-soft)' : 'var(--amber)';
              return (
                <div key={c.id} style={{ display: 'flex', gap: 10 }}>
                  <AvatarChip name={isHuman ? 'you' : cag?.name ?? c.author} color={isHuman ? 'you' : cag?.color ?? '#4c9dff'} size={26} radius={7} fontSize={10} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{isHuman ? 'you' : cag?.name ?? c.author}</span>
                      <MonoTag color={kind.color} bg={kind.bg} size={9}>{c.kind}</MonoTag>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: statusColor }}>{c.status}</span>
                      {(c.status === 'open' || c.status === 'acknowledged') && (
                        <button
                          onClick={() => actions.resolveComment(c.id, 'addressed')}
                          title="mark addressed"
                          style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--green)', marginLeft: 4, background: 'transparent' }}
                        >
                          ✓ resolve
                        </button>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-soft)',
                        background: c.role === 'agent' ? 'rgba(76,157,255,.06)' : 'var(--w-03)',
                        border: `1px solid ${c.role === 'agent' ? 'rgba(76,157,255,.18)' : 'var(--w-07)'}`,
                        borderRadius: 10, padding: '9px 12px',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}
                    >
                      {c.body}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* timeline */}
          <div style={{ marginBottom: 8 }}>
            <SectionLabel>History</SectionLabel>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {timeline.map((e) => {
              const vc = verbColors(String(e.verb).split('.').pop() ?? '');
              const p = e.payload as { actorName?: string; to?: string; body?: string; from?: string; resolution?: string; filename?: string };
              return (
                <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)', flex: 'none', width: 78 }}>
                    {new Date(e.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: vc.color, flex: 'none' }}>{e.verb.replace('task.', '').replace('comment.', '')}</span>
                  <span style={{ color: 'var(--text-mid)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.actorName ?? e.actorId}
                    {p.to ? ` → ${p.to}` : ''}
                    {p.filename ? ` · ${p.filename}` : ''}
                    {p.body ? ` · “${p.body}”` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--line)', padding: '14px 20px', flex: 'none', background: 'var(--bg)' }}>
          <Composer store={store} placeholder={`Steer ${holder}…`} compact />
        </div>
      </div>
    </>
  );
}

function SignalAnswer({ onAnswer }: { onAnswer: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <span style={{ display: 'inline-flex', gap: 5, flex: 1, minWidth: 140 }}>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) { onAnswer(v.trim()); setV(''); } }}
        placeholder="your decision…"
        style={{ flex: 1, minWidth: 0, background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 6, padding: '3px 8px', color: 'var(--text)', fontSize: 11.5 }}
      />
      <button disabled={!v.trim()} onClick={() => { onAnswer(v.trim()); setV(''); }}
        style={{ cursor: v.trim() ? 'pointer' : 'default', fontSize: 11, fontWeight: 600, color: '#0a0b0d', background: 'var(--accent)', border: 'none', borderRadius: 6, padding: '3px 10px', opacity: v.trim() ? 1 : 0.4 }}>
        Answer
      </button>
    </span>
  );
}

function MetaCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--w-03)', border: '1px solid var(--w-06)', borderRadius: 9, padding: '10px 12px' }}>
      <div
        style={{
          fontFamily: 'var(--mono)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.07em',
          color: 'var(--text-dim)', marginBottom: 5,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
