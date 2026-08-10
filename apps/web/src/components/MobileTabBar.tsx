import type { ViewId } from '../types';
import { TAB_ITEM_HEIGHT } from '../viewport';

export type MobileTab = 'feed' | 'board' | 'ask' | 'insight' | 'more';

const TABS: Array<{ id: MobileTab; label: string; icon: string; view: ViewId }> = [
  { id: 'feed', label: 'Feed', icon: '◉', view: 'control' },
  { id: 'board', label: 'Board', icon: '▦', view: 'board' },
  { id: 'ask', label: 'Ask', icon: '✦', view: 'ask' },
  { id: 'insight', label: 'Insight', icon: '◇', view: 'intelligence' },
  { id: 'more', label: 'More', icon: '•••', view: 'more' },
];

export function mobileTabForView(view: ViewId): MobileTab {
  if (view === 'control') return 'feed';
  if (view === 'board') return 'board';
  if (view === 'ask') return 'ask';
  if (view === 'intelligence') return 'insight';
  return 'more';
}

export function MobileTabBar({ view, signalCount, onNavigate }: {
  view: ViewId;
  signalCount: number;
  onNavigate: (view: ViewId) => void;
}) {
  const active = mobileTabForView(view);
  return (
    <nav
      aria-label="Mobile navigation"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 45,
        display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
        minHeight: `calc(${TAB_ITEM_HEIGHT}px + env(safe-area-inset-bottom))`,
        paddingBottom: 'env(safe-area-inset-bottom)', background: 'var(--bg-rail)',
        borderTop: '1px solid var(--w-09)', boxShadow: '0 -8px 24px rgba(0,0,0,.24)',
      }}
    >
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            type="button"
            key={tab.id}
            onClick={() => onNavigate(tab.view)}
            aria-current={selected ? 'page' : undefined}
            aria-label={tab.id === 'feed' && signalCount ? `${tab.label}, ${signalCount} decisions waiting` : tab.label}
            style={{
              position: 'relative', minWidth: 0, minHeight: TAB_ITEM_HEIGHT, cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
              color: selected ? 'var(--accent)' : 'var(--text-dim)',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: tab.id === 'more' ? 13 : 17, lineHeight: 1 }}>{tab.icon}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: selected ? 700 : 500 }}>{tab.label}</span>
            {tab.id === 'feed' && signalCount > 0 && (
              <span
                data-signal-badge
                style={{
                  position: 'absolute', top: 4, left: 'calc(50% + 8px)', minWidth: 16, height: 16,
                  padding: '0 4px', borderRadius: 999, boxSizing: 'border-box',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--amber)', color: 'var(--bg)', border: '2px solid var(--bg-rail)',
                  fontFamily: 'var(--mono)', fontSize: 8.5, fontWeight: 800,
                }}
              >
                {signalCount > 99 ? '99+' : signalCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
