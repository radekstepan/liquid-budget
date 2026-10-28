"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fmt,
  mergeBelowThreshold,
  mergeGroupFlow,
  layoutGroupedIncomeSankey,
  sankeyAutoFitThreshold,
  sankeyContentHeight,
  OVER_INCOME_LABEL,
  sankeyThresholdStep,
  sankeyThresholdStops,
  showSankeySourceAmount,
  sortMergedGroupFlow,
  SANKEY_LEFT_LABEL_INSET,
  SANKEY_NODE_GAP,
  SANKEY_NODE_MIN_HEIGHT,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  SANKEY_SOURCE_GUTTER,
  UNCATEGORIZED_GROUP_LABEL,
  type MergedSpendingItem,
  type SankeyTargetSort,
  type SpendingBreakdownItem,
  type SpendingDimension,
  type SpendingGroupFlow,
} from "@ynab/logic";
import { Button, Panel, Tooltip } from "@ynab/theme";
import {
  ChartTip,
  colorForName,
  sankeyIncomeGradientStops,
  sankeyTargetColors,
  SankeyBucketHatchPattern,
  SANKEY_INCOME_COLOR,
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
  | { kind: "head"; col: "income" | "group" | "target"; x: number; y: number }
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

// Each ribbon carries one flat color — the color of the node it flows
// INTO — through its whole length: left-hop ribbons the middle group's (or
// the Remaining plug's green for the full-width surplus ribbons), right-hop
// ribbons their final category's or merchant's family shade. The income
// side never colors a ribbon. Exported so tests can pin the fills.
//
// Spotlight scale: at rest every ribbon and every bar sits at
// SANKEY_RIBBON_OPACITY — nearly as solid as the hover step, one small
// step below it so the spotlight still reads as a brightening; while a
// flow path is hovered the path's ribbons and bars brighten to
// SANKEY_RIBBON_HOVER_OPACITY (ribbons render above the rest) and
// everything outside the path dims to SANKEY_RIBBON_DIM_OPACITY, kept
// far below rest so the off-path wash stays clearly dimmer. Bars share
// their ribbons' exact fill at the same steps, so the line into a bar
// always matches the bar.
export const SANKEY_RIBBON_OPACITY = 0.75;
export const SANKEY_RIBBON_DIM_OPACITY = 0.12;
export const SANKEY_RIBBON_HOVER_OPACITY = 0.85;

// Render-only bars — the merged "Other" buckets on every column and the
// "Remaining" surplus plug — carry a light hatch (no bar carries a
// border), so computed rows never read as real ones.
export const SANKEY_BUCKET_HATCH_ID = "sankey-bucket-hatch";

// Income bars fill with a hard-edged top-to-bottom gradient built from
// their outgoing ribbons' destination colors — one gradient per bar, so
// each bar segment matches its ribbon exactly. Bar i paints from
// `${SANKEY_INCOME_GRADIENT_ID_PREFIX}${i}`.
export const SANKEY_INCOME_GRADIENT_ID_PREFIX = "sankey-income-gradient-";

// Session flag for the Under auto-fit: it runs at most once per tab session —
// on the first Sankey paint with a measured container — and never again after
// the user drags the slider themselves. Report tab switches remount this
// component, so a mount-local ref alone would re-auto and fight the user's
// in-session choice; sessionStorage survives remounts but resets on a fresh
// tab load, which is exactly "initial load" semantics.
const SANKEY_AUTOFIT_SESSION_KEY = "ynab:reports:spendingAutoFit";

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
  // Budget view group names in Budget order (group.sort) — the "Group"
  // sort mode orders the Sankey's middle column by this.
  groupOrder = [],
  // Budget view category names in group-major sort order — the "Group"
  // sort mode orders categories within their parent group by this.
  // Merchants have no Budget position and stay value-descending.
  categoryOrder = [],
  initialView = "sankey",
  initialDimension = "categories",
}: {
  categoryFlow: SpendingGroupFlow;
  merchantFlow: SpendingGroupFlow;
  income: SpendingItem[];
  groupOrder?: readonly string[];
  categoryOrder?: readonly string[];
  initialView?: SpendingViewMode;
  initialDimension?: SpendingDimension;
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
  const [hover, setHover] = useState<Hover | null>(null);
  // Mousemove fires far more often than the display refreshes; coalescing
  // hover commits to one per frame (latest wins) keeps cursor sweeps from
  // queuing a full multi-hundred-element re-render per event — the same
  // throttle the other reports use. Clears stay synchronous.
  const pushHover = useRafThrottledSet(setHover);
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
  // Column order for the Sankey layout (a permutation — sums and marginals
  // are untouched, so the header totals and Bars rows read `merged`).
  const ordered = useMemo(
    () => sortMergedGroupFlow(merged, groupOrder, sort, categoryOrder),
    [merged, groupOrder, sort, categoryOrder]
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

  // Bars rows: spending shares (unchanged by the income side). Bars share
  // the Sankey's family colors so a category keeps its color across views.
  const rows = useMemo(() => {
    const maxSpend = merged.targets.reduce((m, s) => Math.max(m, s.value), 1);
    const colors = sankeyTargetColors(
      merged.groups.map((g) => ({ name: g.name, bucket: g.bucket === true })),
      merged.targets.map((t) => ({ name: t.name, bucket: t.bucket === true, isPlug: false })),
      merged.links.map((l) => ({
        middleIndex: l.groupIndex,
        targetIndex: l.targetIndex,
        value: l.value,
      }))
    );
    return merged.targets.map((s, i) => {
      const share = spentTotal !== 0 ? s.value / spentTotal : 0;
      const pctOfTotal = Math.round(share * 100);
      const pctOfMax = (s.value / maxSpend) * 100;
      const color = colors[i] ?? colorForName(s.name);
      return { ...s, share, pctOfTotal, pctOfMax, color, i };
    });
  }, [merged, spentTotal]);

  // Income rows for the layout: the same Under threshold folds small
  // income sources into an Other bucket on the left, and the proportional
  // link math runs on the merged columns (conservation preserved).
  const incomeRows: MergedSpendingItem[] = mergedIncome.items;

  const empty = incomeRows.length === 0 && merged.targets.length === 0;
  const growRows = rows.length > 0 && rows.length <= 14;
  const nounSingular = dimension === "categories" ? "category" : "merchant";
  const nounPlural = dimension === "categories" ? "categories" : "merchants";
  const remaining = totals.remaining;

  // The chart grows past the viewport when rows need more room (the
  // container scrolls) instead of crushing labels onto each other. Counts
  // come from the raw inputs (plus the future Remaining plug): raw lengths
  // can only overestimate the layout's filtered columns, erring toward
  // harmless slack rather than crushed rows.
  const contentH = useMemo(
    () =>
      sankeyContentHeight(
        Math.max(
          incomeRows.length,
          merged.groups.length,
          merged.targets.length + (totals.incomeTotal > totals.spendingTotal ? 1 : 0)
        ),
        chartSize.height
      ),
    [incomeRows.length, merged.groups.length, merged.targets.length, totals.incomeTotal, totals.spendingTotal, chartSize.height]
  );

  const sankey = useMemo(() => {
    if (chartSize.width <= 0 || chartSize.height <= 0) return null;
    return layoutGroupedIncomeSankey(incomeRows, ordered.groups, ordered.targets, ordered.links, {
      width: chartSize.width,
      height: contentH,
      padLeft: SANKEY_SOURCE_GUTTER,
      padRight: LABEL_ZONE,
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
      minNodeHeight: SANKEY_NODE_MIN_HEIGHT,
    });
  }, [incomeRows, ordered.groups, ordered.targets, ordered.links, chartSize.width, chartSize.height, contentH]);

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
      flow.groups,
      flow.targets,
      flow.links,
      income,
      stops,
      chartSize.height
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
    flow,
    income,
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
  // non-positive values), so labels and bars always agree.
  const srcRows = useMemo(
    () =>
      (sankey?.sources ?? []).map((s, i) => ({
        ...s,
        flowPct:
          totals.flowTotal !== 0 ? Math.round((s.value / totals.flowTotal) * 100) : 0,
        // Neutral gray for the income tooltip dot only: the bars
        // themselves fill with their outgoing ribbons' colors. No single
        // color can stand for a gradient bar.
        color: SANKEY_INCOME_COLOR,
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
        color: colorForName(m.name),
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
    // Family colors attribute each target to its dominant parent group
    // (cells taken straight from the layout's own right-hop ribbons, so the
    // mapping is aligned with the drawn columns by construction).
    const colors = sankey
      ? sankeyTargetColors(
          sankey.middles.map((m) => ({ name: m.name, bucket: m.bucket })),
          targets.map((t, i) => ({
            name: t.name,
            bucket: t.bucket,
            isPlug: sankey.remainingTargetIndex === i,
          })),
          sankey.linksRight.map((l) => ({
            middleIndex: l.sourceIndex,
            targetIndex: l.targetIndex,
            value: l.value,
          }))
        )
      : [];
    return targets.map((t, i) => ({
      ...t,
      flowPct:
        totals.flowTotal !== 0 ? Math.round((t.value / totals.flowTotal) * 100) : 0,
      color: colors[i] ?? colorForName(t.name),
      // By position, never by name: a literal "Remaining" category is
      // still just a category.
      isPlug: sankey?.remainingTargetIndex === i,
      i,
    }));
  }, [sankey, totals.flowTotal]);

  // Flat destination color of a left-hop ribbon: its middle group's color —
  // except the full-width surplus ribbons, which carry the Remaining plug's
  // green straight through to the right. Shared by the ribbon fills and the
  // income bar gradients so each bar melts into exactly its ribbons' colors.
  const leftFillFor = (targetIndex: number, targetName: string): string => {
    const plugTarget = sankey?.remainingTargetIndex;
    return targetIndex >= midRows.length && plugTarget != null
      ? (tgtRows[plugTarget]?.color ?? colorForName(targetName))
      : (midRows[targetIndex]?.color ?? colorForName(targetName));
  };

  // One fill gradient per income bar: each bar stacks its outgoing
  // ribbons' destination colors top-to-bottom with hard edges at the
  // ribbon boundaries — no feathering, no border, no gray. A bar with no
  // outgoing bands (defensive) falls back to the solid neutral income gray.
  const incomeGradients = useMemo(() => {
    if (sankey == null) return [];
    return sankey.sources.map((bar, idx) => {
      const bands = sankey.linksLeft
        .filter((l) => l.sourceIndex === idx)
        .map((l) => ({ y0: l.sy0, y1: l.sy1, color: leftFillFor(l.targetIndex, l.targetName) }));
      return sankeyIncomeGradientStops(bar.y, bar.y + bar.h, bands);
    });
    // leftFillFor closes over the layout-derived rows, hence their deps.
  }, [sankey, midRows, tgtRows]);

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
          {isOther && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Render-only — grouped by the Under threshold</span>
            </div>
          )}
          {r.transfer === true && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Includes withdrawals from off-budget accounts</span>
            </div>
          )}
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
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>
              {dimension === "categories"
                ? "Rolls up into its group — no splitting"
                : "The merchant's exact share in this group"}
            </span>
          </div>
        </div>
      );
    }
    if (hover.kind === "group") {
      const r = midRows[hover.idx];
      if (!r) return null;
      const isOther = r.bucket === true;
      const spendPct =
        spentTotal !== 0 ? Math.round((r.value / spentTotal) * 100) : 0;
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            {r.name}
          </div>
          <TipLabel
            color={r.color}
            label="Spent"
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
                : `${r.memberCount} ${r.memberCount === 1 ? nounSingular : nounPlural} · ${spendPct}% of ${fmt(spentTotal)} spending`}
            </span>
          </div>
          {isOther && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Render-only — grouped by the Under threshold</span>
            </div>
          )}
          {r.name === UNCATEGORIZED_GROUP_LABEL && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Spending with no category set</span>
            </div>
          )}
          {r.unfundedValue > 0 && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>
                {`Spending exceeded income by ${fmt(totals.spendingTotal - totals.incomeTotal)} — covered from savings or debt`}
              </span>
            </div>
          )}
        </div>
      );
    }
    if (hover.kind === "bar") {
      const r = rows[hover.idx];
      if (!r) return null;
      const isOther = r.bucket === true;
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            {r.name}
          </div>
          <TipLabel
            color={r.color}
            label="Spent"
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
                : `of ${fmt(spentTotal)} total`}
            </span>
          </div>
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
    if (hover.kind === "head") {
      const heads = {
        income: {
          title: "Income",
          lines: [
            "Money received this period.",
            "Includes withdrawals back into the budget.",
          ],
        },
        group: {
          title: "Category groups",
          lines: [
            "Income splits across groups,",
            "then flows into spending.",
          ],
        },
        target: {
          title: dimension === "categories" ? "Spending by category" : "Spending by merchant",
          lines: [
            "Where the money went.",
            "Unspent income lands in Remaining.",
          ],
        },
      } as const;
      const head = heads[hover.col];
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            {head.title}
          </div>
          {head.lines.map((line) => (
            <div
              key={line}
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>{line}</span>
            </div>
          ))}
        </div>
      );
    }
    const r = tgtRows[hover.idx];
    if (!r) return null;
    const isOther = r.bucket === true;
    const isRemaining = r.isPlug;
    const spendPct =
      spentTotal !== 0 ? Math.round((r.value / spentTotal) * 100) : 0;
    return (
      <div className="space-y-[3px]">
        <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
          {r.name}
        </div>
        <TipLabel
          color={r.color}
          label={isRemaining ? "Left" : "Spent"}
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
                : `${spendPct}% of ${fmt(spentTotal)} spending`}
          </span>
        </div>
        {isOther && (
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>Render-only — grouped by the Under threshold</span>
          </div>
        )}
        {isRemaining && (
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>{`Render-only row — unspent income, not a real ${nounSingular}`}</span>
          </div>
        )}
        {r.transfer === true && !isRemaining && (
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>Includes money moved to off-budget accounts</span>
          </div>
        )}
        {r.unfundedValue > 0 && (
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>
              {`Spending exceeded income by ${fmt(totals.spendingTotal - totals.incomeTotal)} — covered from savings or debt`}
            </span>
          </div>
        )}
      </div>
    );
  })();

  // Connected-highlight sets per hover (null = unconstrained, everything
  // stays at rest opacity). Hovering any bar spotlights its flow path: an
  // income lights every line leading from it — its left ribbons plus its
  // full downstream contribution, every right-hop cell in full (money is
  // fungible, so that is every group and target) — and only the other
  // incomes' bars dim; a target lights itself, its dominant (largest-link)
  // cell, its dominant parent group, and the income ribbons feeding that
  // group — only the dominant path spotlights, so a merchant split across
  // groups traces its true home instead of every group's full funding fan;
  // a group lights every line leading into it from every income plus every
  // line leading out of it, with the bars on both ends. Ribbon hovers trace
  // the through-line end to end: a right ribbon lights its group and target
  // plus every left ribbon feeding that group (a merged cell carries every
  // income's money, so one income cannot be traced through it), and a left
  // ribbon lights every cell continuing through its middle. Spotlighted
  // ribbons brighten and render above the dimmed rest.
  const hl = useMemo(() => {
    const none = {
      src: null as Set<number> | null,
      mid: null as Set<number> | null,
      tgt: null as Set<number> | null,
      ll: null as Set<string> | null,
      rl: null as Set<string> | null,
    };
    if (!hover || hover.kind === "bar" || hover.kind === "head" || !sankey) return none;
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
      // Every cell carries this income's money (fungible proportional
      // split), so the full downstream contribution lights in full.
      for (const l of sankey.linksRight) {
        rl.add(key(l.sourceIndex, l.targetIndex));
        tgt.add(l.targetIndex);
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
      // Each target belongs to its dominant (largest-link) parent group —
      // the same rule as the family colors and the Group sort — so only
      // that group's path spotlights. Categories trivially have one group;
      // a merchant split across groups used to light every group's full
      // funding fan here, highlighting income flows with nothing to do
      // with it. Ties keep the first link in layout order (deterministic).
      const isPlug = sankey.remainingTargetIndex === hover.idx;
      let dom: { middleIndex: number; value: number } | null = null;
      for (const l of sankey.linksRight) {
        if (l.targetIndex !== hover.idx) continue;
        if (dom == null || l.value > dom.value) {
          dom = { middleIndex: l.sourceIndex, value: l.value };
        }
      }
      const rl = new Set<string>();
      const mid = new Set<number>();
      if (dom != null) {
        rl.add(key(dom.middleIndex, hover.idx));
        mid.add(dom.middleIndex);
      }
      const ll = new Set<string>();
      const src = new Set<number>();
      for (const l of sankey.linksLeft) {
        const plugLink = l.targetIndex >= midCount;
        if (isPlug ? !plugLink : !mid.has(l.targetIndex)) continue;
        ll.add(key(l.sourceIndex, l.targetIndex));
        src.add(l.sourceIndex);
      }
      return { src, mid, tgt: new Set([hover.idx]), ll, rl };
    }
    // Ribbon hover: the ribbon plus its endpoint bars.
    if (hover.side === "left") {
      const isPlug = hover.b >= midCount;
      // A group-bound left ribbon continues through its middle as every
      // cell out of that middle; a plug ribbon ends at Remaining.
      const cont = isPlug
        ? []
        : sankey.linksRight.filter((l) => l.sourceIndex === hover.b);
      return {
        src: new Set([hover.a]),
        mid: isPlug ? new Set<number>() : new Set([hover.b]),
        tgt:
          isPlug && sankey.remainingTargetIndex != null
            ? new Set([sankey.remainingTargetIndex])
            : new Set(cont.map((l) => l.targetIndex)),
        ll: new Set([key(hover.a, hover.b)]),
        rl: new Set(cont.map((l) => key(l.sourceIndex, l.targetIndex))),
      };
    }
    // A merged cell carries every income's money: the through-line runs
    // back through every left ribbon feeding its middle.
    const back = sankey.linksLeft.filter((l) => l.targetIndex === hover.a);
    return {
      src: new Set(back.map((l) => l.sourceIndex)),
      mid: new Set([hover.a]),
      tgt: new Set([hover.b]),
      ll: new Set(back.map((l) => key(l.sourceIndex, l.targetIndex))),
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
  const ribbonOpacity = (lit: boolean, active: boolean) =>
    !active
      ? SANKEY_RIBBON_OPACITY
      : lit
        ? SANKEY_RIBBON_HOVER_OPACITY
        : SANKEY_RIBBON_DIM_OPACITY;

  // Z-order: spotlighted ribbons render after (above) the dimmed rest, so
  // the selected path is never buried under other legs. Stable: with no
  // hover the layout order passes through unchanged.
  const orderedLinksLeft = useMemo(() => {
    const links = sankey?.linksLeft ?? [];
    if (hl.ll == null) return links;
    const lit: typeof links = [];
    const dim: typeof links = [];
    for (const l of links) {
      (hl.ll.has(`${l.sourceIndex}:${l.targetIndex}`) ? lit : dim).push(l);
    }
    return [...dim, ...lit];
  }, [sankey, hl]);
  const orderedLinksRight = useMemo(() => {
    const links = sankey?.linksRight ?? [];
    if (hl.rl == null) return links;
    const lit: typeof links = [];
    const dim: typeof links = [];
    for (const l of links) {
      (hl.rl.has(`${l.sourceIndex}:${l.targetIndex}`) ? lit : dim).push(l);
    }
    return [...dim, ...lit];
  }, [sankey, hl]);

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
        <Tooltip
          tip={
            remaining >= 0
              ? `Unspent income — lands in the render-only Remaining row on the right`
              : `Spending exceeded income by ${fmt(Math.abs(remaining))} — covered from savings or debt`
          }
        >
          <span style={{ color: "var(--y-ink-soft)" }}>
            {remaining >= 0 ? "Left: " : "Over: "}
            <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
              {fmt(Math.abs(remaining))}
            </span>
          </span>
        </Tooltip>
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
          <Tooltip
            tip={
              <span className="block max-w-[280px] space-y-1 text-left text-[11px] leading-snug">
                <span className="block font-bold">How to read this chart</span>
                <span className="block">
                  Income (left) flows through category groups (middle) into spending (right).
                </span>
                <span className="block">
                  Remaining is unspent income in a render-only row — not a real{" "}
                  {dimension === "categories" ? "category" : "merchant"}. Over income is spending
                  beyond income — covered from savings or debt.
                </span>
                <span className="block">
                  Other is a render-only bucket for rows under the Under threshold — the
                  dashed, hatched bars are computed, not real rows.
                </span>
                <span className="block">
                  Moving money out to investments counts as spending; bringing it back counts
                  as income.
                </span>
                <span className="block">
                  Uncategorized is spending with no category (Merchants view).
                </span>
              </span>
            }
          >
            {/* Plain hint text, deliberately not a button: there is nothing
                to click — the explainer shows on hover (or keyboard focus). */}
            <span
              data-testid="sankey-how-to-read"
              tabIndex={0}
              className="cursor-help text-[11px] whitespace-nowrap"
              style={{
                color: "var(--y-ink-faint)",
                textDecoration: "underline dotted",
                textUnderlineOffset: "3px",
              }}
            >
              How to read
            </span>
          </Tooltip>
        </div>
      </div>

      {viewMode === "bars" ? (
        <div
          className={
            "min-h-0 flex-1 overflow-y-auto px-4 py-3 y-scroll " +
            (growRows ? "flex flex-col" : "")
          }
        >
          <div
            className={
              "mx-auto w-full max-w-[1100px] " +
              (growRows ? "flex h-full min-h-0 flex-col gap-[6px] justify-center" : "space-y-[6px]")
            }
          >
            {empty && <div className="grid place-items-center py-12 y-hint">No data for this timeframe.</div>}
            {rows.map((r) => {
              const isHover = hoverBarIdx === r.i;
              return (
                <div
                  key={r.name}
                  className={
                    "group flex cursor-default items-center gap-3 rounded-[4px] px-2 transition-colors " +
                    (growRows ? "min-h-[36px] flex-1 py-[6px]" : "py-[7px]")
                  }
                  style={{ background: isHover ? "var(--y-row-sel)" : "transparent" }}
                  onMouseMove={(e) => pushHover({ kind: "bar", idx: r.i, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setHover(null)}
                >
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-sm"
                    style={{
                      background: r.color,
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 0 0 1px rgba(0,0,0,0.1)",
                    }}
                  />
                  <span
                    className={
                      "shrink-0 truncate text-[12.5px] " +
                      (growRows ? "w-[22%]" : "w-[26%]")
                    }
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
                      return (
                        <div
                          className="relative h-full rounded-[3px] transition-[width] duration-150"
                          style={{
                            width: `${displayWidth}%`,
                            background: `linear-gradient(rgba(255,255,255,0.18), rgba(255,255,255,0)) , ${r.color}`,
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.18)",
                          }}
                        />
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
          onMouseLeave={() => setHover(null)}
        >
          {empty && (
            <div className="grid h-full place-items-center y-hint">No data for this timeframe.</div>
          )}
          {!empty && sankey != null && chartSize.width > 0 && chartSize.height > 0 && (
            <svg
              data-testid="sankey-svg"
              width={chartSize.width}
              height={contentH}
              className="block"
            >
              <defs>
                <SankeyBucketHatchPattern id={SANKEY_BUCKET_HATCH_ID} />
                {incomeGradients.map((stops, idx) => (
                  <linearGradient
                    key={idx}
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
              </defs>
              {/* Column headers: each column names what it holds, so the
                  chart reads without prior knowledge (left is income
                  received — not surplus — middle groups route it, right is
                  where it went). Hovering a header explains the column. */}
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
                      style={{ cursor: "pointer", letterSpacing: "0.08em" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "head", col: h.col, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    >
                      {h.label.toUpperCase()}
                    </text>
                  )
              )}
              {orderedLinksLeft.map((link) => {
                // Flat destination color through the whole length (see
                // leftFillFor): the income side never colors a ribbon.
                const fill = leftFillFor(link.targetIndex, link.targetName);
                const lit = leftLit(link.sourceIndex, link.targetIndex);
                return (
                  <path
                    key={`ll-${link.sourceIndex}-${link.targetIndex}`}
                    data-testid="sankey-link"
                    data-side="left"
                    d={link.d}
                    fill={fill}
                    fillOpacity={ribbonOpacity(lit, hl.ll != null)}
                    stroke="none"
                    style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                    onMouseMove={(e) =>
                      pushHover({
                        kind: "link",
                        side: "left",
                        a: link.sourceIndex,
                        b: link.targetIndex,
                        x: e.clientX,
                        y: e.clientY,
                      })
                    }
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
              {orderedLinksRight.map((link) => {
                // Flat destination color through the whole length: each cell
                // ribbon fills with the final category's or merchant's
                // family shade, so each ribbon reads as where the money
                // lands. One ribbon per group→target cell — hovering one
                // traces its through-line end to end.
                const fill =
                  tgtRows[link.targetIndex]?.color ?? colorForName(link.targetName);
                const lit = rightLit(link.sourceIndex, link.targetIndex);
                return (
                  <path
                    key={`rl-${link.sourceIndex}-${link.targetIndex}`}
                    data-testid="sankey-link"
                    data-side="right"
                    d={link.d}
                    fill={fill}
                    fillOpacity={ribbonOpacity(lit, hl.rl != null)}
                    stroke="none"
                    style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
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
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
              {sankey.sources.map((node, idx) => {
                const r = srcRows[idx]!;
                // Each income bar fills with its own gradient of outgoing
                // ribbon colors — never flat gray, never a hover overlay,
                // never a border. The merged Other bucket adds the
                // render-only hatch. The bar joins the flow-path spotlight
                // at the ribbons' own brightness steps.
                const isBucket = r.bucket === true;
                const lit = hl.src != null && hl.src.has(idx);
                const dim = hl.src != null && !hl.src.has(idx);
                const barOpacity = hl.src == null
                  ? SANKEY_RIBBON_OPACITY
                  : lit
                    ? SANKEY_RIBBON_HOVER_OPACITY
                    : SANKEY_RIBBON_DIM_OPACITY;
                const labelY = node.y + node.h / 2;
                // Bars too short for two lines show the name only, centered
                // on the bar; taller bars keep name + amount.
                const twoLine = showSankeySourceAmount(node.h);
                return (
                  <g key={`src-${node.name}-${idx}`}>
                    <rect
                      data-testid="sankey-income"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={`url(#${SANKEY_INCOME_GRADIENT_ID_PREFIX}${idx})`}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "income", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
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
                      />
                    )}
                    <text
                      data-testid="sankey-income-label"
                      x={sankey.sourceLabelX}
                      y={twoLine ? labelY - 2 : labelY + 4}
                      fontSize={12}
                      textAnchor="end"
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{ cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "income", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
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
                        style={{ cursor: "pointer" }}
                        onMouseMove={(e) =>
                          pushHover({ kind: "income", idx, x: e.clientX, y: e.clientY })
                        }
                        onMouseLeave={() => setHover(null)}
                      >
                        {fmt(node.value)} · {r.flowPct}%
                      </text>
                    )}
                  </g>
                );
              })}
              {sankey.middles.map((node, idx) => {
                const r = midRows[idx]!;
                const color = r.color;
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
                const labelY = node.y + node.h / 2;
                return (
                  <g key={`mid-${node.name}-${idx}`}>
                    {/* Parent groups read as one color with their ribbons:
                        the same fill at the same rest opacity — and the same
                        bright color while the hovered path runs through them.
                        No borders anywhere: the merged Other bucket adds only
                        the render-only hatch. The bar wraps the group's funded
                        flow; when spending exceeds income the gap shows in
                        the tooltip, not as a grey segment. */}
                    <rect
                      data-testid="sankey-group"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={color}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "group", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
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
                      style={{ cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "group", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    >
                      {truncateName(node.name)}
                    </text>
                    <text
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
                      style={{ cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "group", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    >
                      {fmt(node.value)} · {r.flowPct}%
                    </text>
                  </g>
                );
              })}
              {sankey.targets.map((node, idx) => {
                const r = tgtRows[idx]!;
                // Family shade shared with the incoming ribbons, so the line
                // from an income to this bar reads as one color throughout.
                // No borders, hovered or not: render-only rows — the merged
                // Other bucket and the Remaining surplus plug — add only the
                // hatch, and hovering brightens via the spotlight instead of
                // stroking (an SVG stroke centers on the edge, so even a
                // same-color stroke would paint 1px outside the bar and make
                // it look bigger than the ribbon stack feeding it). The bar
                // wraps the row's funded flow; when spending exceeds income
                // the gap shows in the tooltip, not as a grey segment.
                const color = r.color;
                const isComputed = r.bucket === true || r.isPlug;
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
                const labelY = node.y + node.h / 2;
                return (
                  <g key={`tgt-${node.name}-${idx}`}>
                    <rect
                      data-testid="sankey-node"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      fill={color}
                      fillOpacity={barOpacity}
                      stroke="none"
                      style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "node", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
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
                      />
                    )}
                    <text
                      data-testid="sankey-target-label"
                      x={sankey.targetLabelX}
                      y={node.h >= 26 ? labelY - 2 : labelY - 6}
                      fontSize={12}
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{ cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "node", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    >
                      {truncateName(node.name)}
                    </text>
                    <text
                      x={sankey.targetLabelX}
                      y={node.h >= 26 ? labelY + 13 : labelY + 7}
                      fontSize={11}
                      fill="var(--y-ink-faint)"
                      className="y-num"
                      opacity={dim ? 0.4 : 1}
                      style={{ cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "node", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
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
