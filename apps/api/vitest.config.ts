import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // ajv (CJS, via @modelcontextprotocol/sdk) breaks the pool's ESM shim; pre-bundle it.
      deps: { optimizer: { ssr: { enabled: true, include: ['ajv'] } } },
      poolOptions: {
        workers: {
          // Coordination tests are sequential scenarios sharing one D1/DO state;
          // per-test isolated storage also can't snapshot SQLite-backed DOs.
          isolatedStorage: false,
          singleWorker: true,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations, ADMIN_TOKEN: 'test-admin-token' },
            // Tests run without built web assets.
            assets: { directory: './test/fixtures/empty-assets' },
          },
        },
      },
    },
  };
});
