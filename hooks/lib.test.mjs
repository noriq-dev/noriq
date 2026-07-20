// node --test hooks/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPaths, parseBashTargets, toRepoRelative, denyReason } from './lib.mjs';

test('extractPaths pulls the write set from file tools', () => {
  assert.deepEqual(extractPaths('Write', { file_path: '/r/src/a.ts' }), ['/r/src/a.ts']);
  assert.deepEqual(extractPaths('Edit', { file_path: 'src/b.ts' }), ['src/b.ts']);
  assert.deepEqual(extractPaths('MultiEdit', { file_path: 'src/c.ts', edits: [] }), ['src/c.ts']);
  assert.deepEqual(extractPaths('NotebookEdit', { notebook_path: 'nb.ipynb' }), ['nb.ipynb']);
  assert.deepEqual(extractPaths('Read', { file_path: 'src/a.ts' }), []); // reads don't lock
});

test('parseBashTargets handles the common mutating commands', () => {
  assert.deepEqual(parseBashTargets('rm -f src/a.ts src/b.ts').sort(), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(parseBashTargets('mv src/a.ts src/b.ts').sort(), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(parseBashTargets('git mv old.ts new.ts').sort(), ['new.ts', 'old.ts']);
  assert.deepEqual(parseBashTargets('git rm doomed.ts'), ['doomed.ts']);
  assert.deepEqual(parseBashTargets('echo hi > out.txt'), ['out.txt']);
  assert.deepEqual(parseBashTargets('cat x && npm test'), []); // no writes
});

test('parseBashTargets fails OPEN on dynamic constructs', () => {
  assert.deepEqual(parseBashTargets('rm $FILE'), []);
  assert.deepEqual(parseBashTargets('rm $(ls)'), []);
  assert.deepEqual(parseBashTargets('rm src/*.ts'), []); // glob → don't guess
  assert.deepEqual(parseBashTargets('rm `echo x`'), []);
});

test('git checkout only locks the pathspec after --', () => {
  assert.deepEqual(parseBashTargets('git checkout main'), []); // branch switch, not a write
  assert.deepEqual(parseBashTargets('git checkout -- src/a.ts'), ['src/a.ts']);
});

test('toRepoRelative normalizes and rejects escapes', () => {
  assert.equal(toRepoRelative('/repo/src/a.ts', '/repo', '/repo'), 'src/a.ts');
  assert.equal(toRepoRelative('src/a.ts', '/repo', '/repo/apps'), 'apps/src/a.ts');
  assert.equal(toRepoRelative('/etc/passwd', '/repo', '/repo'), null); // outside the repo
  assert.equal(toRepoRelative('../other/x', '/repo', '/repo'), null);
});

test('denyReason renders holder + task + expiry', () => {
  const r = denyReason([{ path: 'src/a.ts', holderName: 'claude-2', taskKey: 'PLNR-9', expiresAt: '2026-07-19T20:00:00Z' }]);
  assert.match(r, /src\/a\.ts/);
  assert.match(r, /claude-2/);
  assert.match(r, /PLNR-9/);
});
