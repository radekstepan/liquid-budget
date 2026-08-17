"use client";

import { useState, useRef, useEffect } from "react";
import type {
  GroupRow,
  CashFlowSummary,
  TrailingNetWorthSummary,
  SpendingInsight,
} from "@ynab/logic";
import { MONTHS, parseMonthKey } from "@ynab/logic";
import { Icon, Button, Panel, Notice, cx, money } from "@ynab/theme";
import { Modal, Btn } from "./ui.js";

export function Inspector({
  groups,
  summary,
  month,
  history,
  avg,
  tbb,
  overBudgeted,
  priorSurplus,
  cashFlow,
  trailingNetWorth,
  insights,
  onSelectMonth,
  onResetDemo,
  onImportYnab4,
  onClearOverdraft,
}: {
  groups: GroupRow[];
  summary?: { assigned: number; outflow: number; available: number; totalAvailable: number };
  month: string;
  history?: { key: string; assigned: number; real: boolean }[];
  avg?: number;
  tbb: number;
  overBudgeted: boolean;
  priorSurplus?: number;
  cashFlow?: CashFlowSummary;
  trailingNetWorth?: TrailingNetWorthSummary;
  insights?: SpendingInsight[];
  onSelectMonth: (key: string) => void;
  onResetDemo?: () => Promise<void> | void;
  onImportYnab4?: (file: File) => Promise<void>;
  onClearOverdraft?: (categoryIds: number[]) => Promise<void> | void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState<{ month: string; net: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const { year, month0 } = parseMonthKey(month);
  const monthName = MONTHS[month0] ?? "";
  const overdraftCats = groups
    .flatMap((g) => g.rows)
    .filter((r) => r.available < 0)
    .map((r) => r.category.id);

  const confirmReset = async () => {
    if (!onResetDemo) return;
    setResetting(true);
    try {
      await onResetDemo();
    } finally {
      setResetting(false);
      setConfirmingReset(false);
      setMenuOpen(false);
    }
  };

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

  return (
    <aside className="y-inspector w-[252px] shrink-0 p-2.5 space-y-2.5 y-scroll overflow-auto">
      {/* Header with Month & Settings Cog */}
      <div className="flex items-center px-1">
        <div>
          <div className="y-caps">Demo Budget</div>
          <div className="text-[12.5px] font-bold mt-[1px]" style={{ color: "var(--y-ink)" }}>
            {monthName} {year}
          </div>
        </div>
        <div className="ml-auto relative" ref={menuRef}>
          <Button
            onClick={() => setMenuOpen((o) => !o)}
            size="sm"
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="gear" size={12} />
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
                <Icon name="export" size={12} /> Export as CSV
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  window.open("/api/export?format=json", "_blank");
                }}
                className="y-menu-item"
              >
                <Icon name="export" size={12} /> Export as JSON
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  window.open("/api/export?format=sqlite", "_blank");
                }}
                className="y-menu-item"
              >
                <Icon name="export" size={12} /> Backup SQLite DB
              </button>
              {onResetDemo && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmingReset(true);
                  }}
                  className="y-menu-item"
                >
                  <Icon name="reset" size={12} /> Reset demo data
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
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImportYnab4(f).catch((err) => alert(String(err)));
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
      >
        <div className="text-[20px] font-bold leading-[1.1] y-num">{money(tbb)}</div>
        <div className="text-[9px] font-bold tracking-[.09em] uppercase opacity-90">
          {overBudgeted ? "Overbudgeted" : "To Be Budgeted"}
        </div>
        {overBudgeted && onClearOverdraft && overdraftCats.length > 0 && (
          <Button
            onClick={() => onClearOverdraft(overdraftCats)}
            size="sm"
            variant="danger"
            className="mt-2 w-full"
          >
            Zero out {overdraftCats.length} overdrafted
          </Button>
        )}
      </div>

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
              -{money(effectiveCashFlow.outflow)}
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

            return (
              <div className="space-y-1">
                <svg
                  viewBox={`0 0 ${W} ${H}`}
                  className="w-full overflow-visible"
                  style={{ height: 64 }}
                >
                  <defs>
                    <linearGradient id="y-nw-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2f7fb0" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="#2f7fb0" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>

                  {/* Shaded Area */}
                  <path d={areaD} fill="url(#y-nw-grad)" />

                  {/* Trend Line */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke="#2f7fb0"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {/* Data Nodes */}
                  {pts.map((p, i) => {
                    const cxCoord = getX(i);
                    const cyCoord = getY(p.net);
                    const isCurrent = p.month === month;
                    const { month0: m0, year: y } = parseMonthKey(p.month);
                    const label = `Jump to ${MONTHS[m0]} ${y}`;

                    return (
                      <g key={p.month}>
                        {/* Outer focus/active ring */}
                        {isCurrent && (
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
                        <circle
                          cx={cxCoord}
                          cy={cyCoord}
                          r={isCurrent ? "3.5" : "2.5"}
                          fill={isCurrent ? "#1f5c85" : "#2f7fb0"}
                          className="transition-all hover:r-[4.5px] cursor-pointer"
                          onMouseEnter={() => setHoveredPoint({ month: p.month, net: p.net })}
                          onMouseLeave={() => setHoveredPoint(null)}
                          onClick={() => onSelectMonth(p.month)}
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

      {confirmingReset && (
        <Modal
          title="Reset demo data?"
          onClose={() => !resetting && setConfirmingReset(false)}
          footer={
            <>
              <Btn onClick={() => setConfirmingReset(false)} disabled={resetting}>
                Cancel
              </Btn>
              <Btn variant="danger" onClick={confirmReset} disabled={resetting}>
                {resetting ? "Resetting…" : "Yes, reset it"}
              </Btn>
            </>
          }
        >
          <Notice tone="danger" title="This cannot be undone">
            Resetting will permanently wipe all your changes (budgets,
            transactions, accounts) and restore the demo dataset.
          </Notice>
        </Modal>
      )}
    </aside>
  );
}

function formatShortMonth(key: string): string {
  const { year: y, month0 } = parseMonthKey(key);
  return `${MONTHS[month0]?.slice(0, 3) ?? ""} '${String(y).slice(2)}`;
}

function formatFullMonth(key: string): string {
  const { year: y, month0 } = parseMonthKey(key);
  return `${MONTHS[month0] ?? ""} ${y}`;
}
