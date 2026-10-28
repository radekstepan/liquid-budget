"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fmt, OTHER_BUCKET_LABEL, REMAINING_LABEL, OVER_INCOME_LABEL } from "@ynab/logic";

export const PALETTE = [
  "#2f7fb0", // 0: Classic Steel Blue
  "#5c8f2c", // 1: Olive/Forest Green
  "#e8a33d", // 2: Amber/Gold
  "#7e57c2", // 3: Purple/Violet
  "#d45042", // 4: Coral Red
  "#26a69a", // 5: Teal/Cyan
  "#1f5c85", // 6: Deep Navy
  "#c07d1c", // 7: Warm Ochre
  "#b0608f", // 8: Rose/Magenta
  "#5aa5d0", // 9: Sky Blue
  "#78909c", // 10: Slate Grey
  "#8bc34a", // 11: Lime Green
];

export function colorAt(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? "#888";
}

// Stable color per series name (djb2 hash into PALETTE): a category or
// merchant keeps its color across month ranges, dimension toggles, and
// threshold merges. The merged "Other" bucket always renders slate; the
// unspent-income plug is green and each expense's over-income slice is
// neutral gray (an unfunded slice is not a series, so it never takes a
// palette color).
export const OTHER_BUCKET_COLOR = "#78909c";
export const REMAINING_COLOR = "#2f9e5f";
export const OVER_INCOME_COLOR = "#a3adb6";
// Sankey income bars carry no series color: every left-column bar renders
// this one neutral gray so the income side never competes with the
// group/category colors on the right.
export const SANKEY_INCOME_COLOR = "#9aa3ad";

export function colorForName(name: string): string {
  if (name === OTHER_BUCKET_LABEL) return OTHER_BUCKET_COLOR;
  if (name === REMAINING_LABEL) return REMAINING_COLOR;
  if (name === OVER_INCOME_LABEL) return OVER_INCOME_COLOR;
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length] ?? "#888";
}

// Mix a hex color toward black (amt < 1) or white (amt > 1). amt 0..1 darkens,
// 1 keeps it unchanged, >1 lightens. Returns a hex string.
export function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const base = m ? m[1]! : "888888";
  const t = Math.pow(2, Math.log2(amt));
  const ch = (i: number): number => {
    const c = parseInt(base.slice(i * 2, i * 2 + 2), 16);
    const v = amt <= 1 ? c * t : 255 - (255 - c) * t;
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  const [r, g, b] = [ch(0), ch(1), ch(2)];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// Sankey family colors: each middle (parent group) node owns one hue, and
// every target it feeds is a shade of that hue — the largest child takes the
// darkest shade and smaller siblings lighten toward the parent color by rank,
// so more money reads darker (single children keep the parent color). Shades
// only darken from the base, never lighten past it, which keeps bars and
// ribbons readable at ribbon opacity over a light background. Pure hex → hex.
const SANKEY_FAMILY_SHADE_STEPS = [1, 0.87, 0.76, 0.67, 0.6, 0.54];

export function sankeyFamilyShade(base: string, rank: number): string {
  if (rank <= 0) return base;
  const step =
    rank < SANKEY_FAMILY_SHADE_STEPS.length
      ? (SANKEY_FAMILY_SHADE_STEPS[rank] ?? 0.54)
      : Math.max(0.35, 0.54 * Math.pow(0.92, rank - SANKEY_FAMILY_SHADE_STEPS.length + 1));
  return shade(base, step);
}

export type SankeyFamilyGroup = { name: string; bucket: boolean };
export type SankeyFamilyTarget = { name: string; bucket: boolean; isPlug: boolean };
export type SankeyFamilyLink = { middleIndex: number; targetIndex: number; value: number };

/**
 * One color per right-column target, aligned with `targets`: each target
 * takes a shade of its dominant (largest-value) parent group's color, with
 * siblings shaded darkest-first by column order (see sankeyFamilyShade) —
 * in Amount sort the column runs largest-first, so more money reads darker
 * and the smallest sibling keeps the parent color. A target fed by several
 * groups (a merchant split across groups) joins its dominant group's
 * family; ties keep the first link in input order so the result is
 * deterministic. The Remaining plug stays green and merged Other buckets
 * stay slate — both by flag, never by name, so a literal "Remaining" or
 * "Other" row still joins its own family. Targets with no incoming link
 * (defensive: well-formed flows never produce them) fall back to their
 * stable name color. Pure data → hex colors.
 */
export function sankeyTargetColors(
  groups: SankeyFamilyGroup[],
  targets: SankeyFamilyTarget[],
  links: SankeyFamilyLink[]
): string[] {
  const dominant = new Array<number | null>(targets.length).fill(null);
  const best = new Array<number>(targets.length).fill(0);
  for (const l of links) {
    if (l.middleIndex < 0 || l.targetIndex < 0 || l.targetIndex >= targets.length) continue;
    if (!(l.value > 0)) continue;
    if (dominant[l.targetIndex] == null || l.value > (best[l.targetIndex] ?? 0)) {
      dominant[l.targetIndex] = l.middleIndex;
      best[l.targetIndex] = l.value;
    }
  }
  // Family sizes first: the darkest shade goes to the first (largest, in
  // Amount sort) sibling, so each member's rank counts down from the end.
  const familySize = new Map<number, number>();
  targets.forEach((t, i) => {
    if (t.isPlug || t.bucket) return;
    const m = dominant[i];
    if (m == null || groups[m] == null) return;
    familySize.set(m, (familySize.get(m) ?? 0) + 1);
  });
  const seen = new Map<number, number>();
  return targets.map((t, i) => {
    if (t.isPlug) return REMAINING_COLOR;
    if (t.bucket) return OTHER_BUCKET_COLOR;
    const m = dominant[i];
    const g = m != null ? groups[m] : undefined;
    if (g == null || m == null) return colorForName(t.name);
    const base = g.bucket ? OTHER_BUCKET_COLOR : colorForName(g.name);
    const pos = seen.get(m) ?? 0;
    seen.set(m, pos + 1);
    return sankeyFamilyShade(base, (familySize.get(m) ?? 1) - 1 - pos);
  });
}

export function fmtShort(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1).replace(/\.?0+$/, "")}K`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2).replace(/\.?0+$/, "")}K`;
  return fmt(cents);
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    if (min === 0) return [0, 1];
    const step = Math.pow(10, Math.floor(Math.log10(Math.abs(min))));
    return [Math.floor(min / step) * step, Math.ceil(min / step) * step];
  }
  if (min > max) {
    [min, max] = [max, min];
  }
  const span = max - min;
  const rawStep = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step * 0.5; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/**
 * Symmetric log transformation for continuous scales crossing zero.
 * symlog(x) = sign(x) * log10(1 + |x|)
 */
export function symlog(x: number): number {
  if (x === 0) return 0;
  return Math.sign(x) * Math.log10(1 + Math.abs(x));
}

/**
 * Generate sensible decade tick values for symmetric log scale.
 * e.g., -$1M, -$100K, -$10K, -$1K, $0, $1K, $10K, $100K, $1M.
 */
export function symlogTicks(minVal: number, maxVal: number): number[] {
  const ticks: number[] = [];

  if (minVal < 0) {
    const minAbs = Math.abs(minVal);
    const maxPower = Math.max(2, Math.ceil(Math.log10(minAbs)));
    const minPower = Math.min(maxPower >= 7 ? 5 : 4, maxPower);
    for (let p = maxPower; p >= minPower; p--) {
      ticks.push(-Math.pow(10, p));
    }
  }

  ticks.push(0);

  if (maxVal > 0) {
    const maxPower = Math.max(2, Math.ceil(Math.log10(maxVal)));
    const minPower = Math.min(maxPower >= 7 ? 5 : 4, maxPower);
    for (let p = minPower; p <= maxPower; p++) {
      ticks.push(Math.pow(10, p));
    }
  }

  return ticks;
}

export function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Last committed size: the observer can deliver duplicate notifications
  // (the ref-attach update races the observer's initial notification, and
  // settling scrollbars re-fire with identical dimensions). Committing only
  // on actual change keeps each duplicate from forcing a full chart
  // re-render and layout recompute — visible jitter on open.
  const lastRef = useRef({ width: 0, height: 0 });
  const roRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    const commit = (width: number, height: number) => {
      const last = lastRef.current;
      if (last.width === width && last.height === height) return;
      const next = { width, height };
      lastRef.current = next;
      setSize(next);
    };
    if (!node) {
      commit(0, 0);
      return;
    }
    const update = () => {
      commit(node.clientWidth, node.clientHeight);
    };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(node);
      roRef.current = ro;
    }
  }, []);

  return { ref, size };
}

// Throttle frequent state updates (e.g. mousemove-hover) to at most one per
// animation frame. Always delivers the latest value (coalesced), so no
// intermediate cursor positions are lost during fast sweeps.
export function useRafThrottledSet<T>(set: (v: T) => void): (v: T) => void {
  const rafRef = useRef<number | null>(null);
  // Gating flag (not the rAF id): with a synchronous requestAnimationFrame
  // the callback runs before the call returns, so assigning its id over the
  // ref would clobber the callback's own reset and wedge later pushes off.
  const scheduledRef = useRef(false);
  const pendingRef = useRef<T | null>(null);
  const setRef = useRef(set);
  setRef.current = set;

  const push = useCallback((value: T) => {
    pendingRef.current = value;
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      scheduledRef.current = false;
      const v = pendingRef.current;
      if (v !== null) setRef.current(v);
    });
  }, []);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    scheduledRef.current = false;
  }, []);

  return push;
}

export function ChartTip({
  x,
  y,
  content,
}: {
  x: number | null;
  y: number | null;
  content: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (x == null || y == null || !ref.current) return;
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pad = 10;
    let left = x - w / 2;
    left = Math.max(pad, Math.min(window.innerWidth - w - pad, left));
    let top = y - h - 12;
    if (top < 8) top = y + 16;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [x, y, content]);

  if (x == null || y == null || content == null) return null;

  return (
    <div
      ref={ref}
      className="y-tip pointer-events-none fixed z-40"
      style={{ left: 0, top: 0, textAlign: "left" }}
    >
      {content}
    </div>
  );
}

export function TipLabel({
  color,
  label,
  value,
  pct,
  dot = true,
}: {
  color: string;
  label: string;
  value: string;
  pct?: string;
  /** Hide the colored dot; a transparent spacer keeps text/amounts aligned. */
  dot?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap">
      {dot ? (
        <span
          data-testid="tip-dot"
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: color, boxShadow: "0 0 0 2px rgba(255,255,255,0.18)" }}
        />
      ) : (
        <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0" />
      )}
      <span style={{ color: "rgba(242,245,247,0.78)" }}>{label}</span>
      <span className="y-num font-semibold" style={{ color: "#f2f5f7" }}>
        {value}
        {pct && (
          <span className="ml-1 font-normal" style={{ color: "rgba(242,245,247,0.55)" }}>
            ({pct})
          </span>
        )}
      </span>
    </div>
  );
}

// Black-with-opacity used for the diagonal "truncated" hatch across all charts.
export const TRUNC_HATCH_COLOR = "rgba(0,0,0,0.35)";

// A bar whose value reaches this fraction of the max value is visually capped.
export const TRUNC_RATIO = 0.95;
// Solid cap height and dashed continuation strip height (SVG charts).
export const TRUNC_CAP_H = 5;
export const TRUNC_DASH_H = 5;

// Shared SVG marker: a solid cap at the cut edge matching the bar color, plus
// a diagonal dark hatch strip just inside it indicating the bar continues.
export function TruncMarker({
  x,
  y,
  width,
  fill,
  hatchId,
  dir = "up",
  rx = 1,
}: {
  x: number;
  y: number;
  width: number;
  fill: string;
  hatchId: string;
  dir?: "up" | "down";
  rx?: number;
}) {
  if (dir === "down") {
    return (
      <>
        <rect
          data-testid="trunc-hatch"
          x={x}
          y={y - TRUNC_CAP_H - TRUNC_DASH_H}
          width={width}
          height={TRUNC_DASH_H}
          fill={hatchId}
        />
        <rect
          data-testid="trunc-cap"
          x={x}
          y={y - TRUNC_CAP_H}
          width={width}
          height={TRUNC_CAP_H}
          rx={rx}
          fill={fill}
        />
      </>
    );
  }
  return (
    <>
      <rect
        data-testid="trunc-hatch"
        x={x}
        y={y + TRUNC_CAP_H}
        width={width}
        height={TRUNC_DASH_H}
        fill={hatchId}
      />
      <rect
        data-testid="trunc-cap"
        x={x}
        y={y}
        width={width}
        height={TRUNC_CAP_H}
        rx={rx}
        fill={fill}
      />
    </>
  );
}

// Diagonal hatch pattern (matches the CSS `-45deg` stripes in `.y-bar-truncated`).
export function TruncHatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="4" stroke={TRUNC_HATCH_COLOR} strokeWidth="1.4" />
    </pattern>
  );
}

// Light diagonal hatch marking render-only Sankey bars: the merged "Other"
// buckets on every column and the "Remaining" surplus plug are drawn by the
// renderer, not real rows, so they carry this pattern plus a dashed border
// to read as computed at a glance. White lines stay visible over the slate,
// green, and gray fills those bars use.
export function SankeyBucketHatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.65)" strokeWidth="1.6" />
    </pattern>
  );
}

/** One outgoing ribbon band across an income bar: vertical span + ribbon color. */
export type SankeyIncomeBand = { y0: number; y1: number; color: string };
/** One linear-gradient stop: fractional offset + color. */
export type SankeyGradientStop = { offset: number; color: string };

/**
 * Hard-edged top-to-bottom gradient stops for a Sankey income bar, built
 * from the colors of the ribbons extending from it: each band keeps its
 * ribbon's destination color through its exact span, and adjacent bands
 * meet at a hard edge on their shared boundary — so every bar segment
 * matches the ribbon leaving it. (An earlier feathered blend smeared each
 * boundary across the bar and the bar stopped matching its ribbons.) Pure
 * geometry → stops.
 *
 * - Band order is the gradient order (top to bottom); zero-height bands
 *   are skipped.
 * - Shared boundary offsets are kept, not collapsed: the duplicate offset
 *   is what renders the hard edge between two bands.
 * - A single band (or none, defensively) yields a solid fill.
 */
export function sankeyIncomeGradientStops(
  barY0: number,
  barY1: number,
  bands: readonly SankeyIncomeBand[]
): SankeyGradientStop[] {
  const h = barY1 - barY0;
  const live = bands.filter((b) => b.y1 > b.y0 && h > 0);
  if (live.length === 0) {
    return [
      { offset: 0, color: SANKEY_INCOME_COLOR },
      { offset: 1, color: SANKEY_INCOME_COLOR },
    ];
  }
  if (live.length === 1) {
    return [
      { offset: 0, color: live[0]!.color },
      { offset: 1, color: live[0]!.color },
    ];
  }
  const frac = (y: number) => (y - barY0) / h;
  const clamp01 = (o: number) => Math.min(1, Math.max(0, o));
  const stops: SankeyGradientStop[] = [];
  for (const b of live) {
    stops.push({ offset: clamp01(frac(b.y0)), color: b.color });
    stops.push({ offset: clamp01(frac(b.y1)), color: b.color });
  }
  // Bands arrive top-to-bottom, so this sort is a no-op on well-formed
  // input; stability keeps each shared boundary's outgoing color before
  // the incoming one, which is what renders the hard edge.
  stops.sort((a, b) => a.offset - b.offset);
  return stops;
}

// ---------------------------------------------------------------------------
// Outlier detection (Tukey IQR fence) — ported from the SVG bar-chart outlier
// playground. Robust: quartiles cannot be distorted by the outlier itself.
// ---------------------------------------------------------------------------

/** Linear-interpolated quantile, p in [0, 1]. */
export function quantile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

export const median = (xs: number[]) => quantile(xs, 0.5);

/** Tukey fence: anything above Q3 + k·IQR is an outlier (classic k = 1.5). */
export function iqrFence(xs: number[], k = 1.5) {
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, upper: q3 + k * iqr };
}

/** Round up to a "nice" number: 1, 2, 2.5, 5 × 10^k. */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / 10 ** exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/** Nice axis scale: returns a rounded top value and tick positions. */
export function niceScale(maxVal: number, count = 4) {
  const step = niceCeil(Math.max(maxVal, 1) / count);
  const top = step * Math.ceil(maxVal / step - 1e-9);
  const ticks: number[] = [];
  for (let t = 0; t <= top + step * 0.001; t += step) ticks.push(t);
  return { top: Math.max(top, step), ticks };
}

export type OutlierBreak = {
  hasBreak: boolean;
  /** Start of the compressed zone — statistical fence or nice ceiling above it. */
  breakAt: number;
  /** Rounded nice ceiling of `breakAt` (lower-region top). */
  breakTop: number;
  /** Rounded nice ceiling of the max value (end of compressed zone). */
  topVal: number;
  /** Ticks for the lower (linear) region. */
  ticks: number[];
  /** Fraction of space given to the lower region. */
  split: number;
  /** Indices of detected outliers within the input array. */
  outlierIdx: number[];
};

export const NO_BREAK: OutlierBreak = {
  hasBreak: false,
  breakAt: 0,
  breakTop: 0,
  topVal: 0,
  ticks: [],
  split: 0.65,
  outlierIdx: [],
};

/**
 * Decide whether a bar chart needs an axis break: Tukey-fence outliers exist
 * AND they are meaningfully taller than the tallest inlier (so tiny gaps do
 * not produce a break). Requires >= 5 points for stable quartiles.
 */
export function computeOutlierBreak(
  values: number[],
  opts: { k?: number; split?: number; minGap?: number } = {}
): OutlierBreak {
  const { k = 1.5, split = 0.65, minGap = 1.4 } = opts;
  const pos = values.filter((v) => Number.isFinite(v) && v > 0);
  if (pos.length < 5) return NO_BREAK;

  const fence = iqrFence(pos, k);
  const outlierIdx = pos
    .map((v, i) => (v > fence.upper ? i : -1))
    .filter((i) => i >= 0);
  if (outlierIdx.length === 0) return NO_BREAK;

  const maxInlier = Math.max(...pos.filter((v) => v <= fence.upper));
  const max = Math.max(...pos);
  if (max <= maxInlier * minGap) return NO_BREAK;

  const lower = niceScale(Math.max(maxInlier, 1), 3);
  const breakTop = lower.top;
  const topVal = niceCeil(max);
  if (topVal <= breakTop * 1.1) return NO_BREAK;

  return {
    hasBreak: true,
    breakAt: breakTop,
    breakTop,
    topVal,
    ticks: lower.ticks.filter((t) => t > 0),
    split,
    outlierIdx,
  };
}

// ---------------------------------------------------------------------------
// Axis break visuals — the classic print-chart "squiggle" cutout.
// ---------------------------------------------------------------------------

export const AXIS_BREAK_COLOR = "#8a99a8";

/** Horizontal squiggle (for vertical bar charts) at y0 spanning [x1, x2]. */
export function zigZagHorizontal(x1: number, x2: number, y0: number, step = 9, amp = 3.5): string {
  let d = `M ${x1} ${y0}`;
  let up = true;
  for (let x = x1; x <= x2; x += step) {
    d += ` l ${Math.min(step, x2 - x)} ${up ? -amp : amp}`;
    up = !up;
  }
  return d;
}

/** Vertical squiggle (for horizontal bar charts) at x0 spanning [y1, y2]. */
export function zigZagVertical(y1: number, y2: number, x0: number, step = 9, amp = 3.5): string {
  let d = `M ${x0} ${y1}`;
  let right = true;
  for (let y = y1; y <= y2; y += step) {
    d += ` l ${right ? amp : -amp} ${Math.min(step, y2 - y)}`;
    right = !right;
  }
  return d;
}

/**
 * SVG mask that cuts a transparent jagged band through bars at `breaks[i].y`.
 * Place bars inside `<g mask={`url(#${maskId})`}>` and draw thin boundary
 * lines on top via `<AxisBreakMark>`.
 */
export function AxisBreakMask({
  maskId,
  x1,
  x2,
  breaks,
  band = 14,
  vertical = false,
}: {
  maskId: string;
  x1: number;
  x2: number;
  breaks: Array<{ y: number }>;
  band?: number;
  vertical?: boolean;
}) {
  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);
  return (
    <mask id={maskId}>
      <rect width="100%" height="100%" fill="white" />
      {breaks.map((b, i) => (
        <path
          key={i}
          data-testid="axis-break"
          d={
            vertical
              ? zigZagVertical(lo, hi, b.y, 8, 2.5)
              : zigZagHorizontal(lo, hi, b.y, 12, 3.5)
          }
          fill="none"
          stroke="black"
          strokeWidth={band}
          strokeLinejoin="miter"
          strokeMiterlimit={3}
        />
      ))}
    </mask>
  );
}

/**
 * Cutout + double squiggle marking where the scale changes.
 * `vertical` renders a vertical break at x = `y` spanning [min(x1,x2), max(x1,x2)].
 */
export function AxisBreakMark({
  x1,
  x2,
  y,
  vertical = false,
  erase,
  stroke = AXIS_BREAK_COLOR,
  band = 14,
}: {
  x1: number;
  x2: number;
  y: number;
  vertical?: boolean;
  erase?: string;
  stroke?: string;
  band?: number;
}) {
  const lo = Math.min(x1, x2);
  const hi = Math.max(x1, x2);
  if (vertical) {
    return (
      <g>
        {erase && (
          <rect
            data-testid="axis-break"
            x={y - band / 2}
            y={lo}
            width={band}
            height={hi - lo}
            fill={erase}
          />
        )}
        <path
          d={zigZagVertical(lo, hi, y - 2.5, 8, 2.5)}
          fill="none"
          stroke={stroke}
          strokeWidth={1.3}
        />
        <path
          d={zigZagVertical(lo, hi, y + 2.5, 8, 2.5)}
          fill="none"
          stroke={stroke}
          strokeWidth={1.3}
        />
      </g>
    );
  }
  return (
    <g>
      {erase && (
        <rect
          data-testid="axis-break"
          x={lo}
          y={y - band / 2}
          width={hi - lo}
          height={band}
          fill={erase}
        />
      )}
      <path
        d={zigZagHorizontal(lo, hi, y - 3, 12, 3.5)}
        fill="none"
        stroke={stroke}
        strokeWidth={1.3}
      />
      <path
        d={zigZagHorizontal(lo, hi, y + 4, 12, 3.5)}
        fill="none"
        stroke={stroke}
        strokeWidth={1.3}
      />
    </g>
  );
}
