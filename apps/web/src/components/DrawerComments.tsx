import { useEffect, useState } from 'react';
import { api } from '../api';
import { KIND_META } from '../design';
import { mapTaskComment, type AppStore } from '../store';
import type { CommentCounts, CommentVM, TaskVM } from '../types';
import { AvatarChip, MonoTag, SectionLabel } from './bits';
import { Markdown } from './Markdown';

function isUnresolved(c: CommentVM): boolean {
  return c.status === 'open' || c.status === 'acknowledged';
}

function isActivity(c: CommentVM): boolean {
  return !isUnresolved(c) && c.role !== 'human' && c.kind !== 'question' && c.kind !== 'instruction';
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d`;
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

function displayName(c: CommentVM, store: AppStore, pid: string): string {
  if (c.role === 'system') return 'system';
  if (c.role === 'human') return store.user?.id === c.author ? 'you' : 'human';
  return store.helpers.agentById(pid, c.author)?.name ?? c.author;
}

function avatarColor(c: CommentVM, store: AppStore, pid: string): string {
  if (c.role === 'human') return 'you';
  if (c.role === 'system') return '#8b8b8b';
  return store.helpers.agentById(pid, c.author)?.color ?? '#4c9dff';
}

export function CollapsibleMarkdown({ source, lines = 8, compact }: { source: string; lines?: number; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = source.length > 800 || source.split('\n').length > lines;
  return (
    <div>
      <div style={!open && long ? { maxHeight: `${lines * 1.55}em`, overflow: 'hidden' } : undefined}>
        <Markdown source={source} compact={compact} />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            cursor: 'pointer', marginTop: 6, padding: 0, border: 0, background: 'transparent',
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
          }}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function CommentCard({
  c, store, pid, compactBody, canResolve,
}: {
  c: CommentVM; store: AppStore; pid: string; compactBody: boolean; canResolve: boolean;
}) {
  const kind = KIND_META[c.kind] ?? KIND_META.comment;
  const statusColor =
    c.status === 'addressed' ? 'var(--green)' : c.status === 'acknowledged' ? 'var(--text-mid)' : c.status === 'wont_do' ? 'var(--red-soft)' : 'var(--amber)';
  const name = displayName(c, store, pid);
  return (
    <div data-testid={`comment-${c.id}`} style={{ display: 'flex', gap: 10 }}>
      <AvatarChip name={name} color={avatarColor(c, store, pid)} size={26} radius={7} fontSize={10} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{name}</span>
          <MonoTag color={kind.color} bg={kind.bg} size={9}>{c.kind}</MonoTag>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: statusColor }}>{c.status}</span>
          {c.createdAt && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)' }}>{relativeTime(c.createdAt)}</span>
          )}
          {canResolve && store.permissions.canContribute && (c.status === 'open' || c.status === 'acknowledged') && (
            <button
              onClick={() => store.actions.resolveComment(c.id, 'addressed')}
              title="mark addressed"
              style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--green)', marginLeft: 4, background: 'transparent' }}
            >
              ✓ resolve
            </button>
          )}
        </div>
        <div
          style={{
            fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-soft)',
            background: c.role === 'agent' ? 'rgba(76,157,255,.06)' : 'var(--w-03)',
            border: `1px solid ${c.role === 'agent' ? 'rgba(76,157,255,.18)' : 'var(--w-07)'}`,
            borderRadius: 10, padding: '9px 12px',
            wordBreak: 'break-word',
          }}
        >
          <CollapsibleMarkdown source={c.body} lines={compactBody ? 3 : 8} compact />
        </div>
      </div>
    </div>
  );
}

function nest(comments: CommentVM[]): Array<{ parent: CommentVM; replies: CommentVM[] }> {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const replies = new Map<string, CommentVM[]>();
  const roots: CommentVM[] = [];
  for (const c of comments) {
    if (c.parentCommentId && byId.has(c.parentCommentId)) {
      const list = replies.get(c.parentCommentId) ?? [];
      list.push(c);
      replies.set(c.parentCommentId, list);
    } else {
      roots.push(c);
    }
  }
  return roots.map((parent) => ({ parent, replies: replies.get(parent.id) ?? [] }));
}

export function DrawerComments({
  task, store, counts, hasMore,
}: {
  task: TaskVM;
  store: AppStore;
  counts: CommentCounts;
  hasMore: boolean;
}) {
  const pid = store.currentPid;
  const [extra, setExtra] = useState<CommentVM[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageHasMore, setPageHasMore] = useState(hasMore);

  useEffect(() => {
    setExtra([]);
    setPageHasMore(hasMore);
  }, [task.id]);

  useEffect(() => {
    if (extra.length === 0) setPageHasMore(hasMore);
  }, [hasMore, extra.length]);

  const loaded = [...task.comments, ...extra.filter((c) => !task.comments.some((x) => x.id === c.id))];
  const needsYou = loaded.filter(isUnresolved);
  const discussion = loaded.filter((c) => !isUnresolved(c) && !isActivity(c));
  const activity = loaded.filter(isActivity);
  const activityNewest = [...activity].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const loadOlder = async () => {
    const oldest = activityNewest[activityNewest.length - 1];
    setLoadingMore(true);
    try {
      const page = await api.taskComments(task.id, {
        status: 'resolved', authorKind: 'agent', limit: 20, before: oldest?.id,
      });
      setExtra((cur) => [...cur, ...page.comments.map(mapTaskComment)]);
      setPageHasMore(page.hasMore);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div data-testid="drawer-comments">
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14, flexWrap: 'wrap' }}>
        <SectionLabel>Comments</SectionLabel>
        {counts.open > 0 && <MonoTag color="var(--amber)" bg="rgba(245,166,35,.12)" size={9.5}>{counts.open} need you</MonoTag>}
        {counts.resolved > 0 && <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9.5}>{counts.resolved} notes</MonoTag>}
      </div>

      {needsYou.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18 }}>
          {nest(needsYou).map(({ parent, replies }) => (
            <div key={parent.id}>
              <CommentCard c={parent} store={store} pid={pid} compactBody={false} canResolve />
              {replies.length > 0 && (
                <div style={{ marginLeft: 36, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {replies.map((r) => (
                    <CommentCard key={r.id} c={r} store={store} pid={pid} compactBody={false} canResolve={false} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {discussion.length > 0 && (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', marginBottom: 10 }}>
            {discussion.length} resolved
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {nest(discussion).map(({ parent, replies }) => (
              <div key={parent.id}>
                <CommentCard c={parent} store={store} pid={pid} compactBody canResolve={false} />
                {replies.map((r) => (
                  <div key={r.id} style={{ marginLeft: 36, marginTop: 8 }}>
                    <CommentCard c={r} store={store} pid={pid} compactBody canResolve={false} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}

      {activityNewest.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ marginBottom: 10 }}>
            <SectionLabel>Activity</SectionLabel>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 10 }}>
            {activityNewest.map((c) => (
              <CommentCard key={c.id} c={c} store={store} pid={pid} compactBody canResolve={false} />
            ))}
          </div>
        </div>
      )}

      {pageHasMore && (
        <button
          type="button"
          data-testid="load-older-comments"
          disabled={loadingMore}
          onClick={() => void loadOlder()}
          style={{
            cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)',
            border: '1px dashed var(--w-15)', padding: '6px 10px', borderRadius: 8, background: 'transparent',
            marginBottom: 18, width: '100%',
          }}
        >
          {loadingMore ? 'Loading…' : 'Load older notes'}
        </button>
      )}
    </div>
  );
}
