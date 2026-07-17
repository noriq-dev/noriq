import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component rendering tests run in jsdom so DOMPurify (and any DOM APIs) resolve a real
// window. The API workspace has its own workerd-pool config — these are independent.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
