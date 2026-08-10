import { describe, expect, it } from 'vitest';
import { drawerShellStyle } from './Drawer';

describe('mobile task drawer composition', () => {
  it('becomes a full-width bottom sheet while retaining the desktop side drawer', () => {
    const mobile = drawerShellStyle(true);
    expect(mobile).toMatchObject({
      left: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      borderRadius: '22px 22px 0 0',
      paddingBottom: 'env(safe-area-inset-bottom)',
    });
    expect(mobile.animation).toContain('pl-stream-up');

    const desktop = drawerShellStyle(false);
    expect(desktop).toMatchObject({ top: 0, right: 0, bottom: 0, width: 480 });
    expect(desktop.left).toBeUndefined();
    expect(desktop.animation).toContain('pl-drawer');
  });
});
