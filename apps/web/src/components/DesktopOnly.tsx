import { useState } from 'react';
import type { ViewId } from '../types';
import { MIN_TOUCH_TARGET } from '../viewport';
import { Button } from './ui';

export const DESKTOP_ONLY_VIEWS = {
  graph: ['Coordination graph', 'Explore dependencies, ownership, and live coordination across a wide connected canvas.'],
  plans: ['Plans', 'Review phase structure, gates, dispatches, and landing evidence side by side.'],
  roadmap: ['Roadmap', 'Arrange milestones and delivery windows across the project timeline.'],
  docs: ['Docs', 'Read and edit long-form project documents with their surrounding workspace context.'],
  memory: ['Memory', 'Explore durable memories and evidence relationships in the full constellation workspace.'],
  executions: ['Execution', 'Inspect orchestration trees and timelines that need room for parallel branches.'],
  runs: ['Runs', 'Compare run history, model attribution, usage, and outcomes in the full table.'],
  agents: ['Agents', 'Manage runner presence, agent history, capacity, and administrative controls.'],
} satisfies Partial<Record<ViewId, readonly [string, string]>>;

export type DesktopOnlyView = keyof typeof DESKTOP_ONLY_VIEWS;

export function isDesktopOnlyView(view: ViewId): view is DesktopOnlyView {
  return view in DESKTOP_ONLY_VIEWS;
}

export function projectViewLink(projectId: string, view: DesktopOnlyView): string {
  return `${location.origin}/p/${encodeURIComponent(projectId)}/${view}`;
}

export function DesktopOnly({ projectId, view }: { projectId: string; view: DesktopOnlyView }) {
  const [copied, setCopied] = useState(false);
  const [title, detail] = DESKTOP_ONLY_VIEWS[view];
  const copy = async () => {
    await navigator.clipboard.writeText(projectViewLink(projectId, view));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div data-testid={`desktop-only-${view}`} style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '28px 18px' }}>
      <article style={{ maxWidth: 480, margin: '38px auto 0', padding: 22, borderRadius: 16, background: 'var(--card)', border: '1px solid var(--w-09)', boxShadow: '0 18px 50px rgba(0,0,0,.18)' }}>
        <div aria-hidden="true" style={{ fontSize: 25, color: 'var(--accent)', marginBottom: 15 }}>▱</div>
        <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-.02em' }}>{title} works best on desktop</h1>
        <p style={{ margin: '10px 0 0', color: 'var(--text-mid)', fontSize: 13.5, lineHeight: 1.6 }}>{detail}</p>
        <p style={{ margin: '12px 0 18px', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 10.5, lineHeight: 1.55 }}>This tool keeps its full wide-canvas layout. Copy the project link and open it on a larger screen.</p>
        <Button type="button" onClick={() => void copy()} style={{ minHeight: MIN_TOUCH_TARGET, width: '100%' }}>{copied ? 'Project link copied' : 'Copy project link'}</Button>
      </article>
    </div>
  );
}
