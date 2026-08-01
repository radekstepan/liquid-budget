"use client";

import { useMemo, useState } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import { fmt, num, monthLabel } from "@ynab/logic";
import { Icon, Toolbar, Select, Panel, MathCell } from "@ynab/theme";

function getMonthsBetween(start: string, end: string) {
  const partsS = start.split("-");
  const partsE = end.split("-");
  let y = Number(partsS[0]);
  let m = Number(partsS[1]);
  const ey = Number(partsE[0]);
  const em = Number(partsE[1]);
  const out: string[] = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${m.toString().padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function ReportsView({
  data,
  month,
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
  const expense = rangeTxns
    .filter((t) => num(t.amount) < 0)
    .reduce((s, t) => s + num(t.amount), 0);

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
  const payees = [...byPayee.entries()]
    .map(([n, v]) => ({ n, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 6);

  const netWorthData = useMemo(() => {
    const months = getMonthsBetween(actualStart, actualEnd);
    const accBalances = new Map<number, number>();

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

    const points: { month: string; assets: number; debts: number; net: number }[] = [];
    for (const m of months) {
      const txns = txnsByMonth.get(m) || [];
      for (const t of txns) {
        accBalances.set(t.accountId, (accBalances.get(t.accountId) ?? 0) + num(t.amount));
      }

      let assets = 0;
      let debts = 0;
      for (const [, bal] of accBalances.entries()) {
        if (bal > 0) assets += bal;
        else debts += bal;
      }
      points.push({ month: m, assets, debts, net: assets + debts });
    }
    return points;
  }, [data.transactions, actualStart, actualEnd]);

  const palette = [
    "var(--y-blue)",
    "var(--y-blue-dark)",
    "#5aa5d0",
    "var(--y-orange)",
    "var(--y-green-dk)",
    "var(--y-red-dk)",
    "var(--y-grey-pill)",
    "#a482d4",
  ];
  const colorAt = (i: number) => palette[i % palette.length]!;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="chart" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>Reports</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="y-caps">From</span>
          <Select
            value={startMonth}
            onChange={(e) => setStartMonth(e.target.value)}
          >
            {allMonths.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
          <span className="y-caps">To</span>
          <Select
            value={endMonth}
            onChange={(e) => setEndMonth(e.target.value)}
          >
            {allMonths.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        </div>
      </Toolbar>

      <div className="flex-1 overflow-y-auto p-4 y-scroll">
        <div className="mb-3 flex flex-wrap gap-2">
          <MathCell label="Income" value={fmt(income)} tone="green" className="flex-1" style={{ minWidth: 140 }} />
          <MathCell label="Expenses" value={fmt(expense)} tone="red" className="flex-1" style={{ minWidth: 140 }} />
          <MathCell
            label="Net"
            value={fmt(income + expense)}
            tone={income + expense >= 0 ? "green" : "red"}
            className="flex-1"
            style={{ minWidth: 140 }}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Panel title="Net Worth">
            <NetWorthGraph points={netWorthData} />
          </Panel>

          <Panel title="Spending by Category">
            {spending.length === 0 ? (
              <Empty />
            ) : (
              <div className="space-y-[8px] max-h-[300px] overflow-y-auto pr-1 y-scroll">
                {spending.map((s, i) => (
                  <div key={s.name}>
                    <div className="mb-[2px] flex justify-between text-[11.5px]">
                      <span style={{ color: "var(--y-ink-soft)" }}>{s.name}</span>
                      <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
                        {fmt(s.value)}{" "}
                        <span style={{ color: "var(--y-ink-faint)" }}>
                          ({totalSpend ? Math.round((s.value / totalSpend) * 100) : 0}%)
                        </span>
                      </span>
                    </div>
                    <div className="y-bar-track h-[10px] overflow-hidden rounded-[3px]">
                      <div
                        className="h-full rounded-[3px]"
                        style={{
                          width: `${(s.value / maxSpend) * 100}%`,
                          background: colorAt(i),
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Expense Breakdown">
            {spending.length === 0 ? (
              <Empty />
            ) : (
              <div className="flex items-center gap-4">
                <Donut
                  segments={spending.map((s, i) => ({ value: s.value, color: colorAt(i) }))}
                  total={totalSpend}
                />
                <div className="flex-1 space-y-[4px]">
                  {spending.slice(0, 6).map((s, i) => (
                    <div key={s.name} className="flex items-center gap-2 text-[11.5px]">
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ background: colorAt(i) }}
                      />
                      <span className="flex-1 truncate" style={{ color: "var(--y-ink-soft)" }}>
                        {s.name}
                      </span>
                      <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
                        {fmt(s.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Top Payees">
            {payees.length === 0 ? (
              <Empty />
            ) : (
              <div className="space-y-[6px]">
                {payees.map((p) => (
                  <div
                    key={p.n}
                    className="flex items-center justify-between text-[12px]"
                  >
                    <span style={{ color: "var(--y-ink-soft)" }}>{p.n}</span>
                    <span className="y-num font-semibold" style={{ color: "var(--y-ink)" }}>
                      {fmt(p.v)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function NetWorthGraph({
  points,
}: {
  points: { month: string; assets: number; debts: number; net: number }[];
}) {
  if (points.length === 0) return <Empty />;

  const maxVal = Math.max(1, ...points.map((p) => p.assets));
  const minVal = Math.min(0, ...points.map((p) => p.debts));
  const range = maxVal - minVal;

  const W = 500;
  const H = 200;
  const padY = 20;
  const innerH = H - 2 * padY;

  const zeroY = range === 0 ? H / 2 : padY + innerH * (maxVal / range);
  const barW = Math.max(5, Math.min(30, (W - 20) / points.length - 4));

  return (
    <div className="w-full overflow-x-auto">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="min-w-[400px]"
      >
        <line
          x1="0"
          y1={zeroY}
          x2={W}
          y2={zeroY}
          stroke="var(--y-line)"
          strokeWidth="1"
        />

        {points.map((p, i) => {
          const x = 10 + (i * (W - 20)) / points.length;

          const assetH = range === 0 ? 0 : innerH * (p.assets / range);
          const assetY = zeroY - assetH;

          const debtH = range === 0 ? 0 : innerH * (-p.debts / range);
          const debtY = zeroY;

          const netY = range === 0 ? H / 2 : zeroY - innerH * (p.net / range);

          return (
            <g key={i}>
              {p.assets > 0 && (
                <rect
                  x={x}
                  y={assetY}
                  width={barW}
                  height={Math.max(1, assetH)}
                  fill="var(--y-blue)"
                  opacity={0.5}
                />
              )}
              {p.debts < 0 && (
                <rect
                  x={x}
                  y={debtY}
                  width={barW}
                  height={Math.max(1, debtH)}
                  fill="var(--y-red)"
                  opacity={0.5}
                />
              )}

              <circle cx={x + barW / 2} cy={netY} r={3} fill="var(--y-ink)" />
            </g>
          );
        })}

        <path
          d={`M ${points
            .map(
              (p, i) =>
                `${10 + (i * (W - 20)) / points.length + barW / 2},${
                  range === 0 ? H / 2 : zeroY - innerH * (p.net / range)
                }`
            )
            .join(" L ")}`}
          fill="none"
          stroke="var(--y-ink)"
          strokeWidth="2"
        />
      </svg>
      <div className="flex justify-between y-hint px-[10px] mt-1">
        <span>{points[0]!.month}</span>
        <span>{points[points.length - 1]!.month}</span>
      </div>
    </div>
  );
}

function Donut({
  segments,
  total,
}: {
  segments: { value: number; color: string }[];
  total: number;
}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg
      width={120}
      height={120}
      viewBox="0 0 120 120"
      className="shrink-0"
    >
      <circle cx={60} cy={60} r={r} fill="none" stroke="var(--y-line)" strokeWidth={16} />
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
      <text
        x={60}
        y={57}
        textAnchor="middle"
        className="tnum"
        fontSize={12}
        fill="var(--y-ink-soft)"
      >
        Total
      </text>
      <text
        x={60}
        y={72}
        textAnchor="middle"
        className="tnum"
        fontSize={13}
        fontWeight={700}
        fill="var(--y-ink)"
      >
        {fmt(total)}
      </text>
    </svg>
  );
}

function Empty() {
  return <div className="py-4 text-center y-hint">No data for this timeframe.</div>;
}
