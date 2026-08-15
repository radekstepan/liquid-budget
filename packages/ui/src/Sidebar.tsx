"use client";

import { useState } from "react";
import type { Account } from "@ynab/logic";
import { fmt, num } from "@ynab/logic";
import { Button, Icon, cx } from "@ynab/theme";

export type View =
  | "budget"
  | "reports"
  | "calendar"
  | "projections"
  | "transactions"
  | "recurring";

type NavItem = { key: View; label: string; icon: string };
const NAV_TOP: NavItem[] = [
  { key: "budget", label: "Budget", icon: "budget" },
  { key: "reports", label: "Reports", icon: "chart" },
  { key: "calendar", label: "Calendar", icon: "calendar" },
  { key: "recurring", label: "Recurring", icon: "clock" },
  { key: "projections", label: "Projections", icon: "projections" },
];

export function Sidebar({
  view,
  setView,
  accounts,
  selectedAccountId,
  onSelectAccount,
  onAddAccount,
  onEditAccount,
}: {
  view: View;
  setView: (v: View) => void;
  accounts: Account[];
  selectedAccountId: number | null;
  onSelectAccount: (id: number) => void;
  onAddAccount: () => void;
  onEditAccount?: (id: number) => void;
}) {
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
    <aside className="y-sidebar flex h-full w-[214px] shrink-0 flex-col">
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="y-logo">L</div>
          <div className="leading-none">
            <div className="text-[13px] font-bold text-white tracking-wide">LIQUID</div>
            <div className="text-[9px] tracking-[.14em]" style={{ color: "var(--y-side-ink-dim)" }}>MY BUDGET</div>
          </div>
        </div>
      </div>
      <div className="y-side-section-divider" style={{ marginTop: "1px" }} />

      <nav className="px-0 pt-1">
        {NAV_TOP.map(({ key, label, icon }) => {
          const active = view === key;
          return (
            <button
              key={key}
              onClick={() => setView(key)}
              className={cx("y-side-item y-side-nav", active && "is-sel")}
            >
              <Icon name={icon} size={14} />
              {label}
            </button>
          );
        })}
      </nav>

      {/* Accounts row — highlighted when transactions view with no account filter */}
      <button
        onClick={() => setView("transactions")}
        className={cx(
          "y-side-item y-side-nav",
          view === "transactions" && selectedAccountId == null && "is-sel"
        )}
      >
        <Icon name="bank" size={14} />
        <span className="truncate flex-1">Accounts</span>
        <span
          className="y-side-amt"
          style={{
            color:
              liquidTotal + creditTotal < 0 ? "var(--y-side-neg)" : undefined,
            fontWeight: 500,
          }}
        >
          {fmt(liquidTotal + creditTotal)}
        </span>
      </button>

      <div className="y-side-section-divider" />

      <div className="flex-1 overflow-y-auto y-scroll y-scroll--dark">
        {groups.map((label) => {
          const list = accountsFor(label);
          if (list.length === 0) return null;
          const isCollapsed = collapsed[label];
          const total = totalFor(label);
          return (
            <div key={label} className="y-side-group">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [label]: !c[label] }))}
                className="y-side-head flex items-center gap-2 w-full"
              >
                <span
                  className={cx("y-tri ml-[4px] mr-1.5", !isCollapsed && "is-open")}
                  style={{ borderLeftColor: "var(--y-side-sel-top)", flexShrink: 0 }}
                />
                <span className="truncate min-w-0 flex-1">{label}</span>
                <span
                  className="y-side-amt"
                  style={{ color: total < 0 ? "var(--y-side-neg)" : undefined }}
                >
                  {fmt(total)}
                </span>
              </button>
              {!isCollapsed &&
                list.map((a) => {
                  const isSelected = selectedAccountId === a.id;
                  const hasActions = Boolean(onEditAccount);
                  return (
                    <div
                      key={a.id}
                      className="group relative w-full"
                      style={{ paddingLeft: 0 }}
                    >
                      <button
                        onClick={() => onSelectAccount(a.id)}
                        className={cx("y-side-item group/acc", isSelected && "is-sel")}
                      >
                        <span className="truncate">{a.name}</span>
                        <span
                          className={cx(
                            "y-side-amt transition-opacity",
                            hasActions && "group-hover:opacity-0"
                          )}
                          style={{
                            color: num(a.balance) < 0 ? "var(--y-side-neg)" : undefined,
                            fontWeight: 500,
                          }}
                        >
                          {fmt(num(a.balance))}
                        </span>
                      </button>
                      {hasActions && onEditAccount && (
                        <div
                          className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100"
                        >
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditAccount(a.id);
                            }}
                            className="grid h-[18px] w-[18px] place-items-center rounded"
                            style={{ color: "var(--y-side-ink-dim)" }}
                            title="Edit account"
                            aria-label={`Edit account ${a.name}`}
                          >
                            <Icon name="edit" size={11} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}

        <Button
          onClick={onAddAccount}
          variant="primary"
          className="mx-2 mt-2 mb-3 h-[24px] w-[calc(100%-1rem)]"
        >
          <Icon name="plus" size={11} color="#fff" /> Add Account
        </Button>
      </div>

      <div className="y-side-section-divider" />
      <div className="y-side-nw">
          <button
            onClick={() => setNwOpen((o) => !o)}
            className="flex w-full items-center gap-1.5"
            style={{ color: "var(--y-side-ink)" }}
          >
            <span className={cx("y-tri ml-[4px] mr-1", nwOpen && "is-open")} style={{ borderLeftColor: "var(--y-side-sel-top)" }} />
            <span className="text-[11px] font-bold">Net Worth</span>
            <span className="y-side-amt text-white" style={{ fontWeight: 700 }}>
              {fmt(netWorth)}
            </span>
          </button>
          {nwOpen && (
            <div className="mt-2 space-y-[3px]">
              {[
                ["Liquid Accounts", liquidTotal],
                ["Credit Cards", creditTotal],
                ["Off-Budget Assets", offAssets],
                ["Off-Budget Liabilities", offLiab],
              ].map(([label, val]) => (
                <div key={label as string} className="flex items-center justify-between text-[10.5px]">
                  <span style={{ color: "var(--y-side-ink-dim)" }}>{label as string}</span>
                  <span
                    className="y-num font-medium"
                    style={{ color: (val as number) < 0 ? "var(--y-side-neg)" : "var(--y-side-ink)" }}
                  >
                    {fmt(val as number)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
    </aside>
  );
}
