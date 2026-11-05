import { AsyncLocalStorage } from 'node:async_hooks';

type Metrics = {
  stagesMs: Record<string, number>;
  dbCalls: number;
  dbQueries: number;
  dbWaitMs: number;
  dbSqlMs: number;
  dbRowsRead: number;
  dbRowsWritten: number;
  dbResultsWithMeta: number;
};
const current = new AsyncLocalStorage<Metrics>();
const elapsed = (start: number) => Math.round((performance.now() - start) * 100) / 100;

/** One summary per tool invocation, including failures. Never log arguments, SQL or content.
 * Scope is the registered tool callback: HTTP auth/session setup and DO-internal D1 are excluded.
 * Stages can nest; DB wait is summed and may overlap. Neither should be added to total duration.
 */
export async function measureMcpTool<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  const metrics: Metrics = { stagesMs: {}, dbCalls: 0, dbQueries: 0, dbWaitMs: 0,
    dbSqlMs: 0, dbRowsRead: 0, dbRowsWritten: 0, dbResultsWithMeta: 0 };
  return current.run(metrics, async () => {
    const start = performance.now();
    let outcome = 'exception';
    try {
      const result = await fn();
      outcome = result && typeof result === 'object' && 'isError' in result && result.isError ? 'error' : 'ok';
      return result;
    } finally {
      console.info({ event: 'mcp.tool.performance', tool, outcome, durationMs: elapsed(start), ...metrics });
    }
  });
}

export async function measureMcpStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const metrics = current.getStore();
  if (!metrics) return fn();
  const start = performance.now();
  try { return await fn(); }
  finally { metrics.stagesMs[stage] = (metrics.stagesMs[stage] ?? 0) + elapsed(start); }
}

async function databaseCall<T>(queries: number, hasMeta: boolean, fn: () => Promise<T>): Promise<T> {
  const metrics = current.getStore();
  if (!metrics) return fn();
  metrics.dbCalls++;
  metrics.dbQueries += queries;
  const start = performance.now();
  try {
    const result = await fn();
    if (hasMeta) {
      for (const item of (Array.isArray(result) ? result : [result]) as D1Result[]) {
        if (!item?.meta) continue;
        metrics.dbResultsWithMeta++;
        metrics.dbSqlMs += item.meta.duration ?? 0;
        metrics.dbRowsRead += item.meta.rows_read ?? 0;
        metrics.dbRowsWritten += item.meta.rows_written ?? 0;
      }
    }
    return result;
  } finally { metrics.dbWaitMs += elapsed(start); }
}

/** Request-local binding wrapper. Preserve native receivers and unwrap statements for batch(). */
export function instrumentMcpDatabase(db: D1Database): D1Database {
  if (!db) return db; // Schema-only catalog construction has no real bindings.
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const statement = (raw: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(raw, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        if (key === 'all' || key === 'run' || key === 'first' || key === 'raw') {
          return (...args: unknown[]) => databaseCall(1, key === 'all' || key === 'run',
            () => Reflect.apply(target[key], target, args));
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, raw);
    return wrapped;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
      if (key === 'batch') return (statements: D1PreparedStatement[]) => databaseCall(statements.length, true,
        () => target.batch(statements.map(s => originals.get(s) ?? s)));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
