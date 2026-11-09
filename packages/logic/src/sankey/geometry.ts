import type { SankeyLeftHopModel } from "./funding.js";
import type { MergedSpendingItem } from "./merge.js";
import { sankeyTargetColor } from "./style.js";

export type SankeyGeometryOptions = {
  /** Total SVG width/height in px. */
  width: number;
  height: number;
  /** Width of the source and target node bars. Defaults to 14. */
  nodeWidth?: number;
  /** Vertical gap between target nodes. Defaults to 6. */
  nodeGap?: number;
  /**
   * Minimum drawn node height so tiny flows stay hoverable. Defaults to 8.
   * Legacy two-column layouts only — the grouped layout sizes bars from
   * their bands (see minLinkHeight) and reserves label pitch separately,
   * so it ignores this option.
   */
  minNodeHeight?: number;
  /**
   * Minimum drawn band height in the grouped layout: every right-hop cell
   * band and every Remaining plug band draws at least this thick, so tiny
   * flows stay visible as hairlines instead of vanishing. Bars wrap their
   * bands exactly — nothing is ever taken from large bars to fund the
   * floor (no stealing, no crush). Defaults to SANKEY_MIN_LINK_HEIGHT.
   * Legacy layouts ignore this option.
   */
  minLinkHeight?: number;
  /**
   * Left-hop detail in the grouped layout: "bands" draws one whole ribbon
   * per income→middle band (plus the full-width Remaining ribbons);
   * "cells" additionally subdivides each band into one sub-ribbon per
   * downstream cell (leftCells), so each color crosses the middle at one
   * contiguous thickness. Defaults to "bands".
   */
  leftDetail?: "bands" | "cells";
  /**
   * Explicit time-aware funding for the grouped layout (see
   * computeSankeyViewModel): per-(source, right-hop cell) funded cents plus
   * per-source surplus. When present the layout aggregates these into the
   * income→middle bands and subdivides each band back into these exact
   * slices — a zero draws nothing. When absent the layout falls back to the
   * legacy report-wide proportional split (computeDirectFlowLinks).
   */
  leftHop?: SankeyLeftHopModel;
  /** Left gutter before the source node. Defaults to 8. */
  padLeft?: number;
  /** Right gutter after the target nodes (label zone). Defaults to 8. */
  padRight?: number;
  /** Top/bottom gutters. Default to 8. */
  padTop?: number;
  padBottom?: number;
};

export type SankeyNodeLayout = {
  name: string;
  value: number;
  mergedCount: number;
  /** True only for merged "Other" bucket bars (copied from the item). */
  bucket: boolean;
  share: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Exact flat fill for the bar. Targets render this; sources and middles
   * render their gradient stops (sourceFills/middleFills) and use this as
   * the no-bands fallback color.
   */
  fill: string;
  /**
   * Vertical center for the bar's two-line label, in SVG px. Bars shorter
   * than a label still anchor the label clear of neighbors (the layout
   * reserves label pitch per row), so rendering positions labels here
   * verbatim — never recomputed view-side.
   */
  labelY: number;
};

export type SankeyLinkLayout = {
  name: string;
  value: number;
  mergedCount: number;
  /** Source band vertical span (left edge). */
  sy0: number;
  sy1: number;
  /** Target band vertical span (right edge) — equals the node span. */
  ty0: number;
  ty1: number;
  x0: number;
  x1: number;
  /** Closed ribbon path from the source band to the target band. */
  d: string;
};

export type SankeyLayout = {
  total: number;
  /** Source ("Total") node bar; h is 0 when there is no data. */
  source: { x: number; y: number; w: number; h: number };
  nodes: SankeyNodeLayout[];
  links: SankeyLinkLayout[];
  /** x where target-node labels should start (right of the node column). */
  labelX: number;
};

// ---------------------------------------------------------------------------
// Readability contract shared with the view: minimum geometry that keeps
// two-line node labels from overlapping each other and keeps the TOTAL
// captions clear of the source bar. Legacy layouts size the chart with
// sankeyContentHeight; the grouped layout reserves SANKEY_MIN_PITCH per
// row itself and reports its canvas need as contentHeight.
// ---------------------------------------------------------------------------

/** Minimum node height: a two-line label (name + amount) needs a 24px row. */
export const SANKEY_NODE_MIN_HEIGHT = 24;
/** Vertical gap between nodes; pitch = height + gap = 32px per row. */
export const SANKEY_NODE_GAP = 8;
/** Minimum vertical pitch per node so adjacent two-line labels never touch. */
export const SANKEY_MIN_PITCH = SANKEY_NODE_MIN_HEIGHT + SANKEY_NODE_GAP;
/**
 * Minimum drawn band height in the grouped layout: every right-hop cell
 * band and every Remaining plug band draws at least this thick. A hairline
 * that stays visible without pretending to be more flow than it is — bars
 * wrap their bands exactly, so the floor only ever grows tiny bars and the
 * canvas (via contentHeight), never shrinks large ones.
 */
export const SANKEY_MIN_LINK_HEIGHT = 2;
/**
 * Minimum label-center offset below a row's top edge: labelY sits at
 * slotTop + max(barH / 2, this), so hairline bars still anchor their label
 * inside their own reserved pitch instead of on the sliver.
 */
export const SANKEY_LABEL_CENTER_MIN = 13;
/** Top/bottom gutters: room for the TOTAL caption above, amount below. */
export const SANKEY_PAD_TOP = 28;
export const SANKEY_PAD_BOTTOM = 28;
/** Gap between end-anchored left-column labels and the source bar column. */
export const SANKEY_SOURCE_LABEL_GAP = 8;
/** Gap between middle-column bars and their start-anchored labels. */
export const SANKEY_MIDDLE_LABEL_GAP = 6;
/** Minimum clear space between any left-column label and the SVG left edge. */
export const SANKEY_LEFT_LABEL_INSET = 8;
/**
 * Left gutter: room for two-line income labels (truncated name + $ amount)
 * ending SANKEY_SOURCE_LABEL_GAP before the bars while starting no closer
 * than SANKEY_LEFT_LABEL_INSET to x=0.
 */
export const SANKEY_SOURCE_GUTTER = 160;
/**
 * Minimum left-column source bar height (px) that fits a two-line
 * (name + amount) label. Shorter bars render the name only so tiny income
 * sources stay legible instead of crushing two lines into a sliver.
 */
export const SANKEY_SOURCE_AMOUNT_MIN_HEIGHT = 26;

/**
 * Whether a left-column source bar of `nodeHeight` px fits a two-line
 * label. Pure (decides from the rendered node height) so the view rule is
 * unit-testable.
 */
export function showSankeySourceAmount(nodeHeight: number): boolean {
  return nodeHeight >= SANKEY_SOURCE_AMOUNT_MIN_HEIGHT;
}

/**
 * Chart height honoring the minimum pitch: grows past the container (the
 * view scrolls) instead of crushing rows when there are many groups.
 */
export function sankeyContentHeight(itemCount: number, containerHeight: number): number {
  return Math.max(
    containerHeight,
    itemCount * SANKEY_MIN_PITCH + SANKEY_PAD_TOP + SANKEY_PAD_BOTTOM
  );
}

/**
 * Resolve per-node pixel heights for a column of `values` filling `bandH`
 * (the plot height minus gaps): proportional shares first, then a minimum
 * height enforced by taking from the largest nodes first (largest-first
 * keeps small-but-visible nodes exact), then a rescale to fit when even the
 * minimums overflow (pathological all-tiny case). The result always sums to
 * at most `bandH` and never contains NaN.
 */
export function resolveNodeHeights(values: number[], bandH: number, minNodeHeight: number): number[] {
  const total = values.reduce((s, v) => s + v, 0);
  if (values.length === 0 || total <= 0 || bandH <= 0) {
    return values.map(() => 0);
  }
  const heights = values.map((v) => (v / total) * bandH);
  const minH = Math.min(minNodeHeight, bandH / values.length);
  if (minH > 0) {
    const below = heights.filter((h) => h < minH).length;
    if (below > 0) {
      let short = 0;
      for (const h of heights) {
        if (h < minH) short += minH - h;
      }
      const donors = heights
        .map((h, idx) => ({ h, idx }))
        .filter((o) => o.h > minH)
        .sort((a, b) => b.h - a.h);
      for (const o of donors) {
        if (short <= 0) break;
        const give = Math.min(o.h - minH, short);
        heights[o.idx] = (heights[o.idx] ?? o.h) - give;
        short -= give;
      }
      for (let i = 0; i < heights.length; i++) {
        if ((heights[i] ?? 0) < minH) heights[i] = minH;
      }
      // Pathological case (everything tiny): rescale to fit the plot.
      const sum = heights.reduce((a, h) => a + h, 0);
      if (sum > bandH && sum > 0) {
        const k = bandH / sum;
        for (let i = 0; i < heights.length; i++) heights[i] = (heights[i] ?? 0) * k;
      }
    }
  }
  return heights;
}

/**
 * Closed bezier ribbon path from the source band to the target band.
 * The layout uses it for every ribbon and sub-ribbon, so a subdivided
 * band reads as one ribbon split lengthwise.
 */
export function ribbonPath(
  x0: number,
  x1: number,
  sy0: number,
  sy1: number,
  ty0: number,
  ty1: number
): string {
  const f = (n: number) => n.toFixed(2);
  const midX = (x0 + x1) / 2;
  return (
    `M ${f(x0)} ${f(sy0)} C ${f(midX)} ${f(sy0)} ${f(midX)} ${f(ty0)} ${f(x1)} ${f(ty0)} ` +
    `L ${f(x1)} ${f(ty1)} C ${f(midX)} ${f(ty1)} ${f(midX)} ${f(sy1)} ${f(x0)} ${f(sy1)} Z`
  );
}

/**
 * Closed lane ribbon path for a Remaining plug ribbon: from its source band
 * the ribbon drops into a dedicated lane below the middle column, bridges
 * horizontally under the middle bars ([laneX0, laneX1] is the middle bar
 * column), then traverses to its target band on the right. All three runs
 * share the ribbonPath curve family (horizontal tangents at every joint, so
 * the joints are smooth), and the bridge is straight, so the whole path
 * reads as one ribbon that dips under the groups instead of a diagonal
 * slash across them.
 *
 * The traverse run spans [laneX1, x1] — the same x-range as the middle→target
 * ribbons — so when the lane sits below the middle column and the target
 * band sits below the last spending target, the traverse cannot cross any
 * category ribbon: every curve shares one x-parameterization, making each
 * edge a convex combination of its endpoints, and both endpoints of the
 * plug's top edge sit strictly below both endpoints of every category
 * ribbon's bottom edge. (The drop run still crosses income→group ribbons in
 * the left half: the plug band is buried inside its source bar while the
 * lane sits below every middle bar, so the endpoints straddle and a crossing
 * is topological — the same dense-bipartite crossings group ribbons already
 * make with each other. What the lane removes is every crossing with a BAR
 * and every crossing with a middle→target category ribbon.)
 */
export function remainingLanePath(
  x0: number,
  laneX0: number,
  laneX1: number,
  x1: number,
  sy0: number,
  sy1: number,
  ly0: number,
  ly1: number,
  ty0: number,
  ty1: number
): string {
  const f = (n: number) => n.toFixed(2);
  const mDrop = (x0 + laneX0) / 2;
  const mTrav = (laneX1 + x1) / 2;
  return (
    `M ${f(x0)} ${f(sy0)} ` +
    `C ${f(mDrop)} ${f(sy0)} ${f(mDrop)} ${f(ly0)} ${f(laneX0)} ${f(ly0)} ` +
    `L ${f(laneX1)} ${f(ly0)} ` +
    `C ${f(mTrav)} ${f(ly0)} ${f(mTrav)} ${f(ty0)} ${f(x1)} ${f(ty0)} ` +
    `L ${f(x1)} ${f(ty1)} ` +
    `C ${f(mTrav)} ${f(ty1)} ${f(mTrav)} ${f(ly1)} ${f(laneX1)} ${f(ly1)} ` +
    `L ${f(laneX0)} ${f(ly1)} ` +
    `C ${f(mDrop)} ${f(ly1)} ${f(mDrop)} ${f(sy1)} ${f(x0)} ${f(sy1)} Z`
  );
}

/**
 * Lay out a two-column Sankey: one source node ("Total") on the left, one
 * target node per item on the right, connected by bezier ribbons.
 *
 * Invariants (covered by unit tests):
 * - Every link's source band height equals its target node's height
 *   (`sy1 - sy0 === node.h`), so ribbons never over/under-fill a node.
 * - Target nodes stack top-down in input order with `nodeGap` between them
 *   and stay inside the padded plot area.
 * - The source node spans exactly the stacked bands (first band top to last
 *   band bottom), so it is always a subset of the plot area too.
 * - Empty input (or non-positive total) yields an empty layout with
 *   `total: 0` and zero-height source — never NaN geometry.
 */
export function layoutSankey(
  items: MergedSpendingItem[],
  opts: SankeyGeometryOptions
): SankeyLayout {
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

  const empty: SankeyLayout = {
    total: 0,
    source: { x: padLeft, y: padTop, w: nodeWidth, h: 0 },
    nodes: [],
    links: [],
    labelX: width - padRight,
  };

  const total = items.reduce((s, it) => s + it.value, 0);
  if (items.length === 0 || total <= 0 || width <= 0 || height <= 0) {
    return empty;
  }

  const availH = Math.max(0, height - padTop - padBottom);
  // Pathological many-node case: the gaps alone can exceed the plot, so
  // shrink the effective gap to leave at least 1px per node.
  const n = items.length;
  const gap =
    n > 1 && nodeGap * (n - 1) > availH ? Math.max(0, (availH - n) / (n - 1)) : nodeGap;
  const gapsH = gap * Math.max(0, n - 1);
  const bandH = Math.max(0, availH - gapsH);

  const heights = resolveNodeHeights(
    items.map((it) => it.value),
    bandH,
    minNodeHeight
  );

  const nodeX = Math.max(padLeft + nodeWidth + 24, width - padRight - nodeWidth);
  const sourceX = padLeft;
  const linkX0 = sourceX + nodeWidth;
  const linkX1 = nodeX;

  const nodes: SankeyNodeLayout[] = [];
  const links: SankeyLinkLayout[] = [];
  let y = padTop;
  let sy = padTop;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const h = Math.max(0, heights[i] ?? 0);
    const share = total !== 0 ? it.value / total : 0;
    nodes.push({ name: it.name, value: it.value, mergedCount: it.mergedCount, bucket: it.bucket === true, share, x: nodeX, y, w: nodeWidth, h, fill: sankeyTargetColor({ name: it.name, bucket: it.bucket === true, isPlug: false }), labelY: y + h / 2 });
    const sy0 = sy;
    const sy1 = sy + h;
    const ty0 = y;
    const ty1 = y + h;
    links.push({
      name: it.name,
      value: it.value,
      mergedCount: it.mergedCount,
      sy0,
      sy1,
      ty0,
      ty1,
      x0: linkX0,
      x1: linkX1,
      d: ribbonPath(linkX0, linkX1, sy0, sy1, ty0, ty1),
    });
    y += h + gap;
    sy += h + gap;
  }

  const stackedH = y - gap - padTop;
  return {
    total,
    source: { x: sourceX, y: padTop, w: nodeWidth, h: Math.max(0, stackedH) },
    nodes,
    links,
    labelX: nodeX + nodeWidth + 8,
  };
}
