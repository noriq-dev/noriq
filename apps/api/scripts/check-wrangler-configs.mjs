import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPaths = [
  'wrangler.jsonc',
  'wrangler.production.jsonc.example',
  'wrangler.staging.jsonc.example',
  'wrangler.demo.jsonc.example',
];

const requiredBindings = new Map([
  ['PROJECT_ROOM', 'ProjectRoom'],
  ['AGENT_SESSION', 'AgentSession'],
  ['RATE_LIMITER', 'RateLimiter'],
  ['RUNNER_HUB', 'RunnerHub'],
  ['PROJECT_MEMORY', 'ProjectMemory'],
  ['ASK_GENERATION', 'AskGeneration'],
]);
const requiredMigrations = [
  ['v1', ['ProjectRoom', 'AgentSession']],
  ['v2', ['RateLimiter']],
  ['v3', ['RunnerHub']],
  ['v4', ['ProjectMemory']],
  ['v5', ['AskGeneration']],
];
const lifecycleVars = [
  'AGENT_LIFECYCLE_ONLINE_SECONDS',
  'AGENT_COPILOT_RETIRE_DAYS',
  'AGENT_HISTORY_ARCHIVE_DAYS',
  'AGENT_PRESENCE_PURGE_DAYS',
  'RUNNER_OFFLINE_ARCHIVE_DAYS',
  'AGENT_LIFECYCLE_SWEEP_BATCH',
  'AGENT_LIFECYCLE_SWEEP_APPLY',
];

async function readJsonc(relativePath) {
  const source = await readFile(path.join(apiRoot, relativePath), 'utf8');
  const parsed = ts.parseConfigFileTextToJson(relativePath, source);
  assert.equal(parsed.error, undefined, `${relativePath} must be valid JSONC`);
  return parsed.config;
}

const configs = await Promise.all(configPaths.map(async (relativePath) => [relativePath, await readJsonc(relativePath)]));
const canonical = configs[0][1];

for (const [relativePath, config] of configs) {
  assert.equal(config.main, canonical.main, `${relativePath}: Worker entry point drifted`);
  assert.equal(config.compatibility_date, canonical.compatibility_date, `${relativePath}: compatibility date drifted`);
  assert.deepEqual(config.compatibility_flags, canonical.compatibility_flags, `${relativePath}: compatibility flags drifted`);
  assert.deepEqual(config.assets?.run_worker_first, canonical.assets?.run_worker_first, `${relativePath}: Worker-first routes drifted`);

  const bindings = new Map((config.durable_objects?.bindings ?? []).map((binding) => [binding.name, binding.class_name]));
  for (const [binding, className] of requiredBindings) {
    assert.equal(bindings.get(binding), className, `${relativePath}: missing ${binding} Durable Object binding`);
  }

  assert.deepEqual(
    (config.migrations ?? []).map((migration) => [migration.tag, migration.new_sqlite_classes]),
    requiredMigrations,
    `${relativePath}: Durable Object migrations must remain append-only and complete`,
  );
  assert.equal(config.d1_databases?.[0]?.binding, 'DB', `${relativePath}: missing DB binding`);
  for (const variable of lifecycleVars) {
    assert.notEqual(config.vars?.[variable], undefined, `${relativePath}: missing lifecycle variable ${variable}`);
  }
}

const byPath = Object.fromEntries(configs);
const production = byPath['wrangler.production.jsonc.example'];
const staging = byPath['wrangler.staging.jsonc.example'];
const demo = byPath['wrangler.demo.jsonc.example'];

assert.ok(production.vars?.PUBLIC_ORIGIN, 'production: PUBLIC_ORIGIN must match its deployed origin');
for (const optionalBinding of ['ai', 'vectorize', 'r2_buckets', 'send_email']) {
  assert.equal(production[optionalBinding], undefined, `production: ${optionalBinding} must be opt-in for clean-account deploys`);
}

assert.ok(staging.vars?.PUBLIC_ORIGIN, 'staging: PUBLIC_ORIGIN must match its deployed origin');
assert.equal(staging.ai?.binding, 'AI', 'staging: missing Workers AI binding');
assert.deepEqual(
  (staging.vectorize ?? []).map((binding) => binding.binding).sort(),
  ['CODE_VECTORIZE', 'VECTORIZE'],
  'staging: full-capability example needs both search indexes',
);
assert.equal(staging.r2_buckets?.[0]?.binding, 'FILES', 'staging: missing FILES binding');

assert.equal(demo.vars?.DEMO_MODE, '1', 'demo: DEMO_MODE must stay enabled');
for (const costlyBinding of ['ai', 'vectorize', 'r2_buckets', 'send_email']) {
  assert.equal(demo[costlyBinding], undefined, `demo: ${costlyBinding} must remain omitted`);
}

console.log(`Validated ${configs.length} Wrangler configurations.`);
