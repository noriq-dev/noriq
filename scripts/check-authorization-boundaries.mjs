import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceRoots = [join(root, 'apps/api/src'), join(root, 'apps/api/test')];
const allowed = new Set(['apps/api/src/lib/authorization-parity.ts']);
const legacyReachPatterns = [
  /\b(?:p|projects)\.group_id\s+IN\s*\(/i,
  /\bug\.group_id\s*=\s*(?:p|projects)\.group_id\b/i,
  /\bgroup_id\s+IN\s*\(\s*SELECT\s+group_id\s+FROM\s+user_groups/is,
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const violations = [];
for (const path of sourceRoots.flatMap(files)) {
  const file = relative(root, path);
  if (allowed.has(file)) continue;
  const source = readFileSync(path, 'utf8');
  for (const pattern of legacyReachPatterns) {
    if (pattern.test(source)) violations.push(`${file}: legacy projects.group_id reach SQL is forbidden`);
  }
}

if (violations.length) {
  console.error(violations.join('\n'));
  console.error('Project authorization must use lib/authorization.ts or USER_PROJECT_WHERE; only the parity auditor may compare legacy reach.');
  process.exit(1);
}
console.log('Authorization boundary check passed: no legacy group-reach SQL outside the parity auditor.');
