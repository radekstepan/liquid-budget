"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { GroupRow, CatRow } from "@ynab/logic";
import { fmt, todayISO } from "@ynab/logic";
import { Icon, Tooltip, cx } from "@ynab/theme";
import {
  balanceColor,
  isHiddenGroup,
  COL_A,
  COL_O,
  COL_V,
} from "./budgetViewHelpers.js";
import { MonthCells, CategoryMonthCell, OverspentMarker } from "./MonthCells.js";
import type { CategoryMonthCellProps } from "./MonthCells.js";

export type GroupBlockProps = {
  group: GroupRow;
  rowOffset?: number;
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
  onKeyDown?: (e: KeyboardEvent) => void;
  quickFill?: CategoryMonthCellProps["quickFill"];
  selectedCategoryId?: number | null;
  onSelectCategory?: (id: number | null) => void;
  todayMonth?: string;
};

/** Master-category header row + its category rows for the budget grid
 * (ui-split slice 7). Props-driven; category-drag state (drag source +
 * drop-target highlight) is local, while group-level drag stays with the
 * parent. Both levels expose Alt+ArrowUp/Down keyboard reorder (a11y
 * slice 1). Renders `<tr>` elements — must sit inside a `<tbody>`. */
export function GroupBlock({
  group,
  rowOffset,
  collapsed,
  onToggle,
  onAssign,
  currentMonth,
  visibleMonths,
  groupsByMonth,
  showMulti,
  onAddCategory,
  onEditCategory,
  onEditGroup,
  onReorderCategory,
  isDragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onKeyDown,
  quickFill,
  selectedCategoryId,
  onSelectCategory,
  todayMonth,
}: GroupBlockProps) {
  const dragCatId = useRef<number | null>(null);
  const [catOverId, setCatOverId] = useState<number | null>(null);

  const gRow = group;
  const isSpecialGroup = group.group.isCreditCardPayments || isHiddenGroup(group.group);
  const isToday = (m: string) => m === (todayMonth ?? todayISO().slice(0, 7));

  const commitCategoryOrder = (reordered: CatRow[]) => {
    if (!onReorderCategory) return;
    reordered.forEach((row, i) => {
      if (row.category.sort !== i) onReorderCategory(row.category.id, i);
    });
  };

  // Keyboard reorder path (a11y slice 1): Alt+ArrowUp/Down moves one step
  // within the group. Plain arrows are left to screen-reader table nav.
  const moveCategoryNeighbor = (catId: number, dir: -1 | 1) => {
    if (!onReorderCategory) return;
    const srcIdx = group.rows.findIndex((x) => x.category.id === catId);
    if (srcIdx === -1) return;
    if (dir === -1 && srcIdx === 0) return;
    if (dir === 1 && srcIdx === group.rows.length - 1) return;
    const reordered = [...group.rows];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(srcIdx + dir, 0, moved!);
    commitCategoryOrder(reordered);
  };

  return (
    <>
      <tr
        className={cx("y-master", isDragOver && !isSpecialGroup && "is-drop-target")}
        draggable={!isSpecialGroup && Boolean(onDrop)}
        tabIndex={!isSpecialGroup && onKeyDown ? 0 : undefined}
        aria-keyshortcuts={!isSpecialGroup && onKeyDown ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        onKeyDown={!isSpecialGroup ? onKeyDown : undefined}
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
                onClick={() => {
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
              <Tooltip tip="Add category">
                <button
                  onClick={() => onAddCategory()}
                  className="y-group-add-btn"
                  aria-label="Add category"
                >
                  <Icon name="plus" size={11} />
                </button>
              </Tooltip>
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
                isThisMonth={isToday(m)}
              />
            );
          })
        ) : (
          <>
            <td className={cx("num y-num text-right", COL_A, isToday(currentMonth) && "y-grid-col--current-first")}>{fmt(gRow.assigned)}</td>
            <td
              className={cx("num y-num text-right", COL_O)}
              style={{ color: gRow.outflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)" }}
            >
              {fmt(gRow.outflow)}
            </td>
            <td className={cx("num y-num text-right", COL_V, isToday(currentMonth) && "y-grid-col--current-last")} style={{ color: balanceColor(gRow.available) }}>
              {fmt(gRow.available)}
              {gRow.available < 0 && <OverspentMarker />}
            </td>
          </>
        )}
      </tr>

      {!collapsed &&
        group.rows.map((r: CatRow, i: number) => {
          const isCatDropTarget = catOverId === r.category.id;
          const isSelected = selectedCategoryId === r.category.id;
          return (
            // Category rows are tab stops only when reorderable (a11y slice 1).
            <tr
              key={r.category.id}
              data-cat-row
              className={cx(
                "y-row cursor-pointer",
                ((rowOffset ?? 0) + i) % 2 === 1 && "alt",
                isCatDropTarget && "is-drop-target",
                isSelected && "is-sel"
              )}
              onClick={() => onSelectCategory?.(isSelected ? null : r.category.id)}
              draggable={Boolean(onReorderCategory)}
              tabIndex={onReorderCategory ? 0 : undefined}
              aria-keyshortcuts={onReorderCategory ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
              onKeyDown={(e) => {
                if (!e.altKey) return;
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                moveCategoryNeighbor(r.category.id, e.key === "ArrowUp" ? -1 : 1);
              }}
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
                commitCategoryOrder(reordered);
                dragCatId.current = null;
                setCatOverId(null);
              }}
            >
              <td className="y-table-td--sticky-cat pl-[24px]">
                <div className="flex items-center">
                  <span className="truncate">{r.category.name}</span>
                  <span className="y-cat-actions">
                    <Tooltip tip="Edit category">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditCategory(r.category.id);
                        }}
                        className="y-cat-edit-btn"
                        aria-label={`Edit ${r.category.name}`}
                      >
                        <Icon name="edit" size={11} />
                      </button>
                    </Tooltip>
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
                        isThisMonth={isToday(m)}
                      />
                    );
                  })
                : (
                  <>
                    <td className={cx("num", COL_A, isToday(currentMonth) && "y-grid-col--current-first")}>
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
                    <td className={cx("num y-num", COL_V, isToday(currentMonth) && "y-grid-col--current-last")} style={{ color: balanceColor(r.available) }}>
                      {fmt(r.available)}
                      {r.available < 0 && <OverspentMarker />}
                      {r.available < 0 && r.category.overspendCarriesOver && (
                        <Tooltip tip="Red Arrow to the Right: Overspending carries over to next month">
                          <span
                            className="ml-1 text-red-600 font-bold"
                            aria-label="Red arrow: carry over"
                          >
                            ➔
                          </span>
                        </Tooltip>
                      )}
                      {r.available < 0 && r.assigned > 0 && (
                        <Tooltip tip="Set assigned to 0">
                          <button
                            type="button"
                            onClick={() => onAssign(r.category.id, 0, currentMonth)}
                            className="ml-1.5 text-[10px] underline cursor-pointer"
                            style={{ color: "var(--y-red)" }}
                            aria-label={`Unassign ${fmt(r.assigned)} from ${r.category.name}`}
                          >
                            Unassign {fmt(r.assigned)}
                          </button>
                        </Tooltip>
                      )}
                      {r.available < 0 && r.assigned === 0 && (
                        <Tooltip
                          tip={`This category has ${fmt(-r.outflow)} in outflows with $0 assigned. Assign more to cover it, or the overspending will be absorbed into next month's TBB.`}
                        >
                          <span
                            className="ml-1.5 text-[10px]"
                            style={{ color: "var(--y-ink-faint)" }}
                          >
                            overspent
                          </span>
                        </Tooltip>
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
