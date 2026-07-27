import { ExecutionSpec, type ExecutionSpecInput } from '@noriq-dev/shared';

// RUN-135. The `tasks.execution_spec` column holds the spec as JSON text (see migration 0061 for
// why one column rather than six tables). These two functions are the only places that cross
// between the column and the wire shape, so a read and a write can never disagree about the
// encoding.

/**
 * Validate a spec on its way INTO the column, and return the text to store.
 *
 * Throws on anything `ExecutionSpec` rejects — the write seam is where a bad spec must fail,
 * loudly, at the caller that sent it. Null in, null out: that is how a spec is cleared.
 *
 * Callers must run this BEFORE anything durable happens. `blockConcurrencyWhile` serializes a
 * mutation; it is not a transaction, so a throw half-way through leaves whatever already
 * committed — a minted tag, a plan with four of its five tasks.
 *
 * Stores the PARSED value rather than the caller's object, so every row is normalised (defaults
 * applied, unknown keys dropped) and `readExecutionSpec` never has to reason about which shape of
 * spec an old row happens to hold.
 */
export const writeExecutionSpec = (spec: ExecutionSpecInput | null | undefined): string | null =>
  spec == null ? null : JSON.stringify(ExecutionSpec.parse(spec));

/**
 * What a stored spec turned out to be: a spec, nothing, or something unreadable.
 *
 * Three states rather than two, and the third is the point. The write seam validates, so the only
 * ways to reach `unreadable` are a hand-edited row, a restored backup, or a schema that has since
 * narrowed — rare, but the WRONG answer to it is expensive. Collapsing it into "no spec" would
 * tell a planner (RUN-140) that nobody had planned this task, and its response to that is to plan
 * it and write the result, destroying whatever the corrupt value was hiding.
 *
 * So a read never throws — the rest of the task stays readable through every surface, which is
 * what makes the row fixable at all — but it never claims absence it cannot vouch for either.
 */
export type StoredExecutionSpec =
  | { spec: ExecutionSpec | null; unreadable?: false }
  | { spec: null; unreadable: true };

/**
 * Read a spec back out of a row.
 *
 * An empty string counts as unreadable, not as absence: the writer stores JSON or SQL NULL and
 * never `''`, so an empty string is something else having written to the column.
 *
 * Also logged — a task whose spec cannot be read is either corruption or a contract change that
 * needs a migration, and both want a human.
 */
export const readExecutionSpec = (raw: unknown, taskId: string): StoredExecutionSpec => {
  if (raw == null) return { spec: null };
  try {
    const text = String(raw);
    if (text === '') throw new Error('empty column value');
    return { spec: ExecutionSpec.parse(JSON.parse(text)) };
  } catch (err) {
    console.warn(`task ${taskId}: stored execution spec is unreadable`, String(err));
    return { spec: null, unreadable: true };
  }
};
