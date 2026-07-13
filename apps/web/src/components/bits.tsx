// Small shared visual atoms from the design: avatar chips, live dot, wave bars.
import type { CSSProperties } from 'react';
import { agentFg, initials, isGhostColor, YOU_GRADIENT } from '../design';

export function AvatarChip({
  name,
  color,
  size = 26,
  radius = 7,
  fontSize = 10,
  dot,
  title,
}: {
  name: string;
  color: string; // agent color, or 'you'
  size?: number;
  radius?: number;
  fontSize?: number;
  dot?: string;
  title?: string;
}) {
  const isYou = color === 'you';
  const bg = isYou ? YOU_GRADIENT : isGhostColor(color) ? 'rgba(255,255,255,.16)' : color;
  const fg = isYou ? '#0a0b0d' : agentFg(color);
  const style: CSSProperties = {
    position: 'relative',
    width: size,
    height: size,
    flex: 'none',
    borderRadius: radius,
    background: bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--mono)',
    fontSize,
    fontWeight: 700,
    color: fg,
  };
  return (
    <div style={style} title={title ?? name}>
      {isYou ? 'Y' : initials(name)}
      {dot && (
        <span
          style={{
            position: 'absolute',
            right: -3,
            bottom: -3,
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: dot,
            border: '2px solid #0a0b0d',
          }}
        />
      )}
    </div>
  );
}

export function LiveDot({ color = 'var(--green)', size = 7 }: { color?: string; size?: number }) {
  return (
    <span style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color }} />
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: color,
          animation: 'pl-pulse 1.8s ease-out infinite',
        }}
      />
    </span>
  );
}

export function WaveBars({ height = 16, bars = 3 }: { height?: number; bars?: number }) {
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height, justifyContent: 'center' }}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: '100%',
            background: 'var(--green)',
            borderRadius: 1,
            transformOrigin: 'bottom',
            animation: `pl-wave 1s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

export function MonoTag({
  children,
  color,
  bg,
  size = 10,
}: {
  children: React.ReactNode;
  color: string;
  bg: string;
  size?: number;
}) {
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: size,
        fontWeight: 600,
        color,
        background: bg,
        padding: '1px 6px',
        borderRadius: 4,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 10.5,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
      }}
    >
      {children}
    </span>
  );
}
