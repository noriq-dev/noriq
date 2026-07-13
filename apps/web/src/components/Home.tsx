// Home — the landing view: project directory, MCP connect, quick actions.
import { useState } from 'react';
import type { AppStore } from '../store';
import type { ProjectVM } from '../types';
import { LiveDot, SectionLabel } from './bits';
import { Button } from './ui';

export function Home({ store }: { store: AppStore }) {
  const { data, groups, actions } = store;
  const ungrouped = data.projects.filter((p) => !p.groupId);
  const grouped = groups
    .map((g) => ({ group: g, projects: data.projects.filter((p) => p.groupId === g.id) }))
    .filter((g) => g.projects.length > 0);
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '44px 28px 60px' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 6 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.02em', margin: 0 }}>
            {greeting}, {store.user?.name?.split(' ')[0] ?? 'supervisor'}.
          </h1>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-mid)', marginBottom: 34 }}>
          {data.projects.length} project{data.projects.length === 1 ? '' : 's'} ·{' '}
          {data.projects.reduce((n, p) => n + p.openTasks, 0)} open tasks ·{' '}
          {data.projects.filter((p) => p.hasLive).length} with live agents
        </div>

        {/* projects */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <SectionLabel>Projects</SectionLabel>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" style={{ padding: '6px 13px', fontSize: 12 }} onClick={() => actions.createProject()}>
            + new project
          </Button>
        </div>

        {data.projects.length === 0 ? (
          <div
            style={{
              border: '1px dashed rgba(255,255,255,.12)', borderRadius: 14, padding: '36px 20px',
              textAlign: 'center', marginBottom: 36,
            }}
          >
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', marginBottom: 12 }}>no projects yet</div>
            <Button onClick={() => actions.createProject()}>Create the first project</Button>
          </div>
        ) : (
          <>
            {ungrouped.length > 0 && <ProjectGrid projects={ungrouped} onOpen={(id) => actions.selectProject(id)} />}
            {grouped.map(({ group, projects }) => (
              <div key={group.id} style={{ marginTop: 18 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '0 0 10px 2px' }}>
                  {group.name}
                </div>
                <ProjectGrid projects={projects} onOpen={(id) => actions.selectProject(id)} />
              </div>
            ))}
          </>
        )}

        {/* connect an agent */}
        <div style={{ marginTop: 40, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <ConnectCard />
          <div
            style={{
              border: '1px solid rgba(255,255,255,.07)', borderRadius: 14,
              background: 'rgba(255,255,255,.015)', padding: '18px 20px',
            }}
          >
            <SectionLabel>How planar works</SectionLabel>
            <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
              {[
                ['claim', 'Agents claim tasks exclusively — the arbiter prevents collisions; dead agents auto-requeue.'],
                ['steer', 'Comment on any task; the working agent gets it mid-flight and must resolve it before finishing.'],
                ['plan', 'Agents structure work into plans with ordered phases — order is enforced, not decorative.'],
                ['watch', 'Mission Control, the orchestration graph, and the board are all live over WebSocket.'],
              ].map(([k, v]) => (
                <li key={k} style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.55, color: 'var(--text-mid)' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)', paddingTop: 2, width: 38, flex: 'none' }}>{k}</span>
                  <span>{v}</span>
                </li>
              ))}
            </ul>
            <div style={{ marginTop: 14, fontFamily: 'var(--mono)', fontSize: 10.5 }}>
              <a href="/skill.md" target="_blank" rel="noreferrer">agent skill →</a>
              <span style={{ color: 'var(--text-faint)' }}> · </span>
              <a href="/.well-known/oauth-authorization-server" target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)' }}>oauth metadata →</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectGrid({ projects, onOpen }: { projects: ProjectVM[]; onOpen: (id: string) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
      {projects.map((p) => {
        const pct = p.totalTasks ? p.doneTasks / p.totalTasks : 0;
        return (
          <div
            key={p.id}
            onClick={() => onOpen(p.id)}
            className="hover-border"
            style={{
              border: '1px solid rgba(255,255,255,.07)', borderRadius: 13, padding: '15px 16px',
              background: 'rgba(255,255,255,.02)', cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
              <span
                style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, color: p.dotColor,
                  background: 'rgba(255,255,255,.05)', padding: '2px 7px', borderRadius: 5,
                }}
              >
                {p.key}
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <div style={{ flex: 1 }} />
              {p.hasLive && <LiveDot size={7} />}
            </div>
            {p.phase && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.phase}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,.07)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct * 100}%`, background: pct === 1 ? 'var(--green)' : 'var(--blue)' }} />
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                {p.doneTasks}/{p.totalTasks} · {p.openTasks} open
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type ClientId = 'claude' | 'codex' | 'copilot';

const CLIENTS: Array<{ id: ClientId; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'Copilot' },
];

type Scope = 'project' | 'global';

function clientSnippet(id: ClientId, scope: Scope): { intro: string; code: string } {
  const url = `${location.origin}/mcp`;
  const codexToml = `[mcp_servers.planar]
url = "${url}"`;
  const vscodeJson = `{
  "servers": {
    "planar": { "type": "http", "url": "${url}" }
  }
}`;
  switch (id) {
    case 'claude':
      return scope === 'global'
        ? {
            intro: 'All your projects (user scope) — OAuth consent in the browser names the agent identity:',
            code: `claude mcp add -s user --transport http planar ${url}`,
          }
        : {
            intro: 'This project only (local scope) — run inside the repo:',
            code: `claude mcp add --transport http planar ${url}`,
          };
    case 'codex':
      return {
        intro:
          scope === 'global'
            ? 'Add to ~/.codex/config.toml (OAuth prompt on first use):'
            : 'Codex reads its config globally — add to ~/.codex/config.toml and tell the agent which planar project to work:',
        code: codexToml,
      };
    case 'copilot':
      return scope === 'global'
        ? {
            intro: 'VS Code (all workspaces): Command Palette → “MCP: Add Server” → HTTP → Global. Or user-profile mcp.json:',
            code: vscodeJson,
          }
        : {
            intro: 'This workspace only — add to .vscode/mcp.json:',
            code: vscodeJson,
          };
  }
}

function ConnectCard() {
  const [copied, setCopied] = useState(false);
  const [client, setClient] = useState<ClientId>('claude');
  const [scope, setScope] = useState<Scope>('global');
  const { intro, code } = clientSnippet(client, scope);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ border: '1px solid rgba(198,242,78,.2)', borderRadius: 14, background: 'rgba(198,242,78,.03)', padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SectionLabel>Connect an agent</SectionLabel>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 2, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 8, padding: 2 }}>
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              onClick={() => setClient(c.id)}
              style={{
                cursor: 'pointer', padding: '3px 9px', borderRadius: 6, fontSize: 10.5, fontWeight: 600,
                background: client === c.id ? 'rgba(198,242,78,.15)' : 'transparent',
                color: client === c.id ? 'var(--accent)' : 'var(--text-dim)',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 2, margin: '10px 0 0', width: 'fit-content', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.07)', borderRadius: 7, padding: 2 }}>
        {(['global', 'project'] as const).map((sc) => (
          <button
            key={sc}
            onClick={() => setScope(sc)}
            style={{
              cursor: 'pointer', padding: '2px 9px', borderRadius: 5, fontFamily: 'var(--mono)', fontSize: 9.5,
              background: scope === sc ? 'rgba(255,255,255,.1)' : 'transparent',
              color: scope === sc ? 'var(--text)' : 'var(--text-faint)',
            }}
          >
            {sc}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-mid)', lineHeight: 1.6, margin: '8px 0 12px' }}>{intro}</div>
      <pre
        onClick={copy}
        title="click to copy"
        style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent)', cursor: 'pointer',
          background: 'rgba(0,0,0,.3)', border: '1px solid rgba(198,242,78,.25)', borderRadius: 9,
          padding: '10px 12px', lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}
      >
        {copied ? '✓ copied' : code}
      </pre>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6, marginTop: 12 }}>
        The agent then calls <span style={{ fontFamily: 'var(--mono)' }}>get_briefing</span> and teaches itself the
        rest; it takes its working identity with{' '}
        <span style={{ fontFamily: 'var(--mono)' }}>set_agent_identity</span>. All access is OAuth — no API keys to manage.
      </div>
    </div>
  );
}
