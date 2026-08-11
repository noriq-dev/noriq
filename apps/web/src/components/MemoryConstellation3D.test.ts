import { describe, expect, it } from 'vitest';
import {
  CONSTELLATION_DOUBLE_CLICK_MS, CONSTELLATION_DRAG_THRESHOLD_PX, constellation3DClickIntent,
  constellation3DHasDragged, constellation3DKeyboardZoomIntent,
} from './MemoryConstellation3D';

describe('MemoryConstellation3D click intent (PLNR-463)', () => {
  it('keeps a single node click selection-only and recognizes the same node inside the double-click window', () => {
    const first = constellation3DClickIntent(null, 'node-a', 1_000, 0);
    expect(first).toEqual({ next: { nodeId: 'node-a', at: 1_000 }, zoom: false });
    expect(constellation3DClickIntent(first.next, 'node-a', 1_000 + CONSTELLATION_DOUBLE_CLICK_MS, 0))
      .toEqual({ next: null, zoom: true });
  });

  it('does not zoom across different nodes or after the timing window', () => {
    const previous = { nodeId: 'node-a', at: 1_000 };
    expect(constellation3DClickIntent(previous, 'node-b', 1_100, 0).zoom).toBe(false);
    expect(constellation3DClickIntent(previous, 'node-a', 1_000 + CONSTELLATION_DOUBLE_CLICK_MS + 1, 0).zoom).toBe(false);
  });

  it('lets the existing three-pixel threshold pass clicks but makes a drag veto and reset the sequence', () => {
    const previous = { nodeId: 'node-a', at: 1_000 };
    expect(constellation3DClickIntent(previous, 'node-a', 1_100, CONSTELLATION_DRAG_THRESHOLD_PX).zoom).toBe(true);
    expect(constellation3DClickIntent(previous, 'node-a', 1_100, CONSTELLATION_DRAG_THRESHOLD_PX + 0.01))
      .toEqual({ next: null, zoom: false });
    expect(constellation3DHasDragged(false, CONSTELLATION_DRAG_THRESHOLD_PX)).toBe(false);
    expect(constellation3DHasDragged(false, CONSTELLATION_DRAG_THRESHOLD_PX + 0.01)).toBe(true);
    expect(constellation3DHasDragged(true, 0)).toBe(true);
  });

  it('clears a pending node click when the next click hits the background', () => {
    expect(constellation3DClickIntent({ nodeId: 'node-a', at: 1_000 }, null, 1_100, 0))
      .toEqual({ next: null, zoom: false });
  });

  it('reserves camera zoom for Enter on a pinned selection, never arrow-key selection', () => {
    expect(constellation3DKeyboardZoomIntent('Enter', 'node-a')).toBe(true);
    expect(constellation3DKeyboardZoomIntent('ArrowRight', 'node-a')).toBe(false);
    expect(constellation3DKeyboardZoomIntent('Enter', null)).toBe(false);
  });
});
