"use client";

import { useRef, useState, useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fmt } from "@ynab/logic";
import type { QuickBudgetType } from "./useQuickBudget.js";
import { formatMonthLong } from "./budgetViewHelpers.js";
import { Icon, Tooltip, cx } from "@ynab/theme";

/** Per-month Quick Budget ··· menu (ui-split slice 3). Opens beside the
 * month header, flipping left when the scroll container has no room on
 * the right. Closes on outside pointer-down, Escape, or resize. Focus
 * moves into the menu on open, Tab wraps inside it, and close returns
 * focus to the trigger unless focus already moved elsewhere (a11y slice 2). */
export function MonthQuickBudget({
  month,
  values,
  selectedCategory,
  onClearSelectedCategory,
  onQuickBudget,
  open,
  onOpen,
  onClose,
}: {
  month: string;
  values?: { lastMonth: number; spentLastMonth: number; avgBudgeted: number };
  selectedCategory?: { id: number; name: string } | null;
  onClearSelectedCategory?: () => void;
  onQuickBudget: (type: QuickBudgetType, categoryId?: number, month?: string) => void;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const wasOpenRef = useRef(false);
  const [place, setPlace] = useState<"left" | "right">("right");

  // Pick the side with room: the 240px menu opens beside the month header,
  // flipping left when there is no room on the right. Room is measured
  // inside the nearest scrolling ancestor (the budget table's scroll
  // container, minus its scrollbar) — not the window — since that is what
  // actually clips the menu.
  const resolvePlace = useCallback(() => {
    const el = btnRef.current;
    if (!el || typeof window === "undefined") return;
    const rect = el.getBoundingClientRect();
    let clipLeft = 0;
    let clipRight = window.innerWidth;
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX || "") || /(auto|scroll)/.test(style.overflow || "")) {
        const r = node.getBoundingClientRect();
        const scrollbar = Math.max(0, r.width - node.clientWidth);
        clipLeft = r.left;
        clipRight = r.right - scrollbar;
        break;
      }
      node = node.parentElement;
    }
    const need = 248; // 240px menu + 6px gap + margin
    const spaceRight = clipRight - rect.right;
    const spaceLeft = rect.left - clipLeft;
    setPlace(spaceRight >= need || spaceRight >= spaceLeft ? "right" : "left");
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", resolvePlace);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", resolvePlace);
    };
  }, [open, onClose, resolvePlace]);

  // Focus management (a11y slice 2): move focus into the menu on open so
  // keyboard users land on the choices; on close, return it to the trigger
  // unless focus already moved elsewhere (an outside pointer interaction).
  useEffect(() => {
    if (open === wasOpenRef.current) return;
    wasOpenRef.current = open;
    if (open) {
      menuRef.current
        ?.querySelector<HTMLElement>("button:not([disabled])")
        ?.focus();
    } else {
      const active = document.activeElement;
      if (active == null || active === document.body || wrapRef.current?.contains(active)) {
        btnRef.current?.focus();
      }
    }
  }, [open ]);

  // Tab trap (a11y slice 2): wrap focus at both menu ends. Other keys pass
  // through untouched (Escape is handled at document level).
  const handleMenuKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const label = formatMonthLong(month);
  const lastMonth = values?.lastMonth ?? 0;
  const spentLastMonth = values?.spentLastMonth ?? 0;
  const avgBudgeted = values?.avgBudgeted ?? 0;

  const choose = (type: QuickBudgetType) => {
    onQuickBudget(type, selectedCategory?.id, month);
    onClose();
  };

  return (
    <span ref={wrapRef} className={cx("y-month-qb", open && "is-open")}>
      <Tooltip tip={`Quick Budget — ${label}`}>
        <button
          ref={btnRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (open) onClose();
            else {
              resolvePlace();
              onOpen();
            }
          }}
          aria-label={`Quick budget options for ${label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid={`quick-budget-trigger-${month}`}
          className="y-month-qb-btn"
        >
          <Icon name="dots" size={12} />
        </button>
      </Tooltip>
      {open && (
        <span
          ref={menuRef}
          role="menu"
          aria-label={`Quick Budget for ${label}`}
          onKeyDown={handleMenuKeyDown}
          data-testid={`quick-budget-menu-${month}`}
          className={`y-dropdown y-month-qb-menu ${place === "left" ? "is-left" : "is-right"}`}
        >
          <span className="y-dropdown-group y-month-qb-scope">
            <span className="y-month-qb-scope-name">
              {selectedCategory ? selectedCategory.name : "Entire Budget"}
            </span>
            {selectedCategory && onClearSelectedCategory && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearSelectedCategory();
                }}
                className="y-month-qb-scope-clear"
                data-testid={`quick-budget-deselect-${month}`}
              >
                Entire Budget
              </button>
            )}
          </span>
          <Tooltip tip="Set budgeted amounts to last month's values" className="w-full">
            <button
              type="button"
              role="menuitem"
              onClick={() => choose("lastMonth")}
              className="y-dropdown-item y-month-qb-item"
              data-testid={`quick-budget-last-month-${month}`}
            >
              <span className="y-dropdown-item-label">Budgeted Last Month</span>
              <span className="y-num">{fmt(lastMonth)}</span>
            </button>
          </Tooltip>
          <Tooltip tip="Set budgeted amounts to what was spent last month" className="w-full">
            <button
              type="button"
              role="menuitem"
              onClick={() => choose("spentLastMonth")}
              className="y-dropdown-item y-month-qb-item"
              data-testid={`quick-budget-spent-last-month-${month}`}
            >
              <span className="y-dropdown-item-label">Spent Last Month</span>
              <span className="y-num">{fmt(spentLastMonth)}</span>
            </button>
          </Tooltip>
          <Tooltip tip="Set budgeted amounts to average budgeted over last 3 months" className="w-full">
            <button
              type="button"
              role="menuitem"
              onClick={() => choose("avgBudgeted")}
              className="y-dropdown-item y-month-qb-item"
              data-testid={`quick-budget-avg-budgeted-${month}`}
            >
              <span className="y-dropdown-item-label">Average Budgeted</span>
              <span className="y-num">{fmt(avgBudgeted)}</span>
            </button>
          </Tooltip>
          <Tooltip tip="Clear budgeted amounts to $0.00" className="w-full">
            <button
              type="button"
              role="menuitem"
              onClick={() => choose("clear")}
              className="y-dropdown-item y-month-qb-item"
              data-testid={`quick-budget-clear-${month}`}
            >
              <span className="y-dropdown-item-label">Set to Zero</span>
              <span className="y-num">$0.00</span>
            </button>
          </Tooltip>
        </span>
      )}
    </span>
  );
}
