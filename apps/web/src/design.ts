// Visual vocabulary ported from design.html — status/kind colors and helpers.
import type { CommentKind, TaskStatus } from './types';

export interface StatusMeta {
  label: string;
  color: string;
  bg: string;
  dot: string;
}

const STATUS: Record<TaskStatus, StatusMeta> = {
  todo: { label: 'todo', color: '#8a95a3', bg: 'rgba(138,149,163,.14)', dot: '#6b7280' },
  claimed: { label: 'claimed', color: '#f5a623', bg: 'rgba(245,166,35,.14)', dot: '#f5a623' },
  in_progress: { label: 'in progress', color: '#4c9dff', bg: 'rgba(76,157,255,.14)', dot: '#4c9dff' },
  blocked: { label: 'blocked', color: '#ff5c5c', bg: 'rgba(255,92,92,.14)', dot: '#ff5c5c' },
  review: { label: 'review', color: '#b57bff', bg: 'rgba(181,123,255,.14)', dot: '#b57bff' },
  done: { label: 'done', color: '#3fd98b', bg: 'rgba(63,217,139,.14)', dot: '#3fd98b' },
  cancelled: { label: 'cancelled', color: '#6b7280', bg: 'rgba(107,114,128,.14)', dot: '#6b7280' },
};

export const statusMeta = (st: TaskStatus): StatusMeta => STATUS[st] ?? STATUS.todo;

export const KIND_META: Record<CommentKind, { label: string; color: string; bg: string }> = {
  question: { label: '? question', color: '#f5a623', bg: 'rgba(245,166,35,.12)' },
  instruction: { label: '! instruction', color: '#4c9dff', bg: 'rgba(76,157,255,.12)' },
  comment: { label: '# comment', color: '#8a8f98', bg: 'var(--w-06)' },
  reply: { label: 'reply', color: '#3fd98b', bg: 'rgba(63,217,139,.1)' },
};

export const initials = (name: string): string => name.slice(0, 2).toUpperCase();

export const fmtTtl = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** Agents with an rgba() color render as "ghost" chips with light text. */
export const isGhostColor = (color: string): boolean => color.startsWith('rgba');
export const agentFg = (color: string): string => (isGhostColor(color) ? '#e6e8ec' : '#0a0b0d');

export const YOU_GRADIENT = 'linear-gradient(135deg,#c6f24e,#3fd98b)';

export function verbColors(verb: string): { color: string; bg: string } {
  if (verb === 'claimed' || verb === 'done' || verb === 'resolved')
    return { color: '#3fd98b', bg: 'rgba(63,217,139,.1)' };
  if (verb === 'question') return { color: '#f5a623', bg: 'rgba(245,166,35,.12)' };
  if (verb === 'instruction') return { color: '#4c9dff', bg: 'rgba(76,157,255,.12)' };
  if (verb === 'subtask') return { color: '#c6f24e', bg: 'rgba(198,242,78,.1)' };
  if (verb.startsWith('status')) return { color: '#b57bff', bg: 'rgba(181,123,255,.12)' };
  if (verb.startsWith('released')) return { color: '#ff8a8a', bg: 'rgba(255,92,92,.12)' };
  return { color: '#8a8f98', bg: 'var(--w-06)' };
}
