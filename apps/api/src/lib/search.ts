// Task search filters (PLNR-117), shared by the MCP tool and the REST endpoint so the
// two surfaces can't drift. Produces an `AND …` fragment with BARE `?` placeholders +
// its binds — the caller supplies the visibility scoping and must place this fragment
// textually AFTER any numbered (?N) params so SQLite's positional counter lines up.
import { taskWireStatus } from './visibility';
export interface TaskSearchFilters {
  status?: string;
  type?: string;
  tag?: string;
  milestoneId?: string;
  /** Restrict results to one board. Used by runner repository locks in task pickers. */
  boardId?: string;
  /** A resolved agent id, or 'none' for unclaimed. ('me' is resolved by the caller.) */
  holder?: string;
  /** Substring match over title/body/key (LIKE, escaped). */
  text?: string;
  includeArchived?: boolean;
  /** Past-due and still open (PLNR-126). */
  overdue?: boolean;
}

export function taskSearchFilters(f: TaskSearchFilters): { sql: string; binds: unknown[] } {
  const conds: string[] = [];
  const binds: unknown[] = [];
  // Match the WIRE status, not the raw column (PLNR-230): both search surfaces LABEL results
  // with the derived status ('failed' from failed_at, 'proposed' from proposed_at), so the
  // filter must speak the same vocabulary — status:"proposed" has to find the tasks the
  // results would call proposed, and status:"todo" must not sweep in gated spin-offs.
  if (f.status) { conds.push(`${taskWireStatus('t')} = ?`); binds.push(f.status); }
  if (f.type) { conds.push('t.type = ?'); binds.push(f.type); }
  if (f.milestoneId) { conds.push('t.milestone_id = ?'); binds.push(f.milestoneId); }
  if (f.boardId) { conds.push('t.board_id = ?'); binds.push(f.boardId); }
  if (f.holder === 'none') {
    conds.push('t.claimed_by IS NULL');
  } else if (f.holder) {
    conds.push('t.claimed_by = ?');
    binds.push(f.holder);
  }
  if (f.tag) {
    conds.push('EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id AND g.name = ?)');
    binds.push(f.tag.trim().toLowerCase());
  }
  if (f.text) {
    conds.push("(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR t.key LIKE ? ESCAPE '\\')");
    const pat = `%${f.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    binds.push(pat, pat, pat);
  }
  if (f.overdue) {
    conds.push("t.due_at IS NOT NULL AND t.due_at < strftime('%Y-%m-%dT%H:%M:%fZ','now') AND t.status NOT IN ('done','cancelled')");
  }
  if (!f.includeArchived) conds.push('t.archived_at IS NULL');
  return { sql: conds.map((c) => ` AND ${c}`).join(''), binds };
}
