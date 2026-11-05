/** Coalesce concurrent freshness SELECTs into bounded D1 batches. No cached results survive
 * a flush: later stages still read current data. Only pending identical reads are shared.
 * Keeping the existing evaluator avoids a second implementation of readiness/override rules.
 */
export function batchedFreshnessReads(db: D1Database): D1Database {
  type Pending = {
    statement: D1PreparedStatement;
    resolve: (result: D1Result) => void;
    reject: (error: unknown) => void;
    result: Promise<D1Result>;
  };
  let pending = new Map<string, Pending>();
  let scheduled = false;
  const flush = async () => {
    const reads = [...pending.values()];
    pending = new Map();
    scheduled = false;
    // A freshness stage may have several reads per candidate. Bound each database batch.
    for (let i = 0; i < reads.length; i += 50) {
      const chunk = reads.slice(i, i + 50);
      try {
        const results = await db.batch(chunk.map(r => r.statement));
        chunk.forEach((read, n) => {
          const result = results[n];
          if (!result || !result.success) read.reject(new Error('Freshness read batch failed'));
          else read.resolve(result);
        });
      } catch (error) { chunk.forEach(read => read.reject(error)); }
    }
  };
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    // This adapter is deliberately read-only and used only by the freshness evaluator.
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Freshness batching only supports SELECT');
    const raw = db.prepare(sql).bind(...values);
    const read = () => {
      const key = JSON.stringify([sql, values]);
      const existing = pending.get(key);
      if (existing) return existing.result;
      let resolve!: Pending['resolve'];
      let reject!: Pending['reject'];
      const result = new Promise<D1Result>((yes, no) => { resolve = yes; reject = no; });
      pending.set(key, { statement: raw, resolve, reject, result });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => { void flush(); });
      }
      return result;
    };
    return new Proxy(raw, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => statement(sql, args);
        if (key === 'all') return read;
        if (key === 'first') return async (column?: string) => {
          const row = ((await read()).results[0] ?? null) as Record<string, unknown> | null;
          if (column === undefined || row === null) return row;
          if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found`);
          return row[column];
        };
        if (key === 'run' || key === 'raw') return () => { throw new Error('Freshness batching supports all() and first() only'); };
        return Reflect.get(target, key, target);
      },
    });
  };
  return new Proxy(db, {
    get(_target, key) {
      if (key === 'prepare') return statement;
      throw new Error('Freshness batching supports prepare() only');
    },
  });
}
