"use client";

import type { BudgetData } from "@ynab/logic";
import { fmt, num, MONTHS_LONG, parseMonthKey } from "@ynab/logic";
import { IconProjections } from "./icons.js";

export function ProjectionsView({ data, month }: { data: BudgetData; month: string }) {
  const { year, month0 } = parseMonthKey(month);
  const liquidNow = data.accounts.filter((a) => a.kind === "liquid").reduce((s, a) => s + num(a.balance), 0);

  const monthlyNet = data.recurring
    .filter((r) => r.active && r.frequency === "monthly")
    .reduce((s, r) => s + num(r.amount), 0);
  const weeklyNet = data.recurring
    .filter((r) => r.active && r.frequency === "weekly")
    .reduce((s, r) => s + num(r.amount) * 4.33, 0);
  const yearlyNet = data.recurring
    .filter((r) => r.active && r.frequency === "yearly")
    .reduce((s, r) => s + num(r.amount) / 12, 0);
  const perMonth = monthlyNet + weeklyNet + yearlyNet;

  const points: { label: string; value: number }[] = [];
  let bal = liquidNow;
  for (let i = 0; i <= 12; i++) {
    const m = (month0 + i) % 12;
    const y = year + Math.floor((month0 + i) / 12);
    points.push({ label: `${MONTHS_LONG[m]?.slice(0, 3)} ${String(y).slice(2)}`, value: bal });
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
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--accent)" }}><IconProjections width={20} height={20} /></span>
        <h1 className="text-[18px] font-bold" style={{ color: "var(--text)" }}>Projections</h1>
        <span className="ml-auto text-[13.5px]" style={{ color: "var(--muted)" }}>
          Based on {data.recurring.filter((r) => r.active).length} recurring items
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-5 grid grid-cols-3 gap-4">
          <Stat label="Liquid Balance" value={fmt(liquidNow)} />
          <Stat label="Projected Monthly Flow" value={fmt(perMonth)} color={perMonth >= 0 ? "var(--accent)" : "var(--danger)"} />
          <Stat label="Projected in 12 mo" value={fmt(points[points.length - 1]!.value)} color={points[points.length - 1]!.value >= 0 ? "var(--accent)" : "var(--danger)"} />
        </div>

        <div className="rounded-2xl p-5" style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
          <h3 className="mb-4 text-[14.5px] font-bold" style={{ color: "var(--text)" }}>12-Month Liquid Balance Forecast</h3>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 240 }}>
            <defs>
              <linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {y(0) > pad && y(0) < H - pad && (
              <line x1={pad} y1={y(0)} x2={W - pad} y2={y(0)} stroke="var(--danger)" strokeDasharray="4 4" strokeWidth={1} opacity={0.5} />
            )}
            <path d={area} fill="url(#fillGrad)" />
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" />
            {points.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y(p.value)} r={3} fill="var(--accent)" />
            ))}
          </svg>
          <div className="mt-2 flex justify-between text-[11px]" style={{ color: "var(--muted)" }}>
            {points.filter((_, i) => i % 2 === 0).map((p) => (
              <span key={p.label} className="tnum">{p.label}</span>
            ))}
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
          <table className="w-full">
            <thead style={{ background: "var(--panel-2)" }}>
              <tr className="text-left text-[11.5px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                <th className="px-4 py-2.5">Month</th>
                <th className="px-4 py-2.5 text-right">Projected Balance</th>
                <th className="px-4 py-2.5 text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-4 py-2 text-[13.5px]" style={{ color: "var(--text-2)" }}>{p.label}</td>
                  <td className="tnum px-4 py-2 text-right text-[13.5px] font-semibold" style={{ color: p.value < 0 ? "var(--danger)" : "var(--text)" }}>{fmt(p.value)}</td>
                  <td className="tnum px-4 py-2 text-right text-[13px]" style={{ color: perMonth >= 0 ? "var(--accent)" : "var(--danger)" }}>{i === 0 ? "—" : fmt(perMonth)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
      <div className="text-[12px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="tnum mt-1 text-[22px] font-bold" style={{ color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}
