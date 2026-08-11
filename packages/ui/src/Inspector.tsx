"use client";

import { useState, useRef, useEffect } from "react";
import type { GroupRow } from "@ynab/logic";
import { MONTHS, parseMonthKey } from "@ynab/logic";
import { Icon, Button, Panel, cx, money } from "@ynab/theme";

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

  return (
    <aside
      className="y-inspector w-[252px] shrink-0 p-2.5 space-y-2.5 y-scroll overflow-auto"
    >
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
              {onResetDemo && (
                <button
                  onClick={async () => {
                    if (confirm("Reset to demo data? This wipes all your changes.")) {
                      await onResetDemo();
                    }
                    setMenuOpen(false);
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

      <div
        className={cx("y-atb", overBudgeted ? "y-atb--red" : tbb > 0 ? "y-atb--green" : "y-atb--orange")}
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

      <Panel title="Summary" bodyClass="!p-[10px] space-y-[5px] text-[11.5px]">
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
      </Panel>

      <Panel title="Average Assigned" bodyClass="!p-[10px]">
        <div className="text-[18px] font-bold y-num" style={{ color: "var(--y-ink)" }}>{money(avg)}</div>
        <div className="y-hint mt-[2px]">across {history.filter((h) => h.real).length} real months</div>
      </Panel>

      <Panel title="History (12 mo)" bodyClass="!p-[10px]">
        <div className="flex items-end gap-[3px]" style={{ height: 92 }}>
          {(() => {
            const max = Math.max(1, ...history.map((h) => h.assigned));
            const trackH = 80;
            return history.map((h) => {
              const pct = (h.assigned / max) * 100;
              const isCurrent = h.key === month;
              const { month0: m0, year: y } = parseMonthKey(h.key);
              const label = `${MONTHS[m0]?.slice(0, 3) ?? ""} ${y}`;
              const heightPx = Math.max(10, (pct / 100) * trackH);
              return (
                <button
                  key={h.key}
                  onClick={() => h.real && onSelectMonth(h.key)}
                  disabled={!h.real}
                  aria-label={`Jump to ${MONTHS[m0]} ${y}`}
                  title={`${MONTHS[m0]} ${y}: ${money(h.assigned)}`}
                  className="flex-1 min-w-0 rounded-[2px] transition-all"
                  style={{
                    height: `${heightPx}px`,
                    background: !h.real
                      ? "var(--y-line-soft)"
                      : isCurrent
                        ? "var(--y-blue)"
                        : "var(--y-blue-pale)",
                    border: isCurrent ? "1px solid var(--y-blue-dark)" : "1px solid transparent",
                    opacity: !h.real ? 0.55 : isCurrent ? 1 : 0.85,
                    cursor: h.real ? "pointer" : "default",
                    boxShadow: h.real ? "inset 0 1px 0 rgba(255,255,255,0.5)" : "none",
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
      </Panel>
    </aside>
  );
}

function formatShortMonth(key: string): string {
  const { year: y, month0 } = parseMonthKey(key);
  return `${MONTHS[month0]?.slice(0, 3) ?? ""} ${String(y).slice(2)}`;
}
