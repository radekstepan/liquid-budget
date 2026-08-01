"use client";

import { useMemo, useState } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import { fmt, num, monthLabel } from "@ynab/logic";
import { IconReports, IconChevronRight, IconChevronDown } from "./icons.js";

function getMonthsBetween(start: string, end: string) {
  const partsS = start.split("-");
  const partsE = end.split("-");
  let y = Number(partsS[0]);
  let m = Number(partsS[1]);
  const ey = Number(partsE[0]);
  const em = Number(partsE[1]);
  const out = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${m.toString().padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function ReportsView({
  data,
  month, // Current selected month in the app
  onPrev,
  onNext,
}: {
  data: BudgetData;
  month: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const allMonths = useMemo(() => {
    const s = new Set<string>();
    for (const t of data.transactions) s.add(t.date.slice(0, 7));
    if (s.size === 0) return [month];
    return Array.from(s).sort();
  }, [data.transactions, month]);

  const defaultStart = allMonths[0] ?? month;
  const defaultEnd = allMonths[allMonths.length - 1] ?? month;

  const [startMonth, setStartMonth] = useState<string>(defaultStart);
  const [endMonth, setEndMonth] = useState<string>(defaultEnd);

  const actualStart = startMonth <= endMonth ? startMonth : endMonth;
  const actualEnd = startMonth <= endMonth ? endMonth : startMonth;

  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);

  const rangeTxns = data.transactions.filter((t) => {
    const mk = t.date.slice(0, 7);
    return mk >= actualStart && mk <= actualEnd;
  });

  const income = rangeTxns
    .filter((t) => t.categoryId == null && num(t.amount) > 0)
    .reduce((s, t) => s + num(t.amount), 0);
  const expense = rangeTxns.filter((t) => num(t.amount) < 0).reduce((s, t) => s + num(t.amount), 0);

  const byCat = new Map<number, number>();
  for (const t of rangeTxns) {
    if (t.categoryId == null) continue;
    const a = num(t.amount);
    if (a < 0) byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + -a);
  }
  const spending = [...byCat.entries()]
    .map(([id, v]) => ({ name: catMap.get(id) ?? "—", value: v }))
    .sort((a, b) => b.value - a.value);
  const maxSpend = Math.max(1, ...spending.map((s) => s.value));
  const totalSpend = spending.reduce((s, x) => s + x.value, 0);

  const byPayee = new Map<string, number>();
  for (const t of rangeTxns) {
    const a = num(t.amount);
    if (a < 0) byPayee.set(t.payee, (byPayee.get(t.payee) ?? 0) + -a);
  }
  const payees = [...byPayee.entries()].map(([n, v]) => ({ n, v })).sort((a, b) => b.v - a.v).slice(0, 6);

  const netWorthData = useMemo(() => {
    const months = getMonthsBetween(actualStart, actualEnd);
    const accBalances = new Map<number, number>();
    
    // Initial balances before startMonth
    for (const t of data.transactions) {
      if (t.date.slice(0, 7) < actualStart) {
        accBalances.set(t.accountId, (accBalances.get(t.accountId) ?? 0) + num(t.amount));
      }
    }

    const txnsByMonth = new Map<string, Transaction[]>();
    for (const t of data.transactions) {
      const mk = t.date.slice(0, 7);
      if (!txnsByMonth.has(mk)) txnsByMonth.set(mk, []);
      txnsByMonth.get(mk)!.push(t);
    }

    const points = [];
    for (const m of months) {
      const txns = txnsByMonth.get(m) || [];
      for (const t of txns) {
        accBalances.set(t.accountId, (accBalances.get(t.accountId) ?? 0) + num(t.amount));
      }
      
      let assets = 0;
      let debts = 0;
      for (const [accId, bal] of accBalances.entries()) {
        if (bal > 0) assets += bal;
        else debts += bal; 
      }
      points.push({ month: m, assets, debts, net: assets + debts });
    }
    return points;
  }, [data.transactions, actualStart, actualEnd]);

  const palette = ["#2f6d95", "#3a7ca5", "#5b9bc4", "#c47d2f", "#7d59b4", "#2e7d5b", "#a93a30", "#6a7482"];
  const colorAt = (i: number) => palette[i % palette.length]!;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--accent)" }}><IconReports width={20} height={20} /></span>
        <h1 className="text-[18px] font-bold" style={{ color: "var(--text)" }}>Reports</h1>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--muted)]">FROM</span>
            <select
               value={startMonth}
               onChange={e => setStartMonth(e.target.value)}
               className="bg-[var(--panel-2)] border border-[var(--border-strong)] rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--text)] outline-none"
            >
               {allMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--muted)]">TO</span>
            <select
               value={endMonth}
               onChange={e => setEndMonth(e.target.value)}
               className="bg-[var(--panel-2)] border border-[var(--border-strong)] rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--text)] outline-none"
            >
               {allMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-5 grid grid-cols-3 gap-4">
          <Stat label="Income" value={fmt(income)} color="var(--accent)" />
          <Stat label="Expenses" value={fmt(expense)} color="var(--danger)" />
          <Stat label="Net" value={fmt(income + expense)} color={income + expense >= 0 ? "var(--accent)" : "var(--danger)"} />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 mb-5">
          <Panel title="Net Worth">
            <NetWorthGraph points={netWorthData} />
          </Panel>

          <Panel title="Spending by Category">
            {spending.length === 0 && <Empty />}
            <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2">
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
                    <div className="h-full rounded-full" style={{ width: `${(s.value / maxSpend) * 100}%`, background: colorAt(i) }} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Expense Breakdown">
            {spending.length === 0 ? (
              <Empty />
            ) : (
              <div className="flex items-center gap-6">
                <Donut segments={spending.map((s, i) => ({ value: s.value, color: colorAt(i) }))} total={totalSpend} />
                <div className="flex-1 space-y-1.5">
                  {spending.slice(0, 6).map((s, i) => (
                    <div key={s.name} className="flex items-center gap-2 text-[12.5px]">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorAt(i) }} />
                      <span className="flex-1 truncate" style={{ color: "var(--text-2)" }}>{s.name}</span>
                      <span className="tnum font-semibold" style={{ color: "var(--text)" }}>{fmt(s.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>

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
        </div>
      </div>
    </div>
  );
}

function NetWorthGraph({ points }: { points: { month: string, assets: number, debts: number, net: number }[] }) {
   if (points.length === 0) return <Empty />;
   
   const maxVal = Math.max(1, ...points.map(p => p.assets));
   const minVal = Math.min(0, ...points.map(p => p.debts));
   const range = maxVal - minVal;
   
   // SVG dimensions
   const W = 500;
   const H = 200;
   const padY = 20;
   const innerH = H - 2 * padY;
   
   const zeroY = range === 0 ? H/2 : padY + innerH * (maxVal / range);
   
   const barW = Math.max(5, Math.min(30, (W - 20) / points.length - 4));
   
   return (
      <div className="w-full overflow-x-auto">
         <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="min-w-[400px]">
            {/* Zero Line */}
            <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="var(--border-strong)" strokeWidth="1" />
            
            {points.map((p, i) => {
               const x = 10 + i * (W - 20) / points.length;
               
               const assetH = range === 0 ? 0 : innerH * (p.assets / range);
               const assetY = zeroY - assetH;
               
               const debtH = range === 0 ? 0 : innerH * (-p.debts / range);
               const debtY = zeroY;
               
               const netY = range === 0 ? H/2 : zeroY - innerH * (p.net / range);
               
               return (
                  <g key={i}>
                     {p.assets > 0 && <rect x={x} y={assetY} width={barW} height={Math.max(1, assetH)} fill="var(--accent)" opacity={0.5} />}
                     {p.debts < 0 && <rect x={x} y={debtY} width={barW} height={Math.max(1, debtH)} fill="var(--danger)" opacity={0.5} />}
                     
                     <circle cx={x + barW/2} cy={netY} r={3} fill="var(--text)" />
                  </g>
               );
            })}
            
            {/* Net Line (connect the dots) */}
            <path
               d={`M ${points.map((p, i) => `${10 + i * (W - 20) / points.length + barW/2},${range === 0 ? H/2 : zeroY - innerH * (p.net / range)}`).join(' L ')}`}
               fill="none"
               stroke="var(--text)"
               strokeWidth="2"
            />
         </svg>
         <div className="flex justify-between text-[11px] text-[var(--muted)] px-[10px] mt-2">
            <span>{points[0]!.month}</span>
            <span>{points[points.length - 1]!.month}</span>
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
    <div className="rounded-2xl p-5 flex flex-col" style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
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
  return <div className="py-6 text-center text-[13px]" style={{ color: "var(--muted)" }}>No data for this timeframe.</div>;
}
