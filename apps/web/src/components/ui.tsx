// Shared UI kit: modal + form primitives, in the design language.
import { useEffect, type CSSProperties, type ReactNode } from 'react';

export function Modal({ title, subtitle, onClose, children, width = 420 }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 50, backdropFilter: 'blur(2px)' }} />
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 51,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
      <div
        style={{
          width,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 80px)',
          overflowY: 'auto',
          background: 'var(--bg-raised)',
          border: '1px solid var(--w-12)',
          borderRadius: 16,
          padding: 24,
          boxShadow: '0 30px 80px rgba(0,0,0,.6)',
          animation: 'pl-stream .25s ease both',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.01em' }}>{title}</div>
            {subtitle && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>{subtitle}</div>}
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            className="drawer-x"
            style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 17, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
      </div>
    </>
  );
}

const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  background: 'var(--w-05)',
  border: '1px solid var(--w-1)',
  borderRadius: 9,
  padding: '9px 12px',
  color: 'var(--text)',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
};

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-dim)' }}>{label}</span>
        {hint && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{hint}</span>}
      </div>
      {children}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...inputStyle, ...props.style }} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} style={{ ...inputStyle, minHeight: 74, resize: 'vertical', ...props.style }} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ ...inputStyle, appearance: 'none', ...props.style }} />;
}

export function Button({ variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles: Record<string, CSSProperties> = {
    primary: { background: 'var(--accent)', color: 'var(--bg)', border: '1px solid transparent' },
    ghost: { background: 'var(--w-05)', color: 'var(--text)', border: '1px solid var(--w-12)' },
    danger: { background: 'transparent', color: 'var(--red-soft)', border: '1px solid rgba(255,92,92,.4)' },
  };
  return (
    <button
      {...props}
      className="hover-bright"
      style={{
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        fontWeight: 600,
        fontSize: 12.5,
        padding: '9px 16px',
        borderRadius: 9,
        textAlign: 'center',
        ...styles[variant],
        ...props.style,
      }}
    />
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red-soft)', marginBottom: 10 }}>{String(children)}</div>;
}
