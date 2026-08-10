import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOBILE_TAB_BAR_HEIGHT } from './viewport';

const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const tabBar = readFileSync(resolve(process.cwd(), 'src/components/MobileTabBar.tsx'), 'utf8');

describe('mobile shell content inset', () => {
  it('ends the view frame above the fixed tab bar instead of padding behind it', () => {
    expect(MOBILE_TAB_BAR_HEIGHT).toBe('calc(50px + env(safe-area-inset-bottom))');
    expect(app).toContain('marginBottom: phone ? MOBILE_TAB_BAR_HEIGHT : 0');
    expect(app).not.toContain("paddingBottom: phone ? 'calc(50px + env(safe-area-inset-bottom))' : 0");
    expect(tabBar).toContain('minHeight: MOBILE_TAB_BAR_HEIGHT');
  });
});
