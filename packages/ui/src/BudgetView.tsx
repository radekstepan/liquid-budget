"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { GroupRow, Account, CatRow, BudgetResult } from "@ynab/logic";
import { fmt, num } from "@ynab/logic";
import {
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconFilter,
  IconGrip,
  IconCard,
  IconTotal,
  IconPlus,
  IconPencil,
  IconTrash,
} from "./icons.js";

const COL_A = "w-[90px]";
const COL_O = "w-[90px]";
const COL_V = "w-[100px]";

export type MonthBudget = {
  month: string;
  year: number;
  monthName: string;
  result: BudgetResult;
};

export function BudgetView({
  budgets,
  currentMonth,
  accounts,
  collapsed,
  onToggleGroup,
  onAssign,
  onSelectMonth,
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
}: {
  budgets: MonthBudget[];
  currentMonth: string;
  accounts: Account[];
  collapsed: Record<number, boolean>;
  onToggleGroup: (id: number) => void;
  onAssign: (catId: number, amount: number, month: string) => void;
  onSelectMonth: (key: string) => void;
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
}) {
  // We use the first month to establish the category/group structure since the list is identical across months
  const structureGroups = budgets[0]!.result.groups;
  const creditGroup = structureGroups.find((g) => g.group.isCreditCardPayments);
  const creditAccounts = accounts.filter((a) => a.kind === "credit");
  
  const [menuOpen, setMenuOpen] = useState(false);

  // Drag state
  const dragGroupId = useRef<number | null>(null);
  const [groupOverId, setGroupOverId] = useState<number | null>(null);

  const handleGroupDragStart = useCallback((id: number) => {
    dragGroupId.current = id;
  }, []);

  const handleGroupDrop = useCallback(
    (targetId: number) => {
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
    },
    [structureGroups, onReorderGroup]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Month Navigation & Headers */}
      <div className="flex items-center gap-1 px-5 py-3.5" style={{ borderBottom: "1px solid var(--border)" }}>
        <button onClick={() => onShiftMonth(-1)} className="rounded p-1 hover:bg-[var(--panel-3)] mr-4">
          <IconChevronRight width={16} height={16} className="rotate-180" />
        </button>
        
        <div className="flex flex-1 gap-4">
          {budgets.map((b) => (
             <div key={b.month} className="flex-1 text-center">
                <button
                  onClick={() => onSelectMonth(b.month)}
                  className="rounded-lg px-3.5 py-1.5 text-[15px] transition-all"
                  style={{
                    background: b.month === currentMonth ? "var(--accent)" : "transparent",
                    color: b.month === currentMonth ? "var(--accent-fg)" : "var(--text-2)",
                    fontWeight: b.month === currentMonth ? 700 : 500,
                  }}
                >
                  {b.monthName} {b.year}
                </button>
                <div className="mt-1 text-[12px] text-[var(--muted)]">
                  <div>Income: {fmt(b.result.totalIncome)}</div>
                  <div>Assigned: {fmt(b.result.totalAssigned)}</div>
                </div>
             </div>
          ))}
        </div>
        
        <button onClick={() => onShiftMonth(1)} className="rounded p-1 hover:bg-[var(--panel-3)] ml-4">
          <IconChevronRight width={16} height={16} />
        </button>
      </div>

      {/* Grid Headers */}
      <div className="flex items-center px-5 py-2.5" style={{ borderBottom: "1px solid var(--border)", background: "var(--panel-2)" }}>
        <div className="flex items-center gap-1 w-[220px] shrink-0" style={{ color: "var(--faint)" }}>
          <IconChevronDown width={16} height={16} />
          <span className="ml-1 grid h-[18px] w-[18px] place-items-center rounded-full" style={{ border: "1.6px solid var(--border-strong)" }} />
          <div className="relative">
            <button onClick={() => setMenuOpen((o) => !o)} className="ml-1 rounded-md p-1 transition-colors hover:bg-[var(--panel)]">
              <IconDots width={16} height={16} />
            </button>
            {menuOpen && (
              <div className="animate-fade absolute left-0 top-[28px] z-20 min-w-[180px] overflow-hidden rounded-xl bg-[var(--panel)] border border-[var(--border)] shadow-[var(--shadow-lg)]">
                <button onClick={() => { onCollapseAll(); setMenuOpen(false); }} className="flex w-full items-center px-3 py-2 text-left text-[13px] hover:bg-[var(--panel-3)] text-[var(--text-2)]">
                  Collapse all groups
                </button>
                <button onClick={() => { onExpandAll(); setMenuOpen(false); }} className="flex w-full items-center px-3 py-2 text-left text-[13px] hover:bg-[var(--panel-3)] text-[var(--text-2)]">
                  Expand all groups
                </button>
              </div>
            )}
          </div>
        </div>
        
        <div className="flex flex-1 gap-4 overflow-hidden">
          {budgets.map(b => (
            <div key={b.month} className="flex flex-1 justify-end gap-2 pr-2">
              <div className={`${COL_A} text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]`}>Assign</div>
              <div className={`${COL_O} text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]`}>Actvty</div>
              <div className={`${COL_V} text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]`}>Avail</div>
            </div>
          ))}
        </div>
      </div>

      {/* Grid Body */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {structureGroups
          .filter((g) => !g.group.isCreditCardPayments)
          .map((g) => (
            <GroupBlock
              key={g.group.id}
              groupDef={g.group}
              budgets={budgets}
              collapsed={!!collapsed[g.group.id]}
              onToggle={() => onToggleGroup(g.group.id)}
              onAssign={onAssign}
              onAddCategory={() => onAddCategory(g.group.id)}
              onEditCategory={onEditCategory}
              onDeleteCategory={onDeleteCategory}
              onEditGroup={() => onEditGroup(g.group.id)}
              onDeleteGroup={() => onDeleteGroup(g.group.id)}
              onReorderCategory={onReorderCategory}
              isDragOver={groupOverId === g.group.id}
              onDragStart={() => handleGroupDragStart(g.group.id)}
              onDragOver={() => setGroupOverId(g.group.id)}
              onDragLeave={() => setGroupOverId(null)}
              onDrop={() => handleGroupDrop(g.group.id)}
            />
          ))}

        <button onClick={onAddGroup} className="flex w-full items-center gap-2 px-6 py-2.5 text-[13px] font-medium transition-colors hover:bg-[var(--panel-3)] text-[var(--muted)]">
          <IconPlus width={15} height={15} /> Add Category Group
        </button>
        
        {creditGroup && (
          <GroupBlock
             groupDef={creditGroup.group}
             budgets={budgets}
             collapsed={!!collapsed[creditGroup.group.id]}
             onToggle={() => onToggleGroup(creditGroup.group.id)}
             onAssign={onAssign}
             onAddCategory={() => onAddCategory(creditGroup.group.id)}
             onEditCategory={onEditCategory}
             onDeleteCategory={onDeleteCategory}
             onEditGroup={() => onEditGroup(creditGroup.group.id)}
             onDeleteGroup={() => onDeleteGroup(creditGroup.group.id)}
             onReorderCategory={onReorderCategory}
          />
        )}
      </div>
    </div>
  );
}

function GroupBlock({
  groupDef,
  budgets,
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
}: any) {
  const dragCatId = useRef<number | null>(null);
  const [catOverId, setCatOverId] = useState<number | null>(null);
  
  // Get this group's data for all months
  const groupDataByMonth = budgets.map((b: MonthBudget) => {
     return b.result.groups.find(g => g.group.id === groupDef.id)!;
  });

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        outline: isDragOver ? "2px solid var(--accent)" : "none",
        outlineOffset: "-2px",
        borderRadius: isDragOver ? "4px" : undefined,
        opacity: isDragOver ? 0.85 : 1,
        transition: "opacity 0.15s, outline 0.1s",
      }}
      draggable
      onDragStart={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("[data-cat-row]")) { e.stopPropagation(); return; }
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragOver?.(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop?.(); }}
    >
      <div className="group/gh flex items-center px-5 py-2.5 bg-[var(--panel-2)]">
        <div className="flex items-center gap-1 w-[220px] shrink-0">
          <button onClick={onToggle} className="text-[var(--faint)]">
            {collapsed ? <IconChevronRight width={16} height={16} /> : <IconChevronDown width={16} height={16} />}
          </button>
          <span className="ml-1 grid h-[18px] w-[18px] place-items-center rounded-full border-[1.6px] border-[var(--border-strong)]" />
          <button onClick={onEditGroup} className="ml-2.5 text-[15px] font-bold text-[var(--text)] text-left truncate w-[140px]">
            {groupDef.name}
          </button>
          <button onClick={onAddCategory} className="ml-1 rounded-md p-1 opacity-0 transition-opacity group-hover/gh:opacity-100 text-[var(--muted)]">
            <IconPlus width={15} height={15} />
          </button>
        </div>
        
        <div className="flex flex-1 gap-4">
          {groupDataByMonth.map((gd: GroupRow, i: number) => (
             <div key={i} className="flex flex-1 justify-end gap-2 pr-2">
               <div className={`${COL_A} tnum text-right text-[14.5px] font-bold text-[var(--text)]`}>{fmt(gd.assigned)}</div>
               <div className={`${COL_O} tnum text-right text-[14.5px] font-bold ${gd.outflow < 0 ? 'text-[var(--text)]' : 'text-[var(--muted)]'}`}>{fmt(gd.outflow)}</div>
               <div className={`${COL_V} tnum text-right text-[14.5px] font-bold ${gd.available < 0 ? 'text-[var(--danger)]' : 'text-[var(--text)]'}`}>{fmt(gd.available)}</div>
             </div>
          ))}
        </div>
      </div>

      {!collapsed &&
        groupDataByMonth[0].rows.map((r: CatRow) => (
          <CategoryRow
            key={r.category.id}
            catDef={r.category}
            budgets={budgets}
            onAssign={onAssign}
            onEdit={() => onEditCategory(r.category.id)}
            onDelete={() => onDeleteCategory(r.category.id)}
            isDragOver={catOverId === r.category.id}
            onDragStart={() => { dragCatId.current = r.category.id; }}
            onDragOver={() => setCatOverId(r.category.id)}
            onDragLeave={() => setCatOverId(null)}
            onDrop={() => {
              const srcId = dragCatId.current;
              if (srcId == null || srcId === r.category.id || !onReorderCategory) return;
              const srcIdx = groupDataByMonth[0].rows.findIndex((x: CatRow) => x.category.id === srcId);
              const tgtIdx = groupDataByMonth[0].rows.findIndex((x: CatRow) => x.category.id === r.category.id);
              if (srcIdx === -1 || tgtIdx === -1) return;
              const reordered = [...groupDataByMonth[0].rows];
              const [moved] = reordered.splice(srcIdx, 1);
              reordered.splice(tgtIdx, 0, moved!);
              reordered.forEach((row: CatRow, i: number) => {
                if (row.category.sort !== i) onReorderCategory(row.category.id, i);
              });
              dragCatId.current = null;
              setCatOverId(null);
            }}
          />
        ))}
    </div>
  );
}

function CategoryRow({
  catDef,
  budgets,
  onAssign,
  onEdit,
  onDelete,
  readOnly,
  isDragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: any) {
  return (
    <div
      data-cat-row
      className="group/row flex items-center px-5 py-2 hover:bg-[var(--panel-3)] transition-colors"
      style={{
        borderTop: isDragOver ? "2px solid var(--accent)" : "1px solid var(--border)",
        background: isDragOver ? "var(--accent-soft)" : undefined,
      }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; onDragOver?.(); }}
      onDragLeave={(e) => { e.stopPropagation(); onDragLeave?.(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop?.(); }}
    >
      <div className="flex items-center gap-1 w-[220px] shrink-0">
        <span className="cursor-grab text-[var(--faint)]" draggable onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; onDragStart?.(); }}>
          <IconGrip width={16} height={16} />
        </span>
        <span className="ml-1 grid h-[18px] w-[18px] place-items-center rounded-full border-[1.6px] border-[var(--border-strong)]" />
        <span className="ml-2.5 truncate text-[14.5px] font-medium text-[var(--text)] w-[140px]">{catDef.name}</span>
        {!readOnly && (
           <span className="flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 ml-1">
             <button onClick={onEdit} className="rounded p-0.5 text-[var(--muted)]"><IconPencil width={13} height={13} /></button>
             <button onClick={onDelete} className="rounded p-0.5 text-[var(--muted)]"><IconTrash width={13} height={13} /></button>
           </span>
        )}
      </div>

      <div className="flex flex-1 gap-4">
        {budgets.map((b: MonthBudget, i: number) => {
           const groupRows = b.result.groups.find(g => g.group.id === catDef.groupId)!.rows;
           const catData = groupRows.find(r => r.category.id === catDef.id)!;
           return (
             <CategoryMonthCell key={b.month} month={b.month} catData={catData} readOnly={readOnly} onAssign={onAssign} />
           );
        })}
      </div>
    </div>
  );
}

function CategoryMonthCell({ month, catData, readOnly, onAssign }: any) {
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
    if (!Number.isNaN(v)) onAssign(catData.category.id, v, month);
    setEditing(false);
  };

  return (
    <div className="flex flex-1 justify-end gap-2 pr-2">
      <div className={`${COL_A} text-right`}>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="tnum w-[80px] rounded-md px-2 py-1 text-right text-[14.5px] outline-none focus:ring-2 border border-[var(--accent)] bg-[var(--panel)] text-[var(--text)]"
          />
        ) : (
          <button
            onClick={() => {
              if (readOnly) return;
              setDraft(catData.assigned.toFixed(2));
              setEditing(true);
            }}
            className={`tnum rounded-md px-2 py-1 text-[14.5px] font-semibold hover:bg-[var(--panel)] ${readOnly ? 'cursor-default' : 'cursor-text'} text-[var(--text)]`}
          >
            {fmt(catData.assigned)}
          </button>
        )}
      </div>
      <div className={`${COL_O} tnum text-right text-[14.5px] font-semibold ${catData.outflow < 0 ? 'text-[var(--text-2)]' : 'text-[var(--muted)]'}`}>
        {fmt(catData.outflow)}
      </div>
      <div className={`${COL_V} flex justify-end pr-1`}>
        <span className={`tnum inline-block min-w-[70px] rounded-lg px-2.5 py-1 text-center text-[13.5px] font-bold ${
            catData.available === 0 ? 'bg-[var(--panel)] border border-[var(--border-strong)] text-[var(--muted)]' :
            catData.available < 0 ? 'bg-[var(--danger)] text-white' : 'bg-[var(--accent)] text-white'
        }`}>
          {fmt(catData.available)}
        </span>
      </div>
    </div>
  );
}
