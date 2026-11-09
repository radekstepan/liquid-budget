import type { SpendingBreakdownItem } from "@ynab/logic";

export type SpendingItem = SpendingBreakdownItem;
export type SpendingViewMode = "bars" | "sankey";

export type Hover =
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
