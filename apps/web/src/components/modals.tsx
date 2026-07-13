// Modal host + the create dialogs (projects, tasks, groups, agents).
import { useState } from 'react';
import type { AppStore } from '../store';
import { api, type ApiUser } from '../api';
import { useEffect } from 'react';
import { Button, ErrorNote, Field, Modal, Select, TextArea, TextInput } from './ui';

export function ModalHost({ store }: { store: AppStore }) {
  switch (store.modal) {
    case 'project': return <CreateProjectModal store={store} />;
    case 'project-edit': return <EditProjectModal store={store} />;
    case 'task': return <CreateTaskModal store={store} />;
    case 'group': return <CreateGroupModal store={store} />;
    case 'agent': return <NewAgentModal store={store} />;
    case 'milestone': return <CreateMilestoneModal store={store} />;
    default: return null;
  }
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function CreateProjectModal({ store }: { store: AppStore }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [groupId, setGroupId] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    await store.actions.submitProject({
      key: key.trim().toUpperCase(),
      name: name.trim(),
      description: description.trim() || undefined,
      groupId: groupId || undefined,
    });
  });

  return (
    <Modal title="New project" subtitle="a collection of milestones, plans and tasks" onClose={store.actions.closeModal}>
      <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 12 }}>
        <Field label="Key" hint="≤8 caps">
          <TextInput
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
            placeholder="PLN"
            style={{ fontFamily: 'var(--mono)', textTransform: 'uppercase' }}
          />
        </Field>
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="coordination-mvp" />
        </Field>
      </div>
      <Field label="Description" hint="shown in the top bar">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Phase 1 · MCP + Coordination Core" />
      </Field>
      <Field label="Group" hint="optional">
        <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">— none —</option>
          {store.groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </Select>
      </Field>
      {!groupId && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', background: 'rgba(245,166,35,.07)', border: '1px solid rgba(245,166,35,.25)', borderRadius: 8, padding: '7px 10px', marginBottom: 12 }}>
          ⚠ no group — only you (and admins) will see this project
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <Button variant="ghost" onClick={() => store.actions.openModal('group')}>+ new group</Button>
        <div style={{ flex: 1 }} />
        <ErrorNote>{error}</ErrorNote>
        <Button disabled={busy || !key.trim() || !name.trim()} onClick={run}>Create project</Button>
      </div>
      {key && <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>tasks will be numbered {key}-1, {key}-2, …</div>}
    </Modal>
  );
}

function EditProjectModal({ store }: { store: AppStore }) {
  const project = store.data.projects.find((p) => p.id === store.currentPid);
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.phase ?? '');
  const [groupId, setGroupId] = useState(project?.groupId ?? '');
  const [ttlMin, setTtlMin] = useState(String(Math.round((store.snapshot?.project.claimTtlSeconds ?? 1800) / 60)));
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [ownerId, setOwnerId] = useState<string>('');
  const isAdmin = store.user?.role === 'admin';
  useEffect(() => {
    if (isAdmin) api.users().then((r) => setUsers(r.users)).catch(() => {});
  }, [isAdmin]);
  const { busy, error, run } = useSubmit(async () => {
    await store.actions.submitProjectMeta({
      name: name.trim(),
      description: description.trim(),
      groupId: groupId || null,
      claimTtlSeconds: Math.max(1, Number(ttlMin) || 30) * 60,
      ...(isAdmin && ownerId ? { ownerUserId: ownerId } : {}),
    });
  });
  if (!project) return null;

  return (
    <Modal title={`Edit ${project.key}`} subtitle="project settings" onClose={store.actions.closeModal}>
      <Field label="Name">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" hint="shown in the top bar">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Group">
          <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">— none —</option>
            {store.groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Claim TTL (minutes)" hint="how long agents hold tasks between heartbeats">
          <TextInput type="number" min={1} max={1440} value={ttlMin} onChange={(e) => setTtlMin(e.target.value)} />
        </Field>
      </div>
      {!groupId && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--amber)', background: 'rgba(245,166,35,.07)', border: '1px solid rgba(245,166,35,.25)', borderRadius: 8, padding: '7px 10px', marginBottom: 12 }}>
          ⚠ no group — only the owner (and admins) can see this project
        </div>
      )}
      {isAdmin && (
        <Field label="Owner" hint="ungrouped projects are visible only to their owner">
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">— keep current —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
            ))}
          </Select>
        </Field>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <Button variant="ghost" onClick={() => store.actions.openModal('group')}>+ new group</Button>
        <div style={{ flex: 1 }} />
        <ErrorNote>{error}</ErrorNote>
        <Button disabled={busy || !name.trim()} onClick={run}>Save changes</Button>
      </div>
    </Modal>
  );
}

function CreateTaskModal({ store }: { store: AppStore }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState(2);
  const [milestoneId, setMilestoneId] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [taskType, setTaskType] = useState('feature');
  const milestones = store.snapshot?.milestones ?? [];
  const tags = store.snapshot?.tags ?? [];
  const { busy, error, run } = useSubmit(async () => {
    await store.actions.submitTask({
      title: title.trim(),
      body: body.trim() || undefined,
      priority,
      milestoneId: milestoneId || undefined,
      tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean),
      type: taskType,
    });
  });

  return (
    <Modal title="New task" subtitle={`in ${store.data.projects.find((p) => p.id === store.currentPid)?.name ?? 'project'}`} onClose={store.actions.closeModal}>
      <Field label="Title">
        <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Implement the claim arbiter" />
      </Field>
      <Field label="Description" hint="what done looks like — agents read this">
        <TextArea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Context, constraints, acceptance criteria…" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            <option value={4}>P4 · urgent</option>
            <option value={3}>P3 · high</option>
            <option value={2}>P2 · normal</option>
            <option value={1}>P1 · low</option>
            <option value={0}>P0 · someday</option>
          </Select>
        </Field>
        <Field label="Milestone" hint="optional">
          <Select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
            <option value="">— none —</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.title}</option>
            ))}
          </Select>
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Type">
          <Select value={taskType} onChange={(e) => setTaskType(e.target.value)}>
            <option value="feature">feature</option>
            <option value="bug">bug</option>
            <option value="chore">chore</option>
            <option value="research">research</option>
          </Select>
        </Field>
        <Field label="Tags" hint="comma-separated; new names are created">
          <TextInput
            list="planar-tags"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder={tags.length ? tags.map((c) => c.name).slice(0, 3).join(', ') + ', …' : 'backend, auth, …'}
          />
          <datalist id="planar-tags">
            {tags.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
        <Button variant="ghost" onClick={() => store.actions.openModal('milestone')}>+ new milestone</Button>
        <ErrorNote>{error}</ErrorNote>
        <div style={{ flex: 1 }} />
        <Button disabled={busy || !title.trim()} onClick={run}>Create task</Button>
      </div>
    </Modal>
  );
}

function CreateMilestoneModal({ store }: { store: AppStore }) {
  const editing = store.editMilestone;
  const [title, setTitle] = useState(editing?.title ?? '');
  const [dueAt, setDueAt] = useState(editing?.dueAt ? editing.dueAt.slice(0, 10) : '');
  const { busy, error, run } = useSubmit(async () => {
    await store.actions.submitMilestone(title.trim(), dueAt ? new Date(dueAt).toISOString() : undefined);
  });
  return (
    <Modal
      title={editing ? `Edit milestone` : 'New milestone'}
      subtitle={`in ${store.data.projects.find((p) => p.id === store.currentPid)?.name ?? 'project'} — a collection of tasks`}
      onClose={store.actions.closeModal}
      width={360}
    >
      <Field label="Title">
        <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="v1.0 release" onKeyDown={(e) => e.key === 'Enter' && title.trim() && run()} />
      </Field>
      <Field label="Due date" hint="optional">
        <TextInput type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', marginTop: 6 }}>
        <ErrorNote>{error}</ErrorNote>
        <div style={{ flex: 1 }} />
        <Button disabled={busy || !title.trim()} onClick={run}>{editing ? 'Save changes' : 'Create milestone'}</Button>
      </div>
    </Modal>
  );
}

function CreateGroupModal({ store }: { store: AppStore }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    await store.actions.submitGroup(name.trim(), description.trim() || undefined);
  });
  return (
    <Modal title="New group" subtitle="a collection of projects" onClose={store.actions.closeModal} width={360}>
      <Field label="Name">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Platform" />
      </Field>
      <Field label="Description" hint="optional">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', marginTop: 6 }}>
        <ErrorNote>{error}</ErrorNote>
        <div style={{ flex: 1 }} />
        <Button disabled={busy || !name.trim()} onClick={run}>Create group</Button>
      </div>
    </Modal>
  );
}

function NewAgentModal({ store }: { store: AppStore }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'worker' | 'orchestrator'>('worker');
  const [issued, setIssued] = useState<{ name: string; apiKey: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useSubmit(async () => {
    const r = await api.createAgent(name.trim(), role);
    setIssued({ name: r.name, apiKey: r.apiKey });
  });

  if (issued) {
    const mcpCmd = `claude mcp add --transport http planar ${location.origin}/mcp \\\n  --header "Authorization: Bearer ${issued.apiKey}"`;
    return (
      <Modal title={`${issued.name} · key issued`} subtitle="shown ONCE — only a hash is stored" onClose={store.actions.closeModal} width={520}>
        <div
          style={{
            fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--accent)',
            background: 'rgba(198,242,78,.06)', border: '1px solid rgba(198,242,78,.25)',
            borderRadius: 9, padding: '10px 12px', wordBreak: 'break-all', marginBottom: 12,
          }}
        >
          {issued.apiKey}
        </div>
        <Field label="Connect Claude Code">
          <pre
            style={{
              fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-soft)',
              background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
              borderRadius: 9, padding: '10px 12px', overflowX: 'auto', margin: 0, whiteSpace: 'pre-wrap',
            }}
          >
            {mcpCmd}
          </pre>
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(issued.apiKey);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? '✓ copied' : 'Copy key'}
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={store.actions.closeModal}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="New agent" subtitle="issues an MCP API key" onClose={store.actions.closeModal} width={380}>
      <Field label="Name" hint="how it appears in feeds & the graph">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="nova" />
      </Field>
      <Field label="Role">
        <Select value={role} onChange={(e) => setRole(e.target.value as 'worker' | 'orchestrator')}>
          <option value="worker">worker — claims and executes tasks</option>
          <option value="orchestrator">orchestrator — plans and decomposes</option>
        </Select>
      </Field>
      <div style={{ display: 'flex', marginTop: 6 }}>
        <ErrorNote>{error}</ErrorNote>
        <div style={{ flex: 1 }} />
        <Button disabled={busy || !name.trim()} onClick={run}>Issue key</Button>
      </div>
    </Modal>
  );
}
