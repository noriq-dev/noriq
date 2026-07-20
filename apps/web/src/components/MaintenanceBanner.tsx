import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Write-freeze banner (PLNR-166). While the server reports maintenance mode on /api/health,
 * show a persistent bar so humans know their changes will be refused (writes 503 until the
 * DB cutover completes). Self-contained: polls health itself, independent of the project
 * store, so it works on every view including before a project is loaded.
 */
export function MaintenanceBanner() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () => api.health().then((h) => { if (alive) setOn(!!h.maintenance); }).catch(() => {});
    check();
    const t = setInterval(check, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!on) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        background: '#8a5a00', color: '#fff', textAlign: 'center',
        fontSize: 12, fontWeight: 600, padding: '5px 12px',
        fontFamily: 'var(--mono)', letterSpacing: '.01em',
        boxShadow: '0 1px 6px rgba(0,0,0,.3)',
      }}
    >
      Maintenance in progress — the workspace is temporarily read-only. Changes are paused and will fail until this clears.
    </div>
  );
}
