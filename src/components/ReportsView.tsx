"use client";

import { useMemo } from "react";
import type { BudgetData } from "@/lib/types";
import { fmt, num, monthLabel } from "@/lib/format";
import { IconReports } from "./icons";

export function ReportsView({ data, month }: { data: BudgetData; month: string }) {
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);

  const monthTxns = data.transactions.filter((t) => t.date.startsWith(month));
  const income = monthTxns.filter((t) => num(t.amount) > 0).reduce((s, t) => s + num(t.amount), 0);
  const expense = monthTxns.filter((t) => num(t.amount) < 0).reduce((s, t) => s + num(t.amount), 0);

  // spending by category
  const byCat = new Map<number, number>();
  for (const t of monthTxns) {
    if (t.categoryId == null) continue;
    const a = num(t.amount);
    if (a < 0) byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + -a);
  }
  const spending = [...byCat.entries()]
    .map(([id, v]) => ({ name: catMap.get(id) ?? "—", value: v }))
    .sort((a, b) => b.value - a.value);
  const maxSpend = Math.max(1, ...spending.map((s) => s.value));
  const totalSpend = spending.reduce((s, x) => s + x.value, 0);

  // top payees
  const byPayee = new Map<string, number>();
  for (const t of monthTxns) {
    const a = num(t.amount);
    if (a < 0) byPayee.set(t.payee, (byPayee.get(t.payee) ?? 0) + -a);
  }
  const payees = [...byPayee.entries()].map(([n, v]) => ({ n, v })).sort((a, b) => b.v - a.v).slice(0, 6);

  const palette = ["#2f6d95", "#3a7ca5", "#5b9bc4", "#c47d2f", "#7d59b4", "#2e7d5b", "#a93a30", "#6a7482"];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--accent)" }}><IconReports width={20} height={20} /></span>
        <h1 className="text-[18px] font-bold" style={{ color: "var(--text)" }}>Reports</h1>
        <span className="ml-auto text-[13.5px] font-medium" style={{ color: "var(--muted)" }}>{monthLabel(month)}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-5 grid grid-cols-3 gap-4">
          <Stat label="Income" value={fmt(income)} color="var(--accent)" />
          <Stat label="Expenses" value={fmt(expense)} color="var(--danger)" />
          <Stat label="Net" value={fmt(income + expense)} color={income + expense >= 0 ? "var(--accent)" : "var(--danger)"} />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* Spending by category */}
          <Panel title="Spending by Category">
            {spending.length === 0 && <Empty />}
            <div className="space-y-3">
              {spending.map((s, i) => (
                <div key={s.name}>
                  <div className="mb-1 flex justify-between text-[13px]">
                    <span style={{ color: "var(--text-2)" }}>{s.name}</span>
                    <span className="tnum font-semibold" style={{ color: "var(--text)" }}>
                      {fmt(s.value)}{" "}
                      <span style={{ color: "var(--muted)" }}>
                        ({totalSpend ? Math.round((s.value / totalSpend) * 100) : 0}%)
                      </span>
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full" style={{ background: "var(--track)" }}>
                    <div className="h-full rounded-full" style={{ width: `${(s.value / maxSpend) * 100}%`, background: palette[i % palette.length] }} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {/* Donut + top payees */}
          <Panel title="Expense Breakdown">
            {spending.length === 0 ? (
              <Empty />
            ) : (
              <div className="flex items-center gap-6">
                <Donut segments={spending.map((s, i) => ({ value: s.value, color: palette[i % palette.length] }))} total={totalSpend} />
                <div className="flex-1 space-y-1.5">
                  {spending.slice(0, 6).map((s, i) => (
                    <div key={s.name} className="flex items-center gap-2 text-[12.5px]">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: palette[i % palette.length] }} />
                      <span className="flex-1 truncate" style={{ color: "var(--text-2)" }}>{s.name}</span>
                      <span className="tnum font-semibold" style={{ color: "var(--text)" }}>{fmt(s.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>

          {/* Top payees */}
          <Panel title="Top Payees">
            {payees.length === 0 && <Empty />}
            <div className="space-y-2.5">
              {payees.map((p) => (
                <div key={p.n} className="flex items-center justify-between text-[13.5px]">
                  <span style={{ color: "var(--text-2)" }}>{p.n}</span>
                  <span className="tnum font-semibold" style={{ color: "var(--text)" }}>{fmt(p.v)}</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* Assigned vs spent */}
          <Panel title="Assigned vs Spent">
            <div className="space-y-2.5">
              {data.groups.filter((g) => !g.isCreditCardPayments).map((g) => {
                const catsIn = data.categories.filter((c) => c.groupId === g.id).map((c) => c.id);
                const assigned = data.assignments
                  .filter((a) => a.month === month && catsIn.includes(a.categoryId))
                  .reduce((s, a) => s + num(a.amount), 0);
                const spent = monthTxns
                  .filter((t) => t.categoryId != null && catsIn.includes(t.categoryId) && num(t.amount) < 0)
                  .reduce((s, t) => s + -num(t.amount), 0);
                const pct = assigned ? Math.min(1, spent / assigned) : 0;
                return (
                  <div key={g.id}>
                    <div className="mb-1 flex justify-between text-[13px]">
                      <span style={{ color: "var(--text-2)" }}>{g.name}</span>
                      <span className="tnum" style={{ color: "var(--muted)" }}>
                        <span style={{ color: "var(--danger)" }}>{fmt(spent)}</span> / {fmt(assigned)}
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full" style={{ background: "var(--track)" }}>
                      <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: pct >= 1 ? "var(--danger)" : "var(--accent)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Donut({ segments, total }: { segments: { value: number; color: string }[]; total: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={120} height={120} viewBox="0 0 120 120" className="shrink-0">
      <circle cx={60} cy={60} r={r} fill="none" stroke="var(--track)" strokeWidth={16} />
      {segments.map((s, i) => {
        const frac = total ? s.value / total : 0;
        const len = frac * c;
        const el = (
          <circle
            key={i}
            cx={60}
            cy={60}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={16}
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 60 60)"
          />
        );
        offset += len;
        return el;
      })}
      <text x={60} y={57} textAnchor="middle" className="tnum" fontSize={12} fill="var(--muted)">Total</text>
      <text x={60} y={72} textAnchor="middle" className="tnum" fontSize={13} fontWeight={700} fill="var(--text)">{fmt(total)}</text>
    </svg>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
      <h3 className="mb-4 text-[14.5px] font-bold" style={{ color: "var(--text)" }}>{title}</h3>
      {children}
    </div>
  );
}
function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
      <div className="text-[12px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="tnum mt-1 text-[22px] font-bold" style={{ color }}>{value}</div>
    </div>
  );
}
function Empty() {
  return <div className="py-6 text-center text-[13px]" style={{ color: "var(--muted)" }}>No data for this month.</div>;
}
