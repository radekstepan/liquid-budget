"use client";

import { useState, useRef } from "react";
import type { GroupRow } from "@ynab/logic";
import { MONTHS, parseMonthKey } from "@ynab/logic";
import { Icon, cx, money } from "@ynab/theme";

export function Inspector({
  groups,
  summary,
  month,
  history,
  avg,
  tbb,
  overBudgeted,
  priorSurplus,
  onSelectMonth,
  onResetDemo,
  onImportYnab4,
  onClearOverdraft,
}: {
  groups: GroupRow[];
  summary: { assigned: number; outflow: number; available: number; totalAvailable: number };
  month: string;
  history: { key: string; assigned: number; real: boolean }[];
  avg: number;
  tbb: number;
  overBudgeted: boolean;
  priorSurplus: number;
  onSelectMonth: (key: string) => void;
  onResetDemo?: () => Promise<void> | void;
  onImportYnab4?: (file: File) => Promise<void>;
  onClearOverdraft?: (categoryIds: number[]) => Promise<void> | void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { year, month0 } = parseMonthKey(month);
  const monthName = MONTHS[month0] ?? "";
  const overdraftCats = groups
    .flatMap((g) => g.rows)
    .filter((r) => r.available < 0)
    .map((r) => r.category.id);

  return (
    <aside
      className="w-[252px] shrink-0 p-2.5 space-y-2.5 y-scroll overflow-auto"
      style={{
        background: "linear-gradient(#f2f2f0,#e8e8e5)",
        borderLeft: "1px solid #c4c4bf",
        boxShadow: "1px 0 0 rgba(255,255,255,.7) inset",
      }}
    >
      <div className="flex items-center px-1">
        <div>
          <div className="y-caps">Demo Budget</div>
          <div className="text-[12.5px] font-bold mt-[1px]" style={{ color: "var(--y-ink)" }}>
            {monthName} {year}
          </div>
        </div>
        <div className="ml-auto relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="y-btn y-btn--sm"
            aria-label="Settings"
            title="Settings"
          >
            <Icon name="gear" size={12} />
          </button>
          {menuOpen && (
            <div
              className="y-modal absolute right-0 top-[28px] z-20"
              style={{ width: 220, padding: 4 }}
            >
              <button
                onClick={() => {
                  fileRef.current?.click();
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-[6px] text-left text-[12px] px-3 py-[6px] rounded-[2px] hover:bg-[#e8e8e5]"
              >
                <Icon name="import" size={12} /> Import YNAB4 Backup
              </button>
              {onResetDemo && (
                <button
                  onClick={async () => {
                    if (confirm("Reset to demo data? This wipes all your changes.")) {
                      await onResetDemo();
                    }
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-[6px] text-left text-[12px] px-3 py-[6px] rounded-[2px] hover:bg-[#e8e8e5]"
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

      <div
        className={cx("y-atb", overBudgeted ? "y-atb--red" : tbb > 0 ? "y-atb--green" : "y-atb--orange")}
      >
        <div className="text-[20px] font-bold leading-[1.1] y-num">{money(tbb)}</div>
        <div className="text-[9px] font-bold tracking-[.09em] uppercase opacity-90">
          {overBudgeted ? "Overbudgeted" : "To Be Budgeted"}
        </div>
        {overBudgeted && onClearOverdraft && overdraftCats.length > 0 && (
          <button
            onClick={() => onClearOverdraft(overdraftCats)}
            className="mt-2 y-btn y-btn--sm y-btn--danger"
            style={{ width: "100%" }}
          >
            Zero out {overdraftCats.length} overdrafted
          </button>
        )}
      </div>

      <div className="y-panel">
        <div className="y-panel-head">Summary</div>
        <div className="p-[10px] space-y-[5px] text-[11.5px]">
          {[
            ["Assigned", money(summary.assigned)],
            ["Outflow", money(-summary.outflow)],
            ["Available", money(summary.available)],
            ["Carried Forward", money(priorSurplus)],
            ["Total Available", money(summary.totalAvailable)],
            ["To Be Budgeted", money(tbb)],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span style={{ color: "var(--y-ink-soft)" }}>{k}</span>
              <span className="y-num" style={{ color: "var(--y-ink)" }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="y-panel">
        <div className="y-panel-head">Average Assigned</div>
        <div className="p-[10px]">
          <div className="text-[18px] font-bold y-num" style={{ color: "var(--y-ink)" }}>{money(avg)}</div>
          <div className="y-hint mt-[2px]">across {history.filter((h) => h.real).length} real months</div>
        </div>
      </div>

      <div className="y-panel">
        <div className="y-panel-head">History (12 mo)</div>
        <div className="p-[10px]">
          <div className="flex items-end gap-[3px]" style={{ height: 92 }}>
            {(() => {
              const max = Math.max(1, ...history.map((h) => h.assigned));
              return history.map((h) => {
                const pct = (h.assigned / max) * 100;
                const isCurrent = h.key === month;
                const { month0: m0, year: y } = parseMonthKey(h.key);
                const label = `${MONTHS[m0]?.slice(0, 3) ?? ""} ${y}`;
                return (
                  <button
                    key={h.key}
                    onClick={() => h.real && onSelectMonth(h.key)}
                    disabled={!h.real}
                    aria-label={`Jump to ${MONTHS[m0]} ${y}`}
                    title={`${MONTHS[m0]} ${y}: ${money(h.assigned)}`}
                    className="flex-1 min-w-0 rounded-[2px] transition-all"
                    style={{
                      height: `${Math.max(2, pct)}%`,
                      background: !h.real
                        ? "#dcdcd8"
                        : isCurrent
                        ? "var(--y-blue)"
                        : "var(--y-blue-pale)",
                      border: isCurrent ? "1px solid var(--y-blue-dark)" : "1px solid transparent",
                      opacity: !h.real ? 0.5 : isCurrent ? 1 : 0.85,
                      cursor: h.real ? "pointer" : "default",
                    }}
                  />
                );
              });
            })()}
          </div>
          <div className="flex justify-between mt-1 y-hint">
            <span>{history[0] ? formatShortMonth(history[0].key) : ""}</span>
            <span>{history[history.length - 1] ? formatShortMonth(history[history.length - 1]!.key) : ""}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function formatShortMonth(key: string): string {
  const { year: y, month0 } = parseMonthKey(key);
  return `${MONTHS[month0]?.slice(0, 3) ?? ""} ${String(y).slice(2)}`;
}
