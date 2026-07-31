"use client";

import { useState } from "react";
import type { Account } from "@ynab/logic";
import { fmt, num } from "@ynab/logic";
import {
  IconBudget,
  IconReports,
  IconCalendar,
  IconProjections,
  IconSwap,
  IconClock,
  IconChevronDown,
  IconChevronRight,
  IconDrop,
  IconPlus,
  IconTrash,
} from "./icons.js";

export type View =
  | "budget"
  | "reports"
  | "calendar"
  | "projections"
  | "transactions"
  | "recurring";

const NAV: { key: View; label: string; Icon: typeof IconBudget }[] = [
  { key: "budget", label: "Budget", Icon: IconBudget },
  { key: "reports", label: "Reports", Icon: IconReports },
  { key: "calendar", label: "Calendar", Icon: IconCalendar },
  { key: "projections", label: "Projections", Icon: IconProjections },
  { key: "transactions", label: "All Transactions", Icon: IconSwap },
  { key: "recurring", label: "Recurring Transactions", Icon: IconClock },
];

export function Sidebar({
  view,
  setView,
  accounts,
  onSelectAccount,
  onAddAccount,
  onDeleteAccount,
}: {
  view: View;
  setView: (v: View) => void;
  accounts: Account[];
  onSelectAccount: (id: number) => void;
  onAddAccount: () => void;
  onDeleteAccount?: (id: number) => void;
}) {
  // Group accounts by their `groupLabel` rather than hard-coding category
  // names so that any seed-data labels (e.g. "Budget Accounts") surface.
  const groupOrder = ["Liquid", "Credit Cards", "Retirement", "Budget Accounts"];
  const seen = new Set(accounts.map((a) => a.groupLabel));
  const groups = [...groupOrder.filter((g) => seen.has(g)), ...seen].filter(
    (g, i, arr) => arr.indexOf(g) === i
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    Retirement: true,
  });
  const [nwOpen, setNwOpen] = useState(true);

  const liquid = accounts.filter((a) => a.kind === "liquid");
  const credit = accounts.filter((a) => a.kind === "credit");
  const off = accounts.filter((a) => a.kind === "offbudget");

  const liquidTotal = liquid.reduce((s, a) => s + num(a.balance), 0);
  const creditTotal = credit.reduce((s, a) => s + num(a.balance), 0);
  const offAssets = off.filter((a) => num(a.balance) >= 0).reduce((s, a) => s + num(a.balance), 0);
  const offLiab = off.filter((a) => num(a.balance) < 0).reduce((s, a) => s + num(a.balance), 0);
  const netWorth = liquidTotal + creditTotal + offAssets + offLiab;

  const totalFor = (label: string) =>
    accounts.filter((a) => a.groupLabel === label).reduce((s, a) => s + num(a.balance), 0);
  const accountsFor = (label: string) => accounts.filter((a) => a.groupLabel === label);

  return (
    <aside
      className="flex h-full w-[288px] shrink-0 flex-col"
      style={{ background: "var(--bg)", borderRight: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2.5 px-6 pb-3 pt-5">
        <span style={{ color: "var(--accent)" }}>
          <IconDrop width={22} height={22} />
        </span>
        <span className="text-[17px] font-bold tracking-tight" style={{ color: "var(--text)" }}>
          Demo Budget
        </span>
      </div>

      <nav className="px-4 pt-1">
        {NAV.map(({ key, label, Icon }) => {
          const active = view === key;
          return (
            <button
              key={key}
              onClick={() => setView(key)}
              className="mb-1 flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14.5px] font-medium transition-all"
              style={{
                background: active ? "var(--accent)" : "transparent",
                color: active ? "var(--accent-fg)" : "var(--text-2)",
                boxShadow: active ? "var(--shadow)" : "none",
              }}
            >
              <Icon width={19} height={19} />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="mx-6 my-4 h-px" style={{ background: "var(--border)" }} />

      <div className="flex-1 overflow-y-auto px-4 pb-2">
        {groups.map((label) => {
          const list = accountsFor(label);
          if (list.length === 0) return null;
          const isCollapsed = collapsed[label];
          const total = totalFor(label);
          return (
            <div key={label} className="mb-1.5">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [label]: !c[label] }))}
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5"
              >
                <span style={{ color: "var(--faint)" }}>
                  {isCollapsed ? (
                    <IconChevronRight width={15} height={15} />
                  ) : (
                    <IconChevronDown width={15} height={15} />
                  )}
                </span>
                <span className="text-[14px] font-semibold" style={{ color: "var(--text-2)" }}>
                  {label}
                </span>
                <span
                  className="tnum ml-auto text-[13.5px] font-semibold"
                  style={{ color: total < 0 ? "var(--danger)" : "var(--muted)" }}
                >
                  {fmt(total)}
                </span>
              </button>
              {!isCollapsed &&
                list.map((a) => (
                  <div
                    key={a.id}
                    className="group flex w-full items-center rounded-lg transition-colors hover:bg-[var(--panel-3)]"
                  >
                    <button
                      onClick={() => onSelectAccount(a.id)}
                      className="flex min-w-0 flex-1 items-center py-1.5 pl-8 pr-2 text-left"
                    >
                      <span className="truncate text-[14px] font-medium" style={{ color: "var(--text)" }}>
                        {a.name}
                      </span>
                      <span
                        className="tnum ml-auto text-[13.5px]"
                        style={{ color: num(a.balance) < 0 ? "var(--danger)" : "var(--text-2)" }}
                      >
                        {fmt(num(a.balance))}
                      </span>
                    </button>
                    {onDeleteAccount && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete account "${a.name}"? This removes all its transactions.`)) {
                            onDeleteAccount(a.id);
                          }
                        }}
                        className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ color: "var(--muted)" }}
                        title="Delete account"
                        aria-label={`Delete account ${a.name}`}
                      >
                        <IconTrash width={13} height={13} />
                      </button>
                    )}
                  </div>
                ))}
            </div>
          );
        })}

        <button
          onClick={onAddAccount}
          className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--panel-3)]"
          style={{ color: "var(--muted)" }}
        >
          <IconPlus width={15} height={15} /> Add Account
        </button>
      </div>

      <div className="p-4">
        <div
          className="rounded-2xl p-4"
          style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}
        >
          <button
            onClick={() => setNwOpen((o) => !o)}
            className="flex w-full items-center gap-1.5"
          >
            <span style={{ color: "var(--faint)" }}>
              {nwOpen ? <IconChevronDown width={15} height={15} /> : <IconChevronRight width={15} height={15} />}
            </span>
            <span className="text-[14.5px] font-bold" style={{ color: "var(--text)" }}>
              Net Worth
            </span>
            <span className="tnum ml-auto text-[15px] font-bold" style={{ color: "var(--text)" }}>
              {fmt(netWorth)}
            </span>
          </button>
          {nwOpen && (
            <div className="mt-3 space-y-1.5">
              {[
                ["Liquid Accounts", liquidTotal],
                ["Credit Cards", creditTotal],
                ["Off-Budget Assets", offAssets],
                ["Off-Budget Liabilities", offLiab],
              ].map(([label, val]) => (
                <div key={label as string} className="flex items-center justify-between">
                  <span className="text-[13px]" style={{ color: "var(--muted)" }}>
                    {label}
                  </span>
                  <span
                    className="tnum text-[13px] font-medium"
                    style={{ color: (val as number) < 0 ? "var(--danger)" : "var(--text-2)" }}
                  >
                    {fmt(val as number)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
