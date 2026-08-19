"use client";

import { memo, useState, useRef, useEffect } from "react";
import type { Account } from "@ynab/logic";
import { fmt, num } from "@ynab/logic";
import { Button, Icon, cx } from "@ynab/theme";

export type View =
  | "budget"
  | "reports"
  | "calendar"
  | "projections"
  | "transactions";

type NavItem = { key: View; label: string; icon: string };
const NAV_TOP: NavItem[] = [
  { key: "budget", label: "Budget", icon: "budget" },
  { key: "reports", label: "Reports", icon: "chart" },
  { key: "calendar", label: "Calendar", icon: "calendar" },
  { key: "projections", label: "Projections", icon: "projections" },
];

const DEFAULT_WIDTH = 214;
const MIN_WIDTH = 170;
const MAX_WIDTH = 450;
const STORAGE_KEY = "ynab_sidebar_width";

export const Sidebar = memo(function Sidebar({
  view,
  setView,
  accounts,
  selectedAccountId,
  onSelectAccount,
  onAddAccount,
  onEditAccount,
  onReorderAccount,
  dueBadgeCount = 0,
  dueByAccount,
}: {
  view: View;
  setView: (v: View) => void;
  accounts: Account[];
  selectedAccountId: number | null;
  onSelectAccount: (id: number) => void;
  onAddAccount: () => void;
  onEditAccount?: (id: number) => void;
  onReorderAccount?: (id: number, sort: number) => Promise<void> | void;
  dueBadgeCount?: number;
  dueByAccount?: Record<number, number>;
}) {
  const activeAccounts = accounts.filter((a) => !a.archived);
  const archivedAccounts = accounts.filter((a) => !!a.archived);

  // Group ordering: discover all groupLabels, prioritizing budget accounts first, sorted by account sort indices
  const seen = Array.from(new Set(activeAccounts.map((a) => a.groupLabel)));
  const groupsWithSort = seen.map((groupLabel) => {
    const groupAccs = activeAccounts.filter((a) => a.groupLabel === groupLabel);
    const minSort = groupAccs.length > 0 ? Math.min(...groupAccs.map((a) => a.sort ?? 0)) : 0;
    const isBudget = groupAccs.some((a) => a.onBudget);
    return { groupLabel, minSort, isBudget };
  });

  groupsWithSort.sort((a, b) => {
    if (a.isBudget !== b.isBudget) return a.isBudget ? -1 : 1;
    return a.minSort - b.minSort;
  });

  const groups = groupsWithSort.map((g) => g.groupLabel);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    Retirement: true,
    "Archived Accounts": true,
  });
  const [nwOpen, setNwOpen] = useState(true);

  // Resizable sidebar width with localStorage persistence
  const [width, setWidth] = useState<number>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const n = parseInt(saved, 10);
          if (!isNaN(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
        }
      } catch {}
    }
    return DEFAULT_WIDTH;
  });

  const isResizing = useRef(false);
  const dragAccId = useRef<number | null>(null);
  const [accOverId, setAccOverId] = useState<number | null>(null);

  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, moveEvent.clientX));
      setWidth(newWidth);
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      const finalWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, upEvent.clientX));
      try {
        localStorage.setItem(STORAGE_KEY, String(finalWidth));
      } catch {}
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const resetWidth = () => {
    setWidth(DEFAULT_WIDTH);
    try {
      localStorage.setItem(STORAGE_KEY, String(DEFAULT_WIDTH));
    } catch {}
  };

  const handleDragStart = (e: React.DragEvent, id: number) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    dragAccId.current = id;
  };

  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (accOverId !== id) setAccOverId(id);
  };

  const handleDrop = (e: React.DragEvent, targetAcc: Account, list: Account[]) => {
    e.preventDefault();
    e.stopPropagation();
    const srcId = dragAccId.current;
    if (srcId == null || srcId === targetAcc.id || !onReorderAccount) {
      dragAccId.current = null;
      setAccOverId(null);
      return;
    }

    const srcIdx = list.findIndex((a) => a.id === srcId);
    const tgtIdx = list.findIndex((a) => a.id === targetAcc.id);
    if (srcIdx === -1 || tgtIdx === -1) {
      dragAccId.current = null;
      setAccOverId(null);
      return;
    }

    const reordered = [...list];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved!);

    reordered.forEach((acc, idx) => {
      if (acc.sort !== idx) {
        onReorderAccount(acc.id, idx);
      }
    });

    dragAccId.current = null;
    setAccOverId(null);
  };

  const liquid = activeAccounts.filter((a) => a.kind === "liquid");
  const credit = activeAccounts.filter((a) => a.kind === "credit");
  const off = activeAccounts.filter((a) => a.kind === "offbudget");

  const liquidTotal = liquid.reduce((s, a) => s + num(a.balance), 0);
  const creditTotal = credit.reduce((s, a) => s + num(a.balance), 0);
  const offAssets = off.filter((a) => num(a.balance) >= 0).reduce((s, a) => s + num(a.balance), 0);
  const offLiab = off.filter((a) => num(a.balance) < 0).reduce((s, a) => s + num(a.balance), 0);
  const archivedTotal = archivedAccounts.reduce((s, a) => s + num(a.balance), 0);
  const netWorth = liquidTotal + creditTotal + offAssets + offLiab + archivedTotal;

  const totalFor = (label: string) =>
    activeAccounts.filter((a) => a.groupLabel === label).reduce((s, a) => s + num(a.balance), 0);
  const accountsFor = (label: string) =>
    activeAccounts
      .filter((a) => a.groupLabel === label)
      .slice()
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id);

  return (
    <aside
      className="y-sidebar relative flex h-full shrink-0 flex-col"
      style={{ width: `${width}px` }}
    >
      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="y-logo">L</div>
          <div className="leading-none">
            <div className="text-[13px] font-bold text-white tracking-wide">LIQUID</div>
            <div className="text-[9px] tracking-[.14em]" style={{ color: "var(--y-side-ink-dim)" }}>
              MY BUDGET
            </div>
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
              <span className="truncate flex-1">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Transactions row — highlighted when transactions view with no account filter */}
      <button
        onClick={() => setView("transactions")}
        className={cx(
          "y-side-item y-side-nav",
          view === "transactions" && selectedAccountId == null && "is-sel"
        )}
      >
        <Icon name="swap" size={14} />
        <span className="truncate flex-1">Transactions</span>
        {dueBadgeCount > 0 && (
          <span
            className="y-badge mr-1"
            aria-label={`${dueBadgeCount} due`}
            title={`${dueBadgeCount} scheduled transaction${dueBadgeCount === 1 ? "" : "s"} due`}
          >
            {dueBadgeCount}
          </span>
        )}
        <span
          className="y-side-amt"
          style={{
            color: liquidTotal + creditTotal < 0 ? "var(--y-side-neg)" : undefined,
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
                  const isSelected = view === "transactions" && selectedAccountId === a.id;
                  const isDropTarget = accOverId === a.id;
                  const hasActions = Boolean(onEditAccount);
                  const accDueCount = dueByAccount?.[a.id] ?? 0;
                  return (
                    <div
                      key={a.id}
                      className={cx("y-side-row", isDropTarget && "is-drop-target")}
                      draggable={Boolean(onReorderAccount)}
                      onDragStart={(e) => handleDragStart(e, a.id)}
                      onDragOver={(e) => handleDragOver(e, a.id)}
                      onDragLeave={() => setAccOverId(null)}
                      onDrop={(e) => handleDrop(e, a, list)}
                    >
                      <button
                        onClick={() => onSelectAccount(a.id)}
                        className={cx("y-side-item", isSelected && "is-sel")}
                      >
                        <span className="truncate">{a.name}</span>
                        {accDueCount > 0 && (
                          <span
                            className="y-badge ml-auto mr-1"
                            style={{ minWidth: 14, height: 14, fontSize: 9, padding: "0 3px" }}
                            title={`${accDueCount} scheduled due`}
                          >
                            {accDueCount}
                          </span>
                        )}
                        <span
                          className={cx("y-side-amt", accDueCount === 0 && "ml-auto")}
                          style={{
                            color: num(a.balance) < 0 ? "var(--y-side-neg)" : undefined,
                            fontWeight: 500,
                          }}
                        >
                          {fmt(num(a.balance))}
                        </span>
                      </button>
                      {hasActions && onEditAccount && (
                        <div className="y-side-actions">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditAccount(a.id);
                            }}
                            className="y-side-edit-btn"
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

        {archivedAccounts.length > 0 && (
          <div className="y-side-group">
            <button
              onClick={() =>
                setCollapsed((c) => ({
                  ...c,
                  "Archived Accounts": !c["Archived Accounts"],
                }))
              }
              className="y-side-head flex items-center gap-2 w-full"
            >
              <span
                className={cx(
                  "y-tri ml-[4px] mr-1.5",
                  !collapsed["Archived Accounts"] && "is-open"
                )}
                style={{ borderLeftColor: "var(--y-side-sel-top)", flexShrink: 0 }}
              />
              <span className="truncate min-w-0 flex-1">Archived Accounts</span>
              <span
                className="y-side-amt"
                style={{ color: archivedTotal < 0 ? "var(--y-side-neg)" : undefined }}
              >
                {fmt(archivedTotal)}
              </span>
            </button>
            {!collapsed["Archived Accounts"] &&
              archivedAccounts.map((a) => {
                const isSelected = view === "transactions" && selectedAccountId === a.id;
                const isDropTarget = accOverId === a.id;
                const hasActions = Boolean(onEditAccount);
                return (
                  <div
                    key={a.id}
                    className={cx("y-side-row", isDropTarget && "is-drop-target")}
                    draggable={Boolean(onReorderAccount)}
                    onDragStart={(e) => handleDragStart(e, a.id)}
                    onDragOver={(e) => handleDragOver(e, a.id)}
                    onDragLeave={() => setAccOverId(null)}
                    onDrop={(e) => handleDrop(e, a, archivedAccounts)}
                  >
                    <button
                      onClick={() => onSelectAccount(a.id)}
                      className={cx(
                        "y-side-item opacity-80 hover:opacity-100",
                        isSelected && "is-sel !opacity-100"
                      )}
                    >
                      <span className="truncate">{a.name}</span>
                      <span
                        className="y-side-amt"
                        style={{
                          color: num(a.balance) < 0 ? "var(--y-side-neg)" : undefined,
                          fontWeight: 500,
                        }}
                      >
                        {fmt(num(a.balance))}
                      </span>
                    </button>
                    {hasActions && onEditAccount && (
                      <div className="y-side-actions">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditAccount(a.id);
                          }}
                          className="y-side-edit-btn"
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
        )}

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
          <span
            className={cx("y-tri ml-[4px] mr-1", nwOpen && "is-open")}
            style={{ borderLeftColor: "var(--y-side-sel-top)" }}
          />
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
              <div
                key={label as string}
                className="flex items-center justify-between text-[10.5px]"
              >
                <span style={{ color: "var(--y-side-ink-dim)" }}>
                  {label as string}
                </span>
                <span
                  className="y-num font-medium"
                  style={{
                    color: (val as number) < 0 ? "var(--y-side-neg)" : "var(--y-side-ink)",
                  }}
                >
                  {fmt(val as number)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Vertical Drag Resize Handle on the Right Edge */}
      <div
        onMouseDown={startResizing}
        onDoubleClick={resetWidth}
        className="absolute right-0 top-0 bottom-0 w-[5px] -mr-[2.5px] cursor-col-resize z-30 hover:bg-[var(--y-side-sel-top)] opacity-0 hover:opacity-100 transition-opacity"
        title="Drag to resize sidebar (double-click to reset)"
        aria-label="Resize sidebar"
      />
    </aside>
  );
});
