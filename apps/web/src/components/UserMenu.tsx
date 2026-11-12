// Avatar/name menu — User settings + Sign out (PLNR-640 Montana UX).
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppStore } from '../store';
import { AvatarChip } from './bits';
import { confirm } from './Dialog';

export function UserMenu({
  store,
  variant = 'rail',
  menuSide = variant === 'rail' ? 'top' : 'bottom',
  themeSlot,
}: {
  store: AppStore;
  variant?: 'rail' | 'more' | 'topbar';
  menuSide?: 'top' | 'bottom';
  /** Optional control rendered beside the trigger (e.g. ThemeButton in the rail). */
  themeSlot?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const name = store.user?.name ?? 'You';
  const roleLabel = store.user?.accessMode === 'read_only' ? 'read only' : (store.user?.role ?? 'member');

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

  const openSettings = () => {
    setOpen(false);
    store.actions.setView('settings');
  };

  const signOut = async () => {
    setOpen(false);
    if (!(await confirm('Sign out of Noriq on this device?'))) return;
    await store.actions.logout();
  };

  // More uses an in-flow panel (not absolute overlay) so account actions don't cover
  // Workspace/Notifications underneath on the phone scroll surface (PLNR-640).
  const moreInline = variant === 'more';
  const menuStyle: CSSProperties = moreInline
    ? {
        position: 'relative', zIndex: 'auto',
        marginTop: 10, padding: 6,
        border: '1px solid var(--w-12)', borderRadius: 12,
        background: 'var(--card)',
        boxSizing: 'border-box', width: '100%',
        animation: 'pl-stream .2s ease both',
      }
    : {
        position: 'absolute', zIndex: 70,
        ...(variant === 'topbar' ? { right: 0 } : { left: 0, right: 0 }),
        ...(menuSide === 'top' ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' }),
        padding: 6,
        border: '1px solid var(--w-12)', borderRadius: 12,
        background: 'var(--bg-raised)', boxShadow: '0 18px 55px rgba(0,0,0,.5)',
        animation: `${menuSide === 'top' ? 'pl-stream-up' : 'pl-stream'} .2s ease both`,
        minWidth: variant === 'topbar' ? 200 : undefined,
        boxSizing: 'border-box',
      };

  const menu = open && (
    <div id={menuId} role="menu" aria-label="Account" style={menuStyle}>
      <MenuItem
        label="User settings"
        detail="Profile, password, and passkeys"
        onClick={openSettings}
      />
      <MenuItem
        label="Sign out"
        detail="End this session on this device"
        danger
        onClick={() => { void signOut(); }}
      />
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-testid="user-menu"
      style={{
        position: moreInline ? 'static' : 'relative',
        zIndex: !moreInline && open ? 40 : 'auto',
        display: moreInline ? 'flex' : 'flex',
        flexDirection: moreInline ? 'column' : 'row',
        alignItems: moreInline ? 'stretch' : 'center',
        gap: variant === 'rail' ? 0 : 8,
        width: variant === 'rail' || variant === 'more' ? '100%' : undefined,
        marginBottom: variant === 'more' ? 10 : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: variant === 'rail' ? 0 : 8, width: moreInline ? '100%' : undefined, flex: variant === 'rail' ? 1 : undefined, minWidth: 0 }}>
        <button
          type="button"
          data-testid="user-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={`Account menu for ${name}`}
          title={open ? 'Close account menu' : 'Account menu'}
          onClick={() => setOpen((value) => !value)}
          className="hover-bright"
          style={triggerStyle(variant, open)}
        >
          {variant === 'topbar' ? (
            <AvatarChip name={name} color="you" size={34} radius={17} />
          ) : variant === 'more' ? (
            <>
              <AvatarChip name={name} color="you" size={42} radius={21} />
              <span style={{ minWidth: 0, textAlign: 'left', flex: 1 }}>
                <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{name}</span>
                <span style={{ display: 'block', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 9.5, marginTop: 3 }}>{roleLabel}</span>
              </span>
              <span aria-hidden style={{ color: 'var(--text-faint)', fontSize: 12 }}>{open ? '▴' : '▾'}</span>
            </>
          ) : (
            <>
              <span style={{
                width: 24, height: 24, borderRadius: '50%', flex: 'none',
                background: 'linear-gradient(135deg,#c6f24e,#3fd98b)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10.5, color: 'var(--bg)', fontWeight: 700,
              }}>
                {name.slice(0, 1).toUpperCase()}
              </span>
              <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                <span style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--text-faint)' }}>{roleLabel}</span>
              </span>
            </>
          )}
        </button>
        {themeSlot}
        {!moreInline && menu}
      </div>
      {moreInline && menu}
    </div>
  );
}

function triggerStyle(variant: 'rail' | 'more' | 'topbar', open: boolean): CSSProperties {
  if (variant === 'topbar') {
    return {
      cursor: 'pointer', padding: 0, borderRadius: 17, border: open ? '1px solid var(--w-18)' : '1px solid transparent',
      background: 'transparent', display: 'flex', alignItems: 'center',
    };
  }
  if (variant === 'more') {
    return {
      cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', gap: 11,
      padding: '12px 10px', borderRadius: 12, textAlign: 'left',
      background: open ? 'var(--w-04)' : 'transparent',
      border: open ? '1px solid var(--w-1)' : '1px solid transparent',
    };
  }
  return {
    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, flex: 1, minWidth: 0,
    padding: '7px 8px', borderRadius: 8, textAlign: 'left',
    background: open ? 'var(--w-06)' : 'transparent',
    border: open ? '1px solid var(--w-12)' : '1px solid transparent',
  };
}

function MenuItem({
  label, detail, onClick, danger,
}: {
  label: string;
  detail: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={label === 'Sign out' ? 'user-menu-sign-out' : 'user-menu-settings'}
      onClick={onClick}
      className="hover-bright"
      style={{
        width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
        padding: '9px 11px', borderRadius: 9, cursor: 'pointer', textAlign: 'left',
        background: 'transparent', border: '1px solid transparent',
        color: danger ? 'var(--red-soft)' : 'var(--text)',
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: danger ? 'rgba(255,92,92,.75)' : 'var(--text-faint)' }}>{detail}</span>
    </button>
  );
}
