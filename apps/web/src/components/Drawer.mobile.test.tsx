import { describe, expect, it } from 'vitest';
import { drawerShellStyle } from './Drawer';
import { MOBILE_TAB_BAR_HEIGHT } from '../viewport';

describe('mobile task drawer composition', () => {
  it('becomes a full-width bottom sheet while retaining the desktop side drawer', () => {
    const mobile = drawerShellStyle(true);
    expect(mobile).toMatchObject({
      left: 0,
      right: 0,
      bottom: MOBILE_TAB_BAR_HEIGHT,
      width: '100%',
      borderRadius: '22px 22px 0 0',
    });
    expect(mobile.paddingBottom).toBeUndefined();
    expect(mobile.animation).toContain('pl-stream-up');

    const desktop = drawerShellStyle(false);
    expect(desktop).toMatchObject({ top: 0, right: 0, bottom: 0, width: 480 });
    expect(desktop.left).toBeUndefined();
    expect(desktop.animation).toContain('pl-drawer');
  });
});
