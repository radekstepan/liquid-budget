

export const SANKEY_THRESHOLD_STOPS: readonly number[] = [
  0, 10, 25, 50, 75, 100, 150, 200, 250, 300, 350, 400, 500, 750, 1000, 1500,
  2000, 3000, 5000, 7500, 10000, 15000, 25000, 50000,
];

/**
 * Slider stops covering `maxDollars` (the largest row on any column): the
 * canonical prefix through the smallest stop at or above the data, floored
 * at $50 so the control stays useful on tiny datasets, extended by doubling
 * when the data exceeds the largest canonical stop. Always starts at 0
 * (threshold off) and is strictly ascending.
 */
export function sankeyThresholdStops(maxDollars: number): number[] {
  const target = Math.max(50, Number.isFinite(maxDollars) ? maxDollars : 0);
  const ceiling = SANKEY_THRESHOLD_STOPS.find((s) => s >= target);
  if (ceiling != null) return SANKEY_THRESHOLD_STOPS.filter((s) => s <= ceiling);
  // Beyond the canonical range: keep every canonical stop, then double
  // (50k → 100k → 200k …) until covered.
  const stops = [...SANKEY_THRESHOLD_STOPS];
  const lastCanonical = stops[stops.length - 1]!;
  let next = lastCanonical * 2;
  while (next < target) {
    stops.push(next);
    next *= 2;
  }
  stops.push(next);
  return stops;
}

/**
 * Slider position for a dollar threshold: the nearest stop (ties round
 * down, out-of-range clamps). Stored dollar values from before the stepped
 * slider snap to their closest stop through this.
 */
export function sankeyThresholdStep(stops: readonly number[], dollars: number): number {
  if (stops.length === 0) return 0;
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    const cur = Math.abs((stops[i] ?? 0) - dollars);
    const prev = Math.abs((stops[best] ?? 0) - dollars);
    if (cur < prev) best = i;
  }
  return best;
}

export type SankeyBandSpan = {
  /** Sub-band vertical extent; spans tile the input band edge to edge. */
  y0: number;
  y1: number;
  /** Index into the input values, so colors survive skipped cells. */
  valueIndex: number;
};

/**
 * Subdivide an income band `[y0, y1]` into one span per positive cell
 * value, proportional to value, in input order: the Categories-grouped
 * income bar nests each income→group band's downstream categories inside
 * it, so the category colors drive the bar's segments. Each category has
 * exactly one parent group, so the split is exact — income i's span for
 * category c is its fungible share of that category's funded cell.
 *
 * - Spans tile the band edge to edge (the last span snaps to y1, so float
 *   shares leave no hairline gap); shared boundaries render as hard edges
 *   downstream in sankeyIncomeGradientStops.
 * - Non-positive values are skipped (defensive: layout cells are > 0);
 *   survivors keep their input index for color lookup.
 * - Empty, all non-positive, or zero-height input yields [] so the caller
 *   falls back to the whole band in the group color.
 */
export function subdivideBandByValues(
  band: readonly [number, number],
  values: readonly number[]
): SankeyBandSpan[] {
  const [y0, y1] = band;
  if (!(y1 > y0)) return [];
  let total = 0;
  for (const v of values) {
    if (v > 0) total += v;
  }
  if (!(total > 0)) return [];
  const live = values
    .map((value, valueIndex) => ({ value, valueIndex }))
    .filter((c) => c.value > 0);
  const spans: SankeyBandSpan[] = [];
  let y = y0;
  live.forEach((c, k) => {
    const last = k === live.length - 1;
    // The last span snaps to the band edge instead of accumulating float
    // error across the shares.
    const ny = last ? y1 : y + ((y1 - y0) * c.value) / total;
    spans.push({ y0: y, y1: ny, valueIndex: c.valueIndex });
    y = ny;
  });
  return spans;
}

// ---------------------------------------------------------------------------
// Sankey color math: pure, deterministic, and part of the layout objects.
// The layout resolves every drawable's exact fill (flat colors and gradient
// stops), so rendering is pure presentation with no color logic. Canonical
// home of the palette (previously in ui/chartUtils, which re-exports it).
// ---------------------------------------------------------------------------

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

// The merged "Other" bucket always renders slate; the unspent-income plug
// is green and each expense's over-income slice is neutral gray (an
// unfunded slice is not a series, so it never takes a palette color).
export const OTHER_BUCKET_COLOR = "#78909c";
export const REMAINING_COLOR = "#2f9e5f";
export const OVER_INCOME_COLOR = "#a3adb6";
// Sankey income bars carry no series color: every left-column bar renders
// this one neutral gray so the income side never competes with the
// group/category colors on the right.
export const SANKEY_INCOME_COLOR = "#9aa3ad";

// Stable color per series name (djb2 hash into PALETTE): a category or
// merchant keeps its color across month ranges, dimension toggles, and
// threshold merges. Bucket/plug colors are NEVER name-based: a literal
// "Other" or "Remaining" row keeps its own hash color, and only rows
// flagged bucket/plug render slate/green (see sankeyTargetColor) —
// otherwise a real row shares the computed rows' color and the flows that
// share the color stop being traceable.
export function colorForName(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length] ?? "#888";
}

/**
 * One color for a right-column Sankey target: the category (or merchant)
 * determines its own color, and that color flows backwards along every
 * ribbon arriving at it — no matter which middle group each ribbon comes
 * from. The parent group never tints the target: two categories sharing a
 * group keep their own stable hues, and a merchant split across groups is
 * still one color on every leg. The Remaining plug stays green and merged
 * Other buckets stay slate — both by flag, never by name, so a literal
 * "Remaining" or "Other" row still keeps its own stable color. Sources and
 * middles resolve through the same function with isPlug: false.
 */
export function sankeyTargetColor(t: {
  name: string;
  bucket: boolean;
  isPlug: boolean;
}): string {
  if (t.isPlug) return REMAINING_COLOR;
  if (t.bucket) return OTHER_BUCKET_COLOR;
  return colorForName(t.name);
}

/** One outgoing ribbon band across an income bar: vertical span + ribbon color. */
export type SankeyIncomeBand = { y0: number; y1: number; color: string };
/** One linear-gradient stop: fractional offset + color. */
export type SankeyGradientStop = { offset: number; color: string };

/**
 * Hard-edged top-to-bottom gradient stops for a Sankey income or middle
 * bar, built from the colors of the ribbons extending from it: each band
 * keeps its ribbon's destination color through its exact span, and
 * adjacent bands meet at a hard edge on their shared boundary — so every
 * bar segment matches the ribbon leaving it. (An earlier feathered blend
 * smeared each boundary across the bar and the bar stopped matching its
 * ribbons.) Pure geometry → stops.
 *
 * - Band order is the gradient order (top to bottom); zero-height bands
 *   are skipped.
 * - Shared boundary offsets are kept, not collapsed: the duplicate offset
 *   is what renders the hard edge between two bands.
 * - A single band (or none, defensively) yields a solid fill: the band's
 *   own color, or `fallback` when there are no bands (the neutral income
 *   gray for income bars, the group's own color for middle bars with no
 *   outgoing ribbons).
 */
export function sankeyIncomeGradientStops(
  barY0: number,
  barY1: number,
  bands: readonly SankeyIncomeBand[],
  fallback: string = SANKEY_INCOME_COLOR
): SankeyGradientStop[] {
  const h = barY1 - barY0;
  const live = bands.filter((b) => b.y1 > b.y0 && h > 0);
  if (live.length === 0) {
    return [
      { offset: 0, color: fallback },
      { offset: 1, color: fallback },
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
