// Shared Review-shell chrome for Validity (entity decay) and Memory review.
// Same visual language; separate authority models stay in their own data paths.
import type { ReactNode } from 'react';
import { SectionLabel } from './bits';

export type ReviewFilterChip = {
  id: string;
  label: string;
  detail: string;
  color: string;
  count: number;
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

export function ReviewInboxIntro({
  label, description, trailing,
}: {
  label: ReactNode;
  description: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
        <SectionLabel>{label}</SectionLabel>
        {trailing}
      </div>
      <div style={{ color: 'var(--text-dim)', fontSize: 12.5, lineHeight: 1.55, marginTop: 6 }}>
        {description}
      </div>
    </div>
  );
}

export function ReviewFilterChipGrid({
  chips, selectedId, onSelect,
}: {
  chips: ReviewFilterChip[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 18 }}>
      {chips.map((chip) => {
        const active = selectedId === chip.id;
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => onSelect(active ? undefined : chip.id)}
            style={{
              cursor: 'pointer', textAlign: 'left', padding: '11px 12px', borderRadius: 10,
              background: active ? 'var(--w-1)' : 'var(--w-04)',
              border: `1px solid ${active ? chip.color : 'var(--w-08)'}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>{chip.label}</span>
              <span style={{ color: chip.color, fontFamily: 'var(--mono)', fontSize: 15 }}>{chip.count}</span>
            </div>
            <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginTop: 4 }}>{chip.detail}</div>
          </button>
        );
      })}
    </div>
  );
}

export function ReviewEmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{
      padding: 40, border: '1px dashed var(--w-12)', borderRadius: 12, textAlign: 'center',
      color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11,
    }}>
      {children}
    </div>
  );
}

export function ReviewLoadingState({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>
      {children}
    </div>
  );
}
