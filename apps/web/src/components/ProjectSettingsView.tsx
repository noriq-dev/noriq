// Project-local settings (PLNR-401). Account settings remain in SettingsView.
import { useEffect, useState, type ReactNode } from 'react';
import { api, type ApiUser } from '../api';
import type { AppStore } from '../store';
import { MonoTag, SectionLabel } from './bits';
import { confirm } from './Dialog';
import { Button, ErrorNote, Field, Select, TextInput } from './ui';

type ProjectAccess = Awaited<ReturnType<typeof api.projectAccess>>;
type GrantRole = 'manager' | 'contributor' | 'viewer';

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section style={{ border: '1px solid var(--w-07)', borderRadius: 14, background: 'var(--w-015)', padding: '18px 20px' }}>
      <SectionLabel>{title}</SectionLabel>
      <div style={{ margin: '5px 0 16px', color: 'var(--text-mid)', fontSize: 11.5, lineHeight: 1.55 }}>{description}</div>
      {children}
    </section>
  );
}

function PermissionNote({ children }: { children: ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--w-08)', borderRadius: 9, background: 'var(--w-02)', color: 'var(--text-mid)', padding: '9px 11px', fontFamily: 'var(--mono)', fontSize: 9.5, lineHeight: 1.55 }}>
      {children}
    </div>
  );
}

export function ProjectSettingsView({ store }: { store: AppStore }) {
  const project = store.data.projects.find((item) => item.id === store.currentPid);
  const claimTtlSeconds = store.snapshot?.project.claimTtlSeconds ?? 1800;
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.phase ?? '');
  const [groupId, setGroupId] = useState(project?.groupId ?? '');
  const [ttlMin, setTtlMin] = useState(String(Math.round(claimTtlSeconds / 60)));
  const [isPublic, setIsPublic] = useState(Boolean(project?.isPublic));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibilitySaved, setVisibilitySaved] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [workingAction, setWorkingAction] = useState<string | null>(null);
  const [principalType, setPrincipalType] = useState<'user' | 'group'>('user');
  const [principalId, setPrincipalId] = useState('');
  const [grantRole, setGrantRole] = useState<GrantRole>('viewer');
  const [ownerId, setOwnerId] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!project || !store.permissions.canManage) return;
    let current = true;
    setAccessLoading(true);
    setAccessError(null);
    Promise.all([api.projectAccess(project.id), api.users()])
      .then(([nextAccess, directory]) => {
        if (!current) return;
        setAccess(nextAccess);
        setUsers(directory.users);
      })
      .catch((error) => {
        if (current) setAccessError(error instanceof Error ? error.message : 'Could not load project access.');
      })
      .finally(() => {
        if (current) setAccessLoading(false);
      });
    return () => { current = false; };
  }, [project?.id, store.permissions.canManage]);

  if (!project) return null;

  const canManage = store.permissions.canManage;
  const canOwn = store.permissions.canOwn;
  const effectiveRole = store.permissions.effectiveRole ?? 'viewer';
  const groups = store.groups.filter((group) => group.canEdit || group.id === groupId);

  const reloadAccess = async () => setAccess(await api.projectAccess(project.id));
  const runAccessAction = async (key: string, action: () => Promise<void>) => {
    setAccessError(null);
    setWorkingAction(key);
    try {
      await action();
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : 'Could not update project access.');
    } finally {
      setWorkingAction(null);
    }
  };

  const saveGeneral = async () => {
    if (!canManage) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await store.actions.submitProjectMeta({
        name: name.trim(),
        description: description.trim(),
        groupId: groupId || null,
        claimTtlSeconds: Math.max(1, Number(ttlMin) || 30) * 60,
      });
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save project settings.');
    } finally {
      setSaving(false);
    }
  };

  const saveVisibility = async () => {
    if (!canOwn) return;
    setVisibilitySaving(true);
    setVisibilitySaved(false);
    setVisibilityError(null);
    try {
      await store.actions.submitProjectMeta({ public: isPublic });
      setVisibilitySaved(true);
    } catch (error) {
      setVisibilityError(error instanceof Error ? error.message : 'Could not save project visibility.');
    } finally {
      setVisibilitySaving(false);
    }
  };

  return (
    <div className="content-pad" style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '24px 26px 48px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 4 }}>
          <MonoTag color="var(--accent-ink)" bg="rgba(198,242,78,.08)" size={10}>{project.key}</MonoTag>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 style={{ fontSize: 21, lineHeight: 1.2, letterSpacing: '-.02em', margin: 0 }}>Project settings</h1>
            <p style={{ color: 'var(--text-mid)', fontSize: 12.5, margin: '6px 0 0' }}>Configuration for {project.name}. Account and system settings remain separate.</p>
          </div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, textTransform: 'uppercase', color: canManage ? 'var(--accent-ink)' : 'var(--text-dim)', border: '1px solid var(--w-1)', borderRadius: 7, padding: '5px 8px' }}>
            {effectiveRole}
          </span>
        </header>

        {!canManage && (
          <PermissionNote>
            You can view this project’s configuration. A project manager or owner is required to make changes.
          </PermissionNote>
        )}

        <SettingsSection title="General" description="Identity, organization, and the claim lifetime used by agents working in this project.">
          <div className="project-settings-fields">
            <Field label="Name">
              <TextInput aria-label="Project name" value={name} disabled={!canManage} onChange={(event) => { setName(event.target.value); setSaved(false); }} />
            </Field>
            <Field label="Description" hint="shown in project navigation">
              <TextInput aria-label="Project description" value={description} disabled={!canManage} onChange={(event) => { setDescription(event.target.value); setSaved(false); }} />
            </Field>
            <Field label="Group">
              <Select aria-label="Project group" value={groupId} disabled={!canManage} onChange={(event) => { setGroupId(event.target.value); setSaved(false); }}>
                <option value="">— none —</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </Select>
            </Field>
            <Field label="Claim TTL (minutes)" hint="inactive claims are requeued after this period">
              <TextInput aria-label="Claim TTL in minutes" type="number" min={1} max={1440} value={ttlMin} disabled={!canManage} onChange={(event) => { setTtlMin(event.target.value); setSaved(false); }} />
            </Field>
          </div>
          {!groupId && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--amber)', background: 'rgba(245,166,35,.07)', border: '1px solid rgba(245,166,35,.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 12 }}>
              No group — only explicit project grants, the owner, and administrators provide access.
            </div>
          )}
          {canManage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {store.permissions.canCreateGroups && <Button variant="ghost" onClick={() => store.actions.openModal('group')}>+ new group</Button>}
              <div style={{ flex: 1 }} />
              {saved && <span role="status" style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--green)' }}>Saved</span>}
              <ErrorNote>{saveError}</ErrorNote>
              <Button disabled={saving || !name.trim()} onClick={saveGeneral}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="Visibility" description="Control whether this project also has an unauthenticated, read-only public page.">
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: 'var(--text-soft)', cursor: canOwn ? 'pointer' : 'default' }}>
            <input aria-label="Public read-only page" type="checkbox" checked={isPublic} disabled={!canOwn} onChange={(event) => { setIsPublic(event.target.checked); setVisibilitySaved(false); }} style={{ width: 'auto', marginTop: 2 }} />
            <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>
              Public read-only page
              <span style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 9, color: isPublic ? 'var(--amber)' : 'var(--text-faint)', marginTop: 2 }}>
                {isPublic ? 'Anyone with the link can view this project.' : 'Off — authenticated project access is required.'}
              </span>
            </span>
          </label>
          {!canOwn && <div style={{ marginTop: 12 }}><PermissionNote>Only the project owner can change public visibility.</PermissionNote></div>}
          {canOwn && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 14 }}>
              {visibilitySaved && <span role="status" style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--green)' }}>Visibility saved</span>}
              <ErrorNote>{visibilityError}</ErrorNote>
              <Button disabled={visibilitySaving} onClick={saveVisibility}>{visibilitySaving ? 'Saving…' : 'Save visibility'}</Button>
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="Project access" description="Explicit user and group grants are independent of the project’s organizational group.">
          {!canManage && <PermissionNote>Access grants are visible and editable only to project managers and owners.</PermissionNote>}
          {canManage && accessLoading && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>Loading access…</div>}
          {canManage && access && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-mid)', marginBottom: 12 }}>
                Owner · <b style={{ color: 'var(--text)' }}>{access.owner?.name ?? 'unknown'}</b>
              </div>
              {access.grants.length === 0 && (
                <div style={{ color: 'var(--text-dim)', fontSize: 11.5, padding: '7px 0 10px' }}>No explicit grants.</div>
              )}
              {access.grants.map((grant) => (
                <div key={`${grant.principalType}:${grant.principalId}`} className="project-settings-grant-row">
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{grant.principalType}</span>
                  <span style={{ fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{grant.principalName}</span>
                  <Select
                    aria-label={`Role for ${grant.principalName}`}
                    value={grant.role}
                    disabled={workingAction !== null}
                    onChange={(event) => void runAccessAction(`role:${grant.principalId}`, async () => {
                      await api.setProjectGrant(project.id, { principalType: grant.principalType, principalId: grant.principalId, role: event.target.value as GrantRole });
                      await reloadAccess();
                    })}
                  >
                    <option value="viewer">Viewer</option><option value="contributor">Contributor</option><option value="manager">Manager</option>
                  </Select>
                  <Button variant="ghost" disabled={workingAction !== null} onClick={() => void runAccessAction(`remove:${grant.principalId}`, async () => {
                    await api.revokeProjectGrant(project.id, grant.principalType, grant.principalId);
                    await reloadAccess();
                  })}>Remove</Button>
                </div>
              ))}
              <div className="project-settings-grant-form">
                <Select aria-label="Grant principal type" value={principalType} onChange={(event) => { setPrincipalType(event.target.value as 'user' | 'group'); setPrincipalId(''); }}>
                  <option value="user">User</option><option value="group">Group</option>
                </Select>
                <Select aria-label={`Grant ${principalType}`} value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>
                  <option value="">Choose…</option>
                  {(principalType === 'user' ? users : store.groups).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </Select>
                <Select aria-label="Grant role" value={grantRole} onChange={(event) => setGrantRole(event.target.value as GrantRole)}>
                  <option value="viewer">Viewer</option><option value="contributor">Contributor</option><option value="manager">Manager</option>
                </Select>
                <Button disabled={!principalId || workingAction !== null} onClick={() => void runAccessAction('grant', async () => {
                  await api.setProjectGrant(project.id, { principalType, principalId, role: grantRole });
                  await reloadAccess();
                  setPrincipalId('');
                })}>Grant access</Button>
              </div>
              {access.canTransferOwnership && (
                <div style={{ borderTop: '1px solid var(--w-07)', marginTop: 18, paddingTop: 16 }}>
                  <Field label="Transfer ownership" hint="the previous owner retains manager access">
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Select aria-label="New project owner" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
                        <option value="">Choose active user…</option>
                        {users.filter((user) => user.id !== access.owner?.id && !user.disabled).map((user) => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}
                      </Select>
                      <Button disabled={!ownerId || workingAction !== null} onClick={() => void runAccessAction('transfer', async () => {
                        if (!(await confirm('Transfer project ownership? You will retain manager access.'))) return;
                        await api.transferProjectOwner(project.id, ownerId);
                        await reloadAccess();
                        setOwnerId('');
                        await store.actions.refreshNow();
                      })}>Transfer</Button>
                    </div>
                  </Field>
                </div>
              )}
            </>
          )}
          <ErrorNote>{accessError}</ErrorNote>
        </SettingsSection>

        {canOwn && (
          <SettingsSection title="Danger zone" description="Deleting a project permanently removes its tasks, plans, milestones, tags, and history.">
            <Field label={`Type “${project.name}” to confirm`}>
              <div style={{ display: 'flex', gap: 8 }}>
                <TextInput aria-label="Confirm project name" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={project.name} />
                <Button variant="danger" disabled={confirmName !== project.name} onClick={async () => {
                  setDeleteError(null);
                  try {
                    await store.actions.deleteProject(project.id);
                  } catch (error) {
                    setDeleteError(error instanceof Error ? error.message : 'Could not delete project.');
                  }
                }}>Delete project</Button>
              </div>
            </Field>
            <ErrorNote>{deleteError}</ErrorNote>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}
