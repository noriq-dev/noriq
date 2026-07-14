import { useTheme } from '../theme';

/** Inline dark/light toggle (rail footer, mobile top bar) — sun/moon, no fixed positioning. */
export function ThemeButton({ size = 30, label }: { size?: number; label?: boolean }) {
  const [theme, toggle] = useTheme();
  return (
    <button
      onClick={toggle}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="hover-bright"
      style={{
        cursor: 'pointer', height: size, minWidth: size, padding: label ? '0 10px' : 0,
        borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        fontSize: 14, color: 'var(--text-mid)',
      }}
    >
      <span>{theme === 'dark' ? '☀' : '☾'}</span>
      {label && <span style={{ fontSize: 12.5, fontWeight: 500 }}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
    </button>
  );
}
