// node --test hooks/integration.test.mjs
// Drives the real hook CLI (child process, stdin payload) against a MOCK Noriq /mcp server, so the
// full path — parse hook JSON → git → acquire_lock → allow/deny — is exercised without a live server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'noriq-lock.mjs');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..'); // this git repo (git rev-parse works)

let server;
let base;
const mcpResult = (obj) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } });

before(async () => {
  server = createServer((req, res) => {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const { params } = JSON.parse(buf);
      const { name, arguments: args } = params;
      let body;
      if (name === 'list_projects') body = { projects: [{ id: 'prj_mock', key: 'MOCK' }] };
      else if (name === 'acquire_lock') {
        // A held path denies; everything else grants.
        const conflictPath = (args.paths || []).find((p) => p.includes('locked'));
        body = conflictPath
          ? { ok: false, conflicts: [{ path: conflictPath, holderName: 'peer-agent', taskKey: 'MOCK-1', expiresAt: '2026-07-19T21:00:00Z' }] }
          : { ok: true, locks: (args.paths || []).map((p) => ({ id: 'lok_' + p, path: p, renewed: false })) };
      } else if (name === 'list_locks') body = { enabled: true, locks: [{ id: 'lok_1' }] };
      else if (name === 'release_lock') body = { released: ['lok_1'] };
      else body = { ok: true };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mcpResult(body)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function runHook(payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, NORIQ_URL: base, NORIQ_TOKEN: 't', NORIQ_PROJECT: 'prj_mock', ...extraEnv };
    const child = execFile('node', [HOOK], { env }, (err, _stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stderr });
    });
    child.stdin.end(JSON.stringify({ cwd: REPO, ...payload }));
  });
}

test('grants a free path → allow (exit 0)', async () => {
  const r = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/free.ts' } });
  assert.equal(r.code, 0);
});

test('a held path → DENY (exit 2) with holder info', async () => {
  const r = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/locked.ts' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /locked by peer-agent/);
  assert.match(r.stderr, /MOCK-1/);
});

test('a Bash rm of a locked file is denied too', async () => {
  const r = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm src/locked.ts' } });
  assert.equal(r.code, 2);
});

test('resolves a project KEY via list_projects → allow', async () => {
  const r = await runHook(
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/free.ts' } },
    { NORIQ_PROJECT: 'MOCK' },
  );
  assert.equal(r.code, 0);
});

test('Stop releases and allows (exit 0)', async () => {
  const r = await runHook({ hook_event_name: 'Stop' });
  assert.equal(r.code, 0);
});
