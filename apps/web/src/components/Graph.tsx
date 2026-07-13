// Orchestration graph — orchestrator on top, workers fanned out below,
// animated edges to live claims, signal ticker along the bottom.
import type { AppStore } from '../store';
import { initials, isGhostColor, statusMeta } from '../design';
import { SectionLabel, WaveBars } from './bits';

export function Graph({ store }: { store: AppStore }) {
  const { data, currentPid, helpers, actions } = store;
  const agents = data.agents[currentPid] ?? [];
  const tasks = helpers.tasksOf(currentPid);
  const events = data.events[currentPid] ?? [];

  const orch = agents.find((a) => a.role === 'orch');
  const workers = agents.filter((a) => a.role !== 'orch');
  const n = workers.length;
  const orchX = 50;
  const orchY = 17;

  const blocked = tasks.filter((t) => helpers.effStatus(currentPid, t) === 'blocked').slice(0, 2);
  const working = agents.filter((a) => tasks.some((t) => t.claimedBy === a.id && t.status === 'in_progress'));
  const signals = events
    .slice(0, 4)
    .filter((e) => ['msg', 'question', 'done', 'resolved', 'claimed'].includes(e.verb))
    .slice(0, 3);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'radial-gradient(1200px 620px at 50% -8%, #12161c 0%, #0a0b0d 62%)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {workers.map((w, i) => {
            const x = n === 1 ? 50 : 15 + 70 * (i / (n - 1));
            const y = 55;
            const claim = tasks.find((t) => t.claimedBy === w.id && ['in_progress', 'claimed', 'review'].includes(t.status));
            const isWorking = claim?.status === 'in_progress';
            const ghost = isGhostColor(w.color);
            const m = claim ? statusMeta(claim.status) : null;
            return (
              <path
                key={w.id}
                d={`M${orchX},${orchY + 6} C${orchX},${(orchY + y) / 2} ${x},${y - 18} ${x},${y - 6}`}
                fill="none"
                stroke={ghost ? '#6b7280' : m ? m.color : '#4c9dff'}
                strokeWidth={1.6}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={claim ? '2 2.5' : '1.5 3'}
                opacity={claim ? 0.7 : 0.4}
                style={isWorking ? { animation: 'pl-dash 1.2s linear infinite' } : undefined}
              />
            );
          })}
        </svg>

        {orch && (
          <GraphNode
            left={`${orchX}%`}
            top={`${orchY}%`}
            size={74}
            fontSize={19}
            label={orch.name}
            initialsText={initials(orch.name)}
            color="linear-gradient(135deg,#f5a623,#e08d1a)"
            fg="#0a0b0d"
            shadow="0 0 0 1px rgba(198,242,78,.4),0 0 40px rgba(245,166,35,.35)"
            isOrch
          />
        )}

        {workers.map((w, i) => {
          const x = n === 1 ? 50 : 15 + 70 * (i / (n - 1));
          const claim = tasks.find((t) => t.claimedBy === w.id && ['in_progress', 'claimed', 'review'].includes(t.status));
          const isWorking = claim?.status === 'in_progress';
          const ghost = isGhostColor(w.color);
          const m = claim ? statusMeta(claim.status) : null;
          return (
            <GraphNode
              key={w.id}
              left={`${x}%`}
              top="55%"
              size={claim ? 60 : 48}
              fontSize={15}
              label={w.name}
              initialsText={initials(w.name)}
              color={ghost ? 'rgba(255,255,255,.1)' : w.color}
              fg={ghost ? '#e6e8ec' : '#0a0b0d'}
              shadow={claim ? `0 0 30px ${m ? m.color : '#4c9dff'}55` : 'none'}
              dot={isWorking ? '#3fd98b' : m?.dot}
              working={!!isWorking}
              idle={!claim}
              claimLabel={claim ? `${claim.key} · ${claim.title.split(' ').slice(0, 2).join(' ')}` : undefined}
              claimTint={isWorking ? '76,157,255' : '181,123,255'}
              claimColor={isWorking ? '#8fc0ff' : '#cbb0ff'}
              onClick={claim ? () => actions.openTask(claim.id) : undefined}
            />
          );
        })}

        {blocked.map((t, i) => (
          <div
            key={t.id}
            style={{
              position: 'absolute',
              left: `${38 + i * 24}%`,
              top: '82%',
              transform: 'translate(-50%,-50%)',
              zIndex: 2,
              padding: '5px 9px',
              borderRadius: 8,
              background: 'rgba(255,92,92,.08)',
              border: '1px solid rgba(255,92,92,.3)',
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              color: 'var(--red-soft)',
              whiteSpace: 'nowrap',
            }}
          >
            ⟂ {t.key} blocked
          </div>
        ))}
      </div>

      {/* signal ticker */}
      <div style={{ height: 112, flex: 'none', borderTop: '1px solid var(--line)', background: 'var(--bg-raised)', padding: '12px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9 }}>
          <SectionLabel>Signal</SectionLabel>
          <span style={{ position: 'relative', width: 6, height: 6 }}>
            <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--accent)', animation: 'pl-blink 1.4s infinite' }} />
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
            throughput {working.length * 2 + 2}.0/hr · conflicts 0
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
          {signals.map((e) => {
            let bg = 'rgba(255,255,255,.03)', border = 'rgba(255,255,255,.07)', tagColor = 'var(--text-dim)', tag: string = e.verb;
            if (e.verb === 'question') { bg = 'rgba(245,166,35,.06)'; border = 'rgba(245,166,35,.25)'; tagColor = 'var(--amber)'; tag = `? ${e.actor}`; }
            else if (e.verb === 'done' || e.verb === 'resolved') { bg = 'rgba(63,217,139,.06)'; border = 'rgba(63,217,139,.22)'; tagColor = 'var(--green)'; tag = `✓ ${e.verb}`; }
            else if (e.verb === 'msg') { tag = e.actor; }
            else if (e.verb === 'claimed') { tagColor = 'var(--green)'; tag = 'claimed'; }
            return (
              <div
                key={e.id}
                style={{
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 9,
                  background: bg,
                  border: `1px solid ${border}`,
                }}
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: tagColor }}>{tag}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-soft)' }}>{e.subject.replace(/^→ /, '').slice(0, 52)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GraphNode(props: {
  left: string;
  top: string;
  size: number;
  fontSize: number;
  label: string;
  initialsText: string;
  color: string;
  fg: string;
  shadow: string;
  isOrch?: boolean;
  dot?: string;
  working?: boolean;
  idle?: boolean;
  claimLabel?: string;
  claimTint?: string;
  claimColor?: string;
  onClick?: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: props.left,
        top: props.top,
        transform: 'translate(-50%,-50%)',
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <div
        onClick={props.onClick}
        style={{
          position: 'relative',
          width: props.size,
          height: props.size,
          borderRadius: 18,
          background: props.color,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--mono)',
          fontSize: props.fontSize,
          fontWeight: 700,
          color: props.fg,
          cursor: props.onClick ? 'pointer' : 'default',
          boxShadow: props.shadow,
        }}
      >
        {props.initialsText}
        {props.dot && (
          <span
            style={{
              position: 'absolute',
              right: -3,
              bottom: -3,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: props.dot,
              border: '2.5px solid #0a0b0d',
            }}
          />
        )}
        {props.isOrch && (
          <span style={{ position: 'absolute', inset: -6, borderRadius: 24, border: '1.5px solid rgba(198,242,78,.5)', animation: 'pl-pulse 2.4s ease-out infinite' }} />
        )}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          {props.label}
          {props.isOrch && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 8.5,
                color: 'var(--accent)',
                background: 'rgba(198,242,78,.12)',
                padding: '1px 5px',
                borderRadius: 4,
                marginLeft: 5,
              }}
            >
              ORCH
            </span>
          )}
        </div>
        {props.working && <div style={{ marginTop: 3 }}><WaveBars height={14} bars={4} /></div>}
        {props.idle && !props.isOrch && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>idle</div>
        )}
      </div>
      {props.claimLabel && (
        <div
          style={{
            padding: '5px 9px',
            borderRadius: 8,
            background: `rgba(${props.claimTint},.1)`,
            border: `1px solid rgba(${props.claimTint},.3)`,
            fontFamily: 'var(--mono)',
            fontSize: 9.5,
            color: props.claimColor,
            whiteSpace: 'nowrap',
          }}
        >
          {props.claimLabel}
        </div>
      )}
    </div>
  );
}
