import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  plugins: [react()],
  // Build-time version stamp — compared against the server's /api/health + snapshot
  // version so a stale tab reloads itself after a deploy (PLNR-193).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    proxy: {
      // Local dev: `npm run dev` in apps/api serves the Worker on :8787
      '/api': 'http://localhost:8787',
      '/mcp': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
