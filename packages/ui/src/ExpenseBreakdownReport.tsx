"use client";

import type { SpendingGroupFlow } from "@ynab/logic";
import { SpendingReport, type SpendingItem } from "./SpendingReport.js";

const EMPTY_FLOW: SpendingGroupFlow = { groups: [], targets: [], links: [] };

export function ExpenseBreakdownReport(props: {
  spending: SpendingItem[];
  total: number;
}) {
  // No group data reaches this unwired report: each row is its own group,
  // so the middle column mirrors the right column 1:1.
  const flow: SpendingGroupFlow = {
    groups: props.spending.map((s) => ({ ...s })),
    targets: props.spending,
    links: props.spending.map((s, i) => ({ groupIndex: i, targetIndex: i, value: s.value })),
  };
  return (
    <SpendingReport categoryFlow={flow} merchantFlow={EMPTY_FLOW} income={[]} initialView="sankey" />
  );
}
