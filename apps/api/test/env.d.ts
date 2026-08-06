import type { D1Migration } from '@cloudflare/workers-types/experimental';
import type { ProjectMemory } from '../src/do/ProjectMemory';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    PROJECT_MEMORY: DurableObjectNamespace<ProjectMemory>;
  }
}
