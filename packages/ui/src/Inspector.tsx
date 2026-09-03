"use client";

import { memo, useState, useRef, useEffect, useMemo } from "react";
import type {
  GroupRow,
  CashFlowSummary,
  TrailingNetWorthSummary,
  SpendingInsight,
  DuplicateAnalysisResult,
  ImportSummary,
} from "@ynab/logic";
import { MONTHS, parseMonthKey } from "@ynab/logic";
import { Icon, Button, Panel, Notice, cx, money } from "@ynab/theme";
import { Modal, Btn } from "./ui.js";

export const Inspector = memo(function Inspector({
  groups,
  summary,
  month,
  history,
  avg,
  tbb,
  overBudgeted,
  priorSurplus,
  totalIncome,
  totalAssigned,
  overspentPrevious,
  overspentPreviousMonthKey,
  incomeFromFuture,
  incomeFromPast,
  incomeDeferredToFuture,
  incomeDeferredToPast,
  cashFlow,
  trailingNetWorth,
  insights,
  selectedCategory,
  onClearSelectedCategory,
  quickFill,
  onQuickBudget,
  isBudgetView,
  onSelectMonth,
  onImportYnab4,
  onImportCsv,
  onAnalyzeDuplicates,
  onOpenRenameRules,
}: {
  groups: GroupRow[];
  summary?: { assigned: number; outflow: number; available: number; totalAvailable: number };
  month: string;
  history?: { key: string; assigned: number; real: boolean }[];
  avg?: number;
  tbb: number;
  overBudgeted: boolean;
  priorSurplus?: number;
  totalIncome?: number;
  totalAssigned?: number;
  overspentPrevious?: number;
  overspentPreviousMonthKey?: string;
  incomeFromFuture?: number;
  incomeFromPast?: number;
  incomeDeferredToFuture?: number;
  incomeDeferredToPast?: number;
  cashFlow?: CashFlowSummary;
  trailingNetWorth?: TrailingNetWorthSummary;
  insights?: SpendingInsight[];
  selectedCategory?: { id: number; name: string } | null;
  onClearSelectedCategory?: () => void;
  quickFill?: {
    lastMonthAssignments?: Map<number, number>;
    spentLastMonthByCategory?: Map<number, number>;
    avgSpentByCategory?: Map<number, number>;
    avgBudgetedByCategory?: Map<number, number>;
    underfundedByCategory?: Map<number, number>;
  };
  onQuickBudget?: (type: "lastMonth" | "spentLastMonth" | "avgBudgeted" | "clear", categoryId?: number) => void;
  isBudgetView?: boolean;
  onSelectMonth: (key: string) => void;
  onImportYnab4?: (file: File) => Promise<ImportSummary | void>;
  onImportCsv?: (file: File) => void;
  onAnalyzeDuplicates?: () => Promise<DuplicateAnalysisResult | void>;
  onOpenRenameRules?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<DuplicateAnalysisResult | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{ month: string; net: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const csvFileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown when user clicks outside
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // Fallback defaults if not provided
  const effectiveCashFlow: CashFlowSummary = cashFlow ?? {
    month,
    income: summary?.assigned ?? 0,
    outflow: summary ? Math.abs(summary.outflow) : 0,
    net: (summary?.assigned ?? 0) - (summary ? Math.abs(summary.outflow) : 0),
    savingsRate: 0,
  };

  const effectiveNetWorth: TrailingNetWorthSummary = trailingNetWorth ?? {
    points: history
      ? history.map((h) => ({ month: h.key, assets: h.assigned, debts: 0, net: h.assigned }))
      : [],
    currentNet: 0,
    startNet: 0,
    delta: 0,
    pctDelta: 0,
  };

  const effectiveInsights: SpendingInsight[] = insights ?? [
    { id: "clean", type: "clean", message: "Spending is steady within 3-month baseline" },
  ];

  // Quick Budget figures
  const quickBudgetValues = useMemo(() => {
    if (!quickFill) {
      return { lastMonth: 0, spentLastMonth: 0, avgBudgeted: 0 };
    }
    if (selectedCategory) {
      const catId = selectedCategory.id;
      return {
        lastMonth: quickFill.lastMonthAssignments?.get(catId) ?? 0,
        spentLastMonth: quickFill.spentLastMonthByCategory?.get(catId) ?? 0,
        avgBudgeted: quickFill.avgBudgetedByCategory?.get(catId) ?? 0,
      };
    }
    // All categories sum
    let lastMonth = 0;
    if (quickFill.lastMonthAssignments) {
      for (const val of quickFill.lastMonthAssignments.values()) lastMonth += val;
    }
    let spentLastMonth = 0;
    if (quickFill.spentLastMonthByCategory) {
      for (const val of quickFill.spentLastMonthByCategory.values()) spentLastMonth += val;
    }
    let avgBudgeted = 0;
    if (quickFill.avgBudgetedByCategory) {
      for (const val of quickFill.avgBudgetedByCategory.values()) avgBudgeted += val;
    }
    return { lastMonth, spentLastMonth, avgBudgeted };
  }, [quickFill, selectedCategory]);

  return (
    <aside className="y-inspector w-[252px] shrink-0 p-2.5 space-y-2.5 y-scroll overflow-auto">
      {/* Header with Settings Cog */}
      <div className="flex items-center px-1">
        <div className="ml-auto relative" ref={menuRef}>
          <Button
            onClick={() => setMenuOpen((o) => !o)}
            size="sm"
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="cog" size={13} />
          </Button>
          {menuOpen && (
            <div
              className="absolute right-0 top-[28px] z-20"
              style={{
                width: 220,
                padding: 4,
                background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
                border: "1px solid var(--y-chrome-line)",
                borderRadius: 4,
                boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
              }}
            >
              <button
                onClick={() => {
                  csvFileRef.current?.click();
                  setMenuOpen(false);
                }}
                className="y-menu-item"
              >
                <Icon name="import" size={12} /> Import CSV
              </button>
              <button
                onClick={() => {
                  fileRef.current?.click();
                  setMenuOpen(false);
                }}
                className="y-menu-item"
              >
                <Icon name="import" size={12} /> Import YNAB4 Backup
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  window.open("/api/export", "_blank");
                }}
                className="y-menu-item"
              >
                <Icon name="export" size={12} /> Backup YNAB4
              </button>
              {onOpenRenameRules && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenRenameRules();
                  }}
                  className="y-menu-item"
                >
                  <Icon name="az" size={12} /> Rename rules
                </button>
              )}
              {onAnalyzeDuplicates && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setAnalysisError(null);
                    setAnalyzing(true);
                    onAnalyzeDuplicates()
                      .then((res) => {
                        if (res) setAnalysisResult(res);
                      })
                      .catch((err: any) =>
                        setAnalysisError(err?.message ? String(err.message) : String(err))
                      )
                      .finally(() => setAnalyzing(false));
                  }}
                  className="y-menu-item"
                  disabled={analyzing}
                >
                  <Icon name="flag" size={12} />{" "}
                  {analyzing ? "Analyzing" : "Flag duplicates"}
                </button>
              )}
            </div>
          )}
          {onImportYnab4 && (
            <input
              ref={fileRef}
              type="file"
              accept=".y4backup,.zip"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  try {
                    const summary = await onImportYnab4(f);
                    if (summary && summary.duplicatesSkipped?.length) {
                      setImportResult(summary);
                    }
                  } catch (err: any) {
                    setImportError(err?.message ? String(err.message) : String(err));
                  }
                }
                e.target.value = "";
              }}
            />
          )}
          {onImportCsv && (
            <input
              ref={csvFileRef}
              type="file"
              accept=".csv,text/csv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImportCsv(f);
                e.target.value = "";
              }}
            />
          )}
        </div>
      </div>

      {/* Primary To Be Budgeted / Overbudgeted Banner */}
      <div
        className={cx(
          "y-atb",
          overBudgeted ? "y-atb--red" : tbb > 0 ? "y-atb--green" : "y-atb--orange"
        )}
        title={
          overBudgeted || (incomeFromFuture != null && incomeFromFuture > 0) || (incomeFromPast != null && incomeFromPast > 0)
            ? [
                `Prior surplus: ${money(priorSurplus ?? 0)}`,
                `Income this month: ${money(totalIncome ?? 0)}`,
                ...(incomeFromFuture != null && incomeFromFuture > 0
                  ? [`  ↳ ${money(incomeFromFuture)} from future transaction dates`]
                  : []),
                ...(incomeFromPast != null && incomeFromPast > 0
                  ? [`  ↳ ${money(incomeFromPast)} from past transaction dates`]
                  : []),
                `Assigned this month: ${money(totalAssigned ?? 0)}`,
                `─────────────────`,
                `= TBB: ${money(tbb)}`,
              ].join("\n")
            : undefined
        }
      >
        <div className="text-[20px] font-bold leading-[1.1] y-num">{money(tbb)}</div>
        <div className="text-[9px] font-bold tracking-[.09em] uppercase opacity-90">
          {overBudgeted ? "Overbudgeted" : "To Be Budgeted"}
        </div>
      </div>

      {/* Visual indicator explaining deferred income originating from future/past transaction dates */}
      {incomeFromFuture != null && incomeFromFuture > 0 && (
        <div
          className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-[var(--y-panel-alt)] border border-[var(--y-line-soft)] text-[11px] text-[var(--y-ink-soft)] leading-snug"
          data-testid="deferred-income-indicator"
        >
          <span className="shrink-0 flex items-center">
            <Icon name="info" size={12} color="#2f7fb0" />
          </span>
          <span>
            <strong className="text-[var(--y-ink)]">{money(incomeFromFuture)}</strong> of income originated from future transaction dates.
          </span>
        </div>
      )}
      {incomeFromPast != null && incomeFromPast > 0 && (
        <div
          className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-[var(--y-panel-alt)] border border-[var(--y-line-soft)] text-[11px] text-[var(--y-ink-soft)] leading-snug"
          data-testid="deferred-income-indicator"
        >
          <span className="shrink-0 flex items-center">
            <Icon name="info" size={12} color="#2f7fb0" />
          </span>
          <span>
            <strong className="text-[var(--y-ink)]">{money(incomeFromPast)}</strong> of income originated from past transaction dates.
          </span>
        </div>
      )}

      {/* Quick Budget Panel */}
      {isBudgetView !== false && quickFill && (
        <Panel title="Quick Budget" bodyClass="!p-[10px] space-y-1.5">
          <div data-testid="quick-budget-panel" className="space-y-1.5">
            <div className="flex items-center justify-between text-[10.5px] text-[var(--y-ink-soft)] pb-0.5 border-b border-[var(--y-line-soft)]">
              {selectedCategory ? (
                <>
                  <span className="truncate font-semibold text-[var(--y-ink)]">
                    {selectedCategory.name}
                  </span>
                  {onClearSelectedCategory && (
                    <button
                      type="button"
                      onClick={onClearSelectedCategory}
                      className="text-[10px] text-[var(--y-blue)] hover:underline cursor-pointer ml-2 shrink-0"
                      data-testid="quick-budget-deselect"
                    >
                      Entire Budget
                    </button>
                  )}
                </>
              ) : (
                <span className="font-semibold text-[var(--y-ink)]">Entire Budget</span>
              )}
            </div>

            <button
              type="button"
              onClick={() => onQuickBudget?.("lastMonth", selectedCategory?.id)}
              className="y-btn y-btn--sm w-full flex items-center justify-between px-2.5 py-1.5 cursor-pointer text-left"
              title="Set budgeted amounts to last month's values"
              data-testid="quick-budget-last-month"
            >
              <span className="font-semibold text-[11px] text-[var(--y-ink)]">Budgeted Last Month</span>
              <span className="y-num font-bold text-[var(--y-ink)]">
                {money(quickBudgetValues.lastMonth)}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onQuickBudget?.("spentLastMonth", selectedCategory?.id)}
              className="y-btn y-btn--sm w-full flex items-center justify-between px-2.5 py-1.5 cursor-pointer text-left"
              title="Set budgeted amounts to what was spent last month"
              data-testid="quick-budget-spent-last-month"
            >
              <span className="text-[11px] text-[var(--y-ink)]">Spent Last Month</span>
              <span className="y-num text-[var(--y-ink-soft)]">
                {money(quickBudgetValues.spentLastMonth)}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onQuickBudget?.("avgBudgeted", selectedCategory?.id)}
              className="y-btn y-btn--sm w-full flex items-center justify-between px-2.5 py-1.5 cursor-pointer text-left"
              title="Set budgeted amounts to average budgeted over last 3 months"
              data-testid="quick-budget-avg-budgeted"
            >
              <span className="text-[11px] text-[var(--y-ink)]">Average Budgeted</span>
              <span className="y-num text-[var(--y-ink-soft)]">
                {money(quickBudgetValues.avgBudgeted)}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onQuickBudget?.("clear", selectedCategory?.id)}
              className="y-btn y-btn--sm w-full flex items-center justify-between px-2.5 py-1.5 cursor-pointer text-left"
              title="Clear budgeted amounts to $0.00"
              data-testid="quick-budget-clear"
            >
              <span className="text-[11px] text-[var(--y-ink-soft)]">Set to Zero</span>
              <span className="y-num text-[var(--y-ink-soft)]">
                $0.00
              </span>
            </button>
          </div>
        </Panel>
      )}

      {/* Card 1: Net Monthly (Cash Flow & Savings Rate) */}
      <Panel title="Net Monthly" bodyClass="!p-[10px] space-y-2">
        <div className="flex items-baseline justify-between">
          <div>
            <div
              className={cx(
                "text-[18px] font-bold y-num leading-none",
                effectiveCashFlow.net >= 0 ? "text-[#2e7d32]" : "text-[#c0483a]"
              )}
            >
              {effectiveCashFlow.net >= 0 ? "+" : ""}
              {money(effectiveCashFlow.net)}
            </div>
            <div className="y-hint text-[10px] mt-0.5">Net Cash Flow</div>
          </div>
          <span
            className={cx(
              "px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide",
              effectiveCashFlow.net >= 0
                ? "bg-[#e4f1d4] text-[#427a1b]"
                : "bg-[#f7dedb] text-[#97341f]"
            )}
          >
            {effectiveCashFlow.net >= 0
              ? `${effectiveCashFlow.savingsRate}% saved`
              : "Deficit"}
          </span>
        </div>

        <div className="space-y-[4px] text-[11px] pt-1 border-t border-[var(--y-line-soft)]">
          <div className="flex justify-between">
            <span style={{ color: "var(--y-ink-soft)" }}>Income (Inflow)</span>
            <span className="y-num font-medium text-[#2e7d32]">
              +{money(effectiveCashFlow.income)}
            </span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: "var(--y-ink-soft)" }}>Expenses (Outflow)</span>
            <span className="y-num font-medium" style={{ color: "var(--y-ink)" }}>
              {effectiveCashFlow.outflow >= 0
                ? `-${money(effectiveCashFlow.outflow)}`
                : `+${money(Math.abs(effectiveCashFlow.outflow))}`}
            </span>
          </div>
        </div>
      </Panel>

      {/* Card 2: 12-Month Net Worth Trajectory & Interactive Sparkline */}
      <Panel title="Net Worth (12 mo)" bodyClass="!p-[10px] space-y-2">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[17px] font-bold y-num leading-none" style={{ color: "var(--y-ink)" }}>
              {hoveredPoint ? money(hoveredPoint.net) : money(effectiveNetWorth.currentNet)}
            </div>
            <div className="y-hint text-[10px] mt-0.5">
              {hoveredPoint ? formatFullMonth(hoveredPoint.month) : "Current Net Worth"}
            </div>
          </div>
          <span
            className={cx(
              "px-1.5 py-0.5 rounded text-[10px] font-bold inline-flex items-center gap-0.5",
              effectiveNetWorth.delta >= 0
                ? "bg-[#e4f1d4] text-[#427a1b]"
                : "bg-[#f7dedb] text-[#97341f]"
            )}
            title="12-Month Change"
          >
            {effectiveNetWorth.delta >= 0 ? "▲" : "▼"}{" "}
            {money(Math.abs(effectiveNetWorth.delta))}
            {effectiveNetWorth.pctDelta != null ? ` (${effectiveNetWorth.pctDelta >= 0 ? "+" : ""}${effectiveNetWorth.pctDelta}%)` : ""}
          </span>
        </div>

        {/* SVG Sparkline */}
        <div className="relative pt-1">
          {(() => {
            const pts = effectiveNetWorth.points;
            if (pts.length === 0) return null;

            const W = 224;
            const H = 64;
            const padX = 8;
            const padY = 8;

            let minVal = Math.min(...pts.map((p) => p.net));
            let maxVal = Math.max(...pts.map((p) => p.net));
            if (minVal === maxVal) {
              minVal -= 100;
              maxVal += 100;
            }
            const range = maxVal - minVal;
            const yMin = minVal - range * 0.1;
            const yMax = maxVal + range * 0.1;

            const getX = (i: number) =>
              pts.length === 1
                ? W / 2
                : padX + (i / (pts.length - 1)) * (W - 2 * padX);
            const getY = (v: number) =>
              H - padY - ((v - yMin) / (yMax - yMin)) * (H - 2 * padY);

            const pathD = pts
              .map((p, i) => `${i === 0 ? "M" : "L"} ${getX(i).toFixed(1)} ${getY(p.net).toFixed(1)}`)
              .join(" ");

            const areaD = `${pathD} L ${getX(pts.length - 1).toFixed(1)} ${H} L ${getX(0).toFixed(1)} ${H} Z`;

            const findClosestPoint = (
              e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>,
              el: SVGSVGElement
            ) => {
              if (pts.length === 0) return null;
              if (pts.length === 1) return pts[0]!;

              const rect = el.getBoundingClientRect();
              const clientX =
                typeof e.clientX === "number" && !Number.isNaN(e.clientX)
                  ? e.clientX
                  : typeof (e.nativeEvent as any)?.clientX === "number"
                  ? (e.nativeEvent as any).clientX
                  : 0;

              const rectWidth = rect.width > 0 ? rect.width : W;
              const rectLeft = typeof rect.left === "number" ? rect.left : 0;
              const relX = clientX - rectLeft;
              const rawSvgX = (relX / rectWidth) * W;
              const svgX = Number.isFinite(rawSvgX) ? rawSvgX : 0;

              let closestIdx = 0;
              let minDiff = Infinity;
              for (let i = 0; i < pts.length; i++) {
                const diff = Math.abs(getX(i) - svgX);
                if (diff < minDiff) {
                  minDiff = diff;
                  closestIdx = i;
                }
              }
              return pts[closestIdx]!;
            };

            const hoveredIdx = hoveredPoint
              ? pts.findIndex((p) => p.month === hoveredPoint.month)
              : -1;

            return (
              <div className="space-y-1">
                <svg
                  viewBox={`0 0 ${W} ${H}`}
                  className="w-full overflow-visible cursor-pointer select-none"
                  style={{ height: 64 }}
                  onPointerMove={(e) => {
                    const closest = findClosestPoint(e, e.currentTarget);
                    if (closest) {
                      setHoveredPoint({ month: closest.month, net: closest.net });
                    }
                  }}
                  onMouseMove={(e) => {
                    const closest = findClosestPoint(e, e.currentTarget);
                    if (closest) {
                      setHoveredPoint({ month: closest.month, net: closest.net });
                    }
                  }}
                  onPointerLeave={() => setHoveredPoint(null)}
                  onMouseLeave={() => setHoveredPoint(null)}
                  onClick={(e) => {
                    const closest = findClosestPoint(e, e.currentTarget);
                    if (closest) {
                      onSelectMonth(closest.month);
                    }
                  }}
                  aria-label="12-Month Net Worth Sparkline"
                >
                  <defs>
                    <linearGradient id="y-nw-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2f7fb0" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="#2f7fb0" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>

                  {/* Catch-all transparent backdrop for smooth event handling */}
                  <rect x="0" y="0" width={W} height={H} fill="transparent" />

                  {/* Shaded Area */}
                  <path d={areaD} fill="url(#y-nw-grad)" className="pointer-events-none" />

                  {/* Trend Line */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke="#2f7fb0"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="pointer-events-none"
                  />

                  {/* Active vertical guide line on hover */}
                  {hoveredIdx >= 0 && (
                    <line
                      x1={getX(hoveredIdx)}
                      y1={padY - 2}
                      x2={getX(hoveredIdx)}
                      y2={H - padY + 2}
                      stroke="#2f7fb0"
                      strokeWidth="1.5"
                      strokeDasharray="2 2"
                      opacity="0.5"
                      className="pointer-events-none"
                    />
                  )}

                  {/* Data Nodes */}
                  {pts.map((p, i) => {
                    const cxCoord = getX(i);
                    const cyCoord = getY(p.net);
                    const isCurrent = p.month === month;
                    const isHovered = hoveredPoint?.month === p.month;
                    const { month0: m0, year: y } = parseMonthKey(p.month);

                    return (
                      <g key={p.month} className="pointer-events-none">
                        {/* Current month outer ring when not hovering any month */}
                        {isCurrent && !hoveredPoint && (
                          <circle
                            cx={cxCoord}
                            cy={cyCoord}
                            r="5.5"
                            fill="none"
                            stroke="#1f5c85"
                            strokeWidth="1.5"
                            opacity="0.8"
                          />
                        )}
                        {/* Hover snap halo */}
                        {isHovered && (
                          <circle
                            cx={cxCoord}
                            cy={cyCoord}
                            r="6.5"
                            fill="#2f7fb0"
                            fillOpacity="0.25"
                          />
                        )}
                        {/* Node circle */}
                        <circle
                          cx={cxCoord}
                          cy={cyCoord}
                          r={isHovered ? 4.5 : isCurrent ? 3.5 : 2.5}
                          fill={isHovered ? "#1f5c85" : isCurrent ? "#1f5c85" : "#2f7fb0"}
                          stroke={isHovered ? "#ffffff" : "none"}
                          strokeWidth={isHovered ? 1.5 : 0}
                          opacity={hoveredPoint && !isHovered ? 0.45 : 1}
                        >
                          <title>{`${MONTHS[m0]} ${y}: ${money(p.net)}`}</title>
                        </circle>
                      </g>
                    );
                  })}
                </svg>

                {/* HTML Interactive Jump Row for Full Accessibility and Click Targets */}
                <div className="flex items-center gap-[2px] pt-0.5">
                  {pts.map((p) => {
                    const { month0: m0, year: y } = parseMonthKey(p.month);
                    const isCurrent = p.month === month;
                    const isHovered = hoveredPoint?.month === p.month;
                    const shortLabel = `${MONTHS[m0]?.slice(0, 1)}`;
                    return (
                      <button
                        key={p.month}
                        onClick={() => onSelectMonth(p.month)}
                        onMouseEnter={() => setHoveredPoint({ month: p.month, net: p.net })}
                        onMouseLeave={() => setHoveredPoint(null)}
                        aria-label={`Jump to ${MONTHS[m0]} ${y}`}
                        title={`${MONTHS[m0]} ${y}: ${money(p.net)}`}
                        className={cx(
                          "flex-1 text-[9px] py-0.5 rounded text-center transition-all",
                          isCurrent
                            ? "bg-[#2f7fb0] text-white font-bold"
                            : isHovered
                            ? "bg-[var(--y-hover)] text-[var(--y-ink)] font-semibold"
                            : "hover:bg-[var(--y-hover)] text-[var(--y-ink-soft)]"
                        )}
                      >
                        {shortLabel}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>

        <div className="flex justify-between text-[10px] y-hint pt-0.5">
          <span>{effectiveNetWorth.points[0] ? formatShortMonth(effectiveNetWorth.points[0].month) : ""}</span>
          <span>
            {effectiveNetWorth.points.length > 0
              ? formatShortMonth(effectiveNetWorth.points[effectiveNetWorth.points.length - 1]!.month)
              : ""}
          </span>
        </div>
      </Panel>

      {/* Card 3: Trends & Insights (3-Month Average) */}
      <Panel title="Trends & Insights" bodyClass="!p-[10px] space-y-1.5">
        {[...effectiveInsights]
          .sort((a, b) => (b.pctChange ?? 0) - (a.pctChange ?? 0))
          .map((insight) => (
            <div
              key={insight.id}
              className="p-2 rounded border border-[var(--y-line-soft)] bg-[var(--y-panel-alt)] text-[11px] leading-tight flex items-center justify-between"
            >
              <div className="min-w-0 pr-2">
                <div className="font-semibold text-[var(--y-ink)] truncate">
                  {insight.categoryName ?? insight.message}
                </div>
                {insight.amount != null && (
                  <div className="y-hint text-[10px] mt-0.5">
                    {money(insight.amount)} this mo
                  </div>
                )}
              </div>
              {insight.pctChange != null ? (
                <div className="shrink-0 text-right">
                  <div
                    className={cx(
                      "text-[11px] font-bold y-num",
                      insight.pctChange > 0 ? "text-[#c0483a]" : "text-[#2e7d32]"
                    )}
                  >
                    {insight.pctChange >= 0 ? "+" : ""}
                    {insight.pctChange}%
                  </div>
                  <div className="y-hint text-[9px]">vs 3-mo avg</div>
                </div>
              ) : (
                <div className="y-hint text-[10px]">{insight.message}</div>
              )}
            </div>
          ))}
      </Panel>

      {importError && (
        <Modal
          title="Import Failed"
          onClose={() => setImportError(null)}
          footer={
            <Btn variant="primary" onClick={() => setImportError(null)}>
              Dismiss
            </Btn>
          }
        >
          <Notice tone="danger" title="Unable to import YNAB4 data">
            {importError}
          </Notice>
        </Modal>
      )}

      {importResult && importResult.duplicatesSkipped.length > 0 && (
        <Modal
          title="Import Complete"
          onClose={() => setImportResult(null)}
          footer={
            <Btn variant="primary" onClick={() => setImportResult(null)}>
              Done
            </Btn>
          }
        >
          <Notice
            tone="warn"
            title={`${importResult.duplicatesSkipped.length} duplicate entr${
              importResult.duplicatesSkipped.length === 1 ? "y was" : "ies were"
            } skipped`}
          >
            {importResult.transactions} transaction{importResult.transactions === 1 ? "" : "s"}{" "}
            imported. The entries below matched an earlier entry and were not imported.
          </Notice>
          <div
            className="y-scroll mt-3 max-h-[300px] overflow-auto rounded border"
            style={{ borderColor: "var(--y-line)" }}
          >
            <table className="y-table w-full text-left">
              <thead className="y-thead--sticky">
                <tr>
                  <th>Date</th>
                  <th>Account</th>
                  <th>Payee</th>
                  <th className="num">Amount</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {importResult.duplicatesSkipped.slice(0, 50).map((d, i) => (
                  <tr key={i} className="y-row">
                    <td className="y-num whitespace-nowrap">{d.date}</td>
                    <td className="truncate">{d.accountName || <span className="y-hint">—</span>}</td>
                    <td className="truncate">{d.payee || <span className="y-hint">—</span>}</td>
                    <td className="num y-num">{money(d.amount)}</td>
                    <td className="y-hint text-[10px]">{d.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {importResult.duplicatesSkipped.length > 50 && (
            <p className="y-hint mt-2 text-[11px]">
              …and {importResult.duplicatesSkipped.length - 50} more.
            </p>
          )}
        </Modal>
      )}

      {analysisError && (
        <Modal
          title="Analysis Failed"
          onClose={() => setAnalysisError(null)}
          footer={
            <Btn variant="primary" onClick={() => setAnalysisError(null)}>
              Dismiss
            </Btn>
          }
        >
          <Notice tone="danger" title="Unable to analyze duplicates">
            {analysisError}
          </Notice>
        </Modal>
      )}

      {analysisResult && (
        <Modal
          title="Duplicate Analysis"
          onClose={() => setAnalysisResult(null)}
          footer={
            <Btn variant="primary" onClick={() => setAnalysisResult(null)}>
              Done
            </Btn>
          }
        >
          {analysisResult.duplicateCount === 0 ? (
            <Notice tone="ok" title="No duplicate transactions found">
              Every transaction in your budget is unique.
            </Notice>
          ) : (
            <>
              <Notice
                tone="warn"
                title={`${analysisResult.duplicateCount} duplicate entr${
                  analysisResult.duplicateCount === 1 ? "y" : "ies"
                } in ${analysisResult.groups.length} group${analysisResult.groups.length === 1 ? "" : "s"}`}
              >
                {analysisResult.flaggedCount} marked duplicate ·{" "}
                {analysisResult.alreadyFlaggedCount} already flagged ·{" "}
                {analysisResult.lockedCount} reconciled (left untouched)
                {analysisResult.clearedCount > 0
                  ? ` · ${analysisResult.clearedCount} no longer duplicate (cleared)`
                  : ""}
              </Notice>
              <div className="y-scroll mt-3 max-h-[300px] space-y-2 overflow-auto">
                {analysisResult.groups.map((g) => (
                  <div
                    key={g.fingerprint}
                    className="rounded border p-2"
                    style={{ borderColor: "var(--y-line-soft)" }}
                  >
                    <div className="text-[11px] font-semibold" style={{ color: "var(--y-ink)" }}>
                      {g.keeper.date} · {g.keeper.accountName} · {g.keeper.payee || "—"} ·{" "}
                      {money(g.keeper.amount)}
                    </div>
                    <div className="y-hint pl-3 text-[11px]">
                      {g.duplicates.map((d) => (
                        <div key={d.id ?? d.rowNumber ?? 0} className="truncate">
                          {d.date} · {d.payee || "—"} · {money(d.amount)}
                          {d.status === "r"
                            ? " · locked"
                            : d.flagColor
                              ? ` · already flagged ${d.flagColor}`
                              : " · marked duplicate"}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}
    </aside>
  );
});

function formatShortMonth(key: string): string {
  const { year: y, month0 } = parseMonthKey(key);
  return `${MONTHS[month0]?.slice(0, 3) ?? ""} '${String(y).slice(2)}`;
}

function formatFullMonth(key: string): string {
  const { year: y, month0 } = parseMonthKey(key);
  return `${MONTHS[month0] ?? ""} ${y}`;
}
