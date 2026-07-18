import { defineWorkersProject, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';
import path from 'node:path';
import fs from 'node:fs';

// The suite exercises real DOs + D1 in workerd, and the pool's per-test `isolatedStorage`
// can't snapshot SQLite-backed DOs — so within a project everything must run on ONE shared
// worker (singleWorker), which serializes ~55 files onto one core (~4.5 min, PLNR-198).
//
// The only parallelism knob left is to shard the files across independent pool PROJECTS:
// each shard gets its own in-memory D1/DO, so the shared agent-mint bootstrap can't race,
// and runs serially inside itself — identical conditions to a single-worker run, on a file
// subset. Shards run in parallel → ~10s on a multi-core box (27× faster). Round-robin over
// the sorted file list keeps assignment deterministic (no Date.now/random) and balanced.
// (`test.projects` inline in a vitest.config.ts does NOT work — the pool plugin only wires
// `cloudflare:test` when each project is a workspace entry, so this must be a workspace file.)
//
// load.test.ts is a ~28s stress test (a 12-agent claim stampede). It's kept out of the shards
// and given its own `load` project, selected by name — `npm test` runs `--project 'shard*'`
// (no load), `npm run test:load` runs `--project load`. (Selection is by project name, NOT an
// env flag: shell env does not reach vitest's config evaluation.)
//
// Targeting one file: `cd apps/api && npx vitest run test/oauth.test.ts` — a positional file
// runs in whichever shard owns it. (Once a workspace file exists it governs every run, so the
// old `vitest run --root apps/api test/oauth.test.ts` from the repo root no longer resolves
// the path — cd in, or use `-t <name>`.)
//
// 8 shards ≈ 7 files each; the full run lands ~10s on any multi-core box and scales down to
// ~4 cores fine (shards just queue). Tune only if the file count grows a lot.
const SHARDS = 8;

const testDir = path.join(__dirname, 'test');
const testFiles = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts') && f !== 'load.test.ts')
  .sort();
const shards: string[][] = Array.from({ length: SHARDS }, () => []);
testFiles.forEach((f, i) => shards[i % SHARDS]!.push(`test/${f}`));

// One pool project per shard. Everything but the file list is identical across shards.
const project = (name: string, include: string[]) =>
  defineWorkersProject(async () => {
    const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
    return {
      // tslib's CJS default-export shape confuses the workers pool; force the ESM build.
      resolve: { alias: { tslib: 'tslib/tslib.es6.js' } },
      test: {
        name,
        include,
        exclude: [...configDefaults.exclude],
        setupFiles: ['./test/apply-migrations.ts'],
        // The suite runs OAuth-flow mints through a single shared worker, so late tests
        // pay for all accumulated state — on GitHub runners the heaviest cases blow
        // through vitest's default 5s (PLNR-169). Only a real hang should time out.
        testTimeout: 30_000,
        // CJS deps (ajv via MCP SDK; tslib + ASN.1 libs via @simplewebauthn) break
        // the pool's ESM shim; pre-bundle them.
        deps: {
          optimizer: {
            ssr: {
              enabled: true,
              include: ['ajv', 'tslib', '@simplewebauthn/server', '@peculiar/asn1-schema', '@peculiar/asn1-ecc', '@peculiar/asn1-rsa', '@peculiar/asn1-x509', '@peculiar/asn1-android', '@hexagon/base64', 'cbor-x'],
            },
          },
        },
        poolOptions: {
          workers: {
            // Coordination tests are sequential scenarios sharing one D1/DO state;
            // per-test isolated storage also can't snapshot SQLite-backed DOs.
            isolatedStorage: false,
            singleWorker: true,
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              // R2 for attachment tests (the generic wrangler.jsonc doesn't bind FILES).
              r2Buckets: ['FILES'],
              bindings: { TEST_MIGRATIONS: migrations, ADMIN_TOKEN: 'test-admin-token', DISABLE_RATE_LIMIT: true, DEMO_MODE: '1' },
              // Tests run without built web assets.
              assets: { directory: './test/fixtures/empty-assets' },
            },
          },
        },
      },
    };
  });

export default [
  ...shards.filter((g) => g.length).map((include, k) => project(`shard-${k}`, include)),
  project('load', ['test/load.test.ts']),
];
