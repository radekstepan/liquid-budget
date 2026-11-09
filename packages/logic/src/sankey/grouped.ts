import type { SankeyGeometryOptions, SankeyNodeLayout } from "./geometry.js";
import { SANKEY_LABEL_CENTER_MIN, SANKEY_MIDDLE_LABEL_GAP, SANKEY_MIN_LINK_HEIGHT, SANKEY_MIN_PITCH, SANKEY_NODE_GAP, SANKEY_PAD_BOTTOM, SANKEY_PAD_TOP, SANKEY_SOURCE_LABEL_GAP, remainingLanePath, ribbonPath } from "./geometry.js";
import type { DirectSankeyLinkLayout, DirectSankeyTargetNode } from "./direct.js";
import type { DirectFlowLinkValue, MonthlySankeySeries, SpendingBreakdownItem, SpendingGroupFlowLink } from "./flow.js";
import { REMAINING_LABEL, computeDirectFlowLinks } from "./flow.js";
import type { MergedSpendingItem } from "./merge.js";
import { mergeBelowThreshold, mergeGroupFlow } from "./merge.js";
import { computeSankeyViewModel } from "./funding.js";
import type { SankeyGradientStop, SankeyIncomeBand } from "./style.js";
import { REMAINING_COLOR, SANKEY_INCOME_COLOR, sankeyIncomeGradientStops, sankeyTargetColor, subdivideBandByValues } from "./style.js";

/** Middle-column node: same funded/unfunded shape as a right-column target. */
export type GroupedSankeyMiddleNode = DirectSankeyTargetNode;

/**
 * Right-hop link: one middle→target cell drawn as ONE ribbon. The right hop
 * used to subdivide each cell per income source, but the per-income bands
 * rendered as visible split lines inside every cell — money is fungible, so
 * a group feeds each of its targets through a single band in the TARGET's
 * color, and hovering a group spotlights every line leading out of it in
 * full. (sourceIndex into middles, targetIndex into targets.)
 */
export type GroupedRightLinkLayout = DirectSankeyLinkLayout;

/**
 * One left-hop sub-ribbon: income i's share of one middle→target cell,
 * drawn in the cell's target color. Emitted only when leftDetail is
 * "cells" (both groupings request it, so the same through-color flows
 * from the right column all the way to income everywhere). Band-major in
 * cell order, so siblings tile
 * each source band edge to edge in the same order the cells leave the
 * middle — while the target slots tile each middle's incoming stack in
 * cell-major order (all incomes' slices of one cell adjacent), so each
 * color enters the middle as one contiguous block at exactly the thickness
 * it leaves it.
 */
export type GroupedLeftCellLayout = {
  /** Index into sources. */
  sourceIndex: number;
  /** Index into middles. */
  middleIndex: number;
  /** Index into linksRight: the downstream cell this slice funds. */
  rightLinkIndex: number;
  /** Index into targets: the downstream cell's destination. */
  targetIndex: number;
  sourceName: string;
  middleName: string;
  targetName: string;
  /** Funded cents in this slice (the cell's funded value times the income's share). */
  value: number;
  /** Source slice vertical span (left edge, within the income's band). */
  sy0: number;
  sy1: number;
  /** Target slice vertical span (right edge, within the cell's block). */
  ty0: number;
  ty1: number;
  x0: number;
  x1: number;
  /** Closed ribbon path from the source slice to the target slice. */
  d: string;
  /** Exact flat fill: the downstream cell's target color. */
  fill: string;
};

export type GroupedIncomeSankeyLayout = {
  incomeTotal: number;
  spendingTotal: number;
  /** Height-scale denominator: max(income, spending). */
  flowTotal: number;
  /**
   * Pixels per cent: the ONE linear scale of the whole chart. Every band
   * above the visibility floor draws at exactly value * pxPerCent on both
   * hops, so equal money always reads at equal thickness.
   */
  pxPerCent: number;
  /**
   * Effective band visibility floor in px (the minLinkHeight option): bands
   * below value * pxPerCent draw at this height instead. The only
   * distortion in the geometry, confined to hairline flows.
   */
  linkFloor: number;
  /**
   * Canvas height the layout needs (tallest column, or the Remaining lane
   * when it hangs lowest, plus padBottom). Callers size the SVG to
   * max(containerHeight, contentHeight): the layout never crushes bars to
   * fit — it reports how tall it is instead.
   */
  contentHeight: number;
  /** Left column: one bar per income source. */
  sources: SankeyNodeLayout[];
  /** Middle column: one bar per category group. */
  middles: GroupedSankeyMiddleNode[];
  /**
   * Right column: one bar per spending group (category or merchant) plus a
   * trailing Remaining plug when income exceeds spending.
   */
  targets: DirectSankeyTargetNode[];
  /**
   * Index into targets of the Remaining plug, or null when spending covers
   * income. Identified by position (never by name), so a literal
   * "Remaining" category can never be mistaken for the plug.
   */
  remainingTargetIndex: number | null;
  /**
   * Top y of the dedicated Remaining lane (one row gap below the last
   * middle bar), or null when no lane routing applies (no surplus, or no
   * middle column to bypass — with no middles the plug ribbon has nothing
   * to cross, so it stays a straight ribbon). Plug ribbons tile the lane
   * in source order via their ly0/ly1 spans.
   */
  remainingLaneY: number | null;
  /**
   * Pixels the Remaining lane pokes past the plot bottom (height minus
   * padBottom) — 0 in the common case, positive only when the middle
   * column hangs below the last spending target. The lane is transit-only
   * (no bar moves), so callers fit it by extending the CANVAS by this
   * amount while keeping the layout height: the plot is absolute-scale and
   * already full, so growing the layout height would just scale every bar
   * up with it and never open room. Same-layout re-call not needed.
   */
  remainingLaneOverflow: number;
  /**
   * Left ribbons: income → middle, fungible proportional allocation
   * (sourceIndex into sources, targetIndex into middles) — except the
   * Remaining ribbons, which carry the plug index (one past the last
   * middle) and run full-width from their income source to the Remaining
   * target through the dedicated lane below the middle column
   * (remainingLanePath): unspent money bypasses groups without crossing a
   * bar or a middle→target ribbon.
   */
  linksLeft: DirectSankeyLinkLayout[];
  /**
   * Right ribbons: middle → spending, exact rollup attribution, one ribbon
   * per cell (sourceIndex into middles, targetIndex into targets). Sorted
   * by (middle, target).
   */
  linksRight: GroupedRightLinkLayout[];
  /**
   * Left-hop sub-ribbons (see GroupedLeftCellLayout). Empty unless
   * leftDetail is "cells". Rendering draws these INSTEAD of the subdivided
   * whole bands; bands with no entry here (plug ribbons, degenerate bands)
   * render whole from linksLeft.
   */
  leftCells: GroupedLeftCellLayout[];
  /**
   * One fill gradient per source bar: hard-edged stops from the bar's
   * outgoing bands' colors (per-cell slices in "cells" mode, whole-band
   * group colors in "bands" mode), so every segment meets its ribbon
   * exactly. Rendering maps these stops to gradient elements verbatim.
   */
  sourceFills: SankeyGradientStop[][];
  /**
   * One fill gradient per middle bar: hard-edged stops from the bar's
   * outgoing cells' target colors, so every segment meets its ribbon
   * exactly. Rendering maps these stops to gradient elements verbatim.
   */
  middleFills: SankeyGradientStop[][];
  /** x for end-anchored income labels (left of the source column). */
  sourceLabelX: number;
  /** x for start-anchored group labels (right of the middle column). */
  middleLabelX: number;
  /** x for start-anchored target labels (right of the target column). */
  targetLabelX: number;
};

/**
 * Lay out a three-column money-flow Sankey: income sources (left) flow into
 * category groups (middle), which flow into spending groups (right). The
 * left hop reuses computeDirectFlowLinks (fungible proportional allocation),
 * or the explicit per-cell funding passed via opts.leftHop (see
 * computeSankeyViewModel); the right hop draws the exact group→target
 * rollup cells scaled by the uniform coverage ratio income/spending, or at
 * their explicit funded values. Surplus income lands in a
 * trailing Remaining target on the right, fed directly from the incomes —
 * unspent money bypasses groups through a dedicated lane below the middle
 * column, so those ribbons cross no bar and no middle→target ribbon.
 *
 * Math-first: this function computes the complete reproducible picture —
 * every node, band, and ribbon with exact y/height/color — and rendering
 * draws it verbatim with no layout logic of its own. The layout is
 * deterministic: equal inputs serialize to identical JSON.
 *
 * Geometry contract (covered by unit tests):
 * - ONE linear scale (pxPerCent) governs the whole chart: every band above
 *   the visibility floor draws at exactly value * pxPerCent on both hops,
 *   so equal money always reads at equal thickness anywhere. The only
 *   distortion is the band floor (linkFloor): bands below it draw at floor
 *   height instead of vanishing. Bars wrap their bands exactly — the floor
 *   only ever grows tiny bars and the canvas, never shrinks large ones:
 *   there is no stealing, so the largest flow always draws the largest bar.
 * - Right ribbon heights derive from cell values directly; Remaining bands
 *   the same. Each middle→target cell draws as ONE ribbon carrying the
 *   full cell value — no per-income subdivision, so no split lines inside
 *   a cell. Every ribbon has equal height at both ends (no taper): bands
 *   within a target run in middle order (source order for the Remaining
 *   plug), bands within a middle run in target order on the way out.
 * - Middle bars wrap their outgoing bands exactly; with no income there
 *   are no bands and every bar is zero-height (labels still show via the
 *   reserved pitch). Incoming bands tile the same drawn stack from the
 *   bar's top edge with no slack on either side.
 * - With leftDetail "cells", each income→middle band subdivides into one
 *   sub-ribbon per downstream cell (leftCells) — per FUNDED cell pair with
 *   explicit funding, so an unfunded pair draws nothing: siblings tile the
 *   source band edge to edge in cell order, while the target slots tile the
 *   middle's incoming stack in cell-major order — every income's slice of
 *   one cell adjacent — so each color enters the middle as one contiguous
 *   block at exactly the thickness it leaves it (flow conservation per
 *   color, in the same order both sides). Sub-ribbons have no taper.
 * - There is no unfunded segment in the geometry (unfundedH is always 0):
 *   the shortfall shows in tooltips and the header only. fundedValue and
 *   unfundedValue still report the funded/unfunded split in cents. Under a
 *   shortfall every column only fills its funded share.
 * - Every row reserves label pitch (SANKEY_MIN_PITCH) independent of its
 *   bar height, so adjacent two-line labels never touch no matter how thin
 *   the bars; labelY anchors each label. The canvas need is reported as
 *   contentHeight — callers size the SVG to max(container, contentHeight)
 *   instead of the layout crushing bars to fit.
 * - Remaining plug ribbons route through a dedicated lane one row gap below
 *   the last middle bar (remainingLaneY): each drops from its source band
 *   into its lane span (ly0/ly1, tiling the lane in source order with no
 *   taper), bridges under the middle bars, then traverses to its plug-bar
 *   band — crossing no bar and no middle→target ribbon (the traverse shares
 *   the right-hop x-range and curve family, so the crossing-freedom is
 *   exact, not approximate). Lane crossings with income→group ribbons in
 *   the left half remain: the endpoints straddle topologically, the same
 *   dense-bipartite crossings group ribbons make with each other. With no
 *   middles the plug ribbon stays a straight ribbon (nothing to bypass).
 * - The lane is transit-only: no bar moves for it. contentHeight includes
 *   the lane bottom, so callers fit it by sizing the canvas (not by
 *   re-laying out at a taller height, which would just rescale every bar).
 *   remainingLaneOverflow still reports how far the lane pokes past the
 *   plot bottom (height minus padBottom); 0 in the common case.
 * - Node `share` is value/flowTotal on all three columns.
 * - Degenerate input (no positive right-column values, or a non-positive
 *   dimension) yields no nodes — never NaN geometry.
 * - Non-positive groups/targets are dropped, and links into dropped rows
 *   are dropped with them.
 */
export function layoutGroupedIncomeSankey(
  sources: MergedSpendingItem[],
  groups: MergedSpendingItem[],
  targets: MergedSpendingItem[],
  groupLinks: SpendingGroupFlowLink[],
  opts: SankeyGeometryOptions
): GroupedIncomeSankeyLayout {
  const {
    width,
    height,
    nodeWidth = 14,
    nodeGap = 6,
    minLinkHeight = SANKEY_MIN_LINK_HEIGHT,
    leftDetail = "bands",
    padLeft = 8,
    padRight = 8,
    padTop = 8,
    padBottom = 8,
  } = opts;
  // minNodeHeight is a legacy-layout option; the grouped layout sizes bars
  // from bands (minLinkHeight) with label pitch from SANKEY_MIN_PITCH.
  void opts.minNodeHeight;
  const linkFloor = Math.max(0, minLinkHeight);

  const nodeX = Math.max(padLeft + nodeWidth + 24, width - padRight - nodeWidth);
  const linkLX0 = padLeft + nodeWidth;
  // The middle column sits centered between the outer columns; the clamp
  // keeps both ribbon runs positive while narrow widths squeeze the
  // ribbons, never the labels or bars.
  const midLo = linkLX0 + 2;
  const midHi = nodeX - nodeWidth - 2;
  const midX =
    midHi >= midLo
      ? Math.min(Math.max(Math.round((linkLX0 + nodeX - nodeWidth) / 2), midLo), midHi)
      : midLo;
  const linkRX0 = midX + nodeWidth;
  const linkRX1 = nodeX;

  // Drop non-positive rows first so link indices remap onto the drawn
  // columns (well-formed flows never trigger this: every value is > 0).
  const grpItems = groups.filter((g) => g.value > 0);
  const tgtItems = targets.filter((t) => t.value > 0);
  const grpRemap = new Map<number, number>();
  groups.forEach((g, i) => {
    if (g.value > 0) grpRemap.set(i, grpRemap.size);
  });
  const tgtRemap = new Map<number, number>();
  targets.forEach((t, i) => {
    if (t.value > 0) tgtRemap.set(i, tgtRemap.size);
  });
  const keptLinks: SpendingGroupFlowLink[] = [];
  const keptOrig: number[] = [];
  groupLinks.forEach((l, k) => {
    const ng = grpRemap.get(l.groupIndex);
    const nt = tgtRemap.get(l.targetIndex);
    if (ng != null && nt != null && l.value > 0) {
      keptLinks.push(l);
      keptOrig.push(k);
    }
  });

  // Explicit time-aware funding (see the leftHop option): per-(source,
  // input-link) funded cents plus per-source surplus. Sources filter like
  // the legacy path (positive only) with indices remapped; funding that
  // references a dropped row or link is skipped (defensive: well-formed
  // view models never produce it).
  const leftHop = opts.leftHop ?? null;
  const keptPosByOrig = new Map<number, number>();
  keptOrig.forEach((orig, kp) => keptPosByOrig.set(orig, kp));
  const keptFunded = new Array<number>(keptLinks.length).fill(0);
  const keptFunding: Map<number, number>[] = keptLinks.map(() => new Map());
  const explicitSrc: MergedSpendingItem[] = [];
  let remainingMapped: number[] = [];
  if (leftHop != null) {
    const srcRemap = new Map<number, number>();
    sources.forEach((s, i) => {
      if (s.value > 0) {
        srcRemap.set(i, explicitSrc.length);
        explicitSrc.push(s);
      }
    });
    remainingMapped = explicitSrc.map(() => 0);
    sources.forEach((_, i) => {
      const s = srcRemap.get(i);
      if (s == null) return;
      remainingMapped[s] = leftHop.remainingBySource[i] ?? 0;
    });
    for (const c of leftHop.cells) {
      const s = srcRemap.get(c.sourceIndex);
      const kp = keptPosByOrig.get(c.rightLinkIndex);
      if (s == null || kp == null || !(c.value > 0)) continue;
      keptFunding[kp]!.set(s, (keptFunding[kp]!.get(s) ?? 0) + c.value);
      keptFunded[kp] = (keptFunded[kp] ?? 0) + c.value;
    }
  }

  // Left hop values: incomes feed the groups proportionally (legacy), or
  // through the explicit per-cell funding above; any surplus feeds
  // Remaining the same way (the plug is last by position).
  const left: {
    sources: MergedSpendingItem[];
    targets: MergedSpendingItem[];
    links: DirectFlowLinkValue[];
    incomeTotal: number;
    spendingTotal: number;
  } = (() => {
    if (leftHop == null) return computeDirectFlowLinks(sources, grpItems);
    const bandAcc = new Map<string, number>();
    keptLinks.forEach((l, kp) => {
      // Kept links passed the remap filter above, so the middle resolves.
      const m = grpRemap.get(l.groupIndex)!;
      for (const [s, v] of keptFunding[kp]!) {
        const key = `${m}:${s}`;
        bandAcc.set(key, (bandAcc.get(key) ?? 0) + v);
      }
    });
    const links: DirectFlowLinkValue[] = [];
    for (let m = 0; m < grpItems.length; m++) {
      for (let s = 0; s < explicitSrc.length; s++) {
        const value = bandAcc.get(`${m}:${s}`) ?? 0;
        if (value > 0) links.push({ sourceIndex: s, targetIndex: m, value });
      }
    }
    const plugValue = remainingMapped.reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
    const plugTargets: MergedSpendingItem[] =
      plugValue > 0
        ? [...grpItems, { name: REMAINING_LABEL, value: plugValue, mergedCount: 1 }]
        : [...grpItems];
    if (plugValue > 0) {
      remainingMapped.forEach((v, s) => {
        if (v > 0) links.push({ sourceIndex: s, targetIndex: grpItems.length, value: v });
      });
    }
    return {
      sources: explicitSrc,
      targets: plugTargets,
      links,
      incomeTotal: explicitSrc.reduce((sum, s) => sum + s.value, 0),
      spendingTotal: grpItems.reduce((sum, g) => sum + g.value, 0),
    };
  })();
  const { incomeTotal, spendingTotal } = left;
  const flowTotal = Math.max(incomeTotal, spendingTotal);
  const coverage = spendingTotal > 0 ? Math.min(1, incomeTotal / spendingTotal) : 1;
  const hasRemaining = leftHop != null
    ? left.targets.length > grpItems.length
    : incomeTotal > spendingTotal;
  const plugIndex = left.targets.length - 1;

  // Right column: spending targets plus the surplus plug. Funded values use
  // the uniform coverage ratio in the legacy path (which is 1 whenever
  // Remaining exists, so the plug is always fully funded); the explicit
  // path funds each target by its cells below, once rightVals exists.
  const rightItems: MergedSpendingItem[] = hasRemaining
    ? [...tgtItems, left.targets[plugIndex]!]
    : [...tgtItems];
  const remainingTargetIndex = hasRemaining ? rightItems.length - 1 : null;

  if (rightItems.length === 0 || flowTotal <= 0 || width <= 0 || height <= 0) {
    return {
      incomeTotal,
      spendingTotal,
      flowTotal,
      pxPerCent: 0,
      linkFloor,
      contentHeight: Math.max(0, height),
      sources: [],
      middles: [],
      targets: [],
      remainingTargetIndex: null,
      remainingLaneY: null,
      remainingLaneOverflow: 0,
      linksLeft: [],
      linksRight: [],
      leftCells: [],
      sourceFills: [],
      middleFills: [],
      sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
      middleLabelX: midX + nodeWidth + SANKEY_MIDDLE_LABEL_GAP,
      targetLabelX: width - padRight,
    };
  }

  const srcItems = left.sources;
  const nS = srcItems.length;
  const nM = grpItems.length;
  const nR = rightItems.length;
  const nMax = Math.max(nS, nM, nR);

  const availH = Math.max(0, height - padTop - padBottom);
  // The longest column's gaps cap the shared gap so all columns fit.
  let gap = nodeGap;
  if (nMax > 1 && gap * (nMax - 1) > availH) {
    gap = Math.max(0, (availH - nMax) / (nMax - 1));
  }
  const bandH = Math.max(0, availH - gap * (nMax - 1));

  // ONE linear scale for the whole chart: every band above the visibility
  // floor draws at exactly value * pxPerCent on both hops. Nothing is ever
  // taken from large bands to fund small ones — no stealing, no crush, so
  // the largest flow always draws the largest bar.
  const pxPerCent = flowTotal > 0 && bandH > 0 ? bandH / flowTotal : 0;
  const flooredBand = (fundedValue: number): number =>
    fundedValue > 0 ? Math.max(fundedValue * pxPerCent, linkFloor) : 0;

  // Right hop values: exact rollup cells at the uniform coverage ratio
  // (legacy), or at their explicit funded value (a fully unfunded cell
  // drops out of the geometry; its shortfall shows in tooltips only).
  // Sorted by (middle, target) so bands run in target order within a
  // middle and in middle order within a target.
  const rightVals = keptLinks
    .map((l, kp) => ({
      middleIndex: grpRemap.get(l.groupIndex) ?? -1,
      targetIndex: tgtRemap.get(l.targetIndex) ?? -1,
      value: leftHop != null ? (keptFunded[kp] ?? 0) : l.value * coverage,
      kp,
    }))
    .filter((l) => l.middleIndex >= 0 && l.targetIndex >= 0 && l.value > 0)
    .sort((a, b) => a.middleIndex - b.middleIndex || a.targetIndex - b.targetIndex);

  // Group ribbon indices per column. left.links is middle-major; Remaining
  // entries (the trailing plug-major run) split off into remIn.
  const midIn: number[][] = grpItems.map(() => []);
  const remIn: number[] = [];
  const srcOut: number[][] = srcItems.map(() => []);
  left.links.forEach((l, k) => {
    if (hasRemaining && l.targetIndex === plugIndex) remIn.push(k);
    else midIn[l.targetIndex]?.push(k);
    srcOut[l.sourceIndex]?.push(k);
  });
  const midOut: number[][] = grpItems.map(() => []);
  const tgtIn: number[][] = tgtItems.map(() => []);
  rightVals.forEach((l, k) => {
    midOut[l.middleIndex]?.push(k);
    tgtIn[l.targetIndex]?.push(k);
  });

  // Ribbon pixel heights derive from VALUES directly (never from bars, so
  // a floored bar can never stretch its bands and a crowded column can
  // never shrink them): each right-hop cell band and each Remaining plug
  // band draws at max(funded * scale, floor). Bars wrap the bands below.
  const linkRH = rightVals.map((cell) => flooredBand(cell.value));
  const linkLH = new Array<number>(left.links.length).fill(0);
  for (const k of remIn) {
    linkLH[k] = flooredBand(left.links[k]?.value ?? 0);
  }
  const rightUnfundedH: number[] = rightItems.map(() => 0);

  // Target bars wrap their incoming bands exactly: spending targets sum
  // their cells, the Remaining plug sums its plug bands. There is no
  // unfunded segment in the geometry — the shortfall shows in tooltips
  // and the header only.
  const rightH = rightItems.map((_t, j) => {
    if (remainingTargetIndex === j) {
      return remIn.reduce((s, k) => s + (linkLH[k] ?? 0), 0);
    }
    return (tgtIn[j] ?? []).reduce((s, k) => s + (linkRH[k] ?? 0), 0);
  });

  // Middle bars wrap their outgoing bands exactly. With no income there
  // are no bands and every bar is zero-height (labels still show via the
  // reserved pitch below).
  const outStack = grpItems.map((_, i) =>
    (midOut[i] ?? []).reduce((s, k) => s + (linkRH[k] ?? 0), 0)
  );
  const midH = [...outStack];
  const midFunded =
    leftHop != null
      ? grpItems.map((_, i) =>
          // midOut is dense over the middles; rightVals indices resolve.
          midOut[i]!.reduce((s, k) => s + rightVals[k]!.value, 0)
        )
      : grpItems.map((g) => g.value * coverage);
  const midUnfundedH = grpItems.map(() => 0);

  // Funded cents per right-column target: the uniform share in the legacy
  // path, the cells' funded sum in the explicit path (the plug is always
  // fully funded — it only exists when income exceeds spending).
  const rightFunded =
    leftHop != null
      ? rightItems.map((t, j) =>
          // Non-plug targets index tgtIn (dense); the plug is fully funded.
          remainingTargetIndex === j
            ? t.value
            : tgtIn[j]!.reduce((s, k) => s + rightVals[k]!.value, 0)
        )
      : rightItems.map((t) => t.value * coverage);

  // Drawn weight of one explicit sub-ribbon: its cell's DRAWN band height
  // times its share of the cell's funded value. Weights tile both edges
  // exactly (each cell's block lands at exactly its outgoing thickness),
  // so explicit sub-ribbons never taper — the value-proportional formula
  // below only fits uniform funding, where every band shares every cell.
  const explicitSubWeight = (rk: number, sourceIndex: number): number => {
    const cell = rightVals[rk]!;
    const funded = cell.value;
    if (!(funded > 0)) return 0;
    // The per-(cell, source) map is genuinely sparse: most pairs are
    // unfunded, which is exactly what this reports.
    const v = keptFunding[cell.kp]!.get(sourceIndex) ?? 0;
    if (!(v > 0)) return 0;
    return (linkRH[rk]! * v) / funded;
  };

  // Left group-ribbon heights subdivide each middle's outgoing stack in
  // proportion to their values: bands tile the stack from the bar's top
  // edge, so the incoming stack always equals the outgoing stack exactly —
  // no slack on either side, no stretching. The explicit cells path sums
  // the sub-ribbon drawn weights instead (same total, exact per-slice
  // tiling on both edges).
  for (let i = 0; i < grpItems.length; i++) {
    const stackH = outStack[i] ?? 0;
    const fj = midFunded[i] ?? 0;
    if (leftHop != null && leftDetail === "cells") {
      for (const k of midIn[i]!) {
        let w = 0;
        for (const rk of midOut[i]!) {
          w += explicitSubWeight(rk, left.links[k]!.sourceIndex);
        }
        linkLH[k] = w;
      }
    } else if (fj > 0) {
      for (const k of midIn[i] ?? []) {
        linkLH[k] = stackH * ((left.links[k]?.value ?? 0) / fj);
      }
    }
  }

  // Sources wrap their outgoing bands exactly (group ribbons plus any
  // full-width Remaining ribbons).
  const bandSum = srcItems.map((_, i) =>
    (srcOut[i] ?? []).reduce((s, k) => s + (linkLH[k] ?? 0), 0)
  );
  const leftH = [...bandSum];

  const srcNodes: SankeyNodeLayout[] = srcItems.map((s, i) => ({
    name: s.name,
    value: s.value,
    mergedCount: s.mergedCount,
    bucket: s.bucket === true,
    share: s.value / flowTotal,
    x: padLeft,
    y: 0, // placed by the stacking pass below
    w: nodeWidth,
    h: Math.max(0, leftH[i] ?? 0),
    fill: SANKEY_INCOME_COLOR,
    labelY: 0, // placed by the stacking pass below
  }));
  const midNodes: GroupedSankeyMiddleNode[] = grpItems.map((g, i) => ({
    name: g.name,
    value: g.value,
    mergedCount: g.mergedCount,
    bucket: g.bucket === true,
    share: g.value / flowTotal,
    x: midX,
    y: 0, // placed by the stacking pass below
    w: nodeWidth,
    h: Math.max(0, midH[i] ?? 0),
    fill: sankeyTargetColor({ name: g.name, bucket: g.bucket === true, isPlug: false }),
    labelY: 0, // placed by the stacking pass below
    fundedValue: midFunded[i] ?? 0,
    unfundedValue: g.value - (midFunded[i] ?? 0),
    unfundedH: midUnfundedH[i] ?? 0,
  }));
  const tgtNodes: DirectSankeyTargetNode[] = rightItems.map((t, j) => ({
    name: t.name,
    value: t.value,
    mergedCount: t.mergedCount,
    bucket: t.bucket === true,
    share: t.value / flowTotal,
    x: nodeX,
    y: 0, // placed by the stacking pass below
    w: nodeWidth,
    h: Math.max(0, rightH[j] ?? 0),
    fill: sankeyTargetColor({
      name: t.name,
      bucket: t.bucket === true,
      isPlug: remainingTargetIndex === j,
    }),
    labelY: 0, // placed by the stacking pass below
    fundedValue: rightFunded[j] ?? 0,
    unfundedValue: t.value - (rightFunded[j] ?? 0),
    unfundedH: rightUnfundedH[j] ?? 0,
  }));

  // Stack all columns top-down; bands accumulate from each bar's top edge.
  // Bar height and label pitch are decoupled: every row reserves at least
  // SANKEY_MIN_PITCH below its top edge, so hairline bars never pull their
  // labels onto each other. Labels anchor at labelY (bar center, or the
  // minimum offset for bars shorter than a label).
  const stackColumn = (nodes: SankeyNodeLayout[]): number => {
    let top = padTop;
    nodes.forEach((node, i) => {
      node.y = top;
      node.labelY = top + Math.max(node.h / 2, SANKEY_LABEL_CENTER_MIN);
      if (i < nodes.length - 1) top += Math.max(node.h + gap, SANKEY_MIN_PITCH);
    });
    return nodes.length === 0 ? padTop : top + (nodes[nodes.length - 1]?.h ?? 0);
  };
  const srcBottom = stackColumn(srcNodes);
  const midBottom = stackColumn(midNodes);
  const tgtBottom = stackColumn(tgtNodes);

  // Dedicated Remaining lane: one row gap below the last middle bar, so
  // plug ribbons bridge under the middle column instead of slashing
  // diagonally across its bars and the category ribbons. Lane spans tile in
  // remIn (source) order at the plug bands' own heights — no taper, and the
  // lane sums to the plug bar height exactly. No lane when there is no plug
  // or no middle column (with no middles the plug ribbon crosses nothing,
  // so it stays a straight ribbon).
  let remainingLaneY: number | null = null;
  let remainingLaneOverflow = 0;
  let laneBottom = midBottom;
  const laneBand = new Map<number, { ly0: number; ly1: number }>();
  const lastMid = midNodes[midNodes.length - 1];
  if (remainingTargetIndex != null && lastMid != null && remIn.length > 0) {
    const laneY = lastMid.y + lastMid.h + gap;
    remainingLaneY = laneY;
    let ly = laneY;
    for (const k of remIn) {
      const h = linkLH[k] ?? 0;
      laneBand.set(k, { ly0: ly, ly1: ly + h });
      ly += h;
    }
    laneBottom = ly;
    remainingLaneOverflow = Math.max(0, ly - (height - padBottom));
  }

  const linksLeft: DirectSankeyLinkLayout[] = left.links.map((l, k) => {
    // targetIndex keys into middles; the Remaining ribbons carry the plug
    // index (one past the last middle) and land on remainingTargetIndex.
    const isPlug = hasRemaining && l.targetIndex === plugIndex;
    const targetName = left.targets[l.targetIndex]?.name ?? "";
    const link: DirectSankeyLinkLayout = {
      name: targetName,
      value: l.value,
      mergedCount: 1,
      sourceIndex: l.sourceIndex,
      targetIndex: l.targetIndex,
      sourceName: srcItems[l.sourceIndex]?.name ?? "",
      targetName,
      fill:
        isPlug && remainingTargetIndex != null
          ? (tgtNodes[remainingTargetIndex]?.fill ?? REMAINING_COLOR)
          : (midNodes[l.targetIndex]?.fill ?? SANKEY_INCOME_COLOR),
      sy0: 0,
      sy1: 0,
      ty0: 0,
      ty1: 0,
      x0: linkLX0,
      x1: isPlug ? linkRX1 : midX,
      d: "",
    };
    // Lane-routed plug ribbons carry their lane span (keyed by left.links
    // index — remIn collects exactly the plug entries, in order).
    const band = isPlug ? laneBand.get(k) : undefined;
    if (band != null) {
      link.ly0 = band.ly0;
      link.ly1 = band.ly1;
    }
    return link;
  });
  for (let i = 0; i < srcNodes.length; i++) {
    let sy = srcNodes[i]!.y;
    for (const k of srcOut[i] ?? []) {
      const h = linkLH[k] ?? 0;
      linksLeft[k]!.sy0 = sy;
      linksLeft[k]!.sy1 = sy + h;
      sy += h;
    }
  }
  // Group bands stack within their middle bar; Remaining bands stack within
  // the Remaining bar on the right (source order — the plug-major run).
  for (let i = 0; i < midNodes.length; i++) {
    let ty = midNodes[i]!.y;
    for (const k of midIn[i] ?? []) {
      const h = linkLH[k] ?? 0;
      linksLeft[k]!.ty0 = ty;
      linksLeft[k]!.ty1 = ty + h;
      ty += h;
    }
  }
  if (remainingTargetIndex != null) {
    let ty = tgtNodes[remainingTargetIndex]!.y;
    for (const k of remIn) {
      const h = linkLH[k] ?? 0;
      linksLeft[k]!.ty0 = ty;
      linksLeft[k]!.ty1 = ty + h;
      ty += h;
    }
  }

  // One ribbon per cell: rightVals is (middle, target) sorted, so bands
  // run in target order within a middle (via midOut) and in middle order
  // within a target (via tgtIn). With no income there are no cells
  // (coverage is 0), so linksRight is empty — never a sourceless ribbon.
  // The bands render in the target's color (see the type docs); hovering
  // an income spotlights every downstream cell in full instead of tracing
  // one income's sliver through each cell.
  const linksRight: GroupedRightLinkLayout[] = rightVals.map((cell) => ({
    name: tgtItems[cell.targetIndex]?.name ?? "",
    value: cell.value,
    mergedCount: 1,
    sourceIndex: cell.middleIndex,
    targetIndex: cell.targetIndex,
    sourceName: grpItems[cell.middleIndex]?.name ?? "",
    targetName: tgtItems[cell.targetIndex]?.name ?? "",
    fill: tgtNodes[cell.targetIndex]?.fill ?? "#888",
    sy0: 0,
    sy1: 0,
    ty0: 0,
    ty1: 0,
    x0: linkRX0,
    x1: linkRX1,
    d: "",
  }));
  for (let i = 0; i < midNodes.length; i++) {
    let sy = midNodes[i]!.y;
    for (const k of midOut[i] ?? []) {
      const h = linkRH[k] ?? 0;
      linksRight[k]!.sy0 = sy;
      linksRight[k]!.sy1 = sy + h;
      sy += h;
    }
  }
  for (let j = 0; j < tgtItems.length; j++) {
    let ty = tgtNodes[j]!.y;
    for (const k of tgtIn[j] ?? []) {
      const h = linkRH[k] ?? 0;
      linksRight[k]!.ty0 = ty;
      linksRight[k]!.ty1 = ty + h;
      ty += h;
    }
  }
  for (const l of linksLeft) {
    // Lane-routed plug ribbons dip under the middle column (bridging its
    // bar column [midX, linkRX0]); every other ribbon stays a straight
    // bar-to-bar bezier.
    l.d =
      l.ly0 != null && l.ly1 != null
        ? remainingLanePath(
            l.x0,
            midX,
            linkRX0,
            l.x1,
            l.sy0,
            l.sy1,
            l.ly0,
            l.ly1,
            l.ty0,
            l.ty1
          )
        : ribbonPath(l.x0, l.x1, l.sy0, l.sy1, l.ty0, l.ty1);
  }
  for (const l of linksRight) {
    l.d = ribbonPath(l.x0, l.x1, l.sy0, l.sy1, l.ty0, l.ty1);
  }

  // Left-hop subdivision (leftDetail "cells" only): each income→middle band
  // splits into one sub-ribbon per downstream cell, in the cell's target
  // color. Siblings tile the source band edge to edge in cell order (the
  // same order the cells leave the middle on the right), weighed by the
  // cells' DRAWN heights — minimum-floored cells included — so the split
  // matches the outgoing side exactly. The target slots instead tile each
  // middle's incoming stack in cell-major order (all incomes' slices of
  // one cell adjacent), so each color enters the middle as one contiguous
  // block at exactly the thickness it leaves it. Plug bands and degenerate
  // bands (no cells, no funded flow) stay whole: they have no entry here
  // and render from linksLeft.
  const leftCells: GroupedLeftCellLayout[] = [];
  if (leftDetail === "cells") {
    for (let m = 0; m < midNodes.length; m++) {
      const cells = midOut[m] ?? [];
      const ins = midIn[m] ?? [];
      const midTop = midNodes[m]!.y;
      const stackH = outStack[m] ?? 0;
      const fj = midFunded[m] ?? 0;
      if (cells.length === 0 || ins.length === 0 || !(stackH > 0) || !(fj > 0)) continue;
      if (leftHop != null) {
        // Explicit funding: one sub-ribbon per FUNDED (cell, income) pair
        // only — an unfunded pair draws nothing. Cell-major order keeps
        // each color's block contiguous at its outgoing thickness.
        const live: { rk: number; lk: number; w: number }[] = [];
        for (const rk of cells) {
          for (const lk of ins) {
            const w = explicitSubWeight(rk, linksLeft[lk]!.sourceIndex);
            if (w > 0) live.push({ rk, lk, w });
          }
        }
        if (live.length === 0) continue;
        const targetSpans = subdivideBandByValues(
          [midTop, midTop + stackH],
          live.map((e) => e.w)
        );
        if (targetSpans.length !== live.length) continue;
        const bandSubs = new Map<number, { rk: number; w: number; span: number }[]>();
        live.forEach((e, span) => {
          const list = bandSubs.get(e.lk) ?? [];
          list.push({ rk: e.rk, w: e.w, span });
          bandSubs.set(e.lk, list);
        });
        for (const lk of ins) {
          const subs = bandSubs.get(lk) ?? [];
          if (subs.length === 0) continue;
          const band = linksLeft[lk]!;
          const sourceSpans = subdivideBandByValues(
            [band.sy0, band.sy1],
            subs.map((e) => e.w)
          );
          if (sourceSpans.length !== subs.length) continue;
          subs.forEach((e, c) => {
            const src = sourceSpans[c]!;
            const tgt = targetSpans[e.span]!;
            const cell = rightVals[e.rk]!;
            const targetIndex = cell.targetIndex;
            // Live subs carry positive weight, which implies positive
            // funding — the entry always exists.
            const v = keptFunding[cell.kp]!.get(band.sourceIndex)!;
            leftCells.push({
              sourceIndex: band.sourceIndex,
              middleIndex: m,
              rightLinkIndex: e.rk,
              targetIndex,
              sourceName: band.sourceName,
              middleName: grpItems[m]?.name ?? "",
              targetName: tgtNodes[targetIndex]?.name ?? "",
              value: v,
              sy0: src.y0,
              sy1: src.y1,
              ty0: tgt.y0,
              ty1: tgt.y1,
              x0: band.x0,
              x1: band.x1,
              d: ribbonPath(band.x0, band.x1, src.y0, src.y1, tgt.y0, tgt.y1),
              fill: tgtNodes[targetIndex]?.fill ?? "#888",
            });
          });
        }
        continue;
      }
      const weights = cells.map((k) => linkRH[k] ?? 0);
      // Target slots: flat (cell, income) weights tile the incoming stack,
      // so each cell's block lands contiguously in outgoing cell order.
      const flat: number[] = [];
      for (const k of cells) {
        const h = linkRH[k] ?? 0;
        for (const lk of ins) {
          flat.push((h * (left.links[lk]?.value ?? 0)) / fj);
        }
      }
      const targetSpans = subdivideBandByValues([midTop, midTop + stackH], flat);
      if (targetSpans.length !== flat.length) continue;
      for (const lk of ins) {
        const band = linksLeft[lk]!;
        const sourceSpans = subdivideBandByValues([band.sy0, band.sy1], weights);
        if (sourceSpans.length !== cells.length) continue;
        const inPos = ins.indexOf(lk);
        cells.forEach((rk, c) => {
          const src = sourceSpans[c]!;
          const tgt = targetSpans[c * ins.length + inPos]!;
          const cell = rightVals[rk]!;
          const targetIndex = cell.targetIndex;
          leftCells.push({
            sourceIndex: band.sourceIndex,
            middleIndex: m,
            rightLinkIndex: rk,
            targetIndex,
            sourceName: band.sourceName,
            middleName: grpItems[m]?.name ?? "",
            targetName: tgtNodes[targetIndex]?.name ?? "",
            value: (cell.value * (left.links[lk]?.value ?? 0)) / fj,
            sy0: src.y0,
            sy1: src.y1,
            ty0: tgt.y0,
            ty1: tgt.y1,
            x0: band.x0,
            x1: band.x1,
            d: ribbonPath(band.x0, band.x1, src.y0, src.y1, tgt.y0, tgt.y1),
            fill: tgtNodes[targetIndex]?.fill ?? "#888",
          });
        });
      }
    }
  }

  // One fill gradient per source bar from its outgoing bands' colors: the
  // per-cell slices in "cells" mode (same subdivision as the sub-ribbons,
  // so every segment meets its ribbon exactly), whole-band group colors in
  // "bands" mode. A bar with no outgoing bands falls back to solid gray.
  const sourceFills = srcNodes.map((bar, i) => {
    const bands: SankeyIncomeBand[] = [];
    for (const k of srcOut[i] ?? []) {
      const band = linksLeft[k]!;
      if (band.targetIndex >= midNodes.length) {
        bands.push({ y0: band.sy0, y1: band.sy1, color: band.fill });
        continue;
      }
      const subs = leftCells.filter(
        (c) => c.sourceIndex === i && c.middleIndex === band.targetIndex
      );
      if (subs.length === 0) {
        bands.push({ y0: band.sy0, y1: band.sy1, color: band.fill });
      } else {
        for (const s of subs) bands.push({ y0: s.sy0, y1: s.sy1, color: s.fill });
      }
    }
    return sankeyIncomeGradientStops(bar.y, bar.y + bar.h, bands, bar.fill);
  });

  // One fill gradient per middle bar from its outgoing cells' target
  // colors, so every segment meets its ribbon exactly. A bar with no
  // outgoing bands falls back to its solid group color.
  const middleFills = midNodes.map((bar, i) => {
    const bands: SankeyIncomeBand[] = [];
    for (const k of midOut[i] ?? []) {
      const cell = linksRight[k]!;
      bands.push({ y0: cell.sy0, y1: cell.sy1, color: cell.fill });
    }
    return sankeyIncomeGradientStops(bar.y, bar.y + bar.h, bands, bar.fill);
  });

  const contentHeight =
    Math.max(srcBottom, midBottom, tgtBottom, laneBottom) + padBottom;

  return {
    incomeTotal,
    spendingTotal,
    flowTotal,
    pxPerCent,
    linkFloor,
    contentHeight,
    sources: srcNodes,
    middles: midNodes,
    targets: tgtNodes,
    remainingTargetIndex,
    remainingLaneY,
    remainingLaneOverflow,
    linksLeft,
    linksRight,
    leftCells,
    sourceFills,
    middleFills,
    sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
    middleLabelX: midX + nodeWidth + SANKEY_MIDDLE_LABEL_GAP,
    targetLabelX: nodeX + nodeWidth + 8,
  };
}

/**
 * Auto-fit "Under" threshold in whole dollars (always one of `stops`): the
 * smallest stop whose merged layout fits `containerHeight`, so the Sankey
 * shows fully on first paint with no amounts under the fold. Fit is
 * measured with the real layout (contentHeight at the container height),
 * not a row-count heuristic, so bars, pitch, and the Remaining lane all
 * count exactly as rendered.
 *
 * When no stop fits, returns the stop with the smallest contentHeight —
 * ties prefer the smaller stop — so the chart gets as close to the
 * viewport as merging allows. Empty stops yield 0. Callers pass the
 * measured container height.
 *
 * Pass the view's monthly series (when it has one) so the probe lays out
 * the same time-aware funding the chart will draw; without it the probe
 * uses the legacy proportional split.
 */
export function sankeyAutoFitThreshold(
  groups: SpendingBreakdownItem[],
  targets: SpendingBreakdownItem[],
  links: SpendingGroupFlowLink[],
  income: SpendingBreakdownItem[],
  stops: readonly number[],
  containerHeight: number,
  series?: MonthlySankeySeries
): number {
  if (stops.length === 0) return 0;
  let fallback = stops[0] ?? 0;
  let fallbackHeight = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const thresholdCents = Math.round(stop * 100);
    // Width is irrelevant to heights (the y-geometry never reads x), so a
    // fixed width keeps the probe reproducible; height is the container's.
    const probeOpts = {
      width: 800,
      height: Math.max(0, containerHeight),
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
    };
    const probe =
      series != null
        ? (() => {
            const vm = computeSankeyViewModel({ groups, targets, links }, income, series, {
              thresholdCents,
            });
            return layoutGroupedIncomeSankey(vm.sources, vm.groups, vm.targets, vm.links, {
              ...probeOpts,
              leftHop: vm.left,
            });
          })()
        : (() => {
            const merged = mergeGroupFlow(groups, targets, links, thresholdCents);
            const mergedIncome = mergeBelowThreshold(income, thresholdCents);
            return layoutGroupedIncomeSankey(
              mergedIncome.items,
              merged.groups,
              merged.targets,
              merged.links,
              probeOpts
            );
          })();
    if (probe.contentHeight < fallbackHeight) {
      fallbackHeight = probe.contentHeight;
      fallback = stop;
    }
    if (probe.contentHeight <= containerHeight) return stop;
  }
  return fallback;
}
