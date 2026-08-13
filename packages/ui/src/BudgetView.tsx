"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import type { GroupRow, CatRow, BudgetResult } from "@ynab/logic";
import { evalAmount, fmt, MONTHS, parseMonthKey, monthKey, todayISO } from "@ynab/logic";
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
  budgets,
  visibleMonths,
  monthCount,
  onSetMonthCount,
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
  budgets: BudgetResult[];
  visibleMonths: string[];
  monthCount: number;
  onSetMonthCount?: (n: number) => void;
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
  const showMulti = monthCount > 1;

  const resolvedVisibleMonths = visibleMonths && visibleMonths.length ? visibleMonths : [currentMonth];
  const resolvedBudgets = budgets && budgets.length ? budgets : [budget];
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

  // For each visible month, find the matching GroupRow by id.
  const groupsByMonth = useMemo(() => {
    return resolvedBudgets.map((b) => {
      const m = new Map<number, GroupRow>();
      for (const g of b.groups) m.set(g.group.id, g);
      return m;
    });
  }, [resolvedBudgets]);

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
        {onSetMonthCount && (
          <MonthCountControl
            value={monthCount}
            onChange={onSetMonthCount}
          />
        )}
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

      <div className="flex-1 overflow-auto y-scroll">
        <table className="y-table">
          <thead className="y-thead y-thead--sticky">
            {showMulti ? (
              <>
                <tr>
                  <th rowSpan={2} style={{ width: 26 }} />
                  <th rowSpan={2} className="y-table-td--sticky-cat">Category</th>
                    {resolvedVisibleMonths.map((m, idx) => (
                    <th
                      key={m}
                      colSpan={3}
                      className={cx(
                        "y-table-th--month-label",
                        idx > 0 && "y-table-colgroup-divider"
                      )}
                    >
                      {formatMonthLong(m)}
                    </th>
                  ))}
                </tr>
                <tr>
                  {resolvedVisibleMonths.map((m, idx) => (
                    <th
                      key={m}
                      colSpan={3}
                      className={cx(
                        idx === 0 && "y-table-cell--month-first",
                        idx > 0 && "y-table-colgroup-divider"
                      )}
                    >
                      <span className="flex justify-around text-[10.5px] font-normal">
                        <span>Budgeted</span>
                        <span>Outflows</span>
                        <span>Balance</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </>
            ) : (
              <tr>
                <th style={{ width: 26 }} />
                <th className="y-table-td--sticky-cat">Category</th>
                <th className={`num ${COL_A}`}>Budgeted</th>
                <th className={`num ${COL_O}`}>Outflows</th>
                <th className={`num ${COL_V}`}>Balance</th>
              </tr>
            )}
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
                visibleMonths={resolvedVisibleMonths}
                groupsByMonth={groupsByMonth}
                showMulti={showMulti}
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
                visibleMonths={resolvedVisibleMonths}
                groupsByMonth={groupsByMonth}
                showMulti={showMulti}
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

/* ------------------------------------------------------------ month-count control */

function MonthCountControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const options = [1, 3, 6, 12];
  return (
    <div
      className="flex items-center overflow-hidden"
      role="group"
      aria-label="Months shown"
      style={{
        border: "1px solid var(--y-chrome-line)",
        borderRadius: 3,
        background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
      }}
    >
      {options.map((n, i) => {
        const active = n === value;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={active}
            aria-label={`${n} month${n === 1 ? "" : "s"}`}
            className={cx(
              "px-2 py-[3px] text-[11px] leading-none",
              i > 0 && "y-table-colgroup-divider"
            )}
            style={{
              border: 0,
              borderLeft: i > 0 ? "1px solid var(--y-chrome-line)" : "none",
              background: active ? "var(--y-master)" : "transparent",
              color: active ? "var(--y-ink)" : "var(--y-ink-soft)",
              fontWeight: active ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {n}
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
  visibleMonths,
  groupsByMonth,
  showMulti,
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
  visibleMonths: string[];
  groupsByMonth: Map<number, GroupRow>[];
  showMulti: boolean;
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
        <td className="y-table-td--sticky-cat">
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
        {showMulti ? (
          visibleMonths.map((m, idx) => {
            const mg = groupsByMonth[idx]?.get(group.group.id);
            return (
              <MonthCells
                key={m}
                group={mg ?? gRow}
                isOtherMonth={m !== currentMonth}
                isFirstMonth={idx === 0}
                isRowForGroup
              />
            );
          })
        ) : (
          <>
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
          </>
        )}
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
              <td className="y-table-td--sticky-cat pl-[26px]">
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
              {showMulti
                ? visibleMonths.map((m, idx) => {
                    const mg = groupsByMonth[idx]?.get(group.group.id);
                    const row = mg?.rows.find((x) => x.category.id === r.category.id);
                    return (
                      <MonthCells
                        key={m}
                        row={row ?? r}
                        isOtherMonth={m !== currentMonth}
                        isFirstMonth={idx === 0}
                        onAssign={(val) => onAssign(r.category.id, val, m)}
                      />
                    );
                  })
                : (
                  <>
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
                  </>
                )}
            </tr>
          );
        })}
    </>
  );
}

/* ------------------------------------------------------------ month cells */

function MonthCells({
  group,
  row,
  isOtherMonth,
  isFirstMonth,
  isRowForGroup,
  onAssign,
}: {
  group?: GroupRow;
  row?: CatRow;
  isOtherMonth: boolean;
  isFirstMonth: boolean;
  isRowForGroup?: boolean;
  onAssign?: (val: number) => void;
}) {
  const divCls = isFirstMonth ? "" : "y-table-colgroup-divider";
  const readOnlyCls = isOtherMonth ? "y-table-cell--readonly" : "";

  if (isRowForGroup && group) {
    return (
      <>
        <td className={`num y-num text-right ${divCls} ${readOnlyCls}`}>
          {fmt(group.assigned)}
        </td>
        <td
          className={`num y-num text-right ${readOnlyCls}`}
          style={{
            color: !isOtherMonth && group.outflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)",
          }}
        >
          {fmt(group.outflow)}
        </td>
        <td className="num y-num text-right" style={{ color: balanceColor(group.available) }}>
          {fmt(group.available)}
        </td>
      </>
    );
  }

  if (!row) return <td colSpan={3} className={divCls} />;

  return (
    <>
      <td className={`num ${divCls} ${readOnlyCls}`}>
        {isOtherMonth || !onAssign ? (
          <span className="y-num">{fmt(row.assigned)}</span>
        ) : (
          <CategoryMonthCell value={row.assigned} onAssign={onAssign} />
        )}
      </td>
      <td
        className={`num y-num ${readOnlyCls}`}
        style={{
          color: row.outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)",
        }}
      >
        {fmt(row.outflow)}
      </td>
      <td className="num y-num" style={{ color: balanceColor(row.available) }}>
        {fmt(row.available)}
      </td>
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
