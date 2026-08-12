"use client";

import { useState, useRef, useEffect } from "react";
import type { GroupRow, CatRow, BudgetResult } from "@ynab/logic";
import { evalAmount, fmt, MONTHS, MONTHS_LONG, parseMonthKey, monthKey, todayISO } from "@ynab/logic";
import {
  Icon,
  MonthNav,
  Button,
  Toolbar,
  ToolbarSep,
  cx,
} from "@ynab/theme";
import type { BudgetHeaderPart } from "@ynab/theme";

/* ------------------------------------------------------------ helpers */

function formatMonthLong(monthKey: string): string {
  const { month0, year } = parseMonthKey(monthKey);
  return `${MONTHS[month0] ?? ""} ${year}`;
}

/**
 * The semantic color of a balance figure. Plain text color only — never a
 * pill, never a background tint, never an icon. The number is the data;
 * color is the meaning.
 */
function balanceColor(n: number): string {
  if (n > 0) return "var(--y-green-dk)";
  if (n < 0) return "var(--y-red)";
  return "var(--y-ink-faint)";
}

function isEmptyRow(r: CatRow): boolean {
  return r.assigned === 0 && r.outflow === 0 && r.available === 0;
}

const COL_A = "w-[120px]";
const COL_O = "w-[120px]";
const COL_V = "w-[120px]";

/* ------------------------------------------------------------ props */

export function BudgetView({
  budget,
  currentMonth,
  collapsed,
  onToggleGroup,
  onAssign,
  onShiftMonth,
  onSetMonth,
  minYear,
  maxYear,
  onAddCategory,
  onAddGroup,
  onEditCategory,
  onDeleteCategory,
  onEditGroup,
  onDeleteGroup,
  onCollapseAll,
  onExpandAll,
  onReorderCategory,
  onReorderGroup,
  onClearOverdraft,
}: {
  budget: BudgetResult;
  currentMonth: string;
  collapsed: Record<number, boolean>;
  onToggleGroup: (id: number) => void;
  onAssign: (catId: number, amount: number, month: string) => void;
  onShiftMonth: (delta: number) => void;
  onSetMonth?: (key: string) => void;
  minYear?: number;
  maxYear?: number;
  onAddCategory: (groupId: number) => void;
  onAddGroup: () => void;
  onEditCategory: (catId: number) => void;
  onDeleteCategory: (catId: number) => void;
  onEditGroup: (groupId: number) => void;
  onDeleteGroup: (groupId: number) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onReorderCategory?: (id: number, sort: number) => void;
  onReorderGroup?: (id: number, sort: number) => void;
  onClearOverdraft?: (categoryIds: number[]) => Promise<void> | void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const dragGroupId = useRef<number | null>(null);
  const [groupOverId, setGroupOverId] = useState<number | null>(null);

  const handleGroupDrop = (targetId: number) => {
    const srcId = dragGroupId.current;
    if (srcId == null || srcId === targetId || !onReorderGroup) return;
    const structureGroups = budget.groups.filter((g) => !g.group.isCreditCardPayments);
    const srcIdx = structureGroups.findIndex((g) => g.group.id === srcId);
    const tgtIdx = structureGroups.findIndex((g) => g.group.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;

    const reordered = [...structureGroups];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved!);
    reordered.forEach((g, i) => {
      if (g.group.sort !== i) onReorderGroup(g.group.id, i);
    });
    dragGroupId.current = null;
    setGroupOverId(null);
  };

  const structureGroups = budget.groups.filter((g) => !g.group.isCreditCardPayments);
  const creditGroup = budget.groups.find((g) => g.group.isCreditCardPayments);

  const headerParts: BudgetHeaderPart[] = [
    {
      label: `Not Budgeted in ${formatMonthLong(previousMonthKey(currentMonth))}`,
      value: budget.priorSurplus,
    },
    {
      label: "Overspent in Previous",
      value: Math.max(
        0,
        budget.groups
          .filter((g) => !g.group.isCreditCardPayments)
          .reduce((s, g) => s + (g.available < 0 ? -g.available : 0), 0) -
          budget.priorSurplus
      ),
    },
    { label: `Income for ${formatMonthLong(currentMonth)}`, value: budget.totalIncome },
    { label: `Budgeted in ${formatMonthLong(currentMonth)}`, value: budget.totalAssigned },
  ];

  const todayMonth = todayISO().slice(0, 7);
  const isOnThisMonth = currentMonth === todayMonth;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <MonthNav
          month={currentMonth}
          onPrev={() => onShiftMonth(-1)}
          onNext={() => onShiftMonth(1)}
          onSetMonth={onSetMonth}
          minYear={minYear}
          maxYear={maxYear}
        />
        {!isOnThisMonth && onSetMonth && (
          <Button size="sm" variant="flat" onClick={() => onSetMonth(todayMonth)}>
            <Icon name="calendar" size={11} /> Today
          </Button>
        )}
        <ToolbarSep />
        <Button onClick={onAddGroup} size="sm">
          <Icon name="plus" size={11} /> Master Category
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative" ref={menuRef}>
            <Button
              onClick={() => setMenuOpen((o) => !o)}
              size="sm"
              aria-label="Group options"
            >
              <Icon name="dots" size={14} />
            </Button>
            {menuOpen && (
              <div
                className="absolute right-0 top-[28px] z-20 min-w-[180px] overflow-hidden"
                style={{
                  background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
                  border: "1px solid var(--y-chrome-line)",
                  borderRadius: 4,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
                  padding: 4,
                }}
              >
                <button
                  onClick={() => {
                    onCollapseAll();
                    setMenuOpen(false);
                  }}
                  className="y-menu-item"
                >
                  Collapse all groups
                </button>
                <button
                  onClick={() => {
                    onExpandAll();
                    setMenuOpen(false);
                  }}
                  className="y-menu-item"
                >
                  Expand all groups
                </button>
              </div>
            )}
          </div>
        </div>
      </Toolbar>

      <HeroBudgetStrip parts={headerParts} atb={budget.tbb} />

      {budget.overBudgeted && onClearOverdraft && (
        <div
          className="px-3 py-1.5 flex items-center gap-2"
          style={{
            background: "var(--y-red-pale)",
            borderBottom: "1px solid var(--y-border-strong)",
          }}
        >
          <span className="text-[11.5px]" style={{ color: "var(--y-red-dk)" }}>
            You've overbudgeted by{" "}
            <strong className="y-num">{fmt(Math.abs(budget.tbb))}</strong> this month.
          </span>
          <Button
            onClick={() =>
              onClearOverdraft(
                budget.groups
                  .flatMap((g) => g.rows)
                  .filter((r) => r.available < 0)
                  .map((r) => r.category.id)
              )
            }
            size="sm"
            variant="danger"
            className="ml-auto"
          >
            Zero out overdrafts
          </Button>
        </div>
      )}

      <MonthStrip currentMonth={currentMonth} onSetMonth={onSetMonth} />

      <div className="flex-1 overflow-y-auto overflow-x-hidden y-scroll">
        <table className="y-table">
          <thead className="y-thead y-thead--sticky">
            <tr>
              <th style={{ width: 26 }} />
              <th>Category</th>
              <th className={`num ${COL_A}`}>Budgeted</th>
              <th className={`num ${COL_O}`}>Outflows</th>
              <th className={`num ${COL_V}`}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {structureGroups.map((g) => (
              <GroupBlock
                key={g.group.id}
                group={g}
                collapsed={!!collapsed[g.group.id]}
                onToggle={() => onToggleGroup(g.group.id)}
                onAssign={onAssign}
                currentMonth={currentMonth}
                onAddCategory={() => onAddCategory(g.group.id)}
                onEditCategory={() => onEditCategory(g.group.id)}
                onDeleteCategory={onDeleteCategory}
                onEditGroup={() => onEditGroup(g.group.id)}
                onDeleteGroup={onDeleteGroup}
                onReorderCategory={onReorderCategory}
                isDragOver={groupOverId === g.group.id}
                onDragStart={() => {
                  dragGroupId.current = g.group.id;
                }}
                onDragOver={() => setGroupOverId(g.group.id)}
                onDragLeave={() => setGroupOverId(null)}
                onDrop={() => handleGroupDrop(g.group.id)}
              />
            ))}
            {creditGroup && (
              <GroupBlock
                group={creditGroup}
                collapsed={!!collapsed[creditGroup.group.id]}
                onToggle={() => onToggleGroup(creditGroup.group.id)}
                onAssign={onAssign}
                currentMonth={currentMonth}
                onAddCategory={() => onAddCategory(creditGroup.group.id)}
                onEditCategory={() => onEditCategory(creditGroup.group.id)}
                onDeleteCategory={onDeleteCategory}
                onEditGroup={() => onEditGroup(creditGroup.group.id)}
                onDeleteGroup={onDeleteGroup}
                onReorderCategory={onReorderCategory}
              />
            )}
          </tbody>
        </table>

        <button
          onClick={onAddGroup}
          className="y-menu-item gap-2 px-3 py-2 text-[11.5px]"
        >
          <Icon name="plus" size={11} /> Add Category Group
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ hero strip */

function HeroBudgetStrip({ parts, atb }: { parts: BudgetHeaderPart[]; atb: number }) {
  const tone = atb > 0 ? "green" : atb < 0 ? "red" : "orange";
  const opSymbols = ["+", "+", "+", "−"];
  return (
    <div
      className="y-budget-header flex items-center gap-3 px-3 py-3 flex-wrap"
      style={{ borderBottom: "1px solid var(--y-border-strong)" }}
    >
      {parts.map((p, i) => (
        <div key={i} className="flex items-center gap-3">
          {i > 0 && <span className="y-math-op">{opSymbols[i - 1] ?? "+"}</span>}
          <div className="y-mathbox">
            <div className="y-math-label">{p.label}</div>
            <div className="y-math-val">{fmt(p.value)}</div>
          </div>
        </div>
      ))}
      <span className="y-math-op">=</span>
      <div
        className={cx("y-atb", `y-atb--${tone}`)}
        style={{ minWidth: 168, padding: "9px 22px" }}
        role="status"
        aria-label="Available to Budget"
      >
        <div className="text-[26px] font-extrabold leading-[1.05] y-num tracking-tight">
          {fmt(atb)}
        </div>
        <div className="text-[9.5px] font-bold tracking-[.11em] uppercase opacity-95 mt-[2px]">
          Available to Budget
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ month strip */

function MonthStrip({
  currentMonth,
  onSetMonth,
}: {
  currentMonth: string;
  onSetMonth?: (key: string) => void;
}) {
  const { year, month0 } = parseMonthKey(currentMonth);
  const total = year * 12 + month0;
  const today = todayISO().slice(0, 7);
  const range = 12;

  if (!onSetMonth) return null;

  return (
    <div
      className="y-month-strip flex items-center justify-center gap-1 px-3 py-1.5"
      style={{
        background: "linear-gradient(#fafaf7, #efefec)",
        borderBottom: "1px solid var(--y-line)",
      }}
    >
      {Array.from({ length: range * 2 + 1 }, (_, i) => i - range).map((delta) => {
        const m = total + delta;
        const yy = Math.floor(m / 12);
        const mm = ((m % 12) + 12) % 12;
        const key = monthKey(yy, mm);
        const isActive = key === currentMonth;
        const isToday = key === today;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSetMonth(key)}
            aria-current={isActive ? "true" : undefined}
            aria-label={MONTHS_LONG[mm] ? `${MONTHS_LONG[mm]} ${yy}` : key}
            className={cx(
              "y-month-strip-btn relative flex items-baseline gap-[2px] px-2 py-[3px] rounded-[3px] text-[11px] leading-none",
              isActive ? "is-active" : "is-inactive"
            )}
            style={
              isActive
                ? {
                    background: "var(--y-master)",
                    color: "var(--y-ink)",
                    fontWeight: 700,
                    boxShadow: "0 1px 0 rgba(255,255,255,.6) inset, 0 1px 2px rgba(0,0,0,.08)",
                  }
                : {
                    color: "var(--y-ink-soft)",
                    border: "1px solid transparent",
                  }
            }
            title={`${MONTHS[mm]} ${yy}`}
          >
            <span className="font-bold">{MONTHS[mm]}</span>
            <span
              className="text-[9px] tracking-tight"
              style={{ color: "var(--y-ink-faint)" }}
            >
              '{String(yy).slice(2)}
            </span>
            {isToday && !isActive && (
              <span
                className="absolute -bottom-[3px] left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full"
                style={{ background: "var(--y-blue)" }}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ group block */

function GroupBlock({
  group,
  collapsed,
  onToggle,
  onAssign,
  currentMonth,
  onAddCategory,
  onEditCategory,
  onDeleteCategory,
  onEditGroup,
  onDeleteGroup,
  onReorderCategory,
  isDragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  group: GroupRow;
  collapsed: boolean;
  onToggle: () => void;
  onAssign: (catId: number, amount: number, month: string) => void;
  currentMonth: string;
  onAddCategory: () => void;
  onEditCategory: () => void;
  onDeleteCategory: (catId: number) => void;
  onEditGroup: () => void;
  onDeleteGroup: (groupId: number) => void;
  onReorderCategory?: (id: number, sort: number) => void;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
}) {
  const dragCatId = useRef<number | null>(null);
  const [catOverId, setCatOverId] = useState<number | null>(null);

  const gRow = group;

  return (
    <>
      <tr
        className="y-master"
        draggable
        style={{
          outline: isDragOver ? "2px solid var(--y-blue)" : "none",
          outlineOffset: "-2px",
        }}
        onDragStart={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("[data-cat-row]")) {
            e.stopPropagation();
            return;
          }
          e.dataTransfer.effectAllowed = "move";
          onDragStart?.();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onDragOver?.();
        }}
        onDragLeave={onDragLeave}
        onDrop={(e) => {
          e.preventDefault();
          onDrop?.();
        }}
      >
        <td className="text-center" style={{ width: 26 }}>
          <span
            className="inline-block cursor-grab"
            style={{ color: "var(--y-ink-faint)" }}
            title="Drag to reorder"
          >
            <Icon name="grip" size={13} />
          </span>
        </td>
        <td>
          <div className="flex items-center gap-[7px]">
            <button onClick={onToggle} className="flex items-center gap-[6px]">
              <span className={cx("y-tri", !collapsed && "is-open")} />
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditGroup();
                }}
                className="cursor-text hover:underline"
                style={{ color: "var(--y-ink)", fontSize: "12.5px" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onEditGroup();
                }}
              >
                {group.group.name}
              </span>
            </button>
            <button
              onClick={() => onAddCategory()}
              className="ml-1 grid h-[18px] w-[18px] place-items-center rounded"
              style={{ color: "var(--y-ink-soft)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--y-master-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              aria-label="Add category"
              title="Add category"
            >
              <Icon name="plus" size={11} />
            </button>
          </div>
        </td>
        <td className="num y-num text-right">{fmt(gRow.assigned)}</td>
        <td
          className="num y-num text-right"
          style={{ color: gRow.outflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)" }}
        >
          {fmt(gRow.outflow)}
        </td>
        <td className="num y-num text-right" style={{ color: balanceColor(gRow.available) }}>
          {fmt(gRow.available)}
        </td>
      </tr>

      {!collapsed &&
        group.rows.map((r: CatRow, i: number) => {
          const empty = isEmptyRow(r);
          return (
            <tr
              key={r.category.id}
              data-cat-row
              className={cx("y-row", i % 2 === 1 && "alt", empty && "is-empty")}
              style={{
                borderTop: catOverId === r.category.id ? "2px solid var(--y-blue)" : undefined,
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                setCatOverId(r.category.id);
              }}
              onDragLeave={(e) => {
                e.stopPropagation();
                setCatOverId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const srcId = dragCatId.current;
                if (srcId == null || srcId === r.category.id || !onReorderCategory) return;
                const srcIdx = group.rows.findIndex((x) => x.category.id === srcId);
                const tgtIdx = group.rows.findIndex((x) => x.category.id === r.category.id);
                if (srcIdx === -1 || tgtIdx === -1) return;
                const reordered = [...group.rows];
                const [moved] = reordered.splice(srcIdx, 1);
                reordered.splice(tgtIdx, 0, moved!);
                reordered.forEach((row, i) => {
                  if (row.category.sort !== i) onReorderCategory(row.category.id, i);
                });
                dragCatId.current = null;
                setCatOverId(null);
              }}
            >
              <td className="text-center" style={{ width: 26 }}>
                <span
                  className="inline-block cursor-grab"
                  style={{ color: "var(--y-ink-faint)" }}
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.effectAllowed = "move";
                    dragCatId.current = r.category.id;
                  }}
                  title="Drag to reorder"
                >
                  <Icon name="grip" size={13} />
                </span>
              </td>
              <td className="pl-[26px]">
                <div className="group/row flex items-center">
                  <span className="truncate">{r.category.name}</span>
                  <span className="ml-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
                    <button
                      onClick={onEditCategory}
                      className="grid h-[18px] w-[18px] place-items-center rounded"
                      style={{ color: "var(--y-ink-soft)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--y-row-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      aria-label={`Edit ${r.category.name}`}
                      title="Edit category"
                    >
                      <Icon name="edit" size={11} />
                    </button>
                  </span>
                </div>
              </td>
              <td className="num">
                <CategoryMonthCell
                  value={r.assigned}
                  onAssign={(val) => onAssign(r.category.id, val, currentMonth)}
                />
              </td>
              <td
                className="num y-num"
                style={{
                  color: r.outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)",
                }}
              >
                {fmt(r.outflow)}
              </td>
              <td className="num y-num" style={{ color: balanceColor(r.available) }}>
                {fmt(r.available)}
              </td>
            </tr>
          );
        })}
    </>
  );
}

/* ------------------------------------------------------------ inline amount cell */

function CategoryMonthCell({
  value,
  onAssign,
}: {
  value: number;
  onAssign: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const v = evalAmount(draft);
    if (v != null) onAssign(v);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        title={(() => {
          const n = evalAmount(draft);
          if (n == null || !Number.isFinite(n)) return undefined;
          if (!/[+\-*/]/.test(draft.replace(/^[+-]/, ""))) return undefined;
          return `= $${n.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`;
        })()}
        className="y-inline-amt"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value.toFixed(2));
        setEditing(true);
      }}
      className="y-inline-amt cursor-text"
      style={{ color: "var(--y-ink)" }}
    >
      {fmt(value)}
    </button>
  );
}

/* ------------------------------------------------------------ */

function previousMonthKey(monthKeyStr: string): string {
  const { year, month0 } = parseMonthKey(monthKeyStr);
  const idx = year * 12 + month0 - 1;
  const yy = Math.floor(idx / 12);
  const mm = idx - yy * 12;
  return monthKey(yy, mm);
}
