/**
 * PLNR-560: static half of the deleteProject guard — ensures the batch module still lists
 * every table name the vitest guard expects. Full FK coverage is asserted in
 * test/delete-project-cascade-guard.test.ts against a migrated D1.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const batchPath = resolve(root, 'src/do/project-room/delete-project.ts');
const source = readFileSync(batchPath, 'utf8');

const sqlBlock = source.match(/export const DELETE_PROJECT_BATCH_SQL[^=]*=\s*\[([\s\S]*?)\];/);
if (!sqlBlock) {
  console.error('Could not parse DELETE_PROJECT_BATCH_SQL from delete-project.ts');
  process.exit(1);
}

const tables = new Set();
for (const line of sqlBlock[1].split('\n')) {
  const del = line.match(/'DELETE FROM ([a-z_][a-z0-9_]*) /i);
  if (del) tables.add(del[1]);
  const upd = line.match(/'UPDATE ([a-z_][a-z0-9_]*) /i);
  if (upd) tables.add(upd[1]);
}

const required = [
  'projects',
  'tasks',
  'orchestrations',
  'orchestration_rejections',
  'ask_actions',
  'project_grants',
  'memory_event_dedup',
];

const missing = required.filter((t) => !tables.has(t));
if (missing.length) {
  console.error(`deleteProject batch missing expected tables: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`deleteProject cascade static check passed (${tables.size} explicit table targets).`);
