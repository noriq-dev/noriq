import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTheme, type ThemePreference } from '../theme';

const OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'system', label: 'System', icon: '◐' },
  { value: 'dark', label: 'Dark', icon: '☾' },
];

const PREF_LABEL: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/**
 * Appearance control — click opens a compact segmented slider for light / system / dark.
 * Used in the rail footer, mobile More sheet, and unauthenticated floating chrome.
 */
export function ThemeButton({
  size = 30,
  label,
  floating,
  menuSide = floating ? 'bottom' : 'top',
}: {
  size?: number;
  label?: boolean;
  /** Fixed top-right chrome on login/setup/invite. */
  floating?: boolean;
  menuSide?: 'top' | 'bottom';
}) {
  const [theme, setPreference, preference] = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerIcon = preference === 'system' ? '◐' : theme === 'dark' ? '☾' : '☀';
  const title = open ? 'Close appearance menu' : `Appearance: ${PREF_LABEL[preference]}`;

  const rootStyle: CSSProperties = floating
    ? { position: 'fixed', top: 12, right: 14, zIndex: 60 }
    : { position: 'relative', display: 'inline-flex' };

  const triggerStyle: CSSProperties = floating
    ? {
        cursor: 'pointer', width: size, height: size, borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
        background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-mid)',
      }
    : {
        cursor: 'pointer', height: size, minWidth: size, padding: label ? '0 10px' : 0,
        borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        fontSize: 14, color: 'var(--text-mid)',
        background: open ? 'var(--w-06)' : 'transparent',
        border: open ? '1px solid var(--w-12)' : '1px solid transparent',
      };

  const menuStyle: CSSProperties = {
    position: 'absolute', zIndex: 70, right: 0,
    ...(menuSide === 'top' ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' }),
    padding: 8,
    border: '1px solid var(--w-12)', borderRadius: 12,
    background: 'var(--bg-raised)', boxShadow: '0 18px 55px rgba(0,0,0,.5)',
    animation: `${menuSide === 'top' ? 'pl-stream-up' : 'pl-stream'} .2s ease both`,
    minWidth: label ? 220 : 196,
  };

  return (
    <div ref={rootRef} style={rootStyle}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="hover-bright"
        style={triggerStyle}
      >
        <span aria-hidden>{triggerIcon}</span>
        {label && (
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>
            {PREF_LABEL[preference]}
          </span>
        )}
      </button>
      {open && (
        <div
          id={menuId}
          role="dialog"
          aria-label="Appearance"
          style={menuStyle}
        >
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.06em',
            textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 2px 7px',
          }}>
            Appearance
          </div>
          <div
            role="radiogroup"
            aria-label="Theme"
            style={{
              display: 'flex', gap: 2, padding: 2, borderRadius: 9,
              background: 'var(--w-02)', border: '1px solid var(--w-07)',
            }}
          >
            {OPTIONS.map((option) => {
              const selected = preference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setPreference(option.value);
                    setOpen(false);
                  }}
                  title={option.value === 'system' ? 'Follow system appearance' : `${option.label} mode`}
                  style={{
                    flex: 1, fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase',
                    padding: '7px 8px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                    background: selected ? 'var(--w-09)' : 'transparent',
                    color: selected ? 'var(--text)' : 'var(--text-dim)',
                  }}
                >
                  <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>{option.icon}</span>
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
