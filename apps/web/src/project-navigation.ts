import type { ViewId } from './types';

export type ProjectViewId = Exclude<ViewId, 'home' | 'ask' | 'settings' | 'project-settings' | 'admin' | 'more'>;

export interface ProjectNavigationItem {
  id: ProjectViewId;
  label: string;
  description: string;
}

export interface ProjectNavigationGroup {
  label: 'Overview' | 'Work' | 'Operate' | 'Knowledge';
  items: ProjectNavigationItem[];
}

/** One shared project-navigation taxonomy for the TopBar and command palette. */
export const PROJECT_NAV_GROUPS: ProjectNavigationGroup[] = [
  {
    label: 'Overview',
    items: [
      { id: 'control', label: 'Mission Control', description: 'Project pulse and coordination' },
    ],
  },
  {
    label: 'Work',
    items: [
      { id: 'graph', label: 'Task Graph', description: 'Dependencies and orchestration' },
      { id: 'board', label: 'Board', description: 'Task flow and ownership' },
      { id: 'plans', label: 'Plans', description: 'Phased implementation work' },
      { id: 'roadmap', label: 'Roadmap', description: 'Milestones and direction' },
      { id: 'review', label: 'Review', description: 'Human decisions and approvals' },
    ],
  },
  {
    label: 'Operate',
    items: [
      { id: 'executions', label: 'Execution', description: 'Execution specifications' },
      { id: 'runs', label: 'Jobs', description: 'Agent-guided work and retained outcomes' },
      { id: 'agents', label: 'Agents', description: 'Live actors and lifecycle' },
      { id: 'intelligence', label: 'Intelligence', description: 'Project-level signals' },
    ],
  },
  {
    label: 'Knowledge',
    items: [
      { id: 'docs', label: 'Docs', description: 'Settled project knowledge' },
      { id: 'memory', label: 'Memory', description: 'Evidence and retained context' },
    ],
  },
];

export const PROJECT_NAV_ITEMS = PROJECT_NAV_GROUPS.flatMap((group) => group.items);

export function projectNavigationContext(view: ViewId): { group: ProjectNavigationGroup; item: ProjectNavigationItem } {
  for (const group of PROJECT_NAV_GROUPS) {
    const item = group.items.find((candidate) => candidate.id === view);
    if (item) return { group, item };
  }
  return { group: PROJECT_NAV_GROUPS[0]!, item: PROJECT_NAV_GROUPS[0]!.items[0]! };
}
