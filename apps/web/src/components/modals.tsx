// Modal host + the create dialogs (projects, tasks, groups, agents).
import { useEffect, useState } from 'react';
import { api, type ApiSnapshot } from '../api';
import type { AppStore } from '../store';
import { Button, ErrorNote, Field, Modal, Select, TextArea, TextInput } from './ui';

export function ModalHost({ store }: { store: AppStore }) {
  switch (store.modal) {
    case 'project': return <CreateProjectModal store={store} />;
    case 'task': return <CreateTaskModal store={store} />;
    case 'group': return <CreateGroupModal store={store} />;
    case 'milestone': return <CreateMilestoneModal store={store} />;
    case 'tag': return <CreateTagModal store={store} />;
    default: return null;
  }
}

export interface PlacementPlan {
  id: string;
  title: string;
  status: string;
  phases: Array<{ id: string; title: string; order: number }>;
}

export function activePlacementPlans(snapshot: Pick<ApiSnapshot, 'plans' | 'phases'> | null | undefined): PlacementPlan[] {
  if (!snapshot) return [];
  return snapshot.plans
    .filter((plan) => plan.archivedAt === null && plan.status !== 'rejected')
    .map((plan) => ({
      id: plan.id, title: plan.title, status: plan.status,
      phases: snapshot.phases
        .filter((phase) => phase.planId === plan.id)
        .sort((a, b) => a.order - b.order)
        .map((phase) => ({ id: phase.id, title: phase.title, order: phase.order })),
    }))
    .filter((plan) => plan.phases.length > 0);
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
          {store.groups.filter((g) => g.canEdit || g.id === groupId).map((g) => (
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
        {store.permissions.canCreateGroups && <Button variant="ghost" onClick={() => store.actions.openModal('group')}>+ new group</Button>}
        <div style={{ flex: 1 }} />
        <ErrorNote>{error}</ErrorNote>
        <Button disabled={busy || !key.trim() || !name.trim()} onClick={run}>Create project</Button>
      </div>
      {key && <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>tasks will be numbered {key}-1, {key}-2, …</div>}
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
  const [planId, setPlanId] = useState('');
  const [phaseId, setPhaseId] = useState('');
  const [loadedPlacement, setLoadedPlacement] = useState<Pick<ApiSnapshot, 'plans' | 'phases'> | null>(null);
  const milestones = store.snapshot?.milestones ?? [];
  const tags = store.snapshot?.tags ?? [];
  const localPlacement = activePlacementPlans(store.snapshot).length > 0 ? store.snapshot : null;
  useEffect(() => {
    setLoadedPlacement(null);
    if (localPlacement || !store.currentPid) return;
    let current = true;
    void api.uiState(store.currentPid, 'plans').then((snapshot) => {
      if (current) setLoadedPlacement(snapshot);
    }).catch(() => {});
    return () => { current = false; };
  }, [localPlacement, store.currentPid]);
  const placementPlans = activePlacementPlans(localPlacement ?? loadedPlacement);
  const placementPhases = placementPlans.find((plan) => plan.id === planId)?.phases ?? [];
  const { busy, error, run } = useSubmit(async () => {
    await store.actions.submitTask({
      title: title.trim(),
      body: body.trim() || undefined,
      priority,
      milestoneId: milestoneId || undefined,
      tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean),
      type: taskType,
      phaseId: phaseId || undefined,
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            <option value={0}>P0 · urgent</option>
            <option value={1}>P1 · high</option>
            <option value={2}>P2 · normal</option>
            <option value={3}>P3 · low</option>
            <option value={4}>P4 · someday</option>
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
      {placementPlans.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Field label="Plan" hint="optional">
            <Select
              aria-label="Task plan"
              value={planId}
              onChange={(event) => { setPlanId(event.target.value); setPhaseId(''); }}
            >
              <option value="">— no plan —</option>
              {placementPlans.map((plan) => (
                <option key={plan.id} value={plan.id}>{plan.title}{plan.status === 'proposed' ? ' · proposed' : ''}</option>
              ))}
            </Select>
          </Field>
          <Field label="Phase" hint={planId ? 'required for this plan' : 'choose a plan first'}>
            <Select aria-label="Task phase" value={phaseId} disabled={!planId} onChange={(event) => setPhaseId(event.target.value)}>
              <option value="">— {planId ? 'choose phase' : 'none'} —</option>
              {placementPhases.map((phase) => <option key={phase.id} value={phase.id}>{phase.title}</option>)}
            </Select>
          </Field>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
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
            list="noriq-tags"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder={tags.length ? tags.map((c) => c.name).slice(0, 3).join(', ') + ', …' : 'backend, auth, …'}
          />
          <datalist id="noriq-tags">
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
        <Button disabled={busy || !title.trim() || (!!planId && !phaseId)} onClick={run}>Create task</Button>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        {editing && (
          <Button
            variant="danger"
            onClick={async () => {
              if (await confirm(`Delete milestone "${editing.title}"? Its tasks stay, just unassigned.`)) {
                await store.actions.deleteMilestone(editing.id);
                store.actions.closeModal();
              }
            }}
          >
            Delete
          </Button>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div style={{ flex: 1 }} />
        <Button disabled={busy || !title.trim()} onClick={run}>{editing ? 'Save changes' : 'Create milestone'}</Button>
      </div>
    </Modal>
  );
}

function CreateTagModal({ store }: { store: AppStore }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    await store.actions.submitTag(name.trim().toLowerCase());
  });
  return (
    <Modal title="New tag" subtitle="tasks can carry any number of tags" onClose={store.actions.closeModal} width={320}>
      <Field label="Name">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="backend" onKeyDown={(e) => e.key === 'Enter' && name.trim() && run()} />
      </Field>
      <div style={{ display: 'flex', marginTop: 6 }}>
        <ErrorNote>{error}</ErrorNote>
        <div style={{ flex: 1 }} />
        <Button disabled={busy || !name.trim()} onClick={run}>Create tag</Button>
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
