"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { BudgetData, Category, SpendingTrendsResult, Transaction } from "@ynab/logic";
import { computeSpendingTrends, getSpendingTransactions } from "@ynab/logic";
import { colorAt } from "./chartUtils.js";
import { useLocalStorage } from "./useLocalStorage.js";

export type SpendingTrendsDataArgs = {
  data: BudgetData;
  startMonth: string;
  endMonth: string;
  resetKey?: number;
};

export type TrendsHover = {
  monthIdx: number;
  x: number;
  y: number;
} | null;

export type SpendingTrendsData = {
  drillGroupId: number | null;
  drillCategoryId: number | null;
  selectedMonth: string | null;
  hover: TrendsHover;
  setHover: (h: TrendsHover) => void;
  hoveredConstituentId: number | null;
  setHoveredConstituentId: (id: number | null) => void;
  filterOpen: boolean;
  setFilterOpen: Dispatch<SetStateAction<boolean>>;
  filterRef: RefObject<HTMLDivElement | null>;
  allCategoryIds: Set<number>;
  activeCategoryIds: Set<number>;
  trends: SpendingTrendsResult;
  colorMap: Map<number, string>;
  transactions: Transaction[];
  accountMap: Map<number, string>;
  currentGroupCats: Category[];
  filterButtonLabel: string;
  handleGoToAll: () => void;
  handleGoToGroup: () => void;
  handleClearMonth: () => void;
  handleDrillSegment: (constituentId: number) => void;
  handleToggleMonth: (month: string) => void;
  handleToggleCategory: (catId: number) => void;
  handleToggleGroup: (groupId: number) => void;
  handleSelectAllCategories: () => void;
  handleDeselectAllCategories: () => void;
  handleSelectCurrentGroupCats: () => void;
  handleClearCurrentGroupCats: () => void;
};

/** Drilldown + filter state and derived report data for spending trends
 * (ui-split slice 10). Owns the drill hierarchy, month filter, hover
 * state, the persisted category filter set, and the trends/color/transactions
 * derivations with all drill/filter handlers. Chart geometry lives in
 * `useSpendingTrendsLayout`; hover wiring stays with the report view. */
export function useSpendingTrendsData({
  data,
  startMonth,
  endMonth,
  resetKey,
}: SpendingTrendsDataArgs): SpendingTrendsData {
  // Drilldown hierarchy state
  const [drillGroupId, setDrillGroupId] = useState<number | null>(null);
  const [drillCategoryId, setDrillCategoryId] = useState<number | null>(null);

  // Selected month filter for transaction table (when drilled into a category or viewing month)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  // Hover state for chart
  const [hover, setHover] = useState<{
    monthIdx: number;
    x: number;
    y: number;
  } | null>(null);

  // Hovered constituent from table to highlight in chart
  const [hoveredConstituentId, setHoveredConstituentId] = useState<number | null>(null);

  // Reset drilldown when resetKey changes (e.g. clicking "Reports" in sidebar)
  useEffect(() => {
    setDrillGroupId(null);
    setDrillCategoryId(null);
    setSelectedMonth(null);
    setHover(null);
    setHoveredConstituentId(null);
  }, [resetKey]);

  // Category filter state — persisted in localStorage
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  // Initial set of all non-CC categories selected
  const allCategoryIds = useMemo(() => {
    const ccGroupIds = new Set(data.groups.filter((g) => g.isCreditCardPayments).map((g) => g.id));
    return new Set(data.categories.filter((c) => !ccGroupIds.has(c.groupId)).map((c) => c.id));
  }, [data.categories, data.groups]);

  const [persistedIds, setPersistedIds] = useLocalStorage<number[] | null>(
    "ynab:reports:trendsActiveCategories",
    null,
    (v): v is number[] | null =>
      v === null || (Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)))
  );
  const [activeCategoryIds, setActiveCategoryIds] = useState<Set<number>>(() => {
    if (persistedIds != null) return new Set(persistedIds);
    return allCategoryIds;
  });

  // Sync to localStorage when activeCategoryIds changes
  useEffect(() => {
    const arr = Array.from(activeCategoryIds);
    setPersistedIds(arr);
  }, [activeCategoryIds, setPersistedIds]);

  // On mount, apply persisted filter; on category changes, prune removed categories
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (persistedIds != null) {
        const valid = persistedIds.filter((id) => allCategoryIds.has(id));
        if (valid.length > 0) {
          setActiveCategoryIds(new Set(valid));
          return;
        }
      }
    }
    setActiveCategoryIds((prev) => {
      const next = new Set<number>();
      for (const id of allCategoryIds) {
        if (prev.has(id)) next.add(id);
      }
      return next.size > 0 ? next : new Set(allCategoryIds);
    });
  }, [allCategoryIds]);

  // Close filter dropdown on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [filterOpen]);

  // Compute spending trends data based on current drill & filter
  const trends: SpendingTrendsResult = useMemo(() => {
    return computeSpendingTrends(data, startMonth, endMonth, {
      drillGroupId,
      drillCategoryId,
      activeCategoryIds,
    });
  }, [data, startMonth, endMonth, drillGroupId, drillCategoryId, activeCategoryIds]);

  // Color mapping: assign a stable color to each constituent
  const colorMap = useMemo(() => {
    const map = new Map<number, string>();
    trends.constituents.forEach((c, idx) => {
      map.set(c.id, colorAt(idx));
    });
    return map;
  }, [trends.constituents]);

  // Transactions list for single-category drilldown or month filter
  const transactions: Transaction[] = useMemo(() => {
    if (trends.drillLevel !== "category" && !selectedMonth) return [];
    return getSpendingTransactions(data, startMonth, endMonth, {
      groupId: drillGroupId,
      categoryId: drillCategoryId,
      month: selectedMonth,
      activeCategoryIds,
    });
  }, [data, startMonth, endMonth, drillGroupId, drillCategoryId, selectedMonth, activeCategoryIds, trends.drillLevel]);

  const accountMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);

  // Breadcrumb navigation handlers
  const handleGoToAll = useCallback(() => {
    setDrillGroupId(null);
    setDrillCategoryId(null);
    setSelectedMonth(null);
    setHover(null);
    setHoveredConstituentId(null);
  }, []);

  const handleGoToGroup = useCallback(() => {
    setDrillCategoryId(null);
    setSelectedMonth(null);
    setHover(null);
    setHoveredConstituentId(null);
  }, []);

  const handleClearMonth = useCallback(() => {
    setSelectedMonth(null);
  }, []);

  const handleDrillSegment = useCallback((constituentId: number) => {
    setHoveredConstituentId(null);
    if (trends.drillLevel === "all") {
      setDrillGroupId(constituentId);
      setDrillCategoryId(null);
      setSelectedMonth(null);
      setHover(null);
    } else if (trends.drillLevel === "group") {
      setDrillCategoryId(constituentId);
      setSelectedMonth(null);
      setHover(null);
    }
  }, [trends.drillLevel]);

  const handleToggleMonth = useCallback((month: string) => {
    setSelectedMonth(prev => prev === month ? null : month);
  }, []);

  // Filter helpers
  const handleToggleCategory = (catId: number) => {
    setActiveCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) {
        next.delete(catId);
      } else {
        next.add(catId);
      }
      return next;
    });
  };

  const handleToggleGroup = (groupId: number) => {
    const groupCatIds = data.categories.filter((c) => c.groupId === groupId).map((c) => c.id);
    const allSelected = groupCatIds.every((id) => activeCategoryIds.has(id));

    setActiveCategoryIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of groupCatIds) next.delete(id);
      } else {
        for (const id of groupCatIds) next.add(id);
      }
      return next;
    });
  };

  const handleSelectAllCategories = () => {
    setActiveCategoryIds(new Set(allCategoryIds));
  };

  const handleDeselectAllCategories = () => {
    setActiveCategoryIds(new Set());
  };

  // Group-specific filter helpers (when drilled into a group)
  const currentGroupCats = useMemo(() => {
    if (drillGroupId == null) return [];
    return data.categories.filter((c) => c.groupId === drillGroupId);
  }, [data.categories, drillGroupId]);

  const handleSelectCurrentGroupCats = () => {
    setActiveCategoryIds((prev) => {
      const next = new Set(prev);
      for (const c of currentGroupCats) next.add(c.id);
      return next;
    });
  };

  const handleClearCurrentGroupCats = () => {
    setActiveCategoryIds((prev) => {
      const next = new Set(prev);
      for (const c of currentGroupCats) next.delete(c.id);
      return next;
    });
  };

  // Filter button label
  const filterButtonLabel = useMemo(() => {
    if (trends.drillLevel === "group" && drillGroupId != null) {
      const activeGroupCount = currentGroupCats.filter((c) => activeCategoryIds.has(c.id)).length;
      return activeGroupCount === currentGroupCats.length
        ? "Categories: All"
        : `Categories: ${activeGroupCount}/${currentGroupCats.length}`;
    }
    return activeCategoryIds.size === allCategoryIds.size
      ? "Categories: All"
      : `Categories: ${activeCategoryIds.size}/${allCategoryIds.size}`;
  }, [trends.drillLevel, drillGroupId, currentGroupCats, activeCategoryIds, allCategoryIds]);

  return {
    drillGroupId,
    drillCategoryId,
    selectedMonth,
    hover,
    setHover,
    hoveredConstituentId,
    setHoveredConstituentId,
    filterOpen,
    setFilterOpen,
    filterRef,
    allCategoryIds,
    activeCategoryIds,
    trends,
    colorMap,
    transactions,
    accountMap,
    currentGroupCats,
    filterButtonLabel,
    handleGoToAll,
    handleGoToGroup,
    handleClearMonth,
    handleDrillSegment,
    handleToggleMonth,
    handleToggleCategory,
    handleToggleGroup,
    handleSelectAllCategories,
    handleDeselectAllCategories,
    handleSelectCurrentGroupCats,
    handleClearCurrentGroupCats,
  };
}
