"use client";

import { useMemo } from "react";
import type { BudgetData } from "@ynab/logic";
import { fmt, num, parseMonthKey, monthLabel } from "@ynab/logic";
import { IconCalendar, IconChevronRight, IconChevronDown } from "./icons.js";

export function CalendarView({
  data,
  month,
  onPrev,
  onNext,
}: {
  data: BudgetData;
  month: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { year, month0 } = parseMonthKey(month);
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);

  const firstDay = new Date(year, month0, 1).getDay();
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();

  const byDay = new Map<number, { payee: string; amount: number; cat: string }[]>();
  for (const t of data.transactions) {
    if (!t.date.startsWith(month)) continue;
    const day = Number(t.date.slice(8, 10));
    const arr = byDay.get(day) ?? [];
    arr.push({ payee: t.payee, amount: num(t.amount), cat: t.categoryId ? catMap.get(t.categoryId) ?? "" : "" });
    byDay.set(day, arr);
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthTotal = data.transactions
    .filter((t) => t.date.startsWith(month))
    .reduce((s, t) => s + num(t.amount), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--accent)" }}><IconCalendar width={20} height={20} /></span>
        <h1 className="text-[18px] font-bold" style={{ color: "var(--text)" }}>Calendar</h1>
        <div className="ml-4 flex items-center gap-1">
          <button onClick={onPrev} className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: "var(--panel)", border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
            <span className="rotate-180"><IconChevronRight width={16} height={16} /></span>
          </button>
          <span className="w-[150px] text-center text-[15px] font-bold" style={{ color: "var(--text)" }}>{monthLabel(month)}</span>
          <button onClick={onNext} className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: "var(--panel)", border: "1px solid var(--border-strong)", color: "var(--text-2)" }}>
            <IconChevronRight width={16} height={16} />
          </button>
        </div>
        <span className="ml-auto text-[13.5px]" style={{ color: "var(--muted)" }}>
          Net this month: <span className="tnum font-bold" style={{ color: monthTotal >= 0 ? "var(--accent)" : "var(--danger)" }}>{fmt(monthTotal)}</span>
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-7 gap-2">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="pb-1 text-center text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>{d}</div>
          ))}
          {cells.map((d, i) => {
            const items = d ? byDay.get(d) ?? [] : [];
            const dayNet = items.reduce((s, x) => s + x.amount, 0);
            return (
              <div
                key={i}
                className="min-h-[104px] rounded-xl p-2"
                style={{
                  background: d ? "var(--panel)" : "transparent",
                  border: d ? "1px solid var(--border)" : "1px solid transparent",
                }}
              >
                {d && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="tnum text-[12.5px] font-semibold" style={{ color: "var(--text-2)" }}>{d}</span>
                      {dayNet !== 0 && (
                        <span className="tnum text-[11px] font-bold" style={{ color: dayNet >= 0 ? "var(--accent)" : "var(--danger)" }}>{fmt(dayNet)}</span>
                      )}
                    </div>
                    <div className="mt-1 space-y-1">
                      {items.slice(0, 3).map((x, j) => (
                        <div key={j} className="truncate rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: x.amount < 0 ? "var(--danger-bg)" : "var(--accent-soft)", color: x.amount < 0 ? "var(--danger)" : "var(--accent)" }}>
                          {x.payee}
                        </div>
                      ))}
                      {items.length > 3 && (
                        <div className="text-[10.5px]" style={{ color: "var(--muted)" }}>+{items.length - 3} more</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
