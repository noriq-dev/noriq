import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    // tslib's CJS default-export shape confuses the workers pool; force the ESM build.
    resolve: { alias: { tslib: 'tslib/tslib.es6.js' } },
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
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
            bindings: { TEST_MIGRATIONS: migrations, ADMIN_TOKEN: 'test-admin-token', DISABLE_RATE_LIMIT: true },
            // Tests run without built web assets.
            assets: { directory: './test/fixtures/empty-assets' },
          },
        },
      },
    },
  };
});
