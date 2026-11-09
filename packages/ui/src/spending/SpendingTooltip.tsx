"use client";

import type { ReactNode } from "react";
import {
  fmt,
  OVER_INCOME_LABEL,
  sankeyTargetColor,
  STILL_HELD_GROUP_LABEL,
  UNCATEGORIZED_GROUP_LABEL,
} from "@ynab/logic";
import { OVER_INCOME_COLOR, TipLabel } from "../chartUtils.js";
import type { Hover } from "./types.js";
import type { SpendingData } from "./useSpendingData.js";
import type { SankeyDerived } from "./useSankeyDerived.js";

export function buildTipContent(
  hover: Hover | null,
  data: SpendingData,
  derived: SankeyDerived
): ReactNode | null {
  const {
    totals,
    activeThreshold,
    spentTotal,
    rows,
    merged,
    nounSingular,
    nounPlural,
    sankey,
  } = data;
  const { srcRows, midRows, tgtRows, heldBars, heldTargets } = derived;
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
}
