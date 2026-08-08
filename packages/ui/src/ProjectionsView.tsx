"use client";

import type { BudgetData } from "@ynab/logic";
import { fmt, num, netMonthlyAmount, MONTHS_LONG, parseMonthKey } from "@ynab/logic";
import { Icon, Toolbar, Panel, MathCell } from "@ynab/theme";

export function ProjectionsView({ data, month }: { data: BudgetData; month: string }) {
  const { year, month0 } = parseMonthKey(month);
  const liquidNow = data.accounts
    .filter((a) => a.kind === "liquid")
    .reduce((s, a) => s + num(a.balance), 0);

  // Per-row net rule: single = its amount; transfer = 0; split = sum of children.
  const monthlyNet = data.recurring
    .filter((r) => r.active && r.frequency === "monthly")
    .reduce((s, r) => s + netMonthlyAmount(r, r.subTransactions ?? []), 0);
  const weeklyNet = data.recurring
    .filter((r) => r.active && r.frequency === "weekly")
    .reduce((s, r) => s + netMonthlyAmount(r, r.subTransactions ?? []) * 4.33, 0);
  const yearlyNet = data.recurring
    .filter((r) => r.active && r.frequency === "yearly")
    .reduce((s, r) => s + netMonthlyAmount(r, r.subTransactions ?? []) / 12, 0);
  const biweeklyNet = data.recurring
    .filter((r) => r.active && r.frequency === "biweekly")
    .reduce((s, r) => s + netMonthlyAmount(r, r.subTransactions ?? []) * 2.16, 0);
  const perMonth = monthlyNet + weeklyNet + biweeklyNet + yearlyNet;

  const points: { label: string; value: number }[] = [];
  let bal = liquidNow;
  for (let i = 0; i <= 12; i++) {
    const m = (month0 + i) % 12;
    const y = year + Math.floor((month0 + i) / 12);
    points.push({
      label: `${MONTHS_LONG[m]?.slice(0, 3)} ${String(y).slice(2)}`,
      value: bal,
    });
    bal += perMonth;
  }

  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const range = max - min || 1;
  const W = 720;
  const H = 240;
  const pad = 10;
  const x = (i: number) => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / range) * (H - pad * 2);
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="projections" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>Projections</span>
        </div>
        <span className="ml-auto y-hint">
          Based on {data.recurring.filter((r) => r.active).length} recurring items
        </span>
      </Toolbar>

      <div className="flex-1 overflow-y-auto p-4 y-scroll">
        <div className="mb-3 flex flex-wrap gap-2">
          <MathCell label="Liquid Balance" value={fmt(liquidNow)} className="flex-1" style={{ minWidth: 150 }} />
          <MathCell
            label="Projected Monthly Flow"
            value={fmt(perMonth)}
            tone={perMonth >= 0 ? "green" : "red"}
            className="flex-1"
            style={{ minWidth: 150 }}
          />
          <MathCell
            label="Projected in 12 mo"
            value={fmt(points[points.length - 1]!.value)}
            tone={points[points.length - 1]!.value >= 0 ? "green" : "red"}
            className="flex-1"
            style={{ minWidth: 150 }}
          />
        </div>

        <Panel title="12-Month Liquid Balance Forecast">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 240 }}>
            <defs>
              <linearGradient id="projFillGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--y-blue)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--y-blue)" stopOpacity={0} />
              </linearGradient>
            </defs>
            {y(0) > pad && y(0) < H - pad && (
              <line
                x1={pad}
                y1={y(0)}
                x2={W - pad}
                y2={y(0)}
                stroke="var(--y-red)"
                strokeDasharray="4 4"
                strokeWidth={1}
                opacity={0.5}
              />
            )}
            <path d={area} fill="url(#projFillGrad)" />
            <path
              d={line}
              fill="none"
              stroke="var(--y-blue)"
              strokeWidth={2.5}
              strokeLinejoin="round"
            />
            {points.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y(p.value)} r={3} fill="var(--y-blue)" />
            ))}
          </svg>
          <div className="mt-1 flex justify-between y-hint">
            {points
              .filter((_, i) => i % 2 === 0)
              .map((p) => (
                <span key={p.label} className="y-num">
                  {p.label}
                </span>
              ))}
          </div>
        </Panel>

        <Panel title="Monthly Breakdown" className="mt-3" bodyClass="!p-0 overflow-hidden">
          <table className="y-table">
            <thead className="y-thead">
              <tr>
                <th>Month</th>
                <th className="num" style={{ width: 160 }}>Projected Balance</th>
                <th className="num" style={{ width: 140 }}>Change</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i} className="y-row">
                  <td style={{ color: "var(--y-ink-soft)" }}>{p.label}</td>
                  <td
                    className="num y-num"
                    style={{ color: p.value < 0 ? "var(--y-red)" : "var(--y-ink)" }}
                  >
                    {fmt(p.value)}
                  </td>
                  <td
                    className="num y-num"
                    style={{ color: perMonth >= 0 ? "var(--y-green-dk)" : "var(--y-red)" }}
                  >
                    {i === 0 ? "—" : fmt(perMonth)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
