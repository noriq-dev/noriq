import { Hono } from 'hono';
import type { Env } from './env';

export { ProjectRoom } from './do/ProjectRoom';
export { AgentSession } from './do/AgentSession';

const app = new Hono<{ Bindings: Env }>();

// --- health -----------------------------------------------------------------
app.get('/api/health', async (c) => {
  // Verifies D1 connectivity end-to-end.
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1, service: 'planar', version: '0.1.0' });
});

// --- MCP (Phase 1) ------------------------------------------------------------
// Streamable HTTP MCP endpoint. Placeholder until the coordination tools land.
app.all('/mcp', (c) =>
  c.json(
    { error: 'MCP server not yet implemented — planar Phase 1 (see ROADMAP.md)' },
    501,
  ),
);

// --- live channel (Phase 1) ---------------------------------------------------
// WebSocket upgrade is forwarded to the project's ProjectRoom DO.
app.get('/ws/projects/:projectId', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('expected WebSocket upgrade', 426);
  }
  const projectId = c.req.param('projectId');
  const stub = c.env.PROJECT_ROOM.get(c.env.PROJECT_ROOM.idFromName(projectId));
  return stub.fetch(c.req.raw);
});

// --- REST (Phase 1/2) ----------------------------------------------------------
app.get('/api/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, key, name, description, status, created_at AS createdAt FROM projects ORDER BY created_at',
  ).all();
  return c.json({ projects: results });
});

export default app;
