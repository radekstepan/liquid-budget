"use client";

import { useState } from "react";
import type { GroupRow } from "@ynab/logic";
import { fmt, monthLabel, MONTHS, parseMonthKey } from "@ynab/logic";
import { IconChevronDown, IconMenu, IconMoon, IconSun, IconChevronUpDown, IconPalette, IconReset } from "./icons.js";

const ACCENTS = [
  { key: "liquid", label: "Liquid Theme", dot: "#2f6d95" },
  { key: "forest", label: "Forest Theme", dot: "#2e7d5b" },
  { key: "grape", label: "Grape Theme", dot: "#6b4a9e" },
  { key: "sunset", label: "Sunset Theme", dot: "#c15b34" },
];

export function Inspector({
  groups,
  summary,
  month,
  history,
  avg,
  tbb,
  overBudgeted,
  priorSurplus,
  theme,
  accent,
  onToggleTheme,
  onSetAccent,
  onSelectMonth,
  onResetDemo,
}: {
  groups: GroupRow[];
  summary: { assigned: number; outflow: number; available: number; totalAvailable: number };
  month: string;
  history: { key: string; assigned: number; real: boolean }[];
  avg: number;
  tbb: number;
  overBudgeted: boolean;
  priorSurplus: number;
  theme: "light" | "dark";
  accent: string;
  onToggleTheme: () => void;
  onSetAccent: (a: string) => void;
  onSelectMonth?: (key: string) => void;
  onResetDemo?: () => void;
}) {
  const [sumOpen, setSumOpen] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  let overdraft: string | null = null;
  for (const g of groups) {
    if (g.group.isCreditCardPayments) continue;
    for (const r of g.rows) {
      if (r.available < 0) {
        overdraft = r.category.name;
        break;
      }
    }
    if (overdraft) break;
  }

  const maxHist = Math.max(1, ...history.map((h) => h.assigned));

  const first = history[0];
  const last = history[history.length - 1];
  const lbl = (k: string) => {
    const { year, month0 } = parseMonthKey(k);
    return `${MONTHS[month0]} ${year}`;
  };

  const accentLabel = ACCENTS.find((a) => a.key === accent)?.label ?? "Liquid Theme";

  return (
    <aside
      className="flex h-full w-[340px] shrink-0 flex-col"
      style={{ background: "var(--bg)", borderLeft: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between px-5 pb-3 pt-5">
        <h2 className="text-[17px] font-bold tracking-tight" style={{ color: "var(--text)" }}>
          Demo Budget
        </h2>
        <div className="relative">
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            className="grid h-8 w-8 place-items-center rounded-lg transition-colors hover:bg-[var(--panel-3)]"
            style={{ color: "var(--muted)" }}
            aria-label="Open settings"
            aria-expanded={settingsOpen}
          >
            <IconMenu width={18} height={18} />
          </button>
          {settingsOpen && (
            <div
              className="animate-fade absolute right-0 top-[36px] z-30 min-w-[200px] overflow-hidden rounded-xl"
              style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}
              role="menu"
            >
              <button
                onClick={() => {
                  setSettingsOpen(false);
                  onToggleTheme();
                }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] transition-colors hover:bg-[var(--panel-3)]"
                style={{ color: "var(--text-2)" }}
                role="menuitem"
              >
                {theme === "dark" ? <IconSun width={15} height={15} /> : <IconMoon width={15} height={15} />}
                {theme === "dark" ? "Switch to light" : "Switch to dark"}
              </button>
              {onResetDemo && (
                <button
                  onClick={() => {
                    setSettingsOpen(false);
                    if (confirm("Reset all data and re-seed the demo budget? This cannot be undone.")) {
                      onResetDemo();
                    }
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] transition-colors hover:bg-[var(--panel-3)]"
                  style={{ color: "var(--danger)" }}
                  role="menuitem"
                >
                  <IconReset width={15} height={15} />
                  Reset demo data
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
      {/* ── TBB Card (YNAB4's primary number) ── */}
        <div
          className="mb-4 overflow-hidden rounded-2xl"
          style={{
            border: `1px solid ${overBudgeted ? "var(--danger-border)" : "var(--border)"}`,
            boxShadow: "var(--shadow)",
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ background: overBudgeted ? "var(--danger)" : "var(--accent)", color: overBudgeted ? "var(--danger-fg)" : "var(--accent-fg)" }}
          >
            <span className="text-[13.5px] font-bold tracking-wide">
              {overBudgeted ? "⚠ Over Budgeted" : "To Be Budgeted"}
            </span>
            <span className="tnum text-[20px] font-extrabold">{fmt(tbb)}</span>
          </div>
          <div
            className="px-4 py-3"
            style={{ background: overBudgeted ? "var(--danger-bg)" : "var(--accent-soft)" }}
          >
            {overBudgeted ? (
              <p className="text-[13px] leading-relaxed" style={{ color: "var(--danger)" }}>
                {overdraft ? (
                  <>
                    You've assigned more than you've earned.{" "}
                    <span className="font-semibold">{overdraft}</span> is also
                    overdrafted. Balance your budget to get back on track.
                  </>
                ) : (
                  <>You've assigned more than you've earned this month. Remove some assignments to get back to zero.</>
                )}
              </p>
            ) : overdraft ? (
              <p className="text-[13px] leading-relaxed" style={{ color: "var(--accent)" }}>
                A <span className="font-semibold">{overdraft}</span> splurge
                overdrafted that category — move money from other buckets to cover it.
              </p>
            ) : (
              <p className="text-[13px] leading-relaxed" style={{ color: "var(--accent)" }}>
                Every bucket is funded. Nicely balanced budget for {monthLabel(month)}!
              </p>
            )}
          </div>
        </div>

        <div
          className="mb-4 rounded-2xl p-4"
          style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}
        >
          <button onClick={() => setSumOpen((o) => !o)} className="flex w-full items-center gap-1.5">
            <span style={{ color: "var(--faint)" }}>
              <IconChevronDown width={15} height={15} />
            </span>
            <span className="text-[15px] font-bold" style={{ color: "var(--text)" }}>
              Summary
            </span>
          </button>

          {sumOpen && (
            <>
              <div
                className="mt-3 rounded-xl px-3.5 py-3"
                style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}
              >
                <Row label="Assigned" value={fmt(summary.assigned)} bold />
                <Row label="Outflow" value={fmt(summary.outflow)} muted />
                <Row label="Available" value={fmt(summary.available)} muted />
                {priorSurplus > 0.004 && (
                  <Row label="↪ Carried Forward" value={fmt(priorSurplus)} accent />
                )}
                <Row label="Total Available" value={fmt(summary.totalAvailable)} muted />
                <Row
                  label="To Be Budgeted"
                  value={fmt(tbb)}
                  accent={!overBudgeted}
                  danger={overBudgeted}
                  bold
                  last
                />
              </div>

              <div className="mt-5 text-center">
                <div className="text-[13px]" style={{ color: "var(--muted)" }}>
                  Average Assigned
                </div>
                <div className="tnum mt-0.5 text-[26px] font-bold" style={{ color: "var(--text)" }}>
                  {fmt(avg)}
                </div>
              </div>

              <div className="mt-4 flex h-[110px] items-end justify-between gap-[3px]">
                {history.map((h) => {
                  const isCurrent = h.key === month;
                  const height = h.real ? Math.max(6, (h.assigned / maxHist) * 100) : 4;
                  const interactive = !!onSelectMonth && h.real;
                  return (
                    <button
                      key={h.key}
                      type="button"
                      title={`${lbl(h.key)}: ${h.real ? fmt(h.assigned) : "no data"}`}
                      aria-label={`Jump to ${lbl(h.key)}`}
                      disabled={!interactive}
                      onClick={interactive ? () => onSelectMonth!(h.key) : undefined}
                      className="flex-1 rounded-t-[3px] transition-all"
                      style={{
                        height: `${height}%`,
                        background: isCurrent
                          ? "var(--accent)"
                          : h.real
                            ? "var(--accent-2)"
                            : "var(--track)",
                        opacity: isCurrent ? 1 : h.real ? 0.68 : 0.45,
                        cursor: interactive ? "pointer" : "default",
                        border: "none",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
              <div className="mt-1.5 flex justify-between text-[11.5px]" style={{ color: "var(--muted)" }}>
                <span>{first ? lbl(first.key) : ""}</span>
                <span>{last ? lbl(last.key) : ""}</span>
              </div>
              <div className="mt-2 text-center text-[12.5px] font-semibold" style={{ color: "var(--text-2)" }}>
                12-Month History
              </div>
            </>
          )}
        </div>
      </div>

      <div className="relative flex items-center gap-2 p-4">
        {pickerOpen && (
          <div
            className="animate-fade absolute bottom-[62px] left-4 right-[70px] z-20 overflow-hidden rounded-xl"
            style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}
          >
            {ACCENTS.map((a) => (
              <button
                key={a.key}
                onClick={() => {
                  onSetAccent(a.key);
                  setPickerOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] transition-colors hover:bg-[var(--panel-3)]"
                style={{ color: "var(--text)", fontWeight: a.key === accent ? 700 : 500 }}
              >
                <span className="h-3.5 w-3.5 rounded-full" style={{ background: a.dot }} />
                {a.label}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => setPickerOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 rounded-xl px-3.5 py-2.5"
          style={{ background: "var(--panel)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
        >
          <span style={{ color: "var(--accent)" }}>
            <IconPalette width={17} height={17} />
          </span>
          <span className="text-[13.5px] font-semibold">{accentLabel}</span>
          <span className="ml-auto" style={{ color: "var(--muted)" }}>
            <IconChevronUpDown width={15} height={15} />
          </span>
        </button>
        <button
          onClick={onToggleTheme}
          className="grid h-[44px] w-[46px] place-items-center rounded-xl"
          style={{ background: "var(--panel)", border: "1px solid var(--border-strong)", color: "var(--text-2)" }}
          title="Toggle dark mode"
        >
          {theme === "dark" ? <IconSun width={18} height={18} /> : <IconMoon width={18} height={18} />}
        </button>
      </div>
    </aside>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
  accent,
  danger,
  last,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
  accent?: boolean;
  danger?: boolean;
  last?: boolean;
}) {
  const valueColor = danger
    ? "var(--danger)"
    : accent
      ? "var(--accent)"
      : bold
        ? "var(--text)"
        : "var(--text-2)";
  return (
    <div
      className="flex items-center justify-between py-1.5"
      style={{ borderBottom: last ? "none" : "1px solid var(--border)" }}
    >
      <span className="text-[13.5px]" style={{ color: muted ? "var(--muted)" : "var(--text-2)", fontWeight: bold ? 600 : 500 }}>
        {label}
      </span>
      <span
        className="tnum text-[13.5px]"
        style={{ color: valueColor, fontWeight: bold ? 700 : 600 }}
      >
        {value}
      </span>
    </div>
  );
}
