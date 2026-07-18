// Home — the landing view: attention inbox, project directory, MCP connect.
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppStore } from '../store';
import type { ProjectVM } from '../types';
import { LiveDot, MonoTag, SectionLabel } from './bits';
import { Button } from './ui';
import { QuestionForm } from './QuestionForm';
import { Markdown } from './Markdown';

type Attention = Awaited<ReturnType<typeof api.attention>>;

/** Cross-project "what needs me right now" (PLNR-121): open decisions/alerts with
 *  inline answer/ack (no tab-hopping), plus overdue-and-open tasks (PLNR-126). */
function AttentionSection({ store }: { store: AppStore }) {
  const { actions } = store;
  const [att, setAtt] = useState<Attention | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const load = () => api.attention().then(setAtt).catch(() => {});
  useEffect(() => {
    load();
    const iv = setInterval(load, 45000);
    return () => clearInterval(iv);
  }, []);

  if (!att || (att.signals.length === 0 && att.overdue.length === 0)) return null;
  const sevColor: Record<string, string> = { critical: 'var(--red-soft)', warning: 'var(--amber)', info: 'var(--blue)' };

  return (
    <div style={{ marginBottom: 34 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <SectionLabel>Needs attention</SectionLabel>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--amber)' }}>
          {att.signals.length + att.overdue.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {att.signals.map((s) => {
          const gate = s.type === 'input_request';
          const accent = gate ? 'var(--accent)' : sevColor[s.severity] ?? 'var(--blue)';
          return (
            <div key={s.id} style={{ border: `1px solid ${accent}44`, borderLeft: `3px solid ${accent}`, borderRadius: 10, background: 'var(--card)', padding: '11px 13px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                <MonoTag color={accent} bg={`${accent}1a`} size={9}>{gate ? 'DECISION' : s.severity.toUpperCase()}</MonoTag>
                <button
                  onClick={() => actions.selectProject(s.projectId)}
                  style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text-mid)', fontFamily: 'var(--mono)', fontSize: 10, padding: 0 }}
                >
                  {s.projectKey}{s.taskKey ? ` · ${s.taskKey}` : ''}
                </button>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{s.agentName}</span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{s.title}</div>
              {s.body && <div style={{ fontSize: 11.5, color: 'var(--text-mid)', marginTop: 4, lineHeight: 1.5 }}><Markdown source={s.body} compact /></div>}
              {gate && s.questions && s.questions.length > 0 ? (
                <QuestionForm questions={s.questions} onSubmit={async (r, a) => { await api.answerSignal(s.projectId, s.id, r, a); load(); }} />
              ) : gate ? (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {s.options && s.options.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {s.options.map((opt) => (
                        <button
                          key={opt}
                          onClick={async () => { await api.answerSignal(s.projectId, s.id, opt); load(); }}
                          className="hover-bright"
                          style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 500, color: 'var(--accent-ink)', background: 'rgba(198,242,78,.08)', border: '1px solid rgba(198,242,78,.35)', borderRadius: 7, padding: '4px 10px' }}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={answers[s.id] ?? ''}
                      onChange={(e) => setAnswers((a) => ({ ...a, [s.id]: e.target.value }))}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && (answers[s.id] ?? '').trim()) { await api.answerSignal(s.projectId, s.id, answers[s.id]!); load(); }
                      }}
                      placeholder={s.options?.length ? 'or type a decision…' : 'your decision…'}
                      style={{ flex: 1, minWidth: 0, background: 'var(--w-03)', border: '1px solid var(--w-1)', borderRadius: 7, padding: '5px 9px', color: 'var(--text)', fontSize: 12 }}
                    />
                    <button
                      disabled={!(answers[s.id] ?? '').trim()}
                      onClick={async () => { await api.answerSignal(s.projectId, s.id, answers[s.id]!); load(); }}
                      style={{ cursor: (answers[s.id] ?? '').trim() ? 'pointer' : 'default', fontSize: 12, fontWeight: 600, color: '#0a0b0d', background: 'var(--accent)', border: 'none', borderRadius: 7, padding: '5px 12px', opacity: (answers[s.id] ?? '').trim() ? 1 : 0.4 }}
                    >
                      Answer
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button onClick={async () => { await api.acknowledgeSignal(s.projectId, s.id); load(); }} style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 500, color: 'var(--text-soft)', background: 'var(--w-04)', border: '1px solid var(--w-1)', borderRadius: 7, padding: '4px 11px' }}>Acknowledge</button>
                  <button onClick={async () => { await api.acknowledgeSignal(s.projectId, s.id, true); load(); }} style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-faint)', background: 'transparent', border: 'none', padding: '4px 4px' }}>dismiss</button>
                </div>
              )}
            </div>
          );
        })}
        {att.overdue.map((t) => (
          <div
            key={t.id}
            onClick={() => actions.selectProject(t.projectId)}
            className="hover-border"
            style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid rgba(255,92,92,.25)', borderLeft: '3px solid var(--red-soft)', borderRadius: 10, background: 'var(--card)', padding: '9px 13px', cursor: 'pointer' }}
          >
            <MonoTag color="var(--red-soft)" bg="rgba(255,92,92,.12)" size={9}>OVERDUE</MonoTag>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-mid)' }}>{t.projectKey} · {t.key}</span>
            <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--red-soft)', whiteSpace: 'nowrap' }}>
              due {new Date(t.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Home({ store }: { store: AppStore }) {
  const { data, groups, actions } = store;
  // A project whose group isn't in the list (e.g. not loaded) must still show —
  // treat it as ungrouped rather than dropping it (PLNR-81 regression guard).
  const knownGroupIds = new Set(groups.map((g) => g.id));
  const ungrouped = data.projects.filter((p) => !p.groupId || !knownGroupIds.has(p.groupId));
  const grouped = groups
    .map((g) => ({ group: g, projects: data.projects.filter((p) => p.groupId === g.id) }))
    .filter((g) => g.projects.length > 0);
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto' }}>
      <div className="content-pad" style={{ maxWidth: 880, margin: '0 auto', padding: '44px 28px 60px' }}>
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

        <AttentionSection store={store} />

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
              border: '1px dashed var(--w-12)', borderRadius: 14, padding: '36px 20px',
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
              border: '1px solid var(--w-07)', borderRadius: 14,
              background: 'var(--w-015)', padding: '18px 20px',
            }}
          >
            <SectionLabel>How Noriq works</SectionLabel>
            <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
              {[
                ['claim', 'Agents claim tasks exclusively — the arbiter prevents collisions; dead agents auto-requeue.'],
                ['steer', 'Comment on any task; the working agent gets it mid-flight and must resolve it before finishing.'],
                ['plan', 'Agents structure work into plans with ordered phases — order is enforced, not decorative.'],
                ['watch', 'Mission Control, the orchestration graph, and the board are all live over WebSocket.'],
              ].map(([k, v]) => (
                <li key={k} style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.55, color: 'var(--text-mid)' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent-ink)', paddingTop: 2, width: 38, flex: 'none' }}>{k}</span>
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
              border: '1px solid var(--w-07)', borderRadius: 13, padding: '15px 16px',
              background: 'var(--w-02)', cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
              <span
                style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, color: p.dotColor,
                  background: 'var(--w-05)', padding: '2px 7px', borderRadius: 5,
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
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--w-07)', overflow: 'hidden' }}>
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
  const codexToml = `[mcp_servers.noriq]
url = "${url}"`;
  const vscodeJson = `{
  "servers": {
    "noriq": { "type": "http", "url": "${url}" }
  }
}`;
  switch (id) {
    case 'claude':
      return scope === 'global'
        ? {
            intro: 'All your projects (user scope) — OAuth consent in the browser names the agent identity:',
            code: `claude mcp add -s user --transport http noriq ${url}`,
          }
        : {
            intro: 'This project only (local scope) — run inside the repo:',
            code: `claude mcp add --transport http noriq ${url}`,
          };
    case 'codex':
      return {
        intro:
          scope === 'global'
            ? 'Add to ~/.codex/config.toml (OAuth prompt on first use):'
            : 'Codex reads its config globally — add to ~/.codex/config.toml and tell the agent which Noriq project to work:',
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
        <div style={{ display: 'flex', gap: 2, background: 'var(--w-05)', border: '1px solid var(--w-08)', borderRadius: 8, padding: 2 }}>
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
      <div style={{ display: 'flex', gap: 2, margin: '10px 0 0', width: 'fit-content', background: 'var(--w-04)', border: '1px solid var(--w-07)', borderRadius: 7, padding: 2 }}>
        {(['global', 'project'] as const).map((sc) => (
          <button
            key={sc}
            onClick={() => setScope(sc)}
            style={{
              cursor: 'pointer', padding: '2px 9px', borderRadius: 5, fontFamily: 'var(--mono)', fontSize: 9.5,
              background: scope === sc ? 'var(--w-1)' : 'transparent',
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
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--accent-ink)', cursor: 'pointer',
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
