"use client";

import { memo, useState, useRef, useEffect, useMemo, Fragment } from "react";
import type { GroupRow, CatRow, BudgetResult, CategoryGroup } from "@ynab/logic";
import { evalAmount, fmt, MONTHS, parseMonthKey, monthKey, todayISO, dollarsToCents } from "@ynab/logic";
import {
  Icon,
  MonthNav,
  Button,
  Toolbar,
  ToolbarSep,
  cx,
} from "@ynab/theme";

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

export function isInternalGroup(group: CategoryGroup | string): boolean {
  const name = typeof group === "string" ? group : group.name;
  return name === "__Internal__" || name.toLowerCase() === "__internal__";
}

export function isHiddenGroup(group: CategoryGroup | string): boolean {
  if (typeof group === "object" && group !== null) {
    if (group.isHidden !== undefined) return Boolean(group.isHidden);
    return group.name === "Hidden Categories" || group.name?.toLowerCase() === "hidden categories";
  }
  return group === "Hidden Categories" || group.toLowerCase() === "hidden categories";
}

const COL_A = "w-[120px]";
const COL_O = "w-[120px]";
const COL_V = "w-[120px]";

/* ------------------------------------------------------------ props */

export const BudgetView = memo(function BudgetView({
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
  lastMonthAssignments,
  spentLastMonthByCategory,
  avgSpentByCategory,
  avgBudgetedByCategory,
  underfundedByCategory,
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
  lastMonthAssignments?: Map<number, number>;
  spentLastMonthByCategory?: Map<number, number>;
  avgSpentByCategory?: Map<number, number>;
  avgBudgetedByCategory?: Map<number, number>;
  underfundedByCategory?: Map<number, number>;
}) {
  const showMulti = monthCount > 1;

  const resolvedVisibleMonths = visibleMonths && visibleMonths.length ? visibleMonths : [currentMonth];
  const resolvedBudgets = budgets && budgets.length ? budgets : [budget];

  const dragGroupId = useRef<number | null>(null);
  const [groupOverId, setGroupOverId] = useState<number | null>(null);

  const handleGroupDrop = (targetId: number) => {
    const srcId = dragGroupId.current;
    if (srcId == null || srcId === targetId || !onReorderGroup) return;
    const structureGroups = budget.groups.filter(
      (g) => !g.group.isCreditCardPayments && !isInternalGroup(g.group) && !isHiddenGroup(g.group)
    );
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

  const visibleGroups = budget.groups.filter((g) => !isInternalGroup(g.group));
  const structureGroups = visibleGroups.filter(
    (g) => !g.group.isCreditCardPayments && !isHiddenGroup(g.group)
  );
  const creditGroup = visibleGroups.find(
    (g) => g.group.isCreditCardPayments && !isHiddenGroup(g.group)
  );
  const hiddenGroup = visibleGroups.find((g) => isHiddenGroup(g.group));

  const quickFill =
    lastMonthAssignments ||
    spentLastMonthByCategory ||
    avgSpentByCategory ||
    avgBudgetedByCategory ||
    underfundedByCategory
      ? {
          lastMonthAssignments,
          spentLastMonthByCategory,
          avgSpentByCategory,
          avgBudgetedByCategory,
          underfundedByCategory,
        }
      : undefined;

  // For each visible month, find the matching GroupRow by id.
  const groupsByMonth = useMemo(() => {
    return resolvedBudgets.map((b) => {
      const m = new Map<number, GroupRow>();
      for (const g of b.groups) m.set(g.group.id, g);
      return m;
    });
  }, [resolvedBudgets]);

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
      </Toolbar>

      <div className="flex-1 overflow-auto y-scroll">
        <table className="y-table">
          <thead className="y-thead y-thead--sticky">
            {showMulti ? (
              <>
                <tr>
                  <th rowSpan={2} className="y-table-td--sticky-cat">Category</th>
                  {resolvedVisibleMonths.map((m, idx) => (
                    <th
                      key={m}
                      colSpan={3}
                      className={cx(
                        "y-table-th--month-label text-center",
                        idx > 0 && "y-table-colgroup-divider"
                      )}
                    >
                      {formatMonthLong(m)}
                    </th>
                  ))}
                </tr>
                <tr className="y-thead-sub">
                  {resolvedVisibleMonths.map((m, idx) => (
                    <Fragment key={m}>
                      <th
                        className={cx(
                          "num text-right",
                          COL_A,
                          idx === 0 && "y-table-cell--month-first",
                          idx > 0 && "y-table-colgroup-divider"
                        )}
                      >
                        Budgeted
                      </th>
                      <th className={cx("num text-right", COL_O)}>
                        Outflows
                      </th>
                      <th className={cx("num text-right", COL_V)}>
                        Balance
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </>
            ) : (
              <tr>
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
                onEditCategory={onEditCategory}
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
                quickFill={quickFill}
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
                onEditCategory={onEditCategory}
                onDeleteCategory={onDeleteCategory}
                onEditGroup={() => onEditGroup(creditGroup.group.id)}
                onDeleteGroup={onDeleteGroup}
                onReorderCategory={onReorderCategory}
              />
            )}
            {hiddenGroup && (
              <GroupBlock
                group={hiddenGroup}
                collapsed={
                  collapsed[hiddenGroup.group.id] !== undefined
                    ? Boolean(collapsed[hiddenGroup.group.id])
                    : true
                }
                onToggle={() => onToggleGroup(hiddenGroup.group.id)}
                onAssign={onAssign}
                currentMonth={currentMonth}
                visibleMonths={resolvedVisibleMonths}
                groupsByMonth={groupsByMonth}
                showMulti={showMulti}
                onAddCategory={() => onAddCategory(hiddenGroup.group.id)}
                onEditCategory={onEditCategory}
                onDeleteCategory={onDeleteCategory}
                onEditGroup={() => onEditGroup(hiddenGroup.group.id)}
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
});

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
  quickFill,
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
  onEditCategory: (catId: number) => void;
  onDeleteCategory: (catId: number) => void;
  onEditGroup: () => void;
  onDeleteGroup: (groupId: number) => void;
  onReorderCategory?: (id: number, sort: number) => void;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
  quickFill?: CategoryMonthCellProps["quickFill"];
}) {
  const dragCatId = useRef<number | null>(null);
  const [catOverId, setCatOverId] = useState<number | null>(null);

  const gRow = group;
  const isSpecialGroup = group.group.isCreditCardPayments || isHiddenGroup(group.group);

  return (
    <>
      <tr
        className={cx("y-master", isDragOver && !isSpecialGroup && "is-drop-target")}
        draggable={!isSpecialGroup && Boolean(onDrop)}
        onDragStart={(e) => {
          if (isSpecialGroup) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.effectAllowed = "move";
          onDragStart?.();
        }}
        onDragOver={(e) => {
          if (isSpecialGroup) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onDragOver?.();
        }}
        onDragLeave={onDragLeave}
        onDrop={(e) => {
          if (isSpecialGroup) return;
          e.preventDefault();
          onDrop?.();
        }}
      >
        <td className="y-table-td--sticky-cat">
          <div className="flex items-center gap-[7px]">
            <span className="flex items-center gap-[6px]">
              <span
                onClick={onToggle}
                className={cx("y-tri", !collapsed && "is-open", "cursor-pointer")}
                role="button"
                tabIndex={0}
                aria-label={`Toggle ${group.group.name} group`}
              />
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if (isSpecialGroup) return;
                  onEditGroup();
                }}
                className={cx("cursor-text", !isSpecialGroup && "hover:underline")}
                style={{ color: "var(--y-ink)", fontSize: "12.5px" }}
                onKeyDown={(e) => {
                  if (isSpecialGroup) return;
                  if (e.key === "Enter" || e.key === " ") onEditGroup();
                }}
              >
                {group.group.name}
              </span>
            </span>
            <span className="y-group-actions">
              <button
                onClick={() => onAddCategory()}
                className="y-group-add-btn"
                aria-label="Add category"
                title="Add category"
              >
                <Icon name="plus" size={11} />
              </button>
            </span>
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
            <td className={cx("num y-num text-right", COL_A)}>{fmt(gRow.assigned)}</td>
            <td
              className={cx("num y-num text-right", COL_O)}
              style={{ color: gRow.outflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)" }}
            >
              {fmt(gRow.outflow)}
            </td>
            <td className={cx("num y-num text-right", COL_V)} style={{ color: balanceColor(gRow.available) }}>
              {fmt(gRow.available)}
            </td>
          </>
        )}
      </tr>

      {!collapsed &&
        group.rows.map((r: CatRow, i: number) => {
          const empty = isEmptyRow(r);
          const isCatDropTarget = catOverId === r.category.id;
          return (
            <tr
              key={r.category.id}
              data-cat-row
              className={cx(
                "y-row",
                i % 2 === 1 && "alt",
                empty && "is-empty",
                isCatDropTarget && "is-drop-target"
              )}
              draggable={Boolean(onReorderCategory)}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = "move";
                dragCatId.current = r.category.id;
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                if (catOverId !== r.category.id) setCatOverId(r.category.id);
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
              <td className="y-table-td--sticky-cat pl-[24px]">
                <div className="flex items-center">
                  <span className="truncate">{r.category.name}</span>
                  <span className="y-cat-actions">
                    <button
                      onClick={() => onEditCategory(r.category.id)}
                      className="y-cat-edit-btn"
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
                        quickFill={quickFill}
                        categoryId={r.category.id}
                      />
                    );
                  })
                : (
                  <>
                    <td className={cx("num", COL_A)}>
                      <CategoryMonthCell
                        value={r.assigned}
                        onAssign={(val) => onAssign(r.category.id, val, currentMonth)}
                        quickFill={quickFill}
                        categoryId={r.category.id}
                        available={r.available}
                      />
                    </td>
                    <td
                      className={cx("num y-num", COL_O)}
                      style={{
                        color: r.outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)",
                      }}
                    >
                      {fmt(r.outflow)}
                    </td>
                    <td className={cx("num y-num", COL_V)} style={{ color: balanceColor(r.available) }}>
                      {fmt(r.available)}
                      {r.available < 0 && r.category.overspendCarriesOver && (
                        <span
                          className="ml-1 text-red-600 font-bold"
                          title="Red Arrow to the Right: Overspending carries over to next month"
                          aria-label="Red arrow: carry over"
                        >
                          ➔
                        </span>
                      )}
                      {r.available < 0 && r.assigned > 0 && (
                        <button
                          type="button"
                          onClick={() => onAssign(r.category.id, 0, currentMonth)}
                          className="ml-1.5 text-[10px] underline cursor-pointer"
                          style={{ color: "var(--y-red)" }}
                          aria-label={`Unassign ${fmt(r.assigned)} from ${r.category.name}`}
                          title="Set assigned to 0"
                        >
                          Unassign {fmt(r.assigned)}
                        </button>
                      )}
                      {r.available < 0 && r.assigned === 0 && (
                        <span
                          className="ml-1.5 text-[10px]"
                          style={{ color: "var(--y-ink-faint)" }}
                          title={`This category has ${fmt(-r.outflow)} in outflows with $0 assigned. Assign more to cover it, or the overspending will be absorbed into next month's TBB.`}
                        >
                          overspent
                        </span>
                      )}
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
  quickFill,
  categoryId,
}: {
  group?: GroupRow;
  row?: CatRow;
  isOtherMonth: boolean;
  isFirstMonth: boolean;
  isRowForGroup?: boolean;
  onAssign?: (val: number) => void;
  quickFill?: CategoryMonthCellProps["quickFill"];
  categoryId?: number;
}) {
  const divCls = isFirstMonth ? "" : "y-table-colgroup-divider";
  const readOnlyCls = isOtherMonth ? "y-table-cell--readonly" : "";

  if (isRowForGroup && group) {
    return (
      <>
        <td className={cx("num y-num text-right", COL_A, divCls, readOnlyCls)}>
          {fmt(group.assigned)}
        </td>
        <td
          className={cx("num y-num text-right", COL_O, readOnlyCls)}
          style={{
            color: !isOtherMonth && group.outflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)",
          }}
        >
          {fmt(group.outflow)}
        </td>
        <td className={cx("num y-num text-right", COL_V)} style={{ color: balanceColor(group.available) }}>
          {fmt(group.available)}
        </td>
      </>
    );
  }

  if (!row) return <td colSpan={3} className={divCls} />;

  return (
    <>
      <td className={cx("num", COL_A, divCls)}>
        {onAssign ? (
          <CategoryMonthCell
            value={row.assigned}
            onAssign={onAssign}
            quickFill={quickFill}
            categoryId={categoryId}
            available={row.available}
          />
        ) : (
          <span className={cx("y-num", readOnlyCls)}>{fmt(row.assigned)}</span>
        )}
      </td>
      <td
        className={cx("num y-num", COL_O, readOnlyCls)}
        style={{
          color: row.outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)",
        }}
      >
        {fmt(row.outflow)}
      </td>
      <td className={cx("num y-num", COL_V)} style={{ color: balanceColor(row.available) }}>
        {fmt(row.available)}
        {row.available < 0 && row.category.overspendCarriesOver && (
          <span
            className="ml-1 text-red-600 font-bold"
            title="Red Arrow to the Right: Overspending carries over to next month"
            aria-label="Red arrow: carry over"
          >
            ➔
          </span>
        )}
      </td>
    </>
  );
}

/* ------------------------------------------------------------ inline amount cell */

type CategoryMonthCellProps = {
  value: number;
  onAssign: (v: number) => void;
  quickFill?: {
    lastMonthAssignments?: Map<number, number>;
    spentLastMonthByCategory?: Map<number, number>;
    avgSpentByCategory?: Map<number, number>;
    avgBudgetedByCategory?: Map<number, number>;
    underfundedByCategory?: Map<number, number>;
  };
  categoryId?: number;
  available?: number;
};

function CategoryMonthCell({
  value,
  onAssign,
}: CategoryMonthCellProps) {
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
    if (v != null) onAssign(dollarsToCents(v));
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        size={1}
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
          return `= ${fmt(dollarsToCents(n))}`;
        })()}
        className="y-inline-amt"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft((value / 100).toFixed(2));
        setEditing(true);
      }}
      className="y-inline-amt cursor-text"
      style={{ color: "var(--y-ink)" }}
    >
      {fmt(value)}
    </button>
  );
}
