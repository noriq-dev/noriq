// Comment composer — kind chip cycles question → instruction → comment.
import type { AppStore } from '../store';
import { KIND_META } from '../design';

export function Composer({ store, placeholder, compact }: { store: AppStore; placeholder: string; compact?: boolean }) {
  const { draftKind, draftText, actions } = store;
  const dk = KIND_META[draftKind];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
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
        <input
          value={draftText}
          onChange={(e) => actions.setDraftText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
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
            fontSize: 12.5,
          }}
        />
        {compact && <PostButton store={store} small />}
      </div>
      {!compact && <PostButton store={store} />}
    </div>
  );
}

function PostButton({ store, small }: { store: AppStore; small?: boolean }) {
  return (
    <button
      onClick={store.actions.postComment}
      className="hover-bright"
      style={{
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
