import { useEffect, useState } from 'react';

export const PHONE_BREAKPOINT = 768;
export const DESKTOP_BREAKPOINT = 1024;
export const WIDE_DESKTOP_BREAKPOINT = 1280;

export const MIN_TOUCH_TARGET = 44;
export const MIN_INPUT_FONT_SIZE = 16;
export const TAB_ITEM_HEIGHT = 50;
export const LIST_ROW_HEIGHT = 54;

export type ViewportKind = 'phone' | 'tablet' | 'desktop';

export interface Viewport {
  kind: ViewportKind;
  phone: boolean;
  tablet: boolean;
  desktop: boolean;
  wide: boolean;
}

const desktopViewport: Viewport = { kind: 'desktop', phone: false, tablet: false, desktop: true, wide: true };

function readViewport(): Viewport {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return desktopViewport;
  if (window.matchMedia(`(max-width: ${PHONE_BREAKPOINT - 1}px)`).matches) {
    return { kind: 'phone', phone: true, tablet: false, desktop: false, wide: false };
  }
  if (window.matchMedia(`(max-width: ${DESKTOP_BREAKPOINT - 1}px)`).matches) {
    return { kind: 'tablet', phone: false, tablet: true, desktop: false, wide: false };
  }
  return { ...desktopViewport, wide: !window.matchMedia(`(max-width: ${WIDE_DESKTOP_BREAKPOINT - 1}px)`).matches };
}

/** The sole JS viewport branch for mobile compositions. CSS may still handle decoration, but
 * components use this hook whenever their rendered anatomy changes across breakpoints. */
export function useViewport(): Viewport {
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const phone = window.matchMedia(`(max-width: ${PHONE_BREAKPOINT - 1}px)`);
    const tablet = window.matchMedia(`(max-width: ${DESKTOP_BREAKPOINT - 1}px)`);
    const wide = window.matchMedia(`(max-width: ${WIDE_DESKTOP_BREAKPOINT - 1}px)`);
    const update = () => setViewport(readViewport());
    phone.addEventListener('change', update);
    tablet.addEventListener('change', update);
    wide.addEventListener('change', update);
    update();
    return () => {
      phone.removeEventListener('change', update);
      tablet.removeEventListener('change', update);
      wide.removeEventListener('change', update);
    };
  }, []);

  return viewport;
}
