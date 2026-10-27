"use client";

import { SpendingReport, type SpendingItem } from "./SpendingReport.js";

export function ExpenseBreakdownReport(props: {
  spending: SpendingItem[];
  total: number;
}) {
  return <SpendingReport categories={props.spending} merchants={[]} initialView="sankey" />;
}
