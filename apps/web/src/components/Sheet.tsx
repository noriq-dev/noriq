import { useEffect, type ReactNode } from 'react';
import { MIN_TOUCH_TARGET } from '../viewport';

export function Sheet({ title, subtitle, onClose, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      role="presentation"
      data-sheet-backdrop
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end',
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)',
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          boxSizing: 'border-box', width: '100%', maxHeight: 'min(88dvh, 760px)', overflowY: 'auto',
          background: 'var(--bg-raised)', border: '1px solid var(--w-12)', borderBottom: 0,
          borderRadius: '22px 22px 0 0', padding: '8px 20px calc(20px + env(safe-area-inset-bottom))',
          boxShadow: '0 -20px 60px rgba(0,0,0,.6)', animation: 'pl-stream-up .2s ease both',
        }}
      >
        <div aria-hidden="true" style={{ width: 38, height: 4, borderRadius: 999, background: 'var(--w-2)', margin: '0 auto 8px' }} />
        <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: MIN_TOUCH_TARGET, marginBottom: 14 }}>
          <div style={{ alignSelf: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.01em' }}>{title}</div>
            {subtitle && <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>{subtitle}</div>}
          </div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="drawer-x"
            style={{
              cursor: 'pointer', color: 'var(--text-dim)', fontSize: 17,
              width: MIN_TOUCH_TARGET, height: MIN_TOUCH_TARGET,
              display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8,
            }}
          >
            ✕
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
