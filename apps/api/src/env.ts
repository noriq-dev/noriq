export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PROJECT_ROOM: DurableObjectNamespace;
  AGENT_SESSION: DurableObjectNamespace;
}
