import type { Hono } from 'hono';
import type { AppContext } from '../auth';
import { isMaintenanceMode, MAINTENANCE_MESSAGE } from './maintenance';

const FREEZE_EXEMPT_PREFIXES = [
  '/mcp',
  '/oauth/',
  '/.well-known/',
  '/api/auth/',
  '/api/reset',
  '/api/setup',
  '/api/health',
  '/ws/',
  '/api/admin/import',
  '/api/admin/memory-restore',
];

/** Write-freeze middleware (PLNR-166) — registered before route handlers on the worker app. */
export function registerMaintenanceFreeze(app: Hono<AppContext>) {
  app.use('*', async (c, next) => {
    if (!isMaintenanceMode(c.env)) return next();
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const path = new URL(c.req.url).pathname;
    if (FREEZE_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p))) return next();
    return c.json({ error: MAINTENANCE_MESSAGE }, 503, { 'Retry-After': '30' });
  });
}
