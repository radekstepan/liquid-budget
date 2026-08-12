"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import type { GroupRow, Account, CatRow, BudgetResult } from "@ynab/logic";
import { evalAmount, fmt, MONTHS, parseMonthKey } from "@ynab/logic";
import {
  Icon,
  MonthNav,
  BudgetHeader,
  Button,
  Toolbar,
  ToolbarSep,
  Pill,
  balanceTone,
  cx,
  money,
} from "@ynab/theme";
import type { BudgetHeaderPart } from "@ynab/theme";
import { useElementSize } from "./chartUtils.js";

const COL_A = "w-[110px]";
const COL_O = "w-[110px]";
const COL_V = "w-[120px]";
const MONTH_BLOCK_PX = 340;

/** Pre-rendered budget for one month; rendered side-by-side in BudgetView. */
export type MonthBudget = {
  month: string;
  result: BudgetResult;
};

function formatMonthLong(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ""} ${y ?? ""}`;
}

/** Compact "Jun '26" label for the table header month strip. */
function formatMonthShort(monthKey: string): string {
  const { month0, year } = parseMonthKey(monthKey);
  return `${MONTHS[month0]?.slice(0, 3) ?? ""} '${String(year).slice(2)}`;
}

function previousMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const idx = (y ?? 2024) * 12 + (m ?? 1) - 2;
  const yy = Math.floor(idx / 12);
  const mm = idx - yy * 12 + 1;
  return `${yy}-${String(mm).padStart(2, "0")}`;
}

export function BudgetView({
  budget,
  currentMonth,
  visibleBudgets,
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
  /** Pre-computed budgets for up to 4 months ending at `currentMonth`. */
  visibleBudgets: MonthBudget[];
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
  const { ref, size } = useElementSize<HTMLDivElement>();
  const visibleCount = Math.max(1, Math.floor(size.width / MONTH_BLOCK_PX));
  const visible = visibleBudgets.slice(-visibleCount);

  // Use the latest visible month's structure for category ordering (categories
  // are static across months). Fall back to the anchor month's structure.
  const anchorResult = visible.length > 0 ? visible[visible.length - 1]!.result : budget;
  const structureGroups = anchorResult.groups;
  const creditGroup = structureGroups.find((g) => g.group.isCreditCardPayments);

  // Lookup: catId -> month -> CatRow. Built once per render so each row can
  // pull its per-month values in O(1) instead of scanning all groups.
  const catByMonth = useMemo(() => {
    const m = new Map<number, Map<string, CatRow>>();
    for (const { month, result } of visibleBudgets) {
      for (const g of result.groups) {
        for (const r of g.rows) {
          let inner = m.get(r.category.id);
          if (!inner) {
            inner = new Map();
            m.set(r.category.id, inner);
          }
          inner.set(month, r);
        }
      }
    }
    return m;
  }, [visibleBudgets]);

  // Same lookup but for group totals (assigned/outflow/available per month).
  const groupByMonth = useMemo(() => {
    const m = new Map<number, Map<string, GroupRow>>();
    for (const { month, result } of visibleBudgets) {
      for (const g of result.groups) {
        let inner = m.get(g.group.id);
        if (!inner) {
          inner = new Map();
          m.set(g.group.id, inner);
        }
        inner.set(month, g);
      }
    }
    return m;
  }, [visibleBudgets]);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown when user clicks outside
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
    const nonCC = structureGroups.filter((g) => !g.group.isCreditCardPayments);
    const srcIdx = nonCC.findIndex((g) => g.group.id === srcId);
    const tgtIdx = nonCC.findIndex((g) => g.group.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;

    const reordered = [...nonCC];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved!);
    reordered.forEach((g, i) => {
      if (g.group.sort !== i) onReorderGroup(g.group.id, i);
    });
    dragGroupId.current = null;
    setGroupOverId(null);
  };

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

      <BudgetHeader
        parts={headerParts}
        ops={["+", "+", "+", "−"]}
        atb={budget.tbb}
      />

      {budget.overBudgeted && onClearOverdraft && (
        <div className="px-3 py-2 flex items-center gap-2" style={{ background: "var(--y-red-pale)", borderBottom: "1px solid var(--y-border-strong)" }}>
          <span className="text-[11.5px]" style={{ color: "var(--y-red-dk)" }}>
            You've overbudgeted by <strong className="y-num">{money(Math.abs(budget.tbb))}</strong> this month.
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

      <div ref={ref} className="flex-1 overflow-y-auto overflow-x-hidden y-scroll">
        <table className="y-table">
          <thead className="y-thead">
            <tr>
              <th rowSpan={2} style={{ width: 26 }} />
              <th rowSpan={2}>Category</th>
              {visible.map(({ month }) => (
                <th
                  key={month}
                  colSpan={3}
                  className="text-center"
                  style={{ borderLeft: "1px solid #cbcbc6" }}
                >
                  {formatMonthShort(month)}
                  {month === currentMonth && (
                    <span style={{ color: "var(--y-blue-dark)", marginLeft: 4 }}>•</span>
                  )}
                </th>
              ))}
            </tr>
            <tr>
              {visible.flatMap(({ month }) => [
                <th key={`${month}-a`} className={`num ${COL_A}`}>Budgeted</th>,
                <th key={`${month}-o`} className={`num ${COL_O}`}>Outflows</th>,
                <th key={`${month}-v`} className={`num ${COL_V}`}>Balance</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {structureGroups
              .filter((g) => !g.group.isCreditCardPayments)
              .map((g) => (
                <GroupBlock
                  key={g.group.id}
                  group={g}
                  visible={visible}
                  groupByMonth={groupByMonth}
                  catByMonth={catByMonth}
                  collapsed={!!collapsed[g.group.id]}
                  onToggle={() => onToggleGroup(g.group.id)}
                  onAssign={onAssign}
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
                visible={visible}
                groupByMonth={groupByMonth}
                catByMonth={catByMonth}
                collapsed={!!collapsed[creditGroup.group.id]}
                onToggle={() => onToggleGroup(creditGroup.group.id)}
                onAssign={onAssign}
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

function GroupBlock({
  group,
  visible,
  groupByMonth,
  catByMonth,
  collapsed,
  onToggle,
  onAssign,
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
  visible: MonthBudget[];
  groupByMonth: Map<number, Map<string, GroupRow>>;
  catByMonth: Map<number, Map<string, CatRow>>;
  collapsed: boolean;
  onToggle: () => void;
  onAssign: (catId: number, amount: number, month: string) => void;
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

  // For each visible month, look up the group's totals row.
  const monthGroupRows = visible.map(({ month }) => groupByMonth.get(group.group.id)?.get(month));

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
          <span className="inline-block cursor-grab" style={{ color: "var(--y-ink-faint)" }} title="Drag to reorder">
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
        {monthGroupRows.map((gRow, idx) => {
          const a = gRow?.assigned ?? 0;
          const o = gRow?.outflow ?? 0;
          const v = gRow?.available ?? 0;
          const month = visible[idx]!.month;
          return [
            <td key={`${month}-a`} className="num y-num text-right">{fmt(a)}</td>,
            <td key={`${month}-o`} className="num y-num text-right" style={{ color: o < 0 ? "var(--y-ink)" : "var(--y-ink-soft)" }}>
              {fmt(o)}
            </td>,
            <td key={`${month}-v`} className="num y-num text-right" style={{ color: v < 0 ? "var(--y-red)" : "var(--y-ink)" }}>
              {fmt(v)}
            </td>,
          ];
        })}
      </tr>

      {!collapsed &&
        group.rows.map((r: CatRow, i: number) => {
          const monthCells = visible.map(({ month }) => {
            const monthRow = catByMonth.get(r.category.id)?.get(month);
            const a = monthRow?.assigned ?? 0;
            const o = monthRow?.outflow ?? 0;
            const v = monthRow?.available ?? 0;
            return { month, a, o, v };
          });
          return (
            <tr
              key={r.category.id}
              data-cat-row
              className={cx("y-row", i % 2 === 1 && "alt")}
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
              {monthCells.map(({ month, a, o, v }) => (
                <FragmentRow
                  key={month}
                  month={month}
                  assigned={a}
                  outflow={o}
                  available={v}
                  onAssign={(val) => onAssign(r.category.id, val, month)}
                />
              ))}
            </tr>
          );
        })}
    </>
  );
}

function FragmentRow({
  month,
  assigned,
  outflow,
  available,
  onAssign,
}: {
  month: string;
  assigned: number;
  outflow: number;
  available: number;
  onAssign: (v: number) => void;
}) {
  return (
    <>
      <td className="num">
        <CategoryMonthCell value={assigned} onAssign={onAssign} />
      </td>
      <td className="num y-num" style={{ color: outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)" }}>
        {fmt(outflow)}
      </td>
      <td className="num">
        <Pill tone={balanceTone(available)} style={{ minWidth: 72 }}>
          {fmt(available)}
        </Pill>
      </td>
    </>
  );
}

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
          return `= $${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
