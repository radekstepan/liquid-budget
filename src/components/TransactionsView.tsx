"use client";

import { useMemo, useState } from "react";
import type { BudgetData } from "@/lib/types";
import { fmt, num } from "@/lib/format";
import { IconPlus, IconTrash, IconSwap, IconX } from "./icons";

export function TransactionsView({
  data,
  accountFilter,
  setAccountFilter,
  onAdd,
  onDelete,
}: {
  data: BudgetData;
  accountFilter: number | null;
  setAccountFilter: (id: number | null) => void;
  onAdd: () => void;
  onDelete: (id: number) => void;
}) {
  const [search, setSearch] = useState("");
  const accMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);

  const filtered = data.transactions.filter((t) => {
    if (accountFilter && t.accountId !== accountFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      const hay = `${t.payee} ${t.memo} ${catMap.get(t.categoryId ?? -1) ?? ""}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });

  const inflow = filtered.filter((t) => num(t.amount) > 0).reduce((s, t) => s + num(t.amount), 0);
  const outflow = filtered.filter((t) => num(t.amount) < 0).reduce((s, t) => s + num(t.amount), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--accent)" }}>
          <IconSwap width={20} height={20} />
        </span>
        <h1 className="text-[18px] font-bold" style={{ color: "var(--text)" }}>
          All Transactions
        </h1>
        {accountFilter && (
          <button
            onClick={() => setAccountFilter(null)}
            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-semibold"
            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
          >
            {accMap.get(accountFilter)} <IconX width={13} height={13} />
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search payee, memo…"
            className="w-[220px] rounded-lg px-3 py-2 text-[13.5px] outline-none focus:ring-2"
            style={{ background: "var(--panel-2)", border: "1px solid var(--border-strong)", color: "var(--text)" }}
          />
          <button
            onClick={onAdd}
            className="flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            <IconPlus width={15} height={15} /> Add Transaction
          </button>
        </div>
      </div>

      {/* summary chips */}
      <div className="flex gap-3 px-6 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <Chip label="Transactions" value={String(filtered.length)} />
        <Chip label="Inflow" value={fmt(inflow)} color="var(--accent)" />
        <Chip label="Outflow" value={fmt(outflow)} color="var(--danger)" />
        <Chip label="Net" value={fmt(inflow + outflow)} />
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10" style={{ background: "var(--panel-2)" }}>
            <tr className="text-left text-[11.5px] uppercase tracking-[0.06em]" style={{ color: "var(--muted)" }}>
              <Th>Date</Th>
              <Th>Account</Th>
              <Th>Payee</Th>
              <Th>Category</Th>
              <Th>Memo</Th>
              <Th right>Outflow</Th>
              <Th right>Inflow</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const amt = num(t.amount);
              return (
                <tr key={t.id} className="group transition-colors hover:bg-[var(--panel-3)]" style={{ borderTop: "1px solid var(--border)" }}>
                  <Td className="tnum" style={{ color: "var(--muted)" }}>{t.date}</Td>
                  <Td>{accMap.get(t.accountId)}</Td>
                  <Td className="font-medium" style={{ color: "var(--text)" }}>{t.payee}</Td>
                  <Td>
                    {t.categoryId ? (
                      <span className="rounded-md px-2 py-0.5 text-[12.5px] font-medium" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                        {catMap.get(t.categoryId)}
                      </span>
                    ) : (
                      <span style={{ color: "var(--faint)" }}>—</span>
                    )}
                  </Td>
                  <Td style={{ color: "var(--muted)" }}>{t.memo || "—"}</Td>
                  <Td right className="tnum" style={{ color: amt < 0 ? "var(--danger)" : "var(--faint)" }}>
                    {amt < 0 ? fmt(amt) : ""}
                  </Td>
                  <Td right className="tnum" style={{ color: amt > 0 ? "var(--accent)" : "var(--faint)" }}>
                    {amt > 0 ? fmt(amt) : ""}
                  </Td>
                  <Td right>
                    <button
                      onClick={() => onDelete(t.id)}
                      className="rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ color: "var(--muted)" }}
                    >
                      <IconTrash width={15} height={15} />
                    </button>
                  </Td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-16 text-center text-[14px]" style={{ color: "var(--muted)" }}>
                  No transactions found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Chip({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl px-3.5 py-2" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="tnum text-[15px] font-bold" style={{ color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`px-4 py-2.5 font-semibold ${right ? "text-right" : "text-left"}`}>{children}</th>;
}
function Td({
  children,
  right,
  className,
  style,
}: {
  children?: React.ReactNode;
  right?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td className={`px-4 py-2.5 text-[13.5px] ${right ? "text-right" : "text-left"} ${className ?? ""}`} style={{ color: "var(--text-2)", ...style }}>
      {children}
    </td>
  );
}
