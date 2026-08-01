"use client";

import { useMemo, useState, Fragment } from "react";
import type { BudgetData, Transaction } from "@ynab/logic";
import { fmt, num } from "@ynab/logic";
import { IconPlus, IconTrash, IconSwap, IconX, IconPencil, IconChevronDown, IconChevronRight } from "./icons.js";

export function TransactionsView({
  data,
  accountFilter,
  setAccountFilter,
  onAdd,
  onEdit,
  onDelete,
}: {
  data: BudgetData;
  accountFilter: number | null;
  setAccountFilter: (id: number | null) => void;
  onAdd: () => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const [search, setSearch] = useState("");
  const accMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);

  const [expandedSplits, setExpandedSplits] = useState<Record<number, boolean>>({});

  const childrenByParent = useMemo(() => {
    const map = new Map<number, Transaction[]>();
    for (const t of data.transactions) {
      if (t.parentId) {
        if (!map.has(t.parentId)) map.set(t.parentId, []);
        map.get(t.parentId)!.push(t);
      }
    }
    return map;
  }, [data.transactions]);

  const parentsList = useMemo(() => data.transactions.filter(t => !t.parentId), [data.transactions]);

  const filteredParents = parentsList.filter((t) => {
    if (accountFilter && t.accountId !== accountFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      const matchT = `${t.payee} ${t.memo} ${catMap.get(t.categoryId ?? -1) ?? ""}`.toLowerCase().includes(s);
      if (matchT) return true;
      const children = childrenByParent.get(t.id) || [];
      const matchChild = children.some(c => `${c.payee} ${c.memo} ${catMap.get(c.categoryId ?? -1) ?? ""}`.toLowerCase().includes(s));
      if (matchChild) return true;
      return false;
    }
    return true;
  });

  const inflow = filteredParents.reduce((sum, t) => {
    const a = num(t.amount);
    return a > 0 ? sum + a : sum;
  }, 0);
  const outflow = filteredParents.reduce((sum, t) => {
    const a = num(t.amount);
    return a < 0 ? sum + a : sum;
  }, 0);

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

      <div className="flex gap-3 px-6 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <Chip label="Transactions" value={String(filteredParents.length)} />
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
              <Th>Status</Th>
              <Th right>Outflow</Th>
              <Th right>Inflow</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filteredParents.map((t) => {
              const renderRow = (txn: Transaction, isChild = false) => {
                const amt = num(txn.amount);
                const hasChildren = !isChild && childrenByParent.has(txn.id);
                const children = hasChildren ? childrenByParent.get(txn.id)! : [];
                const expanded = !!expandedSplits[txn.id];

                let payeeDisplay = txn.payee;
                let icon = null;
                if (txn.transferAccountId) {
                  payeeDisplay = `Transfer : ${accMap.get(txn.transferAccountId) || "Unknown"}`;
                  icon = <IconSwap width={14} height={14} className="mr-1.5 inline-block opacity-70" />;
                }

                return (
                  <Fragment key={txn.id}>
                    <tr className={`group transition-colors ${isChild ? "bg-[var(--panel-3)]" : "hover:bg-[var(--panel-3)]"}`} style={{ borderTop: isChild ? "none" : "1px solid var(--border)" }}>
                      <Td className="tnum" style={{ color: "var(--muted)" }}>{!isChild ? txn.date : ""}</Td>
                      <Td>{!isChild ? accMap.get(txn.accountId) : ""}</Td>
                      <Td className={isChild ? "pl-8" : "font-medium"} style={{ color: "var(--text)" }}>
                        {icon}
                        {payeeDisplay}
                      </Td>
                      <Td>
                        {hasChildren ? (
                          <button
                            onClick={() => setExpandedSplits(s => ({ ...s, [txn.id]: !s[txn.id] }))}
                            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[12.5px] font-medium transition-colors hover:bg-[var(--accent-strong)]"
                            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                          >
                            {expanded ? <IconChevronDown width={14} height={14} /> : <IconChevronRight width={14} height={14} />}
                            Split (Multiple Categories)...
                          </button>
                        ) : txn.categoryId ? (
                          <span className="rounded-md px-2 py-0.5 text-[12.5px] font-medium" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                            {catMap.get(txn.categoryId)}
                          </span>
                        ) : (
                          <span style={{ color: "var(--faint)" }}>—</span>
                        )}
                      </Td>
                      <Td style={{ color: "var(--muted)" }}>{txn.memo || "—"}</Td>
                      <Td>
                        {!isChild && (
                          txn.cleared ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
                              style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                              title="Cleared"
                            >
                              ● Cleared
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold"
                              style={{ background: "var(--warn-bg, var(--panel-3))", color: "var(--warn, var(--text-2))" }}
                              title="Uncleared"
                            >
                              ○ Uncleared
                            </span>
                          )
                        )}
                      </Td>
                      <Td right className="tnum" style={{ color: amt < 0 ? "var(--danger)" : "var(--faint)" }}>
                        {amt < 0 ? fmt(amt) : ""}
                      </Td>
                      <Td right className="tnum" style={{ color: amt > 0 ? "var(--accent)" : "var(--faint)" }}>
                        {amt > 0 ? fmt(amt) : ""}
                      </Td>
                      <Td right>
                        <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button onClick={() => onEdit(txn.id)} className="rounded p-1 text-[var(--muted)] hover:text-[var(--text)]" title="Edit">
                            <IconPencil width={14} height={14} />
                          </button>
                          <button onClick={() => onDelete(txn.id)} className="rounded p-1 text-[var(--muted)] hover:text-[var(--danger)]" title="Delete">
                            <IconTrash width={15} height={15} />
                          </button>
                        </div>
                      </Td>
                    </tr>
                    {expanded && children.map(c => renderRow(c, true))}
                  </Fragment>
                );
              };
              
              return renderRow(t);
            })}
            {filteredParents.length === 0 && (
              <tr>
                <td colSpan={9} className="py-16 text-center text-[14px]" style={{ color: "var(--muted)" }}>
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
