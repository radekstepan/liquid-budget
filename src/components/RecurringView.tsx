"use client";

import { useMemo } from "react";
import type { BudgetData } from "@/lib/types";
import { fmt, num } from "@/lib/format";
import { IconPlus, IconTrash, IconClock } from "./icons";

export function RecurringView({
  data,
  onAdd,
  onDelete,
  onPost,
}: {
  data: BudgetData;
  onAdd: () => void;
  onDelete: (id: number) => void;
  onPost: (id: number) => void;
}) {
  const accMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);

  const monthlyOut = data.recurring
    .filter((r) => r.active && num(r.amount) < 0 && r.frequency === "monthly")
    .reduce((s, r) => s + num(r.amount), 0);
  const monthlyIn = data.recurring
    .filter((r) => r.active && num(r.amount) > 0 && r.frequency === "monthly")
    .reduce((s, r) => s + num(r.amount), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--accent)" }}>
          <IconClock width={20} height={20} />
        </span>
        <h1 className="text-[18px] font-bold" style={{ color: "var(--text)" }}>
          Recurring Transactions
        </h1>
        <button
          onClick={onAdd}
          className="ml-auto flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          <IconPlus width={15} height={15} /> Add Recurring
        </button>
      </div>

      <div className="flex gap-3 px-6 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <Card label="Monthly Income" value={fmt(monthlyIn)} color="var(--accent)" />
        <Card label="Monthly Bills" value={fmt(monthlyOut)} color="var(--danger)" />
        <Card label="Net Monthly" value={fmt(monthlyIn + monthlyOut)} />
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {data.recurring.map((r) => {
            const amt = num(r.amount);
            return (
              <div
                key={r.id}
                className="group rounded-2xl p-4"
                style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-bold" style={{ color: "var(--text)" }}>
                      {r.payee}
                    </div>
                    <div className="mt-0.5 text-[12.5px]" style={{ color: "var(--muted)" }}>
                      {accMap.get(r.accountId)}
                      {r.categoryId ? ` · ${catMap.get(r.categoryId)}` : ""}
                    </div>
                  </div>
                  <span className="tnum text-[15px] font-bold" style={{ color: amt < 0 ? "var(--danger)" : "var(--accent)" }}>
                    {fmt(amt)}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold capitalize" style={{ background: "var(--panel-3)", color: "var(--text-2)" }}>
                    {r.frequency}
                  </span>
                  <span className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                    Next: <span className="tnum font-medium" style={{ color: "var(--text-2)" }}>{r.nextDate}</span>
                  </span>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => onPost(r.id)}
                    className="flex-1 rounded-lg py-1.5 text-[12.5px] font-semibold"
                    style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                  >
                    Post Now
                  </button>
                  <button
                    onClick={() => onDelete(r.id)}
                    className="grid w-9 place-items-center rounded-lg"
                    style={{ background: "var(--panel-3)", color: "var(--muted)" }}
                  >
                    <IconTrash width={15} height={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {data.recurring.length === 0 && (
          <div className="py-16 text-center text-[14px]" style={{ color: "var(--muted)" }}>
            No recurring transactions yet.
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl px-4 py-2.5" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="tnum text-[16px] font-bold" style={{ color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}
