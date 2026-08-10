// Comment composer — kind chip cycles question → instruction → comment.
// Multi-line (PLNR-86): the field is an auto-growing textarea; Enter posts,
// Shift+Enter inserts a newline for longer comments.
import { useEffect, useRef } from 'react';
import type { AppStore } from '../store';
import { KIND_META } from '../design';
import { MIN_INPUT_FONT_SIZE, MIN_TOUCH_TARGET, useViewport } from '../viewport';

export function Composer({ store, placeholder, compact }: { store: AppStore; placeholder: string; compact?: boolean }) {
  const { phone } = useViewport();
  const { draftKind, draftText, actions } = store;
  const dk = KIND_META[draftKind];
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = taRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }
  }, [draftText]);
  if (!store.permissions.canContribute) {
    return <div style={{ color: 'var(--text-dim)', fontSize: 11.5, padding: '8px 2px' }}>View-only access — commenting and coordination actions are disabled.</div>;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, minWidth: 0, flex: 1 }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          background: 'var(--w-05)',
          border: '1px solid var(--w-08)',
          borderRadius: compact ? 10 : 9,
          padding: compact ? '8px 12px' : '7px 12px',
        }}
      >
        <button
          onClick={actions.cycleKind}
          title="switch kind"
          style={{
            minHeight: phone ? MIN_TOUCH_TARGET : undefined,
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: dk.color,
            background: dk.bg,
            padding: '2px 6px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
          }}
        >
          {dk.label}
        </button>
        <textarea
          ref={taRef}
          value={draftText}
          rows={1}
          onChange={(e) => actions.setDraftText(e.target.value)}
          onKeyDown={(e) => {
            // Enter posts; Shift+Enter (or ⌘/Ctrl+Enter) inserts a newline.
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              actions.postComment();
            }
          }}
          placeholder={placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--text)',
            fontSize: phone ? MIN_INPUT_FONT_SIZE : 12.5,
            fontFamily: 'inherit',
            lineHeight: 1.5,
            resize: 'none',
            maxHeight: 160,
            overflowY: 'auto',
          }}
        />
        {compact && <PostButton store={store} small touch={phone} />}
      </div>
      {!compact && <PostButton store={store} />}
    </div>
  );
}

function PostButton({ store, small, touch = false }: { store: AppStore; small?: boolean; touch?: boolean }) {
  return (
    <button
      onClick={store.actions.postComment}
      className="hover-bright"
      style={{
        minHeight: touch ? MIN_TOUCH_TARGET : undefined,
        cursor: 'pointer',
        background: 'var(--accent)',
        color: 'var(--bg)',
        fontWeight: 600,
        fontSize: small ? 12 : 12.5,
        padding: small ? '7px 13px' : '9px 15px',
        borderRadius: small ? 8 : 9,
        flex: 'none',
      }}
    >
      Post
    </button>
  );
}
