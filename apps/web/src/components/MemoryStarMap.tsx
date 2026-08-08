// PLNR-285: the memory star map — §5's "searchable constellation", the secondary, bounded
// whole-project visualization. Complements MemoryGraph.tsx's ego-network (which stays the primary,
// seeded exploration surface); this view answers "what does the whole shape of this project's
// memory look like", never replaces the seeded neighborhood view.
//
// Rendering split (locked decision): the star FIELD — every star and every constellation line, up
// to the endpoint's 300-node/600-edge ceiling — draws to a single <canvas> 2D context in one pass
// per frame. A DOM/SVG overlay carries ONLY labels (a bounded, budgeted subset — see
// starmap-layout.ts's `selectLabels`), the selection focus ring, the hover tooltip, and the
// accessible node list. Nothing here computes layout, encoding, or hit-testing itself — all of
// that lives in the DOM/canvas-free `starmap-layout.ts`, imported and called as pure functions;
// this file's only job is turning that module's output into pixels and event handlers.
//
// Visual language (discretionary, decided here): shape (square/diamond/triangle/hex/circle)
// encodes node TYPE family, fill (solid/hollow) encodes lead vs settled, a halo treatment
// (dashed/broken ring) encodes validity (stale/invalid), radius encodes degree (connectedness),
// and brightness (alpha) encodes authority — each a NON-colour channel by construction, so the
// map reads correctly with colour vision removed entirely (locked decision, PLNR-271's rule).
// Colour is layered on top only as a redundant, familiar cue: the same per-type colour family
// MemoryGraph.tsx's NODE_TYPE_META already uses, so a human reading both views sees one
// consistent vocabulary. Layout is a fixed, seeded-from-uri radial-by-type arrangement with a
// bounded relaxation pass (starmap-layout.ts) — never a live force simulation — so a "twinkle"
// ambient animation here is purely a time-based brightness modulation, never a position change,
// and is fully disabled under `prefers-reduced-motion: reduce`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type ApiConstellation } from '../api';
import {
  applyPins, DEFAULT_CAMERA, DEFAULT_STAR_MAP_PREFS, decodeStarMapPrefs, encodeStarMapPrefs, fitCamera, hitTest,
  screenToWorld, selectLabels, starShapeFor, worldToScreen, clampZoom, type Camera, type ComputedStarMap,
  type LayoutStar, type StarMapPrefs, type Viewport, computeStarMap,
} from './starmap-layout';
import { Button } from './ui';
import { SectionLabel, MonoTag } from './bits';
import { useTheme } from '../theme';

const prefsKey = (pid: string) => `noriq.starmap.${pid}`;

function loadPrefs(pid: string): StarMapPrefs {
  try { return decodeStarMapPrefs(localStorage.getItem(prefsKey(pid))); } catch { return DEFAULT_STAR_MAP_PREFS; }
}
function savePrefs(pid: string, prefs: StarMapPrefs) {
  try { localStorage.setItem(prefsKey(pid), encodeStarMapPrefs(prefs)); } catch { /* private mode / quota — a nicety, never load-bearing */ }
}

// Same per-type colour family MemoryGraph.tsx's NODE_TYPE_META already uses (a CSS var NAME, not
// a resolved value — canvas needs an actual colour string, resolved at draw time via
// getComputedStyle, since canvas fillStyle cannot read `var(...)` itself).
const TYPE_COLOR_VAR: Record<string, string> = {
  project: '--text-mid', repository: '--text-mid', branch: '--text-mid', revision: '--text-mid',
  file: '--blue', symbol: '--blue', api: '--blue', database_entity: '--blue',
  test: '--green',
  task: '--purple', plan: '--purple', run: '--purple', agent: '--purple',
  decision: '--amber', memory: '--amber', requirement: '--amber', procedure: '--amber', episode: '--amber',
  error: '--red-soft', artifact: '--text-mid', unknown: '--text-dim',
};
const colorVarFor = (type: string) => TYPE_COLOR_VAR[type] ?? '--text-mid';

const LABEL_BUDGET = 44;

interface Palette {
  bg: string; bgRail: string; text: string; textSoft: string; textDim: string; textFaint: string; line: string;
  amber: string; redSoft: string;
  typeColor: Record<string, string>;
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim() || '#8a8f98';
  const typeColor: Record<string, string> = {};
  for (const type of Object.keys(TYPE_COLOR_VAR)) typeColor[type] = v(TYPE_COLOR_VAR[type]!);
  return {
    bg: v('--bg'), bgRail: v('--bg-rail'), text: v('--text'), textSoft: v('--text-soft'),
    textDim: v('--text-dim'), textFaint: v('--text-faint'), line: v('--line'),
    amber: v('--amber'), redSoft: v('--red-soft'),
    typeColor,
  };
}

const HISTORICAL_EDGE_TYPES: ReadonlySet<string> = new Set(['supersedes', 'contradicts', 'failed_because']);

function hexToRgba(hex: string, alpha: number): string {
  // Palette colours are either #rrggbb or already rgba(...)/rgb(...) — pass those through.
  if (hex.startsWith('rgb')) return hex;
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------------------------
// Canvas star/edge drawing — a pure function of (ctx, layout, camera, ...) so it is easy to reason
// about even though it lives outside starmap-layout.ts (it touches CanvasRenderingContext2D,
// which the locked decision keeps out of the pure module).
// ---------------------------------------------------------------------------------------------

function drawShape(ctx: CanvasRenderingContext2D, shape: LayoutStar['visual']['shape'], r: number) {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  } else if (shape === 'square') {
    ctx.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
  } else if (shape === 'diamond') {
    ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
  } else if (shape === 'triangle') {
    const h = r * 1.15;
    ctx.moveTo(0, -h); ctx.lineTo(h * 0.95, h * 0.7); ctx.lineTo(-h * 0.95, h * 0.7); ctx.closePath();
  } else if (shape === 'hex') {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

interface DrawState {
  layout: ComputedStarMap | null;
  camera: Camera;
  viewport: Viewport;
  hiddenGroups: ReadonlySet<string>;
  showEdges: boolean;
  hoveredId: string | null;
  selectedId: string | null;
  dragOverride: { nodeId: string; x: number; y: number } | null;
  palette: Palette;
  reducedMotion: boolean;
  startTime: number;
}

function draw(canvas: HTMLCanvasElement, s: DrawState, now: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // jsdom (tests) and any environment without canvas 2D — never a crash
  const dpr = window.devicePixelRatio || 1;
  const w = s.viewport.width, h = s.viewport.height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Night-sky backdrop — subtle, theme-aware (reads its two colours straight from the resolved
  // palette, so it is never a hardcoded dark gradient that breaks in the light theme).
  const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  grad.addColorStop(0, s.palette.bg);
  grad.addColorStop(1, s.palette.bgRail);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (!s.layout) return;

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(s.camera.zoom, s.camera.zoom);
  ctx.translate(-s.camera.x, -s.camera.y);

  const posOf = (star: LayoutStar): { x: number; y: number } =>
    s.dragOverride && s.dragOverride.nodeId === star.nodeId ? { x: s.dragOverride.x, y: s.dragOverride.y } : star;

  if (s.showEdges) {
    ctx.lineWidth = 1 / s.camera.zoom;
    for (const e of s.layout.edges) {
      const a = s.layout.byNodeId.get(e.fromNodeId);
      const b = s.layout.byNodeId.get(e.toNodeId);
      if (!a || !b) continue;
      if (s.hiddenGroups.has(a.groupKey) || s.hiddenGroups.has(b.groupKey)) continue;
      const pa = posOf(a), pb = posOf(b);
      const historical = HISTORICAL_EDGE_TYPES.has(e.type);
      ctx.setLineDash(historical ? [3 / s.camera.zoom, 3 / s.camera.zoom] : []);
      ctx.strokeStyle = historical ? hexToRgba(s.palette.amber, 0.4) : hexToRgba(s.palette.textDim, 0.35);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  for (const star of s.layout.stars) {
    if (s.hiddenGroups.has(star.groupKey)) continue;
    const p = posOf(star);
    const isHovered = s.hoveredId === star.nodeId;
    const isSelected = s.selectedId === star.nodeId;
    const color = s.palette.typeColor[star.type] ?? s.palette.textDim;

    // Ambient twinkle: a per-star phase (seeded from its own uri hash, computed once in
    // starmap-layout — reused here via a cheap re-hash-free trick: derive phase from nodeId's
    // char codes) modulates brightness only — never position. Disabled entirely under
    // prefers-reduced-motion (locked decision).
    let brightness = star.visual.brightness;
    if (!s.reducedMotion) {
      let phase = 0;
      for (let i = 0; i < star.nodeId.length; i++) phase += star.nodeId.charCodeAt(i);
      const t = (now - s.startTime) / 1000;
      brightness = Math.max(0.25, Math.min(1, brightness + Math.sin(t * 0.6 + phase) * 0.08));
    }

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = brightness;

    if (star.visual.halo !== 'none') {
      ctx.save();
      ctx.setLineDash(star.visual.halo === 'dashed' ? [4 / s.camera.zoom, 3 / s.camera.zoom] : [1.5 / s.camera.zoom, 4.5 / s.camera.zoom]);
      ctx.strokeStyle = hexToRgba(star.visual.halo === 'broken' ? s.palette.redSoft : s.palette.amber, 0.75);
      ctx.lineWidth = 1.3 / s.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, star.visual.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawShape(ctx, star.visual.shape, star.visual.radius);
    if (star.visual.fill === 'solid') {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      // Hollow = lead (locked: never colour-only — the ABSENCE of fill is the signal).
      ctx.lineWidth = 1.8 / s.camera.zoom;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    if (isSelected || isHovered) {
      ctx.lineWidth = (isSelected ? 2.2 : 1.4) / s.camera.zoom;
      ctx.strokeStyle = s.palette.text;
      ctx.globalAlpha = 1;
      drawShape(ctx, star.visual.shape, star.visual.radius + 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// DOM overlay bits — labels (budgeted), tooltip, focus ring. All positioned via worldToScreen
// each render, which is cheap: the label set is capped at LABEL_BUDGET, not one-per-star.
// ---------------------------------------------------------------------------------------------

function StarLabel({ star, camera, viewport, dim }: { star: LayoutStar; camera: Camera; viewport: Viewport; dim: boolean }) {
  const p = worldToScreen(star, camera, viewport);
  return (
    <div
      style={{
        position: 'absolute', left: p.x, top: p.y + star.visual.radius * camera.zoom + 4,
        transform: 'translateX(-50%)', pointerEvents: 'none', whiteSpace: 'nowrap',
        fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-dim)',
        opacity: dim ? 0.35 : 0.9, textShadow: '0 1px 3px var(--bg)',
      }}
    >
      {star.label.length > 26 ? `${star.label.slice(0, 25)}…` : star.label}
    </div>
  );
}

function FocusRing({ star, camera, viewport }: { star: LayoutStar; camera: Camera; viewport: Viewport }) {
  const p = worldToScreen(star, camera, viewport);
  const r = (star.visual.radius + 6) * camera.zoom;
  return (
    <div
      style={{
        position: 'absolute', left: p.x - r, top: p.y - r, width: r * 2, height: r * 2,
        borderRadius: '50%', border: '2px solid var(--accent)', pointerEvents: 'none',
        boxShadow: '0 0 0 1px rgba(0,0,0,.25)',
      }}
    />
  );
}

function AuthorityTag({ authority }: { authority: number | null }) {
  if (authority == null) return null;
  return <MonoTag color="var(--blue)" bg="rgba(76,157,255,.12)" size={9.5}>authority {authority}/5</MonoTag>;
}
function ValidityTag({ validity }: { validity: string | null }) {
  if (!validity) return null;
  const meta: Record<string, { icon: string; color: string; bg: string }> = {
    active: { icon: '●', color: 'var(--green)', bg: 'rgba(63,217,139,.12)' },
    stale: { icon: '◐', color: 'var(--amber)', bg: 'rgba(245,166,35,.12)' },
    invalid: { icon: '✕', color: 'var(--red-soft)', bg: 'rgba(255,92,92,.12)' },
  };
  const m = meta[validity] ?? { icon: '?', color: 'var(--text-mid)', bg: 'var(--w-05)' };
  return <MonoTag color={m.color} bg={m.bg} size={9.5}>{m.icon} {validity}</MonoTag>;
}
function LeadTag({ isLead }: { isLead: boolean | null }) {
  if (isLead == null) return null;
  return isLead
    ? <MonoTag color="var(--amber)" bg="rgba(245,166,35,.14)" size={9.5}>◐ LEAD</MonoTag>
    : <MonoTag color="var(--green)" bg="rgba(63,217,139,.12)" size={9.5}>● SETTLED</MonoTag>;
}

function Tooltip({ star, camera, viewport }: { star: LayoutStar; camera: Camera; viewport: Viewport }) {
  const p = worldToScreen(star, camera, viewport);
  return (
    <div
      style={{
        position: 'absolute', left: p.x + 14, top: p.y - 10, zIndex: 6, pointerEvents: 'none',
        maxWidth: 260, padding: '7px 10px', borderRadius: 9, background: 'var(--card)',
        border: '1px solid var(--w-14)', boxShadow: '0 8px 24px rgba(0,0,0,.35)',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{star.label}</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: star.leadReasons?.length ? 4 : 0 }}>
        <MonoTag color="var(--text-mid)" bg="var(--w-06)" size={9}>{star.kind ?? star.type}</MonoTag>
        <LeadTag isLead={star.isLead} />
        <AuthorityTag authority={star.authority} />
        <ValidityTag validity={star.validity} />
      </div>
      {star.leadReasons && star.leadReasons.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{star.leadReasons.join(', ')}</div>
      )}
    </div>
  );
}

function DetailPanel({
  star, onClose, onOpenEgoNetwork, onOpenInspector,
}: {
  star: LayoutStar; onClose: () => void; onOpenEgoNetwork?: (uri: string) => void; onOpenInspector?: (uri: string) => void;
}) {
  return (
    <div
      style={{
        position: 'absolute', right: 12, top: 12, bottom: 12, width: 300, overflowY: 'auto',
        padding: '14px 16px', borderRadius: 12, background: 'var(--card)', border: '1px solid var(--w-14)',
        boxShadow: '0 12px 34px rgba(0,0,0,.4)', zIndex: 7,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{star.label}</div>
        <button onClick={onClose} className="drawer-x" style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 16, width: 24, height: 24, borderRadius: 6 }}>✕</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={9}>{star.kind ?? star.type}</MonoTag>
        <LeadTag isLead={star.isLead} />
        <AuthorityTag authority={star.authority} />
        <ValidityTag validity={star.validity} />
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text-faint)', wordBreak: 'break-all', marginBottom: 10 }}>{star.uri}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)', marginBottom: 12 }}>degree {star.degree}</div>
      {star.leadReasons && star.leadReasons.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-soft)', marginBottom: 12 }}>{star.leadReasons.join(' · ')}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {onOpenEgoNetwork && <Button variant="ghost" onClick={() => onOpenEgoNetwork(star.uri)}>Open in ego-network →</Button>}
        {onOpenInspector && star.type === 'memory' && <Button variant="ghost" onClick={() => onOpenInspector(star.uri)}>Open evidence inspector →</Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The four honest states (locked decision) + loading.
// ---------------------------------------------------------------------------------------------

function CenteredNote({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ maxWidth: 420, textAlign: 'center', padding: '18px 22px', borderRadius: 12, background: 'var(--w-03)', border: '1px solid var(--w-1)' }}>
        <div style={{ fontSize: 20, marginBottom: 8 }}>{icon}</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>{title}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>{body}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------------------------

export function MemoryStarMap({
  pid, onOpenEgoNetwork, onOpenInspector,
}: {
  pid: string;
  onOpenEgoNetwork?: (uri: string) => void;
  onOpenInspector?: (uri: string) => void;
}) {
  const [theme] = useTheme();
  const [prefs, setPrefs] = useState<StarMapPrefs>(() => loadPrefs(pid));
  useEffect(() => setPrefs(loadPrefs(pid)), [pid]);
  useEffect(() => savePrefs(pid, prefs), [pid, prefs]);
  const patchPrefs = useCallback((patch: Partial<StarMapPrefs>) => setPrefs((p) => ({ ...p, ...patch })), []);

  const [data, setData] = useState<ApiConstellation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.memoryConstellation(pid, controller.signal)
      .then((r) => { setData(r); setLoading(false); })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : 'the memory store did not answer');
        setLoading(false);
      });
    return () => controller.abort();
  }, [pid]);

  const rawLayout = useMemo(() => (data ? computeStarMap(data.nodes, data.edges) : null), [data]);
  const layout = useMemo(() => (rawLayout ? applyPins(rawLayout, prefs.pins) : null), [rawLayout, prefs.pins]);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 800, height: 500 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth || 800, height: el.clientHeight || 500 });
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const [camera, setCamera] = useState<Camera>(() => prefs.camera ?? DEFAULT_CAMERA);
  const autoFitDone = useRef(false);
  useEffect(() => {
    if (autoFitDone.current || prefs.camera || !layout || layout.stars.length === 0) return;
    autoFitDone.current = true;
    setCamera(fitCamera(layout.bounds, viewport));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, viewport]);
  useEffect(() => { autoFitDone.current = false; }, [pid]);

  const persistCamera = useCallback((c: Camera) => patchPrefs({ camera: c }), [patchPrefs]);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAccessibleList, setShowAccessibleList] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // --- Drag state: either panning the camera or dragging a single pinned star. ---------------
  const dragRef = useRef<{ mode: 'camera' | 'star'; startScreen: { x: number; y: number }; startCamera: Camera; star?: LayoutStar; offset?: { x: number; y: number }; moved: boolean } | null>(null);
  const [dragOverride, setDragOverride] = useState<{ nodeId: string; x: number; y: number } | null>(null);

  const paletteRef = useRef<Palette>(readPalette());
  useEffect(() => { paletteRef.current = readPalette(); }, [theme]);

  const hiddenGroups = useMemo(() => new Set(prefs.hiddenGroups), [prefs.hiddenGroups]);

  // --- Draw loop: on-demand for every meaningful state change, plus a continuous rAF loop ONLY
  // when ambient motion is allowed (locked decision: prefers-reduced-motion disables it). --------
  const startTimeRef = useRef(performance.now());
  const stateRef = useRef<DrawState | null>(null);
  useEffect(() => {
    stateRef.current = {
      layout, camera, viewport, hiddenGroups, showEdges: prefs.showEdges, hoveredId, selectedId,
      dragOverride, palette: paletteRef.current, reducedMotion, startTime: startTimeRef.current,
    };
    if (canvasRef.current) draw(canvasRef.current, stateRef.current, performance.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, camera, viewport, hiddenGroups, prefs.showEdges, hoveredId, selectedId, dragOverride, theme, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) return; // no ambient loop at all — a static draw already happened above
    let raf = 0;
    const loop = (t: number) => {
      if (canvasRef.current && stateRef.current) draw(canvasRef.current, stateRef.current, t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  // --- Pointer handling --------------------------------------------------------------------
  const canvasPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!layout) return;
    const pt = canvasPoint(e);
    const hit = hitTest(layout.stars, camera, viewport, pt);
    if (hit && !hiddenGroups.has(hit.groupKey)) {
      const world = screenToWorld(pt, camera, viewport);
      dragRef.current = { mode: 'star', startScreen: pt, startCamera: camera, star: hit, offset: { x: world.x - hit.x, y: world.y - hit.y }, moved: false };
    } else {
      dragRef.current = { mode: 'camera', startScreen: pt, startCamera: camera, moved: false };
    }
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const pt = canvasPoint(e);
    const drag = dragRef.current;
    if (!drag) {
      if (!layout) return;
      const hit = hitTest(layout.stars, camera, viewport, pt);
      setHoveredId(hit && !hiddenGroups.has(hit.groupKey) ? hit.nodeId : null);
      return;
    }
    const dx = pt.x - drag.startScreen.x, dy = pt.y - drag.startScreen.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    if (drag.mode === 'camera') {
      setCamera({ ...drag.startCamera, x: drag.startCamera.x - dx / drag.startCamera.zoom, y: drag.startCamera.y - dy / drag.startCamera.zoom });
    } else if (drag.star && drag.offset) {
      const world = screenToWorld(pt, camera, viewport);
      setDragOverride({ nodeId: drag.star.nodeId, x: world.x - drag.offset.x, y: world.y - drag.offset.y });
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === 'camera') {
      if (drag.moved) persistCamera(camera);
      else setSelectedId(null); // a plain click on empty space deselects
    } else if (drag.star) {
      if (drag.moved && dragOverride) {
        patchPrefs({ pins: { ...prefs.pins, [drag.star.uri]: { x: dragOverride.x, y: dragOverride.y } } });
      } else {
        setSelectedId(drag.star.nodeId); // a plain click on a star selects it
      }
      setDragOverride(null);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const pt = canvasPoint(e as unknown as React.PointerEvent);
    const before = screenToWorld(pt, camera, viewport);
    const nextZoom = clampZoom(camera.zoom * (e.deltaY < 0 ? 1.12 : 0.89));
    const trial = { ...camera, zoom: nextZoom };
    const after = screenToWorld(pt, trial, viewport);
    const next = { zoom: nextZoom, x: trial.x + (before.x - after.x), y: trial.y + (before.y - after.y) };
    setCamera(next);
    persistCamera(next);
  };

  const zoomBy = (factor: number) => {
    const next = { ...camera, zoom: clampZoom(camera.zoom * factor) };
    setCamera(next);
    persistCamera(next);
  };
  const resetView = () => {
    if (!layout) return;
    const next = fitCamera(layout.bounds, viewport);
    setCamera(next);
    persistCamera(next);
    patchPrefs({ pins: {} });
  };

  const selectedStar = selectedId ? layout?.byNodeId.get(selectedId) ?? null : null;
  const hoveredStar = hoveredId && hoveredId !== selectedId ? layout?.byNodeId.get(hoveredId) ?? null : null;
  const labelIds = useMemo(() => (layout ? selectLabels(layout.stars, camera, viewport, LABEL_BUDGET) : new Set<string>()),
    [layout, camera, viewport]);

  const groupKeys = useMemo(() => {
    if (!layout) return [];
    const keys = new Set(layout.stars.map((s) => s.groupKey));
    return [...keys].sort();
  }, [layout]);
  const toggleGroup = (g: string) => {
    const has = hiddenGroups.has(g);
    patchPrefs({ hiddenGroups: has ? prefs.hiddenGroups.filter((x) => x !== g) : [...prefs.hiddenGroups, g] });
  };

  const reasons = data?.coverage.reasons ?? [];
  const isEmpty = reasons.includes('graph-empty');
  const isUnindexed = reasons.includes('code-graph-empty') && !isEmpty;
  const isTruncated = reasons.includes('row-limit-reached') && (data?.omitted.nodes ?? 0) + (data?.omitted.edges ?? 0) > 0;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 'none', padding: '8px 16px', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
        <SectionLabel>Constellation</SectionLabel>
        {data && <MonoTag color="var(--text-dim)" bg="var(--w-04)" size={9}>{layout?.stars.length ?? 0} stars · {layout?.edges.length ?? 0} lines</MonoTag>}
        <div style={{ flex: 1 }} />
        {groupKeys.length > 0 && <GroupFilter groupKeys={groupKeys} hidden={hiddenGroups} onToggle={toggleGroup} />}
        <Button variant="ghost" onClick={() => patchPrefs({ showEdges: !prefs.showEdges })}>{prefs.showEdges ? 'hide lines' : 'show lines'}</Button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Button variant="ghost" onClick={() => zoomBy(1 / 1.3)} style={{ padding: '4px 9px' }}>−</Button>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', width: 34, textAlign: 'center' }}>{Math.round(camera.zoom * 100)}%</span>
          <Button variant="ghost" onClick={() => zoomBy(1.3)} style={{ padding: '4px 9px' }}>+</Button>
        </div>
        <Button variant="ghost" onClick={resetView}>reset view</Button>
        <Button variant="ghost" onClick={() => setShowAccessibleList((v) => !v)} aria-expanded={showAccessibleList}>
          {showAccessibleList ? 'hide list' : 'accessible list'}
        </Button>
      </div>

      <div ref={containerRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {loading && <CenteredNote icon="✦" title="Charting the constellation…" body="Fetching the bounded project map." />}
        {!loading && error && (
          <CenteredNote icon="⚠" title="Project memory is unreachable" body={`The memory store did not answer. This is NOT "no memories exist" — retry once the store is back.${error ? ` (${error})` : ''}`} />
        )}
        {!loading && !error && isEmpty && (
          <CenteredNote icon="✦" title="Nothing has been recorded yet" body="This project's memory graph is empty — no memories, tasks, plans, or repository entities have been projected into it yet." />
        )}
        {!loading && !error && !isEmpty && (
          <>
            <canvas
              ref={canvasRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: hoveredId ? 'pointer' : 'grab', touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => { if (!dragRef.current) setHoveredId(null); }}
              onWheel={onWheel}
              role="img"
              aria-label={`Memory star map: ${layout?.stars.length ?? 0} entities, ${layout?.edges.length ?? 0} relationships. Use the accessible list toggle to browse by keyboard.`}
            />
            {layout && [...labelIds].map((id) => {
              const star = layout.byNodeId.get(id);
              if (!star) return null;
              return <StarLabel key={id} star={star} camera={camera} viewport={viewport} dim={!!selectedId && selectedId !== id} />;
            })}
            {selectedStar && <FocusRing star={selectedStar} camera={camera} viewport={viewport} />}
            {hoveredStar && <Tooltip star={hoveredStar} camera={camera} viewport={viewport} />}
            {selectedStar && (
              <DetailPanel star={selectedStar} onClose={() => setSelectedId(null)} onOpenEgoNetwork={onOpenEgoNetwork} onOpenInspector={onOpenInspector} />
            )}
            {(isUnindexed || isTruncated) && (
              <div style={{ position: 'absolute', left: 12, bottom: 12, maxWidth: 380, padding: '9px 12px', borderRadius: 10, background: 'rgba(245,166,35,.08)', border: '1px solid rgba(245,166,35,.3)' }}>
                {isUnindexed && (
                  <div style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.5 }}>
                    No repository index yet — this map shows coordination and memory entities only. That is not the same claim as "nothing is related".
                  </div>
                )}
                {isTruncated && (
                  <div style={{ fontSize: 11, color: 'var(--text-soft)', lineHeight: 1.5, marginTop: isUnindexed ? 6 : 0 }}>
                    Truncated sample — {data!.omitted.nodes} node{data!.omitted.nodes === 1 ? '' : 's'} and {data!.omitted.edges} edge{data!.omitted.edges === 1 ? '' : 's'} omitted by the server's ceiling ({data!.nodeCeiling} nodes / {data!.edgeCeiling} edges), plus {data!.omitted.edgesDanglingPruned} edge{data!.omitted.edgesDanglingPruned === 1 ? '' : 's'} dropped because their other endpoint wasn't sampled.
                  </div>
                )}
              </div>
            )}
            {showAccessibleList && layout && (
              <AccessibleList stars={layout.stars} selectedId={selectedId} onSelect={(id) => setSelectedId(id)} onClose={() => setShowAccessibleList(false)} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GroupFilter({ groupKeys, hidden, onToggle }: { groupKeys: string[]; hidden: ReadonlySet<string>; onToggle: (g: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
        types {hidden.size ? `(${groupKeys.length - hidden.size}/${groupKeys.length})` : '(all)'}
      </Button>
      {open && (
        <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 10, background: 'var(--card)', border: '1px solid var(--w-12)', borderRadius: 10, padding: 10, width: 200, maxHeight: 260, overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,.35)' }}>
          {groupKeys.map((g) => (
            <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-soft)', padding: '2px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={!hidden.has(g)} onChange={() => onToggle(g)} />
              {g} · {starShapeFor(g)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** The accessible node list (locked decision — DOM overlay). A plain, static button list: no
 *  screen-coordinate tracking, so panning/zooming the canvas never touches it. Gives keyboard and
 *  screen-reader users full access to every star without depending on canvas pointer events. */
function AccessibleList({ stars, selectedId, onSelect, onClose }: {
  stars: LayoutStar[]; selectedId: string | null; onSelect: (id: string) => void; onClose: () => void;
}) {
  const sorted = useMemo(() => [...stars].sort((a, b) => a.label.localeCompare(b.label)), [stars]);
  return (
    <div
      style={{
        position: 'absolute', left: 12, top: 12, bottom: 12, width: 300, overflowY: 'auto', zIndex: 6,
        padding: '10px 12px', borderRadius: 12, background: 'var(--card)', border: '1px solid var(--w-14)', boxShadow: '0 12px 34px rgba(0,0,0,.4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <SectionLabel>All entities · {sorted.length}</SectionLabel>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} className="drawer-x" style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 14, width: 22, height: 22, borderRadius: 6 }}>✕</button>
      </div>
      <ul role="list" aria-label="Star map entities" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {sorted.map((s) => (
          <li key={s.nodeId}>
            <button
              onClick={() => onSelect(s.nodeId)}
              className="hover-border"
              style={{
                cursor: 'pointer', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 8px', borderRadius: 7, background: selectedId === s.nodeId ? 'var(--w-045)' : 'var(--w-02)',
                border: `1px solid ${selectedId === s.nodeId ? 'var(--w-18)' : 'var(--w-06)'}`, color: 'inherit', font: 'inherit',
              }}
            >
              <MonoTag color="var(--text-mid)" bg="var(--w-05)" size={8.5}>{s.kind ?? s.type}</MonoTag>
              <span style={{ fontSize: 11.5, color: 'var(--text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
