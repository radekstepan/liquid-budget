"use client";

import { useMemo, useState } from "react";
import type { BudgetData } from "@ynab/logic";
import { fmt, num, parseMonthKey } from "@ynab/logic";
import { Icon, Toolbar, ToolbarSep, MonthNav } from "@ynab/theme";

export function CalendarView({
  data,
  month,
  onPrev,
  onNext,
  onSetMonth,
  minYear,
  maxYear,
  onAdd,
}: {
  data: BudgetData;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onSetMonth?: (key: string) => void;
  minYear?: number;
  maxYear?: number;
  onAdd: (date: string) => void;
}) {
  const { year, month0 } = parseMonthKey(month);
  const catMap = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c.name])),
    [data.categories]
  );
  const [expandedDay, setExpandedDay] = useState<number | null>(null);

  const firstDay = new Date(year, month0, 1).getDay();
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();

  const byDay = new Map<number, { payee: string; amount: number; cat: string }[]>();
  for (const t of data.transactions) {
    if (!t.date.startsWith(month)) continue;
    const day = Number(t.date.slice(8, 10));
    const arr = byDay.get(day) ?? [];
    arr.push({
      payee: t.payee,
      amount: num(t.amount),
      cat: t.categoryId ? catMap.get(t.categoryId) ?? "" : "",
    });
    byDay.set(day, arr);
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthTotal = data.transactions
    .filter((t) => t.date.startsWith(month))
    .reduce((s, t) => s + num(t.amount), 0);

  const dateIso = (d: number) => {
    const yyyy = year;
    const mm = String(month0 + 1).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="calendar" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>Calendar</span>
        </div>
        <ToolbarSep />
        <MonthNav
          month={month}
          onPrev={onPrev}
          onNext={onNext}
          onSetMonth={onSetMonth}
          minYear={minYear}
          maxYear={maxYear}
        />
        <span className="ml-auto y-hint">
          Net this month:{" "}
          <span
            className="y-num font-bold"
            style={{ color: monthTotal >= 0 ? "var(--y-green-dk)" : "var(--y-red)" }}
          >
            {fmt(monthTotal)}
          </span>
        </span>
      </Toolbar>

      <div className="flex-1 overflow-y-auto p-3 y-scroll">
        <div className="grid grid-cols-7 gap-1">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div
              key={d}
              className="y-caps pb-1 text-center"
              style={{ color: "var(--y-ink-soft)" }}
            >
              {d}
            </div>
          ))}
          {cells.map((d, i) => {
            const items = d ? byDay.get(d) ?? [] : [];
            const dayNet = items.reduce((s, x) => s + x.amount, 0);
            const expanded = expandedDay === d;
            const visible = expanded ? items : items.slice(0, 3);
            const overflow = items.length - visible.length;
            return (
              <div
                key={i}
                className="min-h-[100px] p-1.5 transition-colors"
                style={{
                  background: d ? "var(--y-row)" : "transparent",
                  border: d ? "1px solid var(--y-line-soft)" : "1px solid transparent",
                  borderRadius: 3,
                  cursor: d ? "pointer" : "default",
                }}
                onClick={() => {
                  if (!d) return;
                  if (items.length === 0) onAdd(dateIso(d));
                  else setExpandedDay(expanded ? null : d);
                }}
                role={d ? "button" : undefined}
                aria-label={d ? `Add transaction on ${dateIso(d)}` : undefined}
              >
                {d && (
                  <>
                    <div className="flex items-center justify-between">
                      <span
                        className="y-num text-[12px] font-semibold"
                        style={{ color: "var(--y-ink)" }}
                      >
                        {d}
                      </span>
                      {dayNet !== 0 && (
                        <span
                          className="y-num text-[10.5px] font-bold"
                          style={{ color: dayNet >= 0 ? "var(--y-green-dk)" : "var(--y-red)" }}
                        >
                          {fmt(dayNet)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 space-y-[2px]">
                      {visible.map((x, j) => (
                        <div
                          key={j}
                          className="flex items-center gap-1 rounded px-1 py-[1px] text-[10px]"
                          style={{
                            background: x.amount < 0 ? "var(--y-red-pale)" : "var(--y-blue-pale)",
                            color: x.amount < 0 ? "var(--y-red-dk)" : "var(--y-blue-dark)",
                          }}
                          title={`${x.payee}${x.cat ? ` · ${x.cat}` : ""} · ${fmt(x.amount)}`}
                        >
                          <span className="truncate flex-1">{x.payee}</span>
                          <span className="y-num shrink-0">{fmt(x.amount)}</span>
                        </div>
                      ))}
                      {overflow > 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedDay(d);
                          }}
                          className="block w-full p-0 text-left text-[10px] leading-none underline-offset-2 hover:underline"
                          style={{ color: "var(--y-ink-soft)" }}
                        >
                          +{overflow} more
                        </button>
                      )}
                      {expanded && overflow > 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedDay(null);
                          }}
                          className="block w-full p-0 text-left text-[10px] leading-none underline-offset-2 hover:underline"
                          style={{ color: "var(--y-ink-soft)" }}
                        >
                          Show less
                        </button>
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
