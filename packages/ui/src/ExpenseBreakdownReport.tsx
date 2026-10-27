"use client";

import { SpendingReport, type SpendingItem } from "./SpendingReport.js";

export function ExpenseBreakdownReport(props: {
  spending: SpendingItem[];
  total: number;
}) {
  return <SpendingReport {...props} initialView="donut" />;
}

