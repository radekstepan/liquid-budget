"use client";

import type { SankeyTargetSort, SpendingDimension } from "@ynab/logic";
import { useLocalStorage } from "../useLocalStorage.js";
import type { SpendingViewMode } from "./types.js";

export function useSpendingFilters({
  initialView,
  initialDimension,
  initialShowHeld,
}: {
  initialView: SpendingViewMode;
  initialDimension: SpendingDimension;
  initialShowHeld: boolean;
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

  return {
    viewMode,
    setViewMode,
    dimension,
    setDimension,
    thresholdDollars,
    setThresholdDollars,
    sort,
    setSort,
    showHeld,
    setShowHeld,
  };
}

export type SpendingFilters = ReturnType<typeof useSpendingFilters>;
