// Shared Review inbox chrome (PLNR-588 / P1-I): tab strip + filter chips + empty/loading.
// Validity and Memory queues share this look; authority models and APIs stay separate.
import type { ReactNode } from 'react';

export const REVIEW_TAB_KEY = 'noriq.reviewTab';

export type ReviewShellTab = 'work' | 'validity' | 'memory';

/** Prefer Review → Memory as the shared human entry for memory governance. */
export function openReviewMemoryTab(setView: (view: 'review') => void) {
  try { sessionStorage.setItem(REVIEW_TAB_KEY, 'memory'); } catch { /* optional */ }
  setView('review');
}

/** Read-only: safe under React StrictMode's double useState initializer. */
export function readReviewShellTab(): ReviewShellTab {
  try {
    const raw = sessionStorage.getItem(REVIEW_TAB_KEY);
    if (raw === 'work' || raw === 'validity' || raw === 'memory') return raw;
  } catch { /* optional */ }
  return 'work';
}

/** Consume the one-shot nav hint after mount (not during state init). */
export function clearReviewShellTabHint(): void {
  try { sessionStorage.removeItem(REVIEW_TAB_KEY); } catch { /* optional */ }
}

export type InboxFilterOption<T extends string> = {
  id: T;
  label: string;
  detail: string;
  color: string;
};

export function ReviewTabButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        cursor: 'pointer', padding: '7px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
        background: active ? 'var(--w-1)' : 'var(--w-04)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--w-08)'}`,
        color: active ? 'var(--text)' : 'var(--text-dim)',
      }}
    >
      {children}
    </button>
  );
}

export function InboxFilterChips<T extends string>({
  options, selected, counts, onSelect, minWidth = 150,
}: {
  options: Array<InboxFilterOption<T>>;
  selected: T | undefined;
  counts: Partial<Record<T, number>>;
  onSelect: (id: T | undefined) => void;
  minWidth?: number;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`, gap: 8, marginBottom: 18 }}>
      {options.map((item) => {
        const active = selected === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(active ? undefined : item.id)}
            style={{
              cursor: 'pointer', textAlign: 'left', padding: '11px 12px', borderRadius: 10,
              background: active ? 'var(--w-1)' : 'var(--w-04)',
              border: `1px solid ${active ? item.color : 'var(--w-08)'}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>{item.label}</span>
              <span style={{ color: item.color, fontFamily: 'var(--mono)', fontSize: 15 }}>{counts[item.id] ?? 0}</span>
            </div>
            <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 4 }}>{item.detail}</div>
          </button>
        );
      })}
    </div>
  );
}

export function InboxEmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{
      padding: 40, border: '1px dashed var(--w-12)', borderRadius: 12, textAlign: 'center',
      color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11,
    }}>
      {children}
    </div>
  );
}

export function InboxLoading({ label }: { label: string }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>
      {label}
    </div>
  );
}
