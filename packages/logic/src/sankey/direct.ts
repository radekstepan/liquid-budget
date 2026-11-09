import type { SankeyGeometryOptions, SankeyLinkLayout, SankeyNodeLayout } from "./geometry.js";
import { SANKEY_SOURCE_LABEL_GAP, resolveNodeHeights, ribbonPath } from "./geometry.js";
import { REMAINING_LABEL, computeDirectFlowLinks } from "./flow.js";
import type { MergedSpendingItem } from "./merge.js";
import { sankeyTargetColor } from "./style.js";

export type DirectSankeyTargetNode = SankeyNodeLayout & {
  /** Funded cents; incoming ribbons sum to this. */
  fundedValue: number;
  /** Unfunded cents (0 unless spending exceeds income). */
  unfundedValue: number;
  /**
   * Height of the unfunded segment at the node's bottom edge (px). Always
   * 0 in the grouped layout, whose bars wrap their funded flow (the
   * shortfall shows in tooltips and the header only); the legacy direct
   * layout still reserves the segment.
   */
  unfundedH: number;
};

export type DirectSankeyLinkLayout = SankeyLinkLayout & {
  sourceIndex: number;
  targetIndex: number;
  sourceName: string;
  targetName: string;
  /** Exact flat fill for the ribbon (the final destination's color). */
  fill: string;
  /**
   * Lane band vertical span at the middle-column bridge — present only on
   * lane-routed Remaining plug ribbons (see remainingLanePath). The ribbon
   * drops from its source band into this span, bridges under the middle
   * bars, then traverses to its target band; spans tile the lane in source
   * order with no taper (ly1 - ly0 equals the source and target heights).
   */
  ly0?: number;
  ly1?: number;
};

export type DirectIncomeSankeyLayout = {
  incomeTotal: number;
  spendingTotal: number;
  /** Height-scale denominator: max(income, spending). */
  flowTotal: number;
  /** Left column: one bar per income source. */
  sources: SankeyNodeLayout[];
  /** Right column: one bar per spending group (plus Remaining when unspent). */
  targets: DirectSankeyTargetNode[];
  /** One ribbon per (source, target) pair, target-major. */
  links: DirectSankeyLinkLayout[];
  /** x for end-anchored income labels (left of the source column). */
  sourceLabelX: number;
  /** x for start-anchored target labels (right of the target column). */
  targetLabelX: number;
};

/**
 * Lay out a two-column direct money-flow Sankey: income sources (left) flow
 * DIRECTLY into spending groups (right) — there is no middle Total bar.
 * Ribbon values come from computeDirectFlowLinks (fungible proportional
 * allocation), so each expense visibly draws from each income.
 *
 * Geometry contract (covered by unit tests):
 * - The expense (right) column owns the pixel scale: target bars resolve via
 *   resolveNodeHeights, incoming bands exactly fill each bar's funded region
 *   (top-aligned; the unfunded segment, if any, sits at the bar's bottom),
 *   and bands within a bar split its height in proportion to their values.
 * - The income (left) column wraps its outgoing bands: each source bar is
 *   exactly its bands' height, water-filled up to the minimum node height
 *   from leftover plot space (never overflowing it).
 * - Every ribbon has equal height at both ends (no taper): `sy1 - sy0` sums
 *   to the source bar's band region and `ty1 - ty0` to the target's funded
 *   region. Bands within a source run in target order; bands within a target
 *   run in source order.
 * - Node `share` is value/flowTotal on both sides, matching drawn heights.
 * - Degenerate input (no positive values, or a non-positive dimension)
 *   yields no nodes — never NaN geometry.
 *
 * Callers should size height with sankeyContentHeight over the LONGER column
 * (see the readability contract above); the layout never exceeds the padded
 * plot area, but rows below the minimum pitch may touch.
 */
export function layoutDirectIncomeSankey(
  sources: MergedSpendingItem[],
  spending: MergedSpendingItem[],
  opts: SankeyGeometryOptions
): DirectIncomeSankeyLayout {
  const {
    width,
    height,
    nodeWidth = 14,
    nodeGap = 6,
    minNodeHeight = 8,
    padLeft = 8,
    padRight = 8,
    padTop = 8,
    padBottom = 8,
  } = opts;

  const model = computeDirectFlowLinks(sources, spending);
  const { incomeTotal, spendingTotal } = model;
  const flowTotal = Math.max(incomeTotal, spendingTotal);

  if (model.targets.length === 0 || flowTotal <= 0 || width <= 0 || height <= 0) {
    return {
      incomeTotal,
      spendingTotal,
      flowTotal,
      sources: [],
      targets: [],
      links: [],
      sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
      targetLabelX: width - padRight,
    };
  }

  const srcItems = model.sources;
  const tgtItems = model.targets;
  const nS = srcItems.length;
  const nT = tgtItems.length;
  const nMax = Math.max(nS, nT);

  const availH = Math.max(0, height - padTop - padBottom);
  // The longer column's gaps cap the shared gap so both columns fit.
  let gap = nodeGap;
  if (nMax > 1 && gap * (nMax - 1) > availH) {
    gap = Math.max(0, (availH - nMax) / (nMax - 1));
  }
  const bandH = Math.max(0, availH - gap * (nMax - 1));

  // Right column owns the scale; resolveNodeHeights guarantees the bars plus
  // the longer column's gaps fit the plot.
  const rightH = resolveNodeHeights(
    tgtItems.map((t) => t.value),
    bandH,
    minNodeHeight
  );

  // Group ribbon indices per side (model.links is target-major, so groups
  // stay in input order on both sides).
  const byTarget: number[][] = tgtItems.map(() => []);
  const bySource: number[][] = srcItems.map(() => []);
  model.links.forEach((l, k) => {
    byTarget[l.targetIndex]?.push(k);
    bySource[l.sourceIndex]?.push(k);
  });

  // Ribbon pixel heights, derived from the target side so bands exactly fill
  // each bar's funded region.
  const linkH = new Array<number>(model.links.length).fill(0);
  const unfundedH: number[] = tgtItems.map((t, j) => {
    const nodeH = rightH[j] ?? 0;
    const fundedPx = t.value > 0 ? nodeH * ((model.funded[j] ?? 0) / t.value) : 0;
    const fj = model.funded[j] ?? 0;
    if (fj > 0) {
      for (const k of byTarget[j] ?? []) {
        linkH[k] = fundedPx * ((model.links[k]?.value ?? 0) / fj);
      }
    }
    return Math.max(0, nodeH - fundedPx);
  });

  // Left column wraps its outgoing bands, water-filled to the minimum height
  // from leftover space: total bands fit bandH (a subset of the right bars),
  // so the fill can never push the column past the plot.
  const bandSum = srcItems.map((_, i) =>
    (bySource[i] ?? []).reduce((s, k) => s + (linkH[k] ?? 0), 0)
  );
  const totalBands = bandSum.reduce((s, b) => s + b, 0);
  const gapsLeft = gap * Math.max(0, nS - 1);
  const minH = nS > 0 ? Math.min(minNodeHeight, (availH - gapsLeft) / nS) : 0;
  const tiny = bandSum.filter((b) => b < minH).length;
  const extra = Math.max(0, availH - gapsLeft - totalBands);
  const effMin = tiny > 0 ? Math.min(minH, extra / tiny) : minH;
  const leftH = bandSum.map((b) => Math.max(b, effMin));

  const nodeX = Math.max(padLeft + nodeWidth + 24, width - padRight - nodeWidth);
  const linkX0 = padLeft + nodeWidth;
  const linkX1 = nodeX;

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
    fill: sankeyTargetColor({ name: s.name, bucket: s.bucket === true, isPlug: false }),
    labelY: 0, // placed by the stacking pass below
  }));
  const tgtNodes: DirectSankeyTargetNode[] = tgtItems.map((t, j) => ({
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
      isPlug: incomeTotal > spendingTotal && j === tgtItems.length - 1 && t.name === REMAINING_LABEL,
    }),
    labelY: 0, // placed by the stacking pass below
    fundedValue: model.funded[j] ?? 0,
    unfundedValue: model.unfunded[j] ?? 0,
    unfundedH: unfundedH[j] ?? 0,
  }));

  // Stack both columns top-down; bands accumulate from each bar's top edge.
  let y = padTop;
  for (let i = 0; i < srcNodes.length; i++) {
    srcNodes[i]!.y = y;
    srcNodes[i]!.labelY = y + (leftH[i] ?? 0) / 2;
    y += (leftH[i] ?? 0) + gap;
  }
  y = padTop;
  for (let j = 0; j < tgtNodes.length; j++) {
    tgtNodes[j]!.y = y;
    tgtNodes[j]!.labelY = y + (rightH[j] ?? 0) / 2;
    y += (rightH[j] ?? 0) + gap;
  }

  const links: DirectSankeyLinkLayout[] = model.links.map((l) => ({
    name: tgtItems[l.targetIndex]?.name ?? "",
    value: l.value,
    mergedCount: 1,
    sourceIndex: l.sourceIndex,
    targetIndex: l.targetIndex,
    sourceName: srcItems[l.sourceIndex]?.name ?? "",
    targetName: tgtItems[l.targetIndex]?.name ?? "",
    fill: tgtNodes[l.targetIndex]?.fill ?? "#888",
    sy0: 0,
    sy1: 0,
    ty0: 0,
    ty1: 0,
    x0: linkX0,
    x1: linkX1,
    d: "",
  }));
  for (let i = 0; i < srcNodes.length; i++) {
    let sy = srcNodes[i]!.y;
    for (const k of bySource[i] ?? []) {
      const h = linkH[k] ?? 0;
      links[k]!.sy0 = sy;
      links[k]!.sy1 = sy + h;
      sy += h;
    }
  }
  for (let j = 0; j < tgtNodes.length; j++) {
    let ty = tgtNodes[j]!.y;
    for (const k of byTarget[j] ?? []) {
      const h = linkH[k] ?? 0;
      links[k]!.ty0 = ty;
      links[k]!.ty1 = ty + h;
      ty += h;
    }
  }
  for (const l of links) {
    l.d = ribbonPath(l.x0, l.x1, l.sy0, l.sy1, l.ty0, l.ty1);
  }

  return {
    incomeTotal,
    spendingTotal,
    flowTotal,
    sources: srcNodes,
    targets: tgtNodes,
    links,
    sourceLabelX: padLeft - SANKEY_SOURCE_LABEL_GAP,
    targetLabelX: nodeX + nodeWidth + 8,
  };
}
