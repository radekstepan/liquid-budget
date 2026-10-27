"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  fmt,
  mergeBelowThreshold,
  mergeGroupFlow,
  layoutGroupedIncomeSankey,
  sankeyContentHeight,
  SHORTFALL_LABEL,
  showSankeySourceAmount,
  SANKEY_LEFT_LABEL_INSET,
  SANKEY_NODE_GAP,
  SANKEY_NODE_MIN_HEIGHT,
  SANKEY_PAD_BOTTOM,
  SANKEY_PAD_TOP,
  SANKEY_SOURCE_GUTTER,
  type MergedSpendingItem,
  type SpendingBreakdownItem,
  type SpendingDimension,
  type SpendingGroupFlow,
} from "@ynab/logic";
import { Button, Panel, Tooltip } from "@ynab/theme";
import {
  ChartTip,
  colorForName,
  sankeyRibbonShade,
  TipLabel,
  SHORTFALL_COLOR,
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
  // sub-ribbon: a = middle index, b = target index, c = income index whose
  // color the sub-ribbon carries through the middle.
  | { kind: "link"; side: "left"; a: number; b: number; x: number; y: number }
  | { kind: "link"; side: "right"; a: number; b: number; c: number; x: number; y: number }
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

// One shared gradient per income source: every ribbon carrying that
// income's flow — left-hop ribbons and right-hop sub-ribbons alike — holds
// the income color through its midpoint, then settles into a shade of that
// same hue toward the target end. Exported so tests can pin the defs.
export function sankeyRibbonGradientId(incomeIndex: number): string {
  return `sankey-ribbon-${incomeIndex}`;
}

export function SpendingReport({
  categoryFlow,
  merchantFlow,
  income,
  initialView = "sankey",
  initialDimension = "categories",
}: {
  categoryFlow: SpendingGroupFlow;
  merchantFlow: SpendingGroupFlow;
  income: SpendingItem[];
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
  // Slider ceiling: a round number covering the largest group, floored at
  // $50 so the control stays useful on small datasets, capped at $2000 so
  // the slider keeps its resolution on large ones.
  const sliderMax = Math.max(50, Math.min(2000, Math.ceil(maxDollars / 10) * 10));
  const sliderStep = sliderMax <= 100 ? 5 : 10;
  const activeThreshold = Math.min(Math.max(0, thresholdDollars), sliderMax);

  const merged = useMemo(
    () =>
      mergeGroupFlow(flow.groups, flow.targets, flow.links, Math.round(activeThreshold * 100)),
    [flow, activeThreshold]
  );
  const mergedIncome = useMemo(
    () => mergeBelowThreshold(income, Math.round(activeThreshold * 100)),
    [income, activeThreshold]
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

  // Bars rows: spending shares (unchanged by the income side).
  const rows = useMemo(() => {
    const maxSpend = merged.targets.reduce((m, s) => Math.max(m, s.value), 1);
    return merged.targets.map((s, i) => {
      const share = spentTotal !== 0 ? s.value / spentTotal : 0;
      const pctOfTotal = Math.round(share * 100);
      const pctOfMax = (s.value / maxSpend) * 100;
      const color = colorForName(s.name);
      return { ...s, share, pctOfTotal, pctOfMax, color, i };
    });
  }, [merged.targets, spentTotal]);

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
    return layoutGroupedIncomeSankey(incomeRows, merged.groups, merged.targets, merged.links, {
      width: chartSize.width,
      height: contentH,
      padLeft: SANKEY_SOURCE_GUTTER,
      padRight: LABEL_ZONE,
      padTop: SANKEY_PAD_TOP,
      padBottom: SANKEY_PAD_BOTTOM,
      nodeGap: SANKEY_NODE_GAP,
      minNodeHeight: SANKEY_NODE_MIN_HEIGHT,
    });
  }, [incomeRows, merged.groups, merged.targets, merged.links, chartSize.width, chartSize.height, contentH]);

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
        color: colorForName(s.name),
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
        // How many right-column rows this group feeds (distinct targets:
        // each target draws one sub-ribbon per income).
        memberCount: new Set(
          sankey?.linksRight.filter((l) => l.sourceIndex === i).map((l) => l.targetIndex)
        ).size,
        i,
      })),
    [sankey, totals.flowTotal]
  );
  const tgtRows = useMemo(
    () =>
      (sankey?.targets ?? []).map((t, i) => ({
        ...t,
        flowPct:
          totals.flowTotal !== 0 ? Math.round((t.value / totals.flowTotal) * 100) : 0,
        color: colorForName(t.name),
        // By position, never by name: a literal "Remaining" category is
        // still just a category.
        isPlug: sankey?.remainingTargetIndex === i,
        i,
      })),
    [sankey, totals.flowTotal]
  );

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
              color={s.color}
              label="Flows"
              value={fmt(link.value)}
              pct={fundedPct + "%"}
            />
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Proportional split — money is fungible</span>
            </div>
          </div>
        );
      }
      const m = midRows[hover.a];
      const t = tgtRows[hover.b];
      const s = srcRows[hover.c];
      if (!m || !t || !s) return null;
      const link = sankey?.linksRight.find(
        (l) => l.sourceIndex === hover.a && l.targetIndex === hover.b && l.incomeIndex === hover.c
      );
      if (!link) return null;
      // Share of the target's funded amount (under a shortfall the expense
      // is only partly funded, so this is relative to funded, not total).
      const fundedPct =
        t.fundedValue !== 0 ? Math.round((link.value / t.fundedValue) * 100) : 0;
      return (
        <div className="space-y-[3px]">
          <div className="mb-1 text-[11px] font-bold" style={{ color: "#f2f5f7" }}>
            {`${s.name} → ${t.name}`}
          </div>
          <TipLabel
            color={s.color}
            label="Flows"
            value={fmt(link.value)}
            pct={fundedPct + "%"}
          />
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>via {m.name}</span>
          </div>
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
              color={SHORTFALL_COLOR}
              label={SHORTFALL_LABEL}
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
          {r.unfundedValue > 0 && (
            <div
              className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
              style={{ color: "rgba(242,245,247,0.65)" }}
            >
              <span>Spending exceeded income — covered from savings or debt</span>
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
            color={SHORTFALL_COLOR}
            label={SHORTFALL_LABEL}
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
        {r.unfundedValue > 0 && (
          <div
            className="flex items-center gap-2 text-[11px] leading-[1.45] whitespace-nowrap"
            style={{ color: "rgba(242,245,247,0.65)" }}
          >
            <span>Spending exceeded income — covered from savings or debt</span>
          </div>
        )}
      </div>
    );
  })();

  // Connected-highlight sets per hover (null = unconstrained, everything
  // stays full opacity). Hovering any bar or ribbon spotlights its flow
  // path — a target lights its groups, the sub-ribbons feeding it, and the
  // income ribbons feeding those groups — and dims the rest. Ribbon hovers
  // trace the through-line end to end: a right sub-ribbon lights its
  // income bar and the left ribbon feeding its middle, and a left ribbon
  // lights the sub-ribbons continuing its income through that middle.
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
    const rkey = (a: number, b: number, c: number) => `${a}:${b}:${c}`;
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
      for (const l of sankey.linksRight) {
        if (l.incomeIndex !== hover.idx) continue;
        rl.add(rkey(l.sourceIndex, l.targetIndex, l.incomeIndex));
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
        rl.add(rkey(l.sourceIndex, l.targetIndex, l.incomeIndex));
        tgt.add(l.targetIndex);
      }
      return { src, mid: new Set([hover.idx]), tgt, ll, rl };
    }
    if (hover.kind === "node") {
      const rl = new Set<string>();
      const mid = new Set<number>();
      for (const l of sankey.linksRight) {
        if (l.targetIndex !== hover.idx) continue;
        rl.add(rkey(l.sourceIndex, l.targetIndex, l.incomeIndex));
        mid.add(l.sourceIndex);
      }
      const ll = new Set<string>();
      const src = new Set<number>();
      const isPlug = sankey.remainingTargetIndex === hover.idx;
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
      // A group-bound left ribbon continues through its middle as that
      // income's sub-ribbons; a plug ribbon ends at Remaining.
      const cont = isPlug
        ? []
        : sankey.linksRight.filter(
            (l) => l.sourceIndex === hover.b && l.incomeIndex === hover.a
          );
      return {
        src: new Set([hover.a]),
        mid: isPlug ? new Set<number>() : new Set([hover.b]),
        tgt:
          isPlug && sankey.remainingTargetIndex != null
            ? new Set([sankey.remainingTargetIndex])
            : new Set(cont.map((l) => l.targetIndex)),
        ll: new Set([key(hover.a, hover.b)]),
        rl: new Set(cont.map((l) => rkey(l.sourceIndex, l.targetIndex, l.incomeIndex))),
      };
    }
    return {
      src: new Set([hover.c]),
      mid: new Set([hover.a]),
      tgt: new Set([hover.b]),
      ll: new Set([key(hover.c, hover.a)]),
      rl: new Set([rkey(hover.a, hover.b, hover.c)]),
    };
  }, [hover, sankey]);

  const isSrcHover = (idx: number) =>
    (hover?.kind === "income" && hover.idx === idx) ||
    (hover?.kind === "link" && hover.side === "left" && hover.a === idx);
  const isMidHover = (idx: number) =>
    (hover?.kind === "group" && hover.idx === idx) ||
    (hover?.kind === "link" &&
      ((hover.side === "left" && hover.b === idx) || (hover.side === "right" && hover.a === idx)));
  const isTgtHover = (idx: number) =>
    (hover?.kind === "node" && hover.idx === idx) ||
    (hover?.kind === "link" &&
      ((hover.side === "right" && hover.b === idx) ||
        (hover.side === "left" &&
          hover.b >= (sankey?.middles.length ?? 0) &&
          sankey?.remainingTargetIndex === idx)));
  const isLeftLinkHover = (a: number, b: number) =>
    hover?.kind === "link" && hover.side === "left" && hover.a === a && hover.b === b;
  const isRightLinkHover = (a: number, b: number, c: number) =>
    hover?.kind === "link" &&
    hover.side === "right" &&
    hover.a === a &&
    hover.b === b &&
    hover.c === c;
  const hoverBarIdx = hover != null && hover.kind === "bar" ? hover.idx : null;

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
                  className="ml-1.5 inline-block w-[110px] align-middle"
                  style={{ accentColor: "var(--y-blue)" }}
                  min={0}
                  max={sliderMax}
                  step={sliderStep}
                  value={activeThreshold}
                  disabled={empty}
                  onChange={(e) => {
                    setThresholdDollars(Number(e.target.value));
                    setHover(null);
                  }}
                />
              </label>
            </Tooltip>
          </div>
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
                {srcRows.map((r) => (
                  <linearGradient
                    key={`sgrad-${r.i}`}
                    id={sankeyRibbonGradientId(r.i)}
                    x1="0"
                    y1="0"
                    x2="1"
                    y2="0"
                  >
                    <stop offset="0" stopColor={r.color} />
                    <stop offset="0.5" stopColor={r.color} />
                    <stop offset="1" stopColor={sankeyRibbonShade(r.color)} />
                  </linearGradient>
                ))}
              </defs>
              {sankey.linksLeft.map((link) => {
                // Ribbons carry their income source's color on both hops:
                // each ribbon holds the source color through its midpoint,
                // then settles into a shade of that same hue toward the
                // target end — one solid through-color, no per-hop split.
                const fill = `url(#${sankeyRibbonGradientId(link.sourceIndex)})`;
                const isHover = isLeftLinkHover(link.sourceIndex, link.targetIndex);
                const dim =
                  hl.ll != null && !hl.ll.has(`${link.sourceIndex}:${link.targetIndex}`);
                return (
                  <path
                    key={`ll-${link.sourceIndex}-${link.targetIndex}`}
                    data-testid="sankey-link"
                    data-side="left"
                    d={link.d}
                    fill={fill}
                    fillOpacity={isHover ? 0.65 : dim ? 0.18 : 0.35}
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
              {sankey.linksRight.map((link) => {
                // Through-color: each sub-ribbon fills from its own income's
                // gradient, so the income color runs uninterrupted from the
                // left source through the middle group to the right target.
                const fill = `url(#${sankeyRibbonGradientId(link.incomeIndex)})`;
                const isHover = isRightLinkHover(
                  link.sourceIndex,
                  link.targetIndex,
                  link.incomeIndex
                );
                const dim =
                  hl.rl != null &&
                  !hl.rl.has(`${link.sourceIndex}:${link.targetIndex}:${link.incomeIndex}`);
                return (
                  <path
                    key={`rl-${link.sourceIndex}-${link.targetIndex}-${link.incomeIndex}`}
                    data-testid="sankey-link"
                    data-side="right"
                    data-income={link.incomeIndex}
                    d={link.d}
                    fill={fill}
                    fillOpacity={isHover ? 0.65 : dim ? 0.18 : 0.35}
                    stroke="none"
                    style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                    onMouseMove={(e) =>
                      pushHover({
                        kind: "link",
                        side: "right",
                        a: link.sourceIndex,
                        b: link.targetIndex,
                        c: link.incomeIndex,
                        x: e.clientX,
                        y: e.clientY,
                      })
                    }
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
              {sankey.sources.map((node, idx) => {
                const color = colorForName(node.name);
                const isHover = isSrcHover(idx);
                const dim = hl.src != null && !hl.src.has(idx);
                const r = srcRows[idx]!;
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
                      rx={2}
                      fill={color}
                      fillOpacity={dim ? 0.35 : 1}
                      stroke={isHover ? "var(--y-ink)" : "rgba(0,0,0,0.15)"}
                      strokeWidth={isHover ? 2 : 1}
                      style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "income", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    />
                    <text
                      data-testid="sankey-income-label"
                      x={sankey.sourceLabelX}
                      y={twoLine ? labelY - 2 : labelY + 4}
                      fontSize={12}
                      textAnchor="end"
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{ pointerEvents: "none" }}
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
                        style={{ pointerEvents: "none" }}
                      >
                        {fmt(node.value)} · {r.flowPct}%
                      </text>
                    )}
                  </g>
                );
              })}
              {sankey.middles.map((node, idx) => {
                const color = colorForName(node.name);
                const isHover = isMidHover(idx);
                const dim = hl.mid != null && !hl.mid.has(idx);
                const r = midRows[idx]!;
                const labelY = node.y + node.h / 2;
                return (
                  <g key={`mid-${node.name}-${idx}`}>
                    <rect
                      data-testid="sankey-group"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      rx={2}
                      fill={color}
                      fillOpacity={dim ? 0.35 : 1}
                      stroke={isHover ? "var(--y-ink)" : "rgba(0,0,0,0.15)"}
                      strokeWidth={isHover ? 2 : 1}
                      style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "group", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    />
                    {node.unfundedH > 0 && (
                      <rect
                        data-testid="sankey-group-shortfall"
                        x={node.x}
                        y={node.y + Math.max(0, node.h) - node.unfundedH}
                        width={node.w}
                        height={node.unfundedH}
                        rx={2}
                        fill={SHORTFALL_COLOR}
                        fillOpacity={dim ? 0.35 : 1}
                        stroke="rgba(0,0,0,0.35)"
                        strokeWidth={1}
                        strokeDasharray="3 2"
                        style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                        onMouseMove={(e) =>
                          pushHover({ kind: "group", idx, x: e.clientX, y: e.clientY })
                        }
                        onMouseLeave={() => setHover(null)}
                      />
                    )}
                    {/* Middle labels sit in the ribbon zone, so they carry
                        a light halo to stay readable over the ribbons. */}
                    <text
                      data-testid="sankey-group-label"
                      x={sankey.middleLabelX}
                      y={node.h >= 26 ? labelY - 2 : labelY - 6}
                      fontSize={12}
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      style={{ pointerEvents: "none" }}
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
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      style={{ pointerEvents: "none" }}
                    >
                      {fmt(node.value)} · {r.flowPct}%
                    </text>
                  </g>
                );
              })}
              {sankey.targets.map((node, idx) => {
                const color = colorForName(node.name);
                const isHover = isTgtHover(idx);
                const dim = hl.tgt != null && !hl.tgt.has(idx);
                const r = tgtRows[idx]!;
                const labelY = node.y + node.h / 2;
                return (
                  <g key={`tgt-${node.name}-${idx}`}>
                    <rect
                      data-testid="sankey-node"
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={Math.max(0, node.h)}
                      rx={2}
                      fill={color}
                      fillOpacity={dim ? 0.35 : 1}
                      stroke={isHover ? "var(--y-ink)" : "rgba(0,0,0,0.15)"}
                      strokeWidth={isHover ? 2 : 1}
                      style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                      onMouseMove={(e) =>
                        pushHover({ kind: "node", idx, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    />
                    {node.unfundedH > 0 && (
                      <rect
                        data-testid="sankey-shortfall"
                        x={node.x}
                        y={node.y + Math.max(0, node.h) - node.unfundedH}
                        width={node.w}
                        height={node.unfundedH}
                        rx={2}
                        fill={SHORTFALL_COLOR}
                        fillOpacity={dim ? 0.35 : 1}
                        stroke="rgba(0,0,0,0.35)"
                        strokeWidth={1}
                        strokeDasharray="3 2"
                        style={{ transition: "fill-opacity 120ms", cursor: "pointer" }}
                        onMouseMove={(e) =>
                          pushHover({ kind: "node", idx, x: e.clientX, y: e.clientY })
                        }
                        onMouseLeave={() => setHover(null)}
                      />
                    )}
                    <text
                      x={sankey.targetLabelX}
                      y={node.h >= 26 ? labelY - 2 : labelY - 6}
                      fontSize={12}
                      fill="var(--y-ink)"
                      opacity={dim ? 0.4 : 1}
                      style={{ pointerEvents: "none" }}
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
                      style={{ pointerEvents: "none" }}
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
