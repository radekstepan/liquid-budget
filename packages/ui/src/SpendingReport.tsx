"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fmt,
  computeSankeyViewModel,
  excludeHeldCells,
  mergeBelowThreshold,
  mergeGroupFlow,
  layoutGroupedIncomeSankey,
  sankeyAutoFitThreshold,
  sankeyContentHeight,
  sankeyTargetColor,
  OVER_INCOME_LABEL,
  sankeyThresholdStep,
  sankeyThresholdStops,
  showSankeySourceAmount,
  sortMergedGroupFlow,
  SANKEY_FUNDING_EPSILON_CENTS,
  SANKEY_LEFT_LABEL_INSET,
  SANKEY_NODE_GAP,
  SANKEY_NODE_MIN_HEIGHT,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  SANKEY_SOURCE_GUTTER,
  STILL_HELD_GROUP_LABEL,
  UNCATEGORIZED_GROUP_LABEL,
  type GroupedLeftCellLayout,
  type MergedSpendingItem,
  type MonthlySankeySeries,
  type SankeyTargetSort,
  type SpendingBreakdownItem,
  type SpendingDimension,
  type SpendingGroupFlow,
} from "@ynab/logic";
import { Button, Panel, Tooltip } from "@ynab/theme";
import {
  ChartTip,
  SankeyBucketHatchPattern,
  TipLabel,
  OVER_INCOME_COLOR,
  useElementSize,
  useRafThrottledSet,
} from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";

export type SpendingItem = SpendingBreakdownItem;
export type SpendingViewMode = "bars" | "sankey";

type Hover =
  | { kind: "income"; idx: number; x: number; y: number }
  | { kind: "group"; idx: number; x: number; y: number }
  | { kind: "node"; idx: number; x: number; y: number }
  // Left ribbon: a = income index, b = middle index (or the plug index,
  // one past the last middle, for full-width Remaining ribbons). Right
  // ribbon: a = middle index, b = target index — one ribbon per cell, in
  // the target's color.
  | { kind: "link"; side: "left"; a: number; b: number; x: number; y: number }
  | { kind: "link"; side: "right"; a: number; b: number; x: number; y: number }
  | { kind: "bar"; idx: number; x: number; y: number };

const LABEL_ZONE = 190;

// Conservative per-character px estimates for the left-column labels (12px
// names, 11px tabular-nums amounts). SVG gives no text metrics, so name
// truncation budgets against these to stay clear of the left edge; tests
// reuse them to assert the same geometric contract.
export const SOURCE_NAME_PX_PER_CHAR = 7;
export const SOURCE_AMOUNT_PX_PER_CHAR = 6;

function truncateName(name: string, max = 26): string {
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

// True when a right-column row is a still-held account row: every cell
// arriving at it routes through the Still-held pseudo-group. Held cells
// route ONLY through it — and a kept held row's group can never have
// merged away (the group value always covers its cells), so this is exact
// for kept rows. Callers exclude merged buckets first: a bucket is a
// generic render-only row even when every folded row was held.
function isHeldTarget(
  incomingGroupIndices: readonly number[],
  groupNameOf: (groupIndex: number) => string | undefined
): boolean {
  return (
    incomingGroupIndices.length > 0 &&
    incomingGroupIndices.every((g) => groupNameOf(g) === STILL_HELD_GROUP_LABEL)
  );
}

// True when the OS asks for reduced motion: the spotlight cross-fade
// drops to zero duration (instant, like the pre-transition behavior) and
// hover stays fully functional — brightness-only either way, never
// scale/lift/bounce. Reads the media query in an effect (never during
// render) so server and hydration renders always agree.
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// Each ribbon carries one flat color — the color of its FINAL (right-column)
// destination — through its whole length: right-hop ribbons their
// category's or merchant's own color (one ribbon per group→target cell),
// and each left-hop income→group band subdivides into one sub-ribbon per
// downstream cell (layout leftCells), in the same target colors, landing
// in contiguous per-color blocks — so the line from an income bar to a
// category or merchant bar reads as one color throughout at one thickness
// in both groupings. The full-width Remaining ribbons carry the plug's
// green. The target determines the color and it flows backwards along
// every ribbon arriving at it, no matter which middle group each ribbon
// comes from — the parent group never tints a ribbon, and the income side
// never colors one either. Exported so tests can pin the fills.
//
// Spotlight scale: at rest every ribbon and every bar sits at
// SANKEY_RIBBON_OPACITY — nearly as solid as the hover step, one small
// step below it so the spotlight still reads as a brightening; while a
// flow path is hovered the path's ribbons and bars brighten to
// SANKEY_RIBBON_HOVER_OPACITY and everything outside the path dims to
// SANKEY_RIBBON_DIM_OPACITY, kept far below rest so the off-path wash
// stays clearly dimmer. Bars share their ribbons' exact fill at the same
// steps, so the line into a bar always matches the bar. Brightness alone
// carries the spotlight — the DOM order never changes with hover (no
// z-reorder), so the brightness steps glide over
// SANKEY_SPOTLIGHT_TRANSITION_MS instead of snapping: with a stable
// z-order there is no "final z-order at pre-transition brightness" to
// flash (the task-29 hazard), and rapid A→B→C sweeps just retarget the
// in-flight cross-fade. Unchanged arms keep identical attributes, so no
// transition triggers and nothing repaints (the task-30 invariant).
export const SANKEY_RIBBON_OPACITY = 0.75;
export const SANKEY_RIBBON_DIM_OPACITY = 0.12;
export const SANKEY_RIBBON_HOVER_OPACITY = 0.85;
// Cross-fade length for every spotlight brightness step (ribbons, bars,
// hatch overlays, and dimming labels alike) — brightness-only easing,
// never scale/lift/bounce, and zero under prefers-reduced-motion (see
// usePrefersReducedMotion). Flash-safe only because the z-order is
// stable — see above.
export const SANKEY_SPOTLIGHT_TRANSITION_MS = 120;

// The hatch marks computed/derived money — the merged "Other" buckets on
// every column, the "Remaining" surplus plug, and still-held balances —
// versus terminal purchase flows. Middle and target bars hatch by row
// (bucket, plug, and whole-held bars); ribbons hatch by destination
// (right-hop ribbons into bucket, plug, or held targets, plug-lane
// ribbons, and left-hop sub-ribbons funding bucket, plug, or held cells
// — per-sub granularity, like the spotlight); income bars hatch by
// segment (each bar segment funding a hatched sub-ribbon or plug band
// hatches with it, since every segment meets its ribbon exactly). Mixed
// middle bars stay solid, and ribbons out of a middle bucket into a real
// target stay solid — money ending as a terminal purchase reads solid no
// matter its middle routing. No bar carries a border; the hatch alone
// marks derived money.
export const SANKEY_BUCKET_HATCH_ID = "sankey-bucket-hatch";

// Income bars fill with a hard-edged top-to-bottom gradient from the
// layout's own stops (sourceFills) — one gradient per bar, so each bar
// segment matches its ribbon exactly. Bar i paints from
// `${SANKEY_INCOME_GRADIENT_ID_PREFIX}${i}`.
export const SANKEY_INCOME_GRADIENT_ID_PREFIX = "sankey-income-gradient-";

// Middle bars fill the same way — one gradient per bar from the layout's
// own stops (middleFills), so each bar segment matches its ribbon exactly
// instead of sitting flat in the group hue while category-colored arms
// leave it. Bar i paints from
// `${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${i}`.
export const SANKEY_MIDDLE_GRADIENT_ID_PREFIX = "sankey-middle-gradient-";

// Session flag for the Under auto-fit: it runs at most once per tab session —
// on the first Sankey paint with a measured container — and never again after
// the user drags the slider themselves. Report tab switches remount this
// component, so a mount-local ref alone would re-auto and fight the user's
// in-session choice; sessionStorage survives remounts but resets on a fresh
// tab load, which is exactly "initial load" semantics. Exported so tests can
// pin the flag and assert unmerged geometry without the auto-fit raising the
// threshold underneath them.
export const SANKEY_AUTOFIT_SESSION_KEY = "ynab:reports:spendingAutoFit";

function sankeyAutoFitDone(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(SANKEY_AUTOFIT_SESSION_KEY) != null
    );
  } catch {
    return false;
  }
}

function markSankeyAutoFitDone(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SANKEY_AUTOFIT_SESSION_KEY, "1");
  } catch {
    // Private browsing / unavailable storage: auto-fit degrades to once per mount.
  }
}

export function SpendingReport({
  categoryFlow,
  merchantFlow,
  income,
  // Monthly series behind each flow (see computeMonthlySankeySeries): the
  // Sankey funds spending chronologically from these, so an income can only
  // spotlight spending it could actually have funded. Absent (tests,
  // embeds), the Sankey falls back to the legacy proportional split.
  categorySeries,
  merchantSeries,
  // Budget view group names in Budget order (group.sort) — the "Group"
  // sort mode orders the Sankey's middle column by this.
  groupOrder = [],
  // Budget view category names in group-major sort order — the "Group"
  // sort mode orders categories within their parent group by this.
  // Merchants have no Budget position and stay value-descending.
  categoryOrder = [],
  initialView = "sankey",
  initialDimension = "categories",
  initialShowHeld = true,
}: {
  categoryFlow: SpendingGroupFlow;
  merchantFlow: SpendingGroupFlow;
  income: SpendingItem[];
  categorySeries?: MonthlySankeySeries;
  merchantSeries?: MonthlySankeySeries;
  groupOrder?: readonly string[];
  categoryOrder?: readonly string[];
  initialView?: SpendingViewMode;
  initialDimension?: SpendingDimension;
  initialShowHeld?: boolean;
}) {
  const [viewMode, setViewMode] = useLocalStorage<SpendingViewMode>(
    "ynab:reports:spendingViewMode",
    initialView,
    (v): v is SpendingViewMode => v === "bars" || v === "sankey"
  );
  const [dimension, setDimension] = useLocalStorage<SpendingDimension>(
    "ynab:reports:spendingDimension",
    initialDimension,
    (v): v is SpendingDimension => v === "categories" || v === "merchants"
  );
  const [thresholdDollars, setThresholdDollars] = useLocalStorage<number>(
    "ynab:reports:spendingThreshold",
    0,
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
  );
  // Sankey-only column order: by current amount, or by parent group in
  // Budget view order. Bars always stay by amount.
  const [sort, setSort] = useLocalStorage<SankeyTargetSort>(
    "ynab:reports:spendingSort",
    "amount",
    (v): v is SankeyTargetSort => v === "amount" || v === "group"
  );
  // Sankey-only Still-held toggle: hiding removes the Still-held group bar,
  // the held target rows, and their ribbons from the Sankey — the hidden
  // held total refolds into the Remaining plug through the existing
  // allocator. Bars rows, header totals, and the Under merging read the
  // full flow either way. Shown by default (today's behavior).
  const [showHeld, setShowHeld] = useLocalStorage<boolean>(
    "ynab:reports:spendingShowHeld",
    initialShowHeld,
    (v): v is boolean => typeof v === "boolean"
  );
  const [hover, setHover] = useState<Hover | null>(null);
  // Mousemove fires far more often than the display refreshes; coalescing
  // hover commits to one per frame (latest wins) keeps cursor sweeps from
  // queuing a full multi-hundred-element re-render per event — the same
  // throttle the other reports use. Hover-leaves ride the same throttle
  // (never a synchronous clear — Sankey and Bars alike): moving directly
  // from one element to another delivers leave+move as one commit, so arms
  // that stay dimmed never flash through rest in between and the Bars
  // tooltip never blinks off between rows.
  const pushHover = useRafThrottledSet(setHover);
  // Reduced-motion users get the instant (zero-duration) spotlight: same
  // semantics, no glide.
  const transitionMs = usePrefersReducedMotion() ? 0 : SANKEY_SPOTLIGHT_TRANSITION_MS;
  const { ref: chartRef, size: chartSize } = useElementSize<HTMLDivElement>();

  const flow = dimension === "categories" ? categoryFlow : merchantFlow;
  const raw = flow.targets;

  // One shared threshold merges all three columns, so the ceiling covers
  // the largest row on any side.
  const maxDollars = useMemo(
    () =>
      [...raw, ...flow.groups, ...income].reduce((m, s) => Math.max(m, s.value / 100), 0),
    [raw, flow.groups, income]
  );
  // The slider walks stepped stops (small increments first, larger jumps
  // later — see SANKEY_THRESHOLD_STOPS) instead of raw dollars. The stored
  // dollar value snaps to its nearest stop, so values saved before the
  // stepped slider keep working.
  const stops = useMemo(() => sankeyThresholdStops(maxDollars), [maxDollars]);
  const sliderPos = sankeyThresholdStep(stops, thresholdDollars);
  const activeThreshold = stops[sliderPos] ?? 0;

  const merged = useMemo(
    () =>
      mergeGroupFlow(flow.groups, flow.targets, flow.links, Math.round(activeThreshold * 100)),
    [flow, activeThreshold]
  );
  const mergedIncome = useMemo(
    () => mergeBelowThreshold(income, Math.round(activeThreshold * 100)),
    [income, activeThreshold]
  );
  const series = dimension === "categories" ? categorySeries : merchantSeries;
  // Sankey-scoped inputs: the Still-held toggle strips held cells here — a
  // logic-level transform of the flow+series pair, never render-side
  // filtering — so funding, merging, sorting, and the Remaining plug all
  // see consistent inputs. Shown (the default) passes the full pair
  // through untouched.
  const sankeyInputs = useMemo(
    () => (showHeld ? { flow, series } : excludeHeldCells(flow, series)),
    [showHeld, flow, series]
  );
  const sankeyFlow = sankeyInputs.flow;
  const sankeySeries = sankeyInputs.series;
  // The Sankey's own merged columns: the full `merged` when shown (same
  // reference — the default path is today's behavior exactly), a
  // held-excluded merge when hidden. Header totals and Bars rows always
  // read `merged`.
  const sankeyMerged = useMemo(
    () =>
      showHeld
        ? merged
        : mergeGroupFlow(
            sankeyFlow.groups,
            sankeyFlow.targets,
            sankeyFlow.links,
            Math.round(activeThreshold * 100)
          ),
    [showHeld, merged, sankeyFlow, activeThreshold]
  );
  // Column order for the Sankey layout (a permutation — sums and marginals
  // are untouched, so the header totals and Bars rows read `merged`).
  const ordered = useMemo(
    () => sortMergedGroupFlow(sankeyMerged, groupOrder, sort, categoryOrder),
    [sankeyMerged, groupOrder, sort, categoryOrder]
  );
  // Time-aware Sankey model: the merged + sorted columns from above
  // (the same merge/sort calls Bars uses, so the two views cannot disagree
  // while held rows show) plus the chronological funding of each cell.
  // Null without series — the layout then uses the legacy split.
  const timeAware = useMemo(
    () =>
      sankeySeries == null
        ? null
        : computeSankeyViewModel(sankeyFlow, income, sankeySeries, {
            thresholdCents: Math.round(activeThreshold * 100),
            groupOrder,
            sort,
            categoryOrder,
          }),
    [sankeyFlow, income, sankeySeries, activeThreshold, groupOrder, sort, categoryOrder]
  );
  // The header "(N in Other)" note covers all three merged columns.
  const mergedOtherCount = merged.otherCount + mergedIncome.otherCount;

  // Header totals: plain sums (merging preserves sums and breakdowns never
  // emit non-positive values, so these match the layout's filtered totals).
  const totals = useMemo(() => {
    const incomeTotal = mergedIncome.items.reduce((s, x) => s + x.value, 0);
    const spendingTotal = merged.targets.reduce((s, x) => s + x.value, 0);
    return {
      incomeTotal,
      spendingTotal,
      flowTotal: Math.max(incomeTotal, spendingTotal),
      remaining: incomeTotal - spendingTotal,
    };
  }, [merged.targets, mergedIncome.items]);
  const spentTotal = totals.spendingTotal;

  // Bars rows: spending shares (unchanged by the income side). Each row
  // keeps its own full-brightness stable color — NOT the Sankey family
  // shades: those darken toward black to stay readable at translucent
  // ribbon opacity, but at the Bars' full opacity they read too dark
  // (task-31 restore of the pre-task-19 palette). Buckets render slate by
  // flag (never by name, so a literal "Other" row keeps its own color).
  const rows = useMemo(() => {
    const maxSpend = merged.targets.reduce((m, s) => Math.max(m, s.value), 1);
    return merged.targets.map((s, i) => {
      const share = spentTotal !== 0 ? s.value / spentTotal : 0;
      const pctOfTotal = Math.round(share * 100);
      const pctOfMax = (s.value / maxSpend) * 100;
      const color = sankeyTargetColor({ name: s.name, bucket: s.bucket === true, isPlug: false });
      return { ...s, share, pctOfTotal, pctOfMax, color, i };
    });
  }, [merged.targets, spentTotal]);

  // Income rows for the layout: the same Under threshold folds small
  // income sources into an Other bucket on the left, and the proportional
  // link math runs on the merged columns (conservation preserved).
  const incomeRows: MergedSpendingItem[] = mergedIncome.items;

  const empty = incomeRows.length === 0 && merged.targets.length === 0;
  // Sankey-scoped emptiness for the chart below: hiding held rows can leave
  // the Sankey with nothing to draw (only-held data, no income) while Bars
  // still lists the held rows — so the Sankey's own empty state reads the
  // held-excluded columns. Identical to `empty` while held rows show.
  const sankeyEmpty = incomeRows.length === 0 && sankeyMerged.targets.length === 0;
  const nounSingular = dimension === "categories" ? "category" : "merchant";
  const nounPlural = dimension === "categories" ? "categories" : "merchants";
  // Epsilon rule: with full partitioning (every dollar spent or held) Left
  // reconciles to exactly zero — but fractional-cent amounts can leave
  // allocator-scale dust on either side of it. Anything under the
  // allocator's own epsilon (SANKEY_FUNDING_EPSILON_CENTS) is not money, so
  // the header clamps it to $0 and reads "Left", never "Over" — agreeing
  // with the layout's plug, which snaps the same way via
  // allocateCellFunding. A real shortfall (≥ one cent) still reads "Over".
  const remaining =
    Math.abs(totals.remaining) < SANKEY_FUNDING_EPSILON_CENTS ? 0 : totals.remaining;

  // The chart grows past the viewport when rows need more room (the
  // container scrolls) instead of crushing labels onto each other. Counts
  // come from the Sankey's own merged columns (plus the future Remaining
  // plug, detected against the held-excluded spending so a refolded plug
  // still reserves its row): merged lengths can only overestimate the
  // layout's filtered columns, erring toward harmless slack rather than
  // crushed rows.
  const contentH = useMemo(() => {
    const sankeySpendingTotal = sankeyMerged.targets.reduce((s, x) => s + x.value, 0);
    return sankeyContentHeight(
      Math.max(
        incomeRows.length,
        sankeyMerged.groups.length,
        sankeyMerged.targets.length + (totals.incomeTotal > sankeySpendingTotal ? 1 : 0)
      ),
      chartSize.height
    );
  }, [incomeRows.length, sankeyMerged, totals.incomeTotal, chartSize.height]);

  // Math-first: the layout owns EVERYTHING drawn below — node bars, ribbon
  // paths, sub-ribbon paths, bar gradient stops, fills, and label anchors —
  // and this component renders those objects verbatim with no geometry,
  // subdivision, path, color, or label math of its own. A visual glitch is
  // fixed in the layout (unit-tested in @ynab/logic), never here.
  const sankey = useMemo(() => {
    if (chartSize.width <= 0 || chartSize.height <= 0) return null;
    return layoutGroupedIncomeSankey(
      timeAware?.sources ?? incomeRows,
      timeAware?.groups ?? ordered.groups,
      timeAware?.targets ?? ordered.targets,
      timeAware?.links ?? ordered.links,
      {
        width: chartSize.width,
        height: contentH,
        padLeft: SANKEY_SOURCE_GUTTER,
        padRight: LABEL_ZONE,
        padTop: SANKEY_PAD_TOP,
        padBottom: SANKEY_PAD_BOTTOM,
        nodeGap: SANKEY_NODE_GAP,
        minNodeHeight: SANKEY_NODE_MIN_HEIGHT,
        // Both groupings subdivide each income→middle band into one
        // sub-ribbon per downstream cell (layout leftCells), so each color
        // crosses the middle as one contiguous block at its cell's thickness:
        // the same through-color flows from the right column all the way to
        // income in Categories and Merchants alike — and with time-aware
        // funding, only for income that could actually have funded the cell.
        leftDetail: "cells",
        ...(timeAware != null ? { leftHop: timeAware.left } : {}),
      }
    );
  }, [incomeRows, ordered.groups, ordered.targets, ordered.links, timeAware, chartSize.width, chartSize.height, contentH]);

  // Initial-load auto-fit: raise the Under threshold to the smallest stop
  // whose merged columns fit the measured container, so the Sankey shows
  // fully with no amounts under the fold (or as close as merging allows).
  // Raise-only — a stored threshold that already fits is the user's choice
  // and stays — and once per tab session, so later remounts (report tab
  // switches) and resizes never fight the user's in-session slider.
  const autoFittedRef = useRef(false);
  useEffect(() => {
    if (autoFittedRef.current || sankeyAutoFitDone()) return;
    if (viewMode !== "sankey") return;
    if (chartSize.width <= 0 || chartSize.height <= 0) return;
    if (empty) return;
    autoFittedRef.current = true;
    markSankeyAutoFitDone();
    const best = sankeyAutoFitThreshold(
      sankeyFlow.groups,
      sankeyFlow.targets,
      sankeyFlow.links,
      income,
      stops,
      chartSize.height,
      sankeySeries
    );
    if (best > activeThreshold) {
      setThresholdDollars(best);
      setHover(null);
    }
  }, [
    viewMode,
    chartSize.width,
    chartSize.height,
    empty,
    sankeyFlow,
    income,
    sankeySeries,
    stops,
    activeThreshold,
    setThresholdDollars,
  ]);

  // Left-column names truncate to fit the pixel budget between the label
  // anchor and the minimum left inset, so even long names (with ellipsis)
  // end inside the visible area instead of clipping past x=0.
  const sourceLabelMaxChars = Math.max(
    8,
    Math.floor(
      ((sankey?.sourceLabelX ?? 0) - SANKEY_LEFT_LABEL_INSET) / SOURCE_NAME_PX_PER_CHAR
    )
  );

  // Label/tooltip rows follow the layout (which appends Remaining and drops
  // non-positive values), so labels and bars always agree. Colors come from
  // the layout's own fills — recomputing them here would let the two drift.
  const srcRows = useMemo(
    () =>
      (sankey?.sources ?? []).map((s, i) => ({
        ...s,
        flowPct:
          totals.flowTotal !== 0 ? Math.round((s.value / totals.flowTotal) * 100) : 0,
        // The layout's fill doubles as the tooltip dot. The bars themselves
        // paint their gradient stops; no single color can stand for one.
        color: s.fill,
        i,
      })),
    [sankey, totals.flowTotal]
  );
  const midRows = useMemo(
    () =>
      (sankey?.middles ?? []).map((m, i) => ({
        ...m,
        flowPct:
          totals.flowTotal !== 0 ? Math.round((m.value / totals.flowTotal) * 100) : 0,
        // The layout's fill doubles as the tooltip dot. The bars themselves
        // paint their gradient stops; no single color can stand for one.
        color: m.fill,
        // How many right-column rows this group feeds (distinct targets —
        // one ribbon per group→target cell).
        memberCount: new Set(
          sankey?.linksRight.filter((l) => l.sourceIndex === i).map((l) => l.targetIndex)
        ).size,
        i,
      })),
    [sankey, totals.flowTotal]
  );
  const tgtRows = useMemo(() => {
    const targets = sankey?.targets ?? [];
    return targets.map((t, i) => {
      // By position, never by name: a literal "Remaining" category is
      // still just a category.
      const isPlug = sankey?.remainingTargetIndex === i;
      return {
        ...t,
        flowPct:
          totals.flowTotal !== 0 ? Math.round((t.value / totals.flowTotal) * 100) : 0,
        // The layout's fill, shared with every incoming ribbon: the line
        // into this bar reads as one color throughout, whichever middle
        // group each ribbon arrives from.
        color: t.fill,
        isPlug,
        i,
      };
    });
  }, [sankey, totals.flowTotal]);

  // Subdivided left-hop bands grouped for band-level hover: the layout's
  // leftCells carry their own paths and fills (rendered verbatim below),
  // and this only groups them so each band stays one hover target.
  const leftCellsByBand = useMemo(() => {
    const groups = new Map<string, GroupedLeftCellLayout[]>();
    if (sankey == null) return groups;
    for (const c of sankey.leftCells) {
      const key = `${c.sourceIndex}:${c.middleIndex}`;
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    return groups;
  }, [sankey]);

  // Right-column targets that are 100% held money (Sankey indices): kept
  // non-plug rows whose every incoming cell routes through the Still-held
  // pseudo-group (see isHeldTarget). Buckets stay out even when every
  // folded row was held — a bucket is mixed by definition, and mixed
  // elements never hatch. Drives the held hatch on target bars, right-hop
  // ribbons into these targets, and left-hop sub-ribbons funding them.
  const heldTargets = useMemo(() => {
    const set = new Set<number>();
    if (sankey == null) return set;
    for (let i = 0; i < sankey.targets.length; i++) {
      if (i === sankey.remainingTargetIndex) continue;
      if (sankey.targets[i]?.bucket === true) continue;
      if (
        isHeldTarget(
          sankey.linksRight.filter((l) => l.targetIndex === i).map((l) => l.sourceIndex),
          (g) => sankey.middles[g]?.name
        )
      ) {
        set.add(i);
      }
    }
    return set;
  }, [sankey]);

  // Kept Still-held pseudo-group bars that are 100% held money (Sankey
  // middle indices): every outgoing cell lands in a held target or a
  // merged bucket (a bucket may have folded held rows — the money leaving
  // this bar through that link is still held). In real data the Still-held
  // group carries only held cells, so this is exactly the kept bar; the
  // outgoing check keeps the whole-held rule exact instead of trusting
  // the name alone.
  const heldMiddles = useMemo(() => {
    const set = new Set<number>();
    if (sankey == null) return set;
    sankey.middles.forEach((m, i) => {
      if (m.bucket === true || m.name !== STILL_HELD_GROUP_LABEL) return;
      const outs = sankey.linksRight.filter((l) => l.sourceIndex === i);
      if (
        outs.length > 0 &&
        outs.every(
          (l) =>
            heldTargets.has(l.targetIndex) ||
            sankey.targets[l.targetIndex]?.bucket === true
        )
      ) {
        set.add(i);
      }
    });
    return set;
  }, [sankey, heldTargets]);

  // Same rule over the merged columns for the Bars rows (merged target
  // indices — the same indices the Bars rows and tooltips use).
  const heldBars = useMemo(() => {
    const set = new Set<number>();
    merged.targets.forEach((t, i) => {
      if (t.bucket === true) return;
      if (
        isHeldTarget(
          merged.links.filter((l) => l.targetIndex === i).map((l) => l.groupIndex),
          (g) => merged.groups[g]?.name
        )
      ) {
        set.add(i);
      }
    });
    return set;
  }, [merged]);

  // Right-column rows whose ribbons hatch with the BUCKET pattern: a
  // merged Other bucket target or the Remaining plug (by position, never
  // by name). Held rows hatch under their own testid instead (see
  // heldTargets); the sets are disjoint, so a ribbon never
  // double-hatches. Destination-driven: a ribbon hatches iff the money
  // it carries ENDS IN (right-hop) or FUNDS (left-hop) one of these
  // rows — the middle it routes through never matters, so a ribbon out
  // of a middle bucket into a real target stays solid.
  const isBucketOrPlugTarget = (t: number): boolean =>
    sankey?.targets[t]?.bucket === true || t === (sankey?.remainingTargetIndex ?? -1);

  // Per-income-bar hatch spans for the derived-money segments: every
  // left-hop sub-ribbon funding a held, bucket, or plug cell hatches its
  // source span (like the sub itself), and every plug-lane band hatches
  // its source span (the plug ribbon hatches, so the bar segment it
  // leaves hatches too). Spans reuse the layout's own sy0/sy1 — the same
  // spans the bar's gradient segments paint — mapped verbatim, never
  // recomputed. Degenerate whole bands into a middle stay solid: a middle
  // is never a hatched row. One span per hatched sub/band (no merging),
  // so each overlay maps 1:1 to its hatched ribbon.
  const sourceHatchSpans = useMemo(() => {
    const spans: { y0: number; y1: number; held: boolean }[][] = (
      sankey?.sources ?? []
    ).map(() => []);
    if (sankey == null) return spans;
    for (const c of sankey.leftCells) {
      if (!(c.sy1 > c.sy0)) continue;
      const held = heldTargets.has(c.targetIndex);
      // Same rule as isBucketOrPlugTarget, inlined so the memo deps stay
      // honest (the helper itself is re-created every render).
      const bucketOrPlug =
        sankey.targets[c.targetIndex]?.bucket === true ||
        c.targetIndex === sankey.remainingTargetIndex;
      if (!held && !bucketOrPlug) continue;
      spans[c.sourceIndex]?.push({ y0: c.sy0, y1: c.sy1, held });
    }
    for (const l of sankey.linksLeft) {
      if (l.targetIndex !== sankey.middles.length) continue;
      if (!(l.sy1 > l.sy0)) continue;
      spans[l.sourceIndex]?.push({ y0: l.sy0, y1: l.sy1, held: false });
    }
    for (const list of spans) list.sort((a, b) => a.y0 - b.y0);
    return spans;
  }, [sankey, heldTargets]);

  const tipContent: ReactNode | null = (() => {
    if (!hover) return null;
    if (hover.kind === "income") {
      const r = srcRows[hover.idx];
      if (!r) return null;
      const isOther = r.bucket === true;
      const incomePct =
        totals.incomeTotal !== 0 ? Math.round((r.value / totals.incomeTotal) * 100) : 0;
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            {r.name}
          </div>
          <TipLabel
            color={r.color}
            label="Received"
            value={fmt(r.value)}
            pct={r.flowPct + "%"}
          />
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>
              {isOther
                ? `${r.mergedCount} smaller income${r.mergedCount === 1 ? "" : "s"} under ${fmt(Math.round(activeThreshold * 100))}`
                : `${incomePct}% of ${fmt(totals.incomeTotal)} income`}
            </span>
          </div>
        </div>
      );
    }
    if (hover.kind === "link") {
      if (hover.side === "left") {
        const s = srcRows[hover.a];
        const link = sankey?.linksLeft.find(
          (l) => l.sourceIndex === hover.a && l.targetIndex === hover.b
        );
        if (!s || !link) return null;
        // The ribbon lands on a middle, or — past the last middle — on the
        // Remaining plug.
        const target =
          midRows[hover.b] ?? tgtRows[sankey?.remainingTargetIndex ?? -1] ?? null;
        if (!target) return null;
        const fundedPct =
          target.fundedValue !== 0
            ? Math.round((link.value / target.fundedValue) * 100)
            : 0;
        return (
          <div className="space-y-[3px]">
            <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
              {`${s.name} → ${target.name}`}
            </div>
            <TipLabel
              color={target.color}
              label="Flows"
              value={fmt(link.value)}
              pct={fundedPct + "%"}
            />
          </div>
        );
      }
      const m = midRows[hover.a];
      const t = tgtRows[hover.b];
      if (!m || !t) return null;
      const link = sankey?.linksRight.find(
        (l) => l.sourceIndex === hover.a && l.targetIndex === hover.b
      );
      if (!link) return null;
      // Share of the target's funded amount (when spending exceeds income
      // the expense is only partly funded, so this is relative to funded,
      // not total).
      const fundedPct =
        t.fundedValue !== 0 ? Math.round((link.value / t.fundedValue) * 100) : 0;
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            {`${m.name} → ${t.name}`}
          </div>
          <TipLabel
            color={t.color}
            label="Flows"
            value={fmt(link.value)}
            pct={fundedPct + "%"}
          />
        </div>
      );
    }
    if (hover.kind === "group") {
      const r = midRows[hover.idx];
      if (!r) return null;
      const isOther = r.bucket === true;
      // The Still-held pseudo-group reads as holdings, never spending
      // (mirrors the Uncategorized explainer below).
      const isHeldGroup = !isOther && r.name === STILL_HELD_GROUP_LABEL;
      const spendPct =
        spentTotal !== 0 ? Math.round((r.value / spentTotal) * 100) : 0;
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            {r.name}
          </div>
          <TipLabel
            color={r.color}
            label={isHeldGroup ? "Held" : "Spent"}
            value={fmt(r.value)}
            pct={r.flowPct + "%"}
          />
          {r.unfundedValue > 0 && (
            <TipLabel
              color={OVER_INCOME_COLOR}
              label={OVER_INCOME_LABEL}
              value={fmt(r.unfundedValue)}
            />
          )}
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>
              {isOther
                ? `${r.mergedCount} smaller group${r.mergedCount === 1 ? "" : "s"} under ${fmt(Math.round(activeThreshold * 100))}`
                : isHeldGroup
                  ? `${r.memberCount} ${r.memberCount === 1 ? "account" : "accounts"}`
                  : `${r.memberCount} ${r.memberCount === 1 ? nounSingular : nounPlural} · ${spendPct}% of ${fmt(spentTotal)} spending`}
            </span>
          </div>
          {r.name === UNCATEGORIZED_GROUP_LABEL && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Spending with no category set</span>
            </div>
          )}
          {isHeldGroup && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Money that never left these accounts</span>
            </div>
          )}
        </div>
      );
    }
    if (hover.kind === "bar") {
      const r = rows[hover.idx];
      if (!r) return null;
      const isOther = r.bucket === true;
      // Group attribution for this row, from the merged group→target
      // cells (largest first): a category's single parent group, or a
      // merchant's split across the groups it spans. Links into an Other
      // target exist but stay hidden — the merged-bucket line below covers
      // them. Display names mark a merged middle bucket so it never reads
      // as a real group.
      const cells = isOther
        ? []
        : merged.links
            .filter((l) => l.targetIndex === hover.idx)
            .map((l) => {
              const g = merged.groups[l.groupIndex];
              return {
                name:
                  g?.bucket === true ? `${g.name} (merged)` : (g?.name ?? "—"),
                color: sankeyTargetColor({
                  name: g?.name ?? "—",
                  bucket: g?.bucket === true,
                  isPlug: false,
                }),
                value: l.value,
              };
            })
            .sort((a, b) => b.value - a.value);
      const multiGroup = cells.length > 1;
      // Still-held account rows read as holdings, never spending (merged
      // buckets stay generic — see heldBars).
      const isHeld = heldBars.has(hover.idx);
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            {r.name}
          </div>
          <TipLabel
            color={r.color}
            label={isHeld ? "Held" : "Spent"}
            value={fmt(r.value)}
            pct={r.pctOfTotal + "%"}
          />
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>
              {isOther
                ? `${r.mergedCount} smaller ${r.mergedCount === 1 ? nounSingular : nounPlural} under ${fmt(Math.round(activeThreshold * 100))}`
                : isHeld
                  ? "Unspent — still in this account"
                  : cells.length === 1
                  ? `${r.pctOfTotal}% of ${fmt(spentTotal)} spending · in ${cells[0]!.name}`
                  : multiGroup
                    ? `${r.pctOfTotal}% of ${fmt(spentTotal)} spending · across ${cells.length} groups`
                    : `${r.pctOfTotal}% of ${fmt(spentTotal)} spending`}
            </span>
          </div>
          {multiGroup &&
            cells.map((c, ci) => (
              <TipLabel
                key={`${ci}:${c.name}`}
                color={c.color}
                label={c.name}
                value={fmt(c.value)}
                pct={Math.round((c.value / r.value) * 100) + "%"}
              />
            ))}
          {isOther && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Render-only — grouped by the Under threshold</span>
            </div>
          )}
        </div>
      );
    }
    const r = tgtRows[hover.idx];
    if (!r) return null;
    const isOther = r.bucket === true;
    const isRemaining = r.isPlug;
    // Still-held account rows read as holdings, never spending (merged
    // buckets stay generic — see heldTargets).
    const isHeld = heldTargets.has(hover.idx);
    const spendPct =
      spentTotal !== 0 ? Math.round((r.value / spentTotal) * 100) : 0;
    return (
      <div className="space-y-[3px]">
        <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
          {r.name}
        </div>
        <TipLabel
          color={r.color}
          label={isRemaining ? "Left" : isHeld ? "Held" : "Spent"}
          value={fmt(r.value)}
          pct={r.flowPct + "%"}
        />
        {r.unfundedValue > 0 && (
          <TipLabel
            color={OVER_INCOME_COLOR}
            label={OVER_INCOME_LABEL}
            value={fmt(r.unfundedValue)}
          />
        )}
        <div
          className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
          style={{ color: "rgba(242,245,247,0.65)" }}
        >
          <span>
            {isOther
              ? `${r.mergedCount} smaller ${r.mergedCount === 1 ? nounSingular : nounPlural} under ${fmt(Math.round(activeThreshold * 100))}`
              : isRemaining
                ? `Unspent of ${fmt(totals.incomeTotal)} income`
                : isHeld
                  ? "Unspent — still in this account"
                  : `${spendPct}% of ${fmt(spentTotal)} spending`}
          </span>
        </div>
      </div>
    );
  })();

  // Connected-highlight sets per hover (null = unconstrained, everything
  // stays at rest opacity). Hovering any bar spotlights its flow path: an
  // income lights every line leading from it — its left ribbons plus the
  // downstream cells it actually funds (its sub-ribbons), each in full —
  // and only the other incomes' bars dim; a target lights itself, EVERY
  // cell arriving at it (including ribbons from non-dominant parent
  // groups), every parent group feeding those cells, and the income
  // ribbons feeding those groups — so a merchant split across groups
  // traces its full path, never a single home — while each income bar
  // lights only when one of its slices into the target lights, so an
  // income that never funded the target stays dim even when it funded the
  // target's group for other rows; a group lights every line leading into
  // it from every income plus every line leading out of it, with the bars
  // on both ends. Ribbon hovers trace the through-line end to end: a right
  // ribbon lights its group and target plus the left sub-ribbons funding
  // that cell (one income CAN be traced through it — the cell's own
  // slices), and a left ribbon lights the cells its band's slices
  // continue into. Spotlighted ribbons brighten in place — brightness
  // alone carries the spotlight, never paint order.
  const hl = useMemo(() => {
    const none = {
      src: null as Set<number> | null,
      mid: null as Set<number> | null,
      tgt: null as Set<number> | null,
      ll: null as Set<string> | null,
      rl: null as Set<string> | null,
    };
    if (!hover || hover.kind === "bar" || !sankey) return none;
    const key = (a: number, b: number) => `${a}:${b}`;
    const midCount = sankey.middles.length;
    if (hover.kind === "income") {
      const ll = new Set<string>();
      const rl = new Set<string>();
      const mid = new Set<number>();
      const tgt = new Set<number>();
      for (const l of sankey.linksLeft) {
        if (l.sourceIndex !== hover.idx) continue;
        ll.add(key(l.sourceIndex, l.targetIndex));
        if (l.targetIndex < midCount) mid.add(l.targetIndex);
        else if (sankey.remainingTargetIndex != null) tgt.add(sankey.remainingTargetIndex);
      }
      // Only the cells this income actually funds (its sub-ribbons) light —
      // each in full. Under the legacy proportional split that is every
      // cell, so this matches the old "every line" behavior there.
      for (const c of sankey.leftCells) {
        if (c.sourceIndex !== hover.idx) continue;
        rl.add(key(c.middleIndex, c.targetIndex));
        tgt.add(c.targetIndex);
      }
      return { src: new Set([hover.idx]), mid, tgt, ll, rl };
    }
    if (hover.kind === "group") {
      const ll = new Set<string>();
      const rl = new Set<string>();
      const src = new Set<number>();
      const tgt = new Set<number>();
      for (const l of sankey.linksLeft) {
        if (l.targetIndex !== hover.idx) continue;
        ll.add(key(l.sourceIndex, l.targetIndex));
        src.add(l.sourceIndex);
      }
      for (const l of sankey.linksRight) {
        if (l.sourceIndex !== hover.idx) continue;
        rl.add(key(l.sourceIndex, l.targetIndex));
        tgt.add(l.targetIndex);
      }
      return { src, mid: new Set([hover.idx]), tgt, ll, rl };
    }
    if (hover.kind === "node") {
      // Every ribbon arriving at the target lights — including cells from
      // non-dominant parent groups — plus every group feeding those cells
      // and the income ribbons feeding those groups. A single dominant
      // path used to spotlight here, leaving the smaller legs of a
      // merchant split across groups dim; the full path is the target's
      // whole story, so it all lights.
      const isPlug = sankey.remainingTargetIndex === hover.idx;
      const rl = new Set<string>();
      const mid = new Set<number>();
      for (const l of sankey.linksRight) {
        if (l.targetIndex !== hover.idx) continue;
        rl.add(key(l.sourceIndex, l.targetIndex));
        mid.add(l.sourceIndex);
      }
      const ll = new Set<string>();
      for (const l of sankey.linksLeft) {
        const plugLink = l.targetIndex >= midCount;
        if (isPlug ? !plugLink : !mid.has(l.targetIndex)) continue;
        ll.add(key(l.sourceIndex, l.targetIndex));
      }
      // An income bar lights only when one of its slices into the target
      // lights (band AND cell on the path — the same predicate as
      // leftCellLit below): funding the target's group for other rows is
      // not enough. The plug path keeps its band sources (plug bands have
      // no slices). Under the legacy split every band slices into every
      // cell, so this matches the old band-level behavior there.
      const src = new Set<number>();
      if (isPlug) {
        for (const l of sankey.linksLeft) {
          if (l.targetIndex >= midCount) src.add(l.sourceIndex);
        }
      } else {
        for (const c of sankey.leftCells) {
          if (c.targetIndex !== hover.idx || !mid.has(c.middleIndex)) continue;
          if (!ll.has(key(c.sourceIndex, c.middleIndex))) continue;
          src.add(c.sourceIndex);
        }
      }
      return { src, mid, tgt: new Set([hover.idx]), ll, rl };
    }
    // Ribbon hover: the ribbon plus its endpoint bars.
    if (hover.side === "left") {
      const isPlug = hover.b >= midCount;
      // A group-bound left ribbon continues through its middle as the cells
      // its band's slices fund; a plug ribbon ends at Remaining. Under the
      // legacy split that is every cell out of the middle.
      const contKeys = new Set<string>();
      const contTgt = new Set<number>();
      if (!isPlug) {
        for (const c of sankey.leftCells) {
          if (c.sourceIndex !== hover.a || c.middleIndex !== hover.b) continue;
          contKeys.add(key(c.middleIndex, c.targetIndex));
          contTgt.add(c.targetIndex);
        }
      }
      return {
        src: new Set([hover.a]),
        mid: isPlug ? new Set<number>() : new Set([hover.b]),
        tgt:
          isPlug && sankey.remainingTargetIndex != null
            ? new Set([sankey.remainingTargetIndex])
            : contTgt,
        ll: new Set([key(hover.a, hover.b)]),
        rl: contKeys,
      };
    }
    // The through-line runs back through the left slices funding this cell:
    // only incomes with a slice in it light. Under the legacy split that
    // is every left ribbon feeding its middle.
    const rk = sankey.linksRight.findIndex(
      (l) => l.sourceIndex === hover.a && l.targetIndex === hover.b
    );
    const backSrc = new Set<number>();
    const backLl = new Set<string>();
    if (rk >= 0) {
      for (const c of sankey.leftCells) {
        if (c.rightLinkIndex !== rk) continue;
        backSrc.add(c.sourceIndex);
        backLl.add(key(c.sourceIndex, c.middleIndex));
      }
    }
    return {
      src: backSrc,
      mid: new Set([hover.a]),
      tgt: new Set([hover.b]),
      ll: backLl,
      rl: new Set([key(hover.a, hover.b)]),
    };
  }, [hover, sankey]);

  const hoverBarIdx = hover != null && hover.kind === "bar" ? hover.idx : null;

  // Spotlight state per ribbon: while a flow path is hovered (the hl sets
  // are non-null) ribbons in the path brighten and the rest dims; with no
  // path hover every ribbon sits at rest opacity.
  const leftLit = (a: number, b: number) =>
    hl.ll != null && hl.ll.has(`${a}:${b}`);
  const rightLit = (a: number, b: number) =>
    hl.rl != null && hl.rl.has(`${a}:${b}`);
  // Sub-ribbon spotlight: a subdivided band's subs each feed one downstream
  // cell, so a sub lights only when BOTH its band and its cell sit on the
  // hovered path. Hovering a target (or one of its cell ribbons) lights that
  // target's slices — never the sibling categories nested in the same bands.
  // Income, group, and left-ribbon hovers light every downstream cell of
  // their bands, so all subs of a lit band still light there, unchanged.
  const leftCellLit = (s: GroupedLeftCellLayout) =>
    hl.ll != null &&
    hl.rl != null &&
    hl.ll.has(`${s.sourceIndex}:${s.middleIndex}`) &&
    hl.rl.has(`${s.middleIndex}:${s.targetIndex}`);
  const ribbonOpacity = (lit: boolean, active: boolean) =>
    !active
      ? SANKEY_RIBBON_OPACITY
      : lit
        ? SANKEY_RIBBON_HOVER_OPACITY
        : SANKEY_RIBBON_DIM_OPACITY;

  // Z-order is stable: ribbons always render in layout order, hovered or
  // not — the spotlight never re-sequences the DOM. That is what makes the
  // brightness cross-fade flash-safe: with no reorder there is no instant
  // final z-order to show at pre-transition brightness (the task-29
  // flash), so the steps can glide instead of snapping. The off-path wash
  // sits far below rest, so a lit leg painting under a nearly-transparent
  // dim leg reads pure. (An earlier design rendered lit legs above the dim
  // rest; brightness alone reads the same at these steps without the
  // reorder.)
  const linksLeft = sankey?.linksLeft ?? [];
  const linksRight = sankey?.linksRight ?? [];

  return (
    <Panel
      title={dimension === "categories" ? "Spending by Category" : "Spending by Merchant"}
      className="flex h-full min-h-0 flex-col"
      bodyClass="flex min-h-0 flex-1 flex-col p-0"
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--y-line-soft)] px-3 py-2 text-[11px]"
        style={{ background: "linear-gradient(#fbfbf9,#f1f1ee)" }}
      >
        <span style={{ color: "var(--y-ink-soft)" }}>
          In:{" "}
          <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
            {fmt(totals.incomeTotal)}
          </span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          Out:{" "}
          <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
            {fmt(totals.spendingTotal)}
          </span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          {remaining >= 0 ? "Left: " : "Over: "}
          <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
            {fmt(Math.abs(remaining))}
          </span>
        </span>
        <span style={{ color: "var(--y-ink-faint)" }}>·</span>
        <span style={{ color: "var(--y-ink-soft)" }}>
          {rows.length} {rows.length === 1 ? nounSingular : nounPlural}
          {mergedOtherCount > 0 && (
            <span style={{ color: "var(--y-ink-faint)" }}>
              {" "}
              ({mergedOtherCount} in Other)
            </span>
          )}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1.5">
            <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>Group</span>
            <div className="y-seg">
              <Tooltip tip="Group spending by category">
                <Button
                  size="sm"
                  variant={dimension === "categories" ? "primary" : "default"}
                  active={dimension === "categories"}
                  onClick={() => {
                    setDimension("categories");
                    setHover(null);
                  }}
                >
                  Categories
                </Button>
              </Tooltip>
              <Tooltip tip="Group spending by merchant">
                <Button
                  size="sm"
                  variant={dimension === "merchants" ? "primary" : "default"}
                  active={dimension === "merchants"}
                  onClick={() => {
                    setDimension("merchants");
                    setHover(null);
                  }}
                >
                  Merchants
                </Button>
              </Tooltip>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>View</span>
            <div className="y-seg">
              <Tooltip tip="Sankey flow chart">
                <Button
                  size="sm"
                  variant={viewMode === "sankey" ? "primary" : "default"}
                  active={viewMode === "sankey"}
                  onClick={() => {
                    setViewMode("sankey");
                    setHover(null);
                  }}
                >
                  Sankey
                </Button>
              </Tooltip>
              <Tooltip tip="Bar chart">
                <Button
                  size="sm"
                  variant={viewMode === "bars" ? "primary" : "default"}
                  active={viewMode === "bars"}
                  onClick={() => {
                    setViewMode("bars");
                    setHover(null);
                  }}
                >
                  Bars
                </Button>
              </Tooltip>
            </div>
          </div>
          {viewMode === "sankey" && (
            <div className="flex items-center gap-1.5">
              <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>Sort</span>
              <div className="y-seg">
                <Tooltip tip={`Sort ${nounPlural} by current amount`}>
                  <Button
                    size="sm"
                    variant={sort === "amount" ? "primary" : "default"}
                    active={sort === "amount"}
                    onClick={() => {
                      setSort("amount");
                      setHover(null);
                    }}
                  >
                    Amount
                  </Button>
                </Tooltip>
                <Tooltip
                  tip={
                    dimension === "categories"
                      ? "Sort categories by Budget order: parent group, then each category's position in its group"
                      : `Sort ${nounPlural} by parent group in Budget view order (amount within a group)`
                  }
                >
                  <Button
                    size="sm"
                    variant={sort === "group" ? "primary" : "default"}
                    active={sort === "group"}
                    onClick={() => {
                      setSort("group");
                      setHover(null);
                    }}
                  >
                    Group
                  </Button>
                </Tooltip>
              </div>
            </div>
          )}
          {viewMode === "sankey" && (
            <div className="flex items-center gap-1.5">
              <span className="y-caps text-[10px]" style={{ color: "var(--y-ink-faint)" }}>Held</span>
              <Tooltip
                tip={
                  showHeld
                    ? "Hide still-held flows (their money folds into Remaining)"
                    : "Show still-held flows"
                }
              >
                <Button
                  size="sm"
                  variant={showHeld ? "primary" : "default"}
                  active={showHeld}
                  onClick={() => {
                    setShowHeld(!showHeld);
                    setHover(null);
                  }}
                >
                  {showHeld ? "On" : "Off"}
                </Button>
              </Tooltip>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Tooltip
              tip={
                activeThreshold === 0
                  ? "Merge groups smaller than a threshold into Other"
                  : `Groups under ${fmt(Math.round(activeThreshold * 100))} merge into Other`
              }
            >
              <label
                className="y-caps cursor-pointer text-[10px]"
                style={{ color: "var(--y-ink-faint)" }}
              >
                Under{" "}
                <span className="y-num" style={{ color: "var(--y-ink)" }}>
                  {activeThreshold === 0 ? "—" : fmt(Math.round(activeThreshold * 100))}
                </span>
                <input
                  type="range"
                  aria-label="Merge smaller groups under threshold"
                  aria-valuetext={
                    activeThreshold === 0 ? "Off" : fmt(Math.round(activeThreshold * 100))
                  }
                  className="ml-1.5 inline-block w-[110px] align-middle"
                  style={{ accentColor: "var(--y-blue)" }}
                  min={0}
                  max={stops.length - 1}
                  step={1}
                  value={sliderPos}
                  disabled={empty}
                  onChange={(e) => {
                    markSankeyAutoFitDone();
                    setThresholdDollars(stops[Number(e.target.value)] ?? 0);
                    setHover(null);
                  }}
                />
              </label>
            </Tooltip>
          </div>
        </div>
      </div>

      {viewMode === "bars" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 y-scroll">
          {/* Bars rows stack gaplessly at a fixed natural height: no
              inter-row gap, space, or margin — each row's bottom edge
              touches the next row's top edge — and no flex stretching to
              fill the viewport either. Short lists sit at the top; a long
              list overflows and the outer scroller (overflow-y-auto) takes
              over. Rows never compress, stretch, or truncate to fit. */}
          <div className="mx-auto w-full max-w-[1100px]">
            {/* Shared hatch def for bucket and held bars: the SAME pattern
                element the Sankey overlays on its derived-money rows
                (identical angles, spacing, and colors — the two views
                cannot drift). Bars and Sankey never render together, so
                this id stays unique in the document. Zero-size and out of
                flow: no layout effect. */}
            {rows.some((r) => r.bucket === true || heldBars.has(r.i)) && (
              <svg
                data-testid="bars-bucket-hatch-defs"
                aria-hidden="true"
                width={0}
                height={0}
                style={{ position: "absolute" }}
              >
                <defs>
                  <SankeyBucketHatchPattern id={SANKEY_BUCKET_HATCH_ID} />
                </defs>
              </svg>
            )}
            {empty && <div className="grid place-items-center py-12 y-hint">No data for this timeframe.</div>}
            {rows.map((r) => {
              const isHover = hoverBarIdx === r.i;
              return (
                // Keyed by row position, never by name alone: a literal
                // "Other" category sits beside the merged "Other" bucket,
                // and two rows named "Other" share nothing but the label.
                <div
                  key={`${r.i}:${r.bucket === true ? "bucket" : "row"}:${r.name}`}
                  className="group flex cursor-default items-center gap-3 rounded-[4px] px-2 py-[7px] transition-colors"
                  style={{ background: isHover ? "var(--y-row-sel)" : "transparent" }}
                  onMouseMove={(e) => pushHover({ kind: "bar", idx: r.i, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => pushHover(null)}
                >
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-sm"
                    style={{
                      background: r.color,
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(0,0,0,0.1)",
                    }}
                  />
                  <span
                    className="shrink-0 w-[26%] truncate text-[12.5px]"
                    style={{ color: "var(--y-ink)" }}
                  >
                    {r.name}
                    {r.bucket === true && (
                      <span className="ml-1 text-[11px]" style={{ color: "var(--y-ink-faint)" }}>
                        ({r.mergedCount} merged)
                      </span>
                    )}
                  </span>
                  <div
                    className="y-bar-track relative h-[14px] flex-1 overflow-hidden rounded-[3px]"
                    style={{
                      boxShadow:
                        "inset 0 1px 2px rgba(0,0,0,0.18), 0 1px 0 rgba(255,255,255,0.6)",
                    }}
                  >
                    {(() => {
                      // Simple linear scale against the largest group; no
                      // truncation caps or axis breaks on this report.
                      const displayWidth = Math.round(Math.max(r.pctOfMax, r.value > 0 ? 1 : 0) * 100) / 100;
                      // Hatched rows (merged Other buckets and whole-held
                      // rows — disjoint sets) clip the hatch overlay to the
                      // bar's rounded corners; normal rows keep no children.
                      const hatched = r.bucket === true || heldBars.has(r.i);
                      return (
                        <div
                          className={
                            "relative h-full rounded-[3px] transition-[width] duration-150" +
                            (hatched ? " overflow-hidden" : "")
                          }
                          style={{
                            width: `${displayWidth}%`,
                            background: `linear-gradient(rgba(255,255,255,0.18), rgba(255,255,255,0)) , ${r.color}`,
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.18)",
                          }}
                        >
                          {/* Merged Other buckets carry the shared Sankey
                              hatch above the bar color (the same pattern def
                              the Sankey paints on its derived-money rows —
                              Bars render no Remaining plug, so only `bucket`
                              rows qualify for the bucket hatch). The row hover
                              highlight paints the row behind the bar, so the
                              hatch reads in rest and hover alike. */}
                          {r.bucket === true && (
                            <svg
                              data-testid="bars-bucket-hatch"
                              aria-hidden="true"
                              className="absolute inset-0 h-full w-full"
                              pointerEvents="none"
                            >
                              <rect
                                x={0}
                                y={0}
                                width="100%"
                                height="100%"
                                fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                              />
                            </svg>
                          )}
                          {/* Whole-held rows carry the same shared hatch:
                              still-held balances are derived money, like the
                              buckets — never terminal purchases. */}
                          {r.bucket !== true && heldBars.has(r.i) && (
                            <svg
                              data-testid="bars-held-hatch"
                              aria-hidden="true"
                              className="absolute inset-0 h-full w-full"
                              pointerEvents="none"
                            >
                              <rect
                                x={0}
                                y={0}
                                width="100%"
                                height="100%"
                                fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                              />
                            </svg>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  <span
                    className="y-num w-[110px] shrink-0 text-right text-[12px] font-semibold"
                    style={{ color: "var(--y-ink)" }}
                  >
                    {fmt(r.value)}
                  </span>
                  <span
                    className="y-num w-[52px] shrink-0 text-right text-[11px]"
                    style={{ color: "var(--y-ink-faint)" }}
                  >
                    {r.pctOfTotal}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          ref={chartRef}
          className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto y-scroll"
          style={{
            background: "linear-gradient(#ffffff, #f7f7f4)",
            // The SVG is sized exactly to this box, so horizontal scrolling
            // is never legitimate — clip it (a stray horizontal bar steals
            // vertical space and re-flows the chart). Reserve the vertical
            // gutter so a scrollbar appearing mid-session (threshold slider,
            // new data) never steps the width: the first paint is final.
            scrollbarGutter: "stable",
          }}
          onMouseLeave={() => pushHover(null)}
        >
          {sankeyEmpty && (
            <div className="grid h-full place-items-center y-hint">No data for this timeframe.</div>
          )}
          {!sankeyEmpty && sankey != null && chartSize.width > 0 && chartSize.height > 0 && (
            <svg
              data-testid="sankey-svg"
              width={chartSize.width}
              // The canvas fits the layout's own contentHeight (tallest
              // column or the transit-only Remaining lane, plus the bottom
              // pad) — never the row-count heuristic alone, which undercovers
              // fat bars and would clip them. Same geometry, no re-layout.
              height={Math.max(contentH, sankey.contentHeight)}
              className="block"
            >
              <defs>
                <SankeyBucketHatchPattern id={SANKEY_BUCKET_HATCH_ID} />
                {/* Bar fills come from the layout's own gradient stops,
                    rendered verbatim — the stops already tile each bar so
                    every segment meets its ribbon exactly. */}
                {sankey.sourceFills.map((stops, idx) => (
                  <linearGradient
                    key={`income-${idx}`}
                    id={`${SANKEY_INCOME_GRADIENT_ID_PREFIX}${idx}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    {stops.map((s, k) => (
                      <stop key={k} offset={s.offset} stopColor={s.color} />
                    ))}
                  </linearGradient>
                ))}
                {sankey.middleFills.map((stops, idx) => (
                  <linearGradient
                    key={`middle-${idx}`}
                    id={`${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${idx}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    {stops.map((s, k) => (
                      <stop key={k} offset={s.offset} stopColor={s.color} />
                    ))}
                  </linearGradient>
                ))}
              </defs>
              {/* Column headers: each column names what it holds, so the
                  chart reads without prior knowledge (left is income
                  received — not surplus — middle groups route it, right is
                  where it went). Plain labels — no hover. */}
              {(
                [
                  { col: "income" as const, label: "Income", node: sankey.sources[0] },
                  { col: "group" as const, label: "Groups", node: sankey.middles[0] },
                  {
                    col: "target" as const,
                    label: dimension === "categories" ? "Categories" : "Merchants",
                    node: sankey.targets[0],
                  },
                ] satisfies { col: "income" | "group" | "target"; label: string; node: { x: number; w: number } | undefined }[]
              ).map(
                (h) =>
                  h.node != null && (
                    <text
                      key={h.col}
                      data-testid="sankey-colhead"
                      data-col={h.col}
                      x={h.node.x + h.node.w / 2}
                      y={SANKEY_PAD_TOP - 10}
                      fontSize={10}
                      textAnchor="middle"
                      fill="var(--y-ink-faint)"
                      style={{ letterSpacing: "0.08em" }}
                    >
                      {h.label.toUpperCase()}
                    </text>
                  )
              )}
              {linksLeft.map((link) => {
                const subs = leftCellsByBand.get(`${link.sourceIndex}:${link.targetIndex}`);
                const lit = leftLit(link.sourceIndex, link.targetIndex);
                const opacity = ribbonOpacity(lit, hl.ll != null);
                const hoverPayload = (x: number, y: number) => ({
                  kind: "link" as const,
                  side: "left" as const,
                  a: link.sourceIndex,
                  b: link.targetIndex,
                  x,
                  y,
                });
                // A subdivided band renders one sub-ribbon per downstream
                // cell from the layout's own paths and fills — the band
                // stays one hover target (handlers on the wrapping <g>, so
                // moving between sub-ribbons never flickers the spotlight),
                // but each sub carries its own spotlight key: its band's AND
                // its downstream cell's, so a target hover lights only that
                // target's slices out of the shared bands.
                if (subs != null) {
                  return (
                    <g
                      key={`ll-${link.sourceIndex}-${link.targetIndex}`}
                      style={{ cursor: "pointer" }}
                      onMouseMove={(e) => pushHover(hoverPayload(e.clientX, e.clientY))}
                      onMouseLeave={() => pushHover(null)}
                    >
                      {subs.map((s, si) => (
                        <Fragment key={`llsub-${si}`}>
                          <path
                            data-testid="sankey-link"
                            data-side="left"
                            d={s.d}
                            fill={s.fill}
                            fillOpacity={ribbonOpacity(leftCellLit(s), hl.ll != null)}
                            stroke="none"
                            style={{
                              transition: `fill-opacity ${transitionMs}ms`,
                            }}
                          />
                          {/* Sub-ribbons funding a held cell carry the shared
                              hatch over the layout's own path (per-sub
                              granularity, like the spotlight: siblings
                              funding spending cells stay solid) — same
                              opacity step and cross-fade as the solid sub, so
                              the overlay brightens and dims with it. */}
                          {heldTargets.has(s.targetIndex) && (
                            <path
                              data-testid="sankey-held-hatch"
                              data-side="left"
                              d={s.d}
                              fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                              fillOpacity={ribbonOpacity(leftCellLit(s), hl.ll != null)}
                              stroke="none"
                              pointerEvents="none"
                              style={{
                                transition: `fill-opacity ${transitionMs}ms`,
                              }}
                            />
                          )}
                          {/* Sub-ribbons funding a bucket-target or plug cell
                              carry the same shared hatch under the bucket
                              testid (per-sub granularity, like the held
                              overlays: siblings funding real-category cells
                              in the same band stay solid) — same opacity step
                              and cross-fade as the solid sub. Disjoint from
                              the held set (see isBucketOrPlugTarget), so a
                              sub never double-hatches. */}
                          {isBucketOrPlugTarget(s.targetIndex) && (
                            <path
                              data-testid="sankey-bucket-hatch"
                              data-side="left"
                              d={s.d}
                              fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                              fillOpacity={ribbonOpacity(leftCellLit(s), hl.ll != null)}
                              stroke="none"
                              pointerEvents="none"
                              style={{
                                transition: `fill-opacity ${transitionMs}ms`,
                              }}
                            />
                          )}
                        </Fragment>
                      ))}
                    </g>
                  );
                }
                // Whole bands (the Remaining plug and the degenerate fallback)
                // render the layout's own path and fill: one flat ribbon
                // through the whole length, and the income side never colors
                // one.
                const solid = (
                  <path
                    data-testid="sankey-link"
                    data-side="left"
                    d={link.d}
                    fill={link.fill}
                    fillOpacity={opacity}
                    stroke="none"
                    style={{
                      cursor: "pointer",
                      transition: `fill-opacity ${transitionMs}ms`,
                    }}
                    onMouseMove={(e) => pushHover(hoverPayload(e.clientX, e.clientY))}
                    onMouseLeave={() => pushHover(null)}
                  />
                );
                // Only the full-width plug-lane ribbons hatch: b is the plug
                // index (one past the last middle). Degenerate whole bands
                // into a middle stay solid — the hatch follows the
                // destination, and a middle is never a hatched target row.
                if (link.targetIndex !== (sankey?.middles.length ?? -1)) {
                  return (
                    <Fragment key={`ll-${link.sourceIndex}-${link.targetIndex}`}>{solid}</Fragment>
                  );
                }
                // Plug-lane ribbons overlay the SAME layout path with the
                // shared hatch — same opacity step and cross-fade as the
                // solid ribbon, so the overlay brightens and dims with it.
                // Static DOM order (no z-reorder); pointer-events none so
                // hover still hits the solid ribbon beneath.
                return (
                  <Fragment key={`ll-${link.sourceIndex}-${link.targetIndex}`}>
                    {solid}
                    <path
                      data-testid="sankey-bucket-hatch"
                      data-side="left"
                      d={link.d}
                      fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                      fillOpacity={opacity}
                      stroke="none"
                      pointerEvents="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                  </Fragment>
                );
              })}
              {linksRight.map((link) => {
                // One ribbon per group→target cell, rendered from the
                // layout's own path and fill: each ribbon reads as where
                // the money lands, no matter which middle group it comes
                // from — hovering one traces its through-line end to end.
                const lit = rightLit(link.sourceIndex, link.targetIndex);
                const held = heldTargets.has(link.targetIndex);
                const bucket = !held && isBucketOrPlugTarget(link.targetIndex);
                const solid = (
                  <path
                    data-testid="sankey-link"
                    data-side="right"
                    d={link.d}
                    fill={link.fill}
                    fillOpacity={ribbonOpacity(lit, hl.rl != null)}
                    stroke="none"
                    style={{
                      cursor: "pointer",
                      transition: `fill-opacity ${transitionMs}ms`,
                    }}
                    onMouseMove={(e) =>
                      pushHover({
                        kind: "link",
                        side: "right",
                        a: link.sourceIndex,
                        b: link.targetIndex,
                        x: e.clientX,
                        y: e.clientY,
                      })
                    }
                    onMouseLeave={() => pushHover(null)}
                  />
                );
                if (!held && !bucket) {
                  return (
                    <Fragment key={`rl-${link.sourceIndex}-${link.targetIndex}`}>{solid}</Fragment>
                  );
                }
                // Ribbons into a held, bucket, or plug target overlay the
                // SAME layout path with the shared hatch — same opacity step
                // and cross-fade as the solid ribbon, so the overlay
                // brightens and dims with it. Static DOM order (no
                // z-reorder); pointer-events none so hover still hits the
                // solid ribbon beneath. One overlay at most: the held and
                // bucket/plug target sets are disjoint, and ribbons into
                // real targets from any middle (even a middle bucket) stay
                // solid — the hatch follows the destination.
                return (
                  <Fragment key={`rl-${link.sourceIndex}-${link.targetIndex}`}>
                    {solid}
                    <path
                      data-testid={held ? "sankey-held-hatch" : "sankey-bucket-hatch"}
                      data-side="right"
                      d={link.d}
                      fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                      fillOpacity={ribbonOpacity(lit, hl.rl != null)}
                      stroke="none"
                      pointerEvents="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                  </Fragment>
                );
              })}
              {sankey.sources.map((node, idx) => {
                const r = srcRows[idx]!;
                // Each income bar fills with its own gradient — never flat
                // gray, never a hover overlay, never a border. In both
                // groupings the segments are the downstream cells' target
                // colors, so every segment meets its sub-ribbon exactly. The
                // merged Other bucket adds the render-only hatch. The bar
                // joins the flow-path spotlight at the ribbons' own
                // brightness steps.
                const isBucket = r.bucket === true;
                const lit = hl.src != null && hl.src.has(idx);
                const dim = hl.src != null && !hl.src.has(idx);
                const barOpacity = hl.src == null
                  ? SANKEY_RIBBON_OPACITY
                  : lit
                    ? SANKEY_RIBBON_HOVER_OPACITY
                    : SANKEY_RIBBON_DIM_OPACITY;
                // Labels anchor at the layout's own labelY verbatim — never
                // recomputed here, so hairline bars keep their labels clear
                // of neighbors instead of centered on the sliver.
                const labelY = node.labelY;
                // Bars too short for two lines show the name only, centered
                // on the bar; taller bars keep name + amount.
                const twoLine = showSankeySourceAmount(node.h);
                // One hover target per row, like the right column: the <g>
                // owns the row's hover, so the bar, name, and amount all
                // spotlight the same path and moving between them never fires
                // leave+enter (spotlight flicker). The transparent hit band
                // bridges the dead space between the parts — the bar→label
                // gap and the space between the two label lines — so the
                // whole row band holds the hover. It spans the bar's exact
                // vertical extent (adjacent rows never overlap) and runs
                // from the SVG's left edge to the bar's right edge; nothing
                // else interactive lives in the left gutter. Rendered
                // beneath the bar and labels; invisible.
                return (
                  <g
                    key={`src-${node.name}-${idx}`}
                    style={{ cursor: "pointer" }}
                    onMouseMove={(e) =>
                      pushHover({ kind: "income", idx, x: e.clientX, y: e.clientY })
                    }
                    onMouseLeave={() => pushHover(null)}
                  >
                    <rect
                      data-testid="sankey-income-hit"
                      x={0}
                      y={node.y}
                      width={node.x + node.w}
                      height={Math.max(0, node.h)}
                      fill="transparent"
                    />
                    <rect
                      data-testid="sankey-income"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={`url(#${SANKEY_INCOME_GRADIENT_ID_PREFIX}${idx})`}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                    {isBucket && (
                      <rect
                        data-testid="sankey-bucket-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    {/* Derived-money segments hatch like their ribbons —
                        held spans under the held testid, bucket/plug spans
                        under the bucket one (disjoint, like the sub
                        overlays). Skipped on whole-bucket bars, which
                        already hatch end to end. Overlays ride the bar's
                        own opacity step, so the segments brighten and dim
                        with the bar instead of stroking it. */}
                    {!isBucket &&
                      (sourceHatchSpans[idx] ?? []).map((s, k) => (
                        <rect
                          key={`hatch-${k}`}
                          data-testid={s.held ? "sankey-held-hatch" : "sankey-bucket-hatch"}
                          x={node.x}
                          y={s.y0}
                          width={node.w}
                          height={Math.max(0, s.y1 - s.y0)}
                          fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                          fillOpacity={barOpacity}
                          pointerEvents="none"
                          style={{
                            transition: `fill-opacity ${transitionMs}ms`,
                          }}
                        />
                      ))}
                    <text
                      data-testid="sankey-income-label"
                      x={sankey.sourceLabelX}
                      y={twoLine ? labelY - 2 : labelY + 4}
                      fontSize={12}
                      textAnchor="end"
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {truncateName(node.name, sourceLabelMaxChars)}
                    </text>
                    {twoLine && (
                      <text
                        data-testid="sankey-income-amount"
                        x={sankey.sourceLabelX}
                        y={labelY + 13}
                        fontSize={11}
                        textAnchor="end"
                        fill="var(--y-ink-faint)"
                        className="y-num"
                        opacity={dim ? 0.4 : 1}
                        style={{
                          transition: `opacity ${transitionMs}ms`,
                        }}
                      >
                        {fmt(node.value)} · {r.flowPct}%
                      </text>
                    )}
                  </g>
                );
              })}
              {sankey.middles.map((node, idx) => {
                const r = midRows[idx]!;
                const isBucket = r.bucket === true;
                // Parent groups join the flow-path spotlight at the ribbons'
                // own brightness steps: rest opacity at rest, bright when the
                // hovered path runs through them, dimmed otherwise.
                const lit = hl.mid != null && hl.mid.has(idx);
                const dim = hl.mid != null && !hl.mid.has(idx);
                const barOpacity = hl.mid == null
                  ? SANKEY_RIBBON_OPACITY
                  : lit
                    ? SANKEY_RIBBON_HOVER_OPACITY
                    : SANKEY_RIBBON_DIM_OPACITY;
                // Labels anchor at the layout's own labelY verbatim — never
                // recomputed here, so hairline bars keep their labels clear
                // of neighbors instead of centered on the sliver.
                const labelY = node.labelY;
                // One hover target per row, like the other columns: the <g>
                // owns the row's hover, so the bar, name, and amount all
                // spotlight the same path and moving between them never fires
                // leave+enter (spotlight flicker). Deliberately no hit band
                // bridging the bar→label gap: the middle labels sit in the
                // ribbon zone, so a band painted with this row (above the
                // ribbons) would swallow the ribbon hovers crossing it.
                // Instead the ribbons beneath catch most gap pixels — the
                // bands tile the bar's full height at its right edge, so
                // bar→label travel passes through ribbon pixels (a correct
                // switch to the ribbon, not a blink) — and the unified <g>
                // kills the part↔part leave+enter outright.
                return (
                  <g
                    key={`mid-${node.name}-${idx}`}
                    style={{ cursor: "pointer" }}
                    onMouseMove={(e) =>
                      pushHover({ kind: "group", idx, x: e.clientX, y: e.clientY })
                    }
                    onMouseLeave={() => pushHover(null)}
                  >
                    {/* Each middle bar fills with its own gradient — never
                        flat group color, never a hover overlay, never a
                        border. The segments are the outgoing cells' target
                        colors, so every segment meets its ribbon exactly,
                        like the income bars. The merged Other bucket adds
                        only the shared hatch (as does the Still-held group
                        bar). The bar wraps the group's
                        funded flow; when spending exceeds income the gap
                        shows in the tooltip, not as a grey segment. */}
                    <rect
                      data-testid="sankey-group"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={`url(#${SANKEY_MIDDLE_GRADIENT_ID_PREFIX}${idx})`}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                    {isBucket && (
                      <rect
                        data-testid="sankey-bucket-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    {/* A whole-held Still-held group bar carries the shared
                        hatch like the bucket bars (see heldMiddles). */}
                    {heldMiddles.has(idx) && (
                      <rect
                        data-testid="sankey-held-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    {/* Middle labels sit in the ribbon zone, so they carry
                        a fully opaque halo: no ribbon color can bleed
                        through and tint it. */}
                    <text
                      data-testid="sankey-group-label"
                      x={sankey.middleLabelX}
                      y={node.h >= 26 ? labelY - 2 : labelY - 6}
                      fontSize={12}
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      stroke="#ffffff"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {truncateName(node.name)}
                    </text>
                    <text
                      data-testid="sankey-group-amount"
                      x={sankey.middleLabelX}
                      y={node.h >= 26 ? labelY + 13 : labelY + 7}
                      fontSize={11}
                      fill="var(--y-ink-faint)"
                      className="y-num"
                      opacity={dim ? 0.4 : 1}
                      stroke="#ffffff"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {fmt(node.value)} · {r.flowPct}%
                    </text>
                  </g>
                );
              })}
              {sankey.targets.map((node, idx) => {
                const r = tgtRows[idx]!;
                // The target's own color, shared with every incoming ribbon,
                // so each line into this bar reads as one color throughout —
                // whichever middle group it arrives from.
                // No borders, hovered or not: derived-money rows — the merged
                // Other bucket, the Remaining surplus plug, and whole-held
                // rows — add only the hatch, and hovering brightens via the
                // spotlight instead of stroking (an SVG stroke centers on the
                // edge, so even a same-color stroke would paint 1px outside
                // the bar and make it look bigger than the ribbon stack
                // feeding it). The bar wraps the row's funded flow; when
                // spending exceeds income the gap shows in the tooltip, not
                // as a grey segment.
                const color = r.color;
                const isComputed = r.bucket === true || r.isPlug;
                const isHeld = heldTargets.has(idx);
                // Like the middle bars: the same fill at the ribbons' own
                // rest/bright/dim steps, so each incoming line matches the
                // bar exactly in every spotlight state.
                const lit = hl.tgt != null && hl.tgt.has(idx);
                const dim = hl.tgt != null && !hl.tgt.has(idx);
                const barOpacity = hl.tgt == null
                  ? SANKEY_RIBBON_OPACITY
                  : lit
                    ? SANKEY_RIBBON_HOVER_OPACITY
                    : SANKEY_RIBBON_DIM_OPACITY;
                // Labels anchor at the layout's own labelY verbatim — never
                // recomputed here, so hairline bars keep their labels clear
                // of neighbors instead of centered on the sliver.
                const labelY = node.labelY;
                // One hover target per row: the <g> owns the row's hover, so
                // the bar, title, and amount all spotlight the same path and
                // moving between them never fires leave+enter (spotlight
                // flicker). The transparent hit band bridges the dead space
                // between the parts — the bar→label gap and the space between
                // the two label lines — so the whole row band holds the hover.
                // It spans the bar's exact vertical extent (adjacent rows
                // never overlap) and runs to the SVG edge; nothing else
                // interactive lives in the label zone. Rendered beneath the
                // bar and labels; invisible.
                return (
                  <g
                    key={`tgt-${node.name}-${idx}`}
                    style={{ cursor: "pointer" }}
                    onMouseMove={(e) =>
                      pushHover({ kind: "node", idx, x: e.clientX, y: e.clientY })
                    }
                    onMouseLeave={() => pushHover(null)}
                  >
                    <rect
                      data-testid="sankey-target-hit"
                      x={node.x}
                      y={node.y}
                      width={Math.max(0, chartSize.width - node.x)}
                      height={Math.max(0, node.h)}
                      fill="transparent"
                    />
                    <rect
                      data-testid="sankey-node"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={color}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{
                        transition: `fill-opacity ${transitionMs}ms`,
                      }}
                    />
                    {isComputed && (
                      <rect
                        data-testid="sankey-bucket-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    {/* Whole-held rows carry the shared hatch like the
                        buckets (disjoint sets — a held row is never a
                        bucket or the plug, so this never double-hatches). */}
                    {isHeld && (
                      <rect
                        data-testid="sankey-held-hatch"
                        x={node.x}
                        y={node.y}
                        width={node.w}
                        height={Math.max(0, node.h)}
                        fill={`url(#${SANKEY_BUCKET_HATCH_ID})`}
                        fillOpacity={barOpacity}
                        pointerEvents="none"
                        style={{
                          transition: `fill-opacity ${transitionMs}ms`,
                        }}
                      />
                    )}
                    <text
                      data-testid="sankey-target-label"
                      x={sankey.targetLabelX}
                      y={node.h >= 26 ? labelY - 2 : labelY - 6}
                      fontSize={12}
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {truncateName(node.name)}
                    </text>
                    <text
                      data-testid="sankey-target-amount"
                      x={sankey.targetLabelX}
                      y={node.h >= 26 ? labelY + 13 : labelY + 7}
                      fontSize={11}
                      fill="var(--y-ink-faint)"
                      className="y-num"
                      opacity={dim ? 0.4 : 1}
                      style={{
                        transition: `opacity ${transitionMs}ms`,
                      }}
                    >
                      {fmt(node.value)} · {r.flowPct}%
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      )}

      <ChartTip x={hover?.x ?? null} y={hover?.y ?? null} content={tipContent} />
    </Panel>
  );
}
