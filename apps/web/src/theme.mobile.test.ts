import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');

describe('responsive CSS ownership', () => {
  it('keeps touch and safe-area rules without the retired layout overrides', () => {
    expect(css).toContain('@media (pointer: coarse)');
    expect(css).toContain('font-size: 16px !important');
    expect(css).toContain("[role='button'] { min-height: 44px; }");
    expect(css).toContain('env(safe-area-inset-top)');
    for (const retired of ['.mc-grid', '.agents-grid', '.task-drawer {', '.modal-card {', '.bulk-bar {', '.board-col {']) {
      expect(css).not.toContain(retired);
    }
  });
});
