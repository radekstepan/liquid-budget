"use client";

import { useState, useRef, useEffect } from "react";
import type { GroupRow, Account, CatRow, BudgetResult } from "@ynab/logic";
import { fmt } from "@ynab/logic";
import {
  Icon,
  MonthNav,
  BudgetHeader,
  Button,
  ToolbarSep,
  Pill,
  balanceTone,
  cx,
  money,
} from "@ynab/theme";
import type { BudgetHeaderPart } from "@ynab/theme";

const COL_A = "w-[110px]";
const COL_O = "w-[110px]";
const COL_V = "w-[120px]";

export type MonthBudget = {
  month: string;
  year: number;
  monthName: string;
  result: BudgetResult;
};

function formatMonthLong(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${MONTHS[(m ?? 1) - 1] ?? ""} ${y ?? ""}`;
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
  collapsed,
  onToggleGroup,
  onAssign,
  onShiftMonth,
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
  const structureGroups = budget.groups;
  const creditGroup = structureGroups.find((g) => g.group.isCreditCardPayments);

  const [menuOpen, setMenuOpen] = useState(false);

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
      <div className="y-toolbar">
        <MonthNav
          month={formatMonthLong(currentMonth)}
          onPrev={() => onShiftMonth(-1)}
          onNext={() => onShiftMonth(1)}
        />
        <ToolbarSep />
        <Button onClick={onAddGroup} size="sm">
          <Icon name="plus" size={11} /> Master Category
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Button
              onClick={() => setMenuOpen((o) => !o)}
              size="sm"
              aria-label="Group options"
            >
              <Icon name="dots" size={14} />
            </Button>
            {menuOpen && (
              <div className="y-modal absolute right-0 top-[28px] z-20 min-w-[180px]" style={{ width: 200, padding: 4 }}>
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
      </div>

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

      <div className="flex-1 overflow-y-auto overflow-x-hidden y-scroll">
        <table className="y-table">
          <thead className="y-thead">
            <tr>
              <th style={{ width: 26 }} />
              <th>Category</th>
              <th className={`num ${COL_A}`}>Budgeted</th>
              <th className={`num ${COL_O}`}>Outflows</th>
              <th className={`num ${COL_V}`}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {structureGroups
              .filter((g) => !g.group.isCreditCardPayments)
              .map((g) => (
                <GroupBlock
                  key={g.group.id}
                  group={g}
                  month={currentMonth}
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
                month={currentMonth}
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
          className="flex w-full items-center gap-2 px-3 py-2 text-[11.5px] font-medium"
          style={{ color: "var(--y-ink-soft)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--y-row-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Icon name="plus" size={11} /> Add Category Group
        </button>
      </div>
    </div>
  );
}

function GroupBlock({
  group,
  month,
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
  month: string;
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

  const sumBudgeted = group.rows.reduce((t, r) => t + r.assigned, 0);
  const sumOutflow = group.rows.reduce((t, r) => t + r.outflow, 0);
  const sumBalance = group.rows.reduce((t, r) => t + r.available, 0);

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
        <td className="num y-num text-right">{fmt(sumBudgeted)}</td>
        <td className="num y-num text-right" style={{ color: sumOutflow < 0 ? "var(--y-ink)" : "var(--y-ink-soft)" }}>
          {fmt(sumOutflow)}
        </td>
        <td className="num y-num text-right" style={{ color: sumBalance < 0 ? "var(--y-red)" : "var(--y-ink)" }}>
          {fmt(sumBalance)}
        </td>
      </tr>

      {!collapsed &&
        group.rows.map((r: CatRow, i: number) => (
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
            <td className="num">
              <CategoryMonthCell
                value={r.assigned}
                onAssign={(v) => onAssign(r.category.id, v, month)}
              />
            </td>
            <td className="num y-num" style={{ color: r.outflow < 0 ? "var(--y-ink-soft)" : "var(--y-ink-faint)" }}>
              {fmt(r.outflow)}
            </td>
            <td className="num">
              <Pill tone={balanceTone(r.available)} style={{ minWidth: 72 }}>
                {fmt(r.available)}
              </Pill>
            </td>
          </tr>
        ))}
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
    const v = parseFloat(draft.replace(/[^0-9.-]/g, ""));
    if (!Number.isNaN(v)) onAssign(v);
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
