"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { GroupRow, Account, CatRow } from "@ynab/logic";
import { fmt, num, MONTHS, parseMonthKey, monthKey } from "@ynab/logic";
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

const COL_A = "w-[132px]";
const COL_O = "w-[132px]";
const COL_V = "w-[148px]";

export function BudgetView({
  groups,
  month,
  year,
  accounts,
  collapsed,
  onToggleGroup,
  onAssign,
  onSelectMonth,
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
  groups: GroupRow[];
  month: string;
  year: number;
  accounts: Account[];
  collapsed: Record<number, boolean>;
  onToggleGroup: (id: number) => void;
  onAssign: (catId: number, amount: number) => void;
  onSelectMonth: (key: string) => void;
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
  const { month0 } = parseMonthKey(month);
  const totalBudget = groups.reduce((s, g) => s + g.available, 0);
  const creditGroup = groups.find((g) => g.group.isCreditCardPayments);
  const creditAccounts = accounts.filter((a) => a.kind === "credit");
  const [menuOpen, setMenuOpen] = useState(false);

  // ── Group drag-and-drop state ──
  const dragGroupId = useRef<number | null>(null);
  const [groupOverId, setGroupOverId] = useState<number | null>(null);

  const handleGroupDragStart = useCallback((id: number) => {
    dragGroupId.current = id;
  }, []);

  const handleGroupDrop = useCallback(
    (targetId: number) => {
      const srcId = dragGroupId.current;
      if (srcId == null || srcId === targetId || !onReorderGroup) return;
      const nonCC = groups.filter((g) => !g.group.isCreditCardPayments);
      const srcIdx = nonCC.findIndex((g) => g.group.id === srcId);
      const tgtIdx = nonCC.findIndex((g) => g.group.id === targetId);
      if (srcIdx === -1 || tgtIdx === -1) return;
      // Assign sequential sort values reflecting the new order.
      const reordered = [...nonCC];
      const [moved] = reordered.splice(srcIdx, 1);
      reordered.splice(tgtIdx, 0, moved!);
      reordered.forEach((g, i) => {
        if (g.group.sort !== i) onReorderGroup(g.group.id, i);
      });
      dragGroupId.current = null;
      setGroupOverId(null);
    },
    [groups, onReorderGroup]
  );

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center gap-1 px-5 py-3.5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {MONTHS.map((m, i) => {
          const key = monthKey(year, i);
          const active = i === month0;
          const past = i < month0;
          return (
            <button
              key={m}
              onClick={() => onSelectMonth(key)}
              className="rounded-lg px-3.5 py-1.5 text-[15px] transition-all"
              style={{
                background: active ? "var(--accent)" : "transparent",
                color: active ? "var(--accent-fg)" : past ? "var(--faint)" : "var(--text-2)",
                fontWeight: active ? 700 : 500,
                textDecoration: past ? "line-through" : "none",
                fontStyle: active || past ? "italic" : "normal",
              }}
            >
              {m}
            </button>
          );
        })}
      </div>

      <div
        className="flex items-center px-5 py-2.5"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--panel-2)" }}
      >
        <div className="flex items-center gap-1" style={{ color: "var(--faint)" }}>
          <IconChevronDown width={16} height={16} />
          <span className="ml-1 grid h-[18px] w-[18px] place-items-center rounded-full" style={{ border: "1.6px solid var(--border-strong)" }} />
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="ml-1 rounded-md p-1 transition-colors hover:bg-[var(--panel)]"
              aria-label="Open budget menu"
              aria-expanded={menuOpen}
            >
              <IconDots width={16} height={16} />
            </button>
            {menuOpen && (
              <div
                className="animate-fade absolute left-0 top-[28px] z-20 min-w-[180px] overflow-hidden rounded-xl"
                style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}
                role="menu"
              >
                <button
                  onClick={() => {
                    onCollapseAll();
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--panel-3)]"
                  style={{ color: "var(--text-2)" }}
                  role="menuitem"
                >
                  Collapse all groups
                </button>
                <button
                  onClick={() => {
                    onExpandAll();
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--panel-3)]"
                  style={{ color: "var(--text-2)" }}
                  role="menuitem"
                >
                  Expand all groups
                </button>
              </div>
            )}
          </div>
          <button
            className="rounded-md p-1 opacity-50"
            style={{ color: "var(--faint)", cursor: "not-allowed" }}
            aria-label="Filter (coming soon)"
            disabled
            title="Filters coming in a future update"
          >
            <IconFilter width={16} height={16} />
          </button>
        </div>
        <div className="flex-1" />
        <div className={`${COL_A} text-right text-[11.5px] font-semibold uppercase tracking-[0.07em]`} style={{ color: "var(--muted)" }}>
          Assigned
        </div>
        <div className={`${COL_O} text-right text-[11.5px] font-semibold uppercase tracking-[0.07em]`} style={{ color: "var(--muted)" }}>
          Outflow
        </div>
        <div className={`${COL_V} pr-1 text-right text-[11.5px] font-semibold uppercase tracking-[0.07em]`} style={{ color: "var(--muted)" }}>
          Available
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {groups
          .filter((g) => !g.group.isCreditCardPayments)
          .map((g) => (
            <GroupBlock
              key={g.group.id}
              g={g}
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

        <button
          onClick={onAddGroup}
          className="flex w-full items-center gap-2 px-6 py-2.5 text-[13px] font-medium transition-colors hover:bg-[var(--panel-3)]"
          style={{ color: "var(--muted)" }}
        >
          <IconPlus width={15} height={15} /> Add Category Group
        </button>

        {creditGroup && (
          <CreditGroupHeader
            g={creditGroup}
            collapsed={!!collapsed[creditGroup.group.id]}
            onToggle={() => onToggleGroup(creditGroup.group.id)}
          />
        )}
        {creditGroup && !collapsed[creditGroup.group.id] && (
          <div>
            {creditGroup.rows.map((r) => (
              <CategoryRow
                key={r.category.id}
                r={r}
                onAssign={onAssign}
                onEdit={() => onEditCategory(r.category.id)}
                onDelete={() => onDeleteCategory(r.category.id)}
              />
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-4 px-5 py-5">
          {creditAccounts.map((a) => {
            const cat = creditGroup?.rows.find((r) => r.category.linkedAccountId === a.id);
            const pool = cat?.available ?? 0;
            const debt = Math.max(0, -num(a.balance));
            const coveredPct = debt > 0 ? Math.min(1, pool / debt) : 1;
            const remaining = Math.max(0, debt - pool);
            const fullyCovered = remaining <= 0.004;
            return (
              <div
                key={a.id}
                className="rounded-2xl p-4"
                style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-[15px] font-bold" style={{ color: "var(--text)" }}>
                      {a.name}
                    </div>
                    <div className="text-[13px]" style={{ color: "var(--muted)" }}>
                      Payment Pool
                    </div>
                  </div>
                  <span
                    className="tnum rounded-lg px-2.5 py-1 text-[13.5px] font-bold"
                    style={{
                      background: fullyCovered ? "var(--accent)" : "var(--warn)",
                      color: "#fff",
                    }}
                  >
                    {fmt(pool)}
                  </span>
                </div>
                <div className="mt-3.5 h-2.5 overflow-hidden rounded-full" style={{ background: "var(--track)" }}>
                  <div
                    className={fullyCovered ? "stripe h-full rounded-full" : "stripe-warn h-full rounded-full"}
                    style={{ width: `${Math.max(4, coveredPct * 100)}%` }}
                  />
                </div>
                <div className="mt-2.5 text-[13px]" style={{ color: "var(--text-2)" }}>
                  {fullyCovered ? (
                    <>
                      <span className="font-bold" style={{ color: "var(--text)" }}>100%</span> of your debt
                      is covered!
                    </>
                  ) : (
                    <>
                      <span className="tnum font-bold" style={{ color: "var(--warn)" }}>{fmt(remaining)}</span> of
                      debt is remaining.
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className="flex items-center px-5 py-3.5"
        style={{ borderTop: "1px solid var(--border)", background: "var(--panel-2)" }}
      >
        <span style={{ color: "var(--muted)" }}>
          <IconTotal width={19} height={19} />
        </span>
        <span className="ml-2.5 text-[15.5px] font-bold" style={{ color: "var(--text)" }}>
          Total Budget
        </span>
        <span className="tnum ml-auto pr-1 text-[16px] font-bold" style={{ color: "var(--text)" }}>
          {fmt(totalBudget)}
        </span>
      </div>
    </div>
  );
}

function GroupBlock({
  g,
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
  g: GroupRow;
  collapsed: boolean;
  onToggle: () => void;
  onAssign: (id: number, amt: number) => void;
  onAddCategory: () => void;
  onEditCategory: (id: number) => void;
  onDeleteCategory: (id: number) => void;
  onEditGroup: () => void;
  onDeleteGroup: () => void;
  onReorderCategory?: (id: number, sort: number) => void;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
}) {
  // ── Category drag state within this group ──
  const dragCatId = useRef<number | null>(null);
  const [catOverId, setCatOverId] = useState<number | null>(null);

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
        // Only trigger group drag when the drag originates on the header, not on category rows.
        const target = e.target as HTMLElement;
        if (target.closest("[data-cat-row]")) { e.stopPropagation(); return; }
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragOver?.(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop?.(); }}
    >
      <div className="group/gh flex items-center px-5 py-2.5" style={{ background: "var(--panel-2)" }}>
        <button onClick={onToggle} className="flex items-center gap-1" style={{ color: "var(--faint)" }}>
          {collapsed ? <IconChevronRight width={16} height={16} /> : <IconChevronDown width={16} height={16} />}
        </button>
        <span className="ml-1 grid h-[18px] w-[18px] place-items-center rounded-full" style={{ border: "1.6px solid var(--border-strong)" }} />
        <button onClick={onEditGroup} className="ml-2.5 text-[15px] font-bold" style={{ color: "var(--text)" }}>
          {g.group.name}
        </button>
        <button
          onClick={onAddCategory}
          className="ml-2 rounded-md p-1 opacity-0 transition-opacity group-hover/gh:opacity-100"
          style={{ color: "var(--muted)" }}
          title="Add category"
        >
          <IconPlus width={15} height={15} />
        </button>
        <button
          onClick={() => {
            if (confirm(`Delete group "${g.group.name}"? This also deletes all of its categories and their assignment history.`)) {
              onDeleteGroup();
            }
          }}
          className="ml-1 rounded-md p-1 opacity-0 transition-opacity group-hover/gh:opacity-100"
          style={{ color: "var(--muted)" }}
          title="Delete group"
          aria-label={`Delete group ${g.group.name}`}
        >
          <IconTrash width={14} height={14} />
        </button>
        <div className="flex-1" />
        <div className={`${COL_A} tnum text-right text-[14.5px] font-bold`} style={{ color: "var(--text)" }}>
          {fmt(g.assigned)}
        </div>
        <div className={`${COL_O} tnum text-right text-[14.5px] font-bold`} style={{ color: g.outflow < 0 ? "var(--text)" : "var(--muted)" }}>
          {fmt(g.outflow)}
        </div>
        <div className={`${COL_V} tnum pr-1 text-right text-[14.5px] font-bold`} style={{ color: g.available < 0 ? "var(--danger)" : "var(--text)" }}>
          {fmt(g.available)}
        </div>
      </div>

      {!collapsed &&
        g.rows.map((r) => (
          <CategoryRow
            key={r.category.id}
            r={r}
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
              const srcIdx = g.rows.findIndex((x) => x.category.id === srcId);
              const tgtIdx = g.rows.findIndex((x) => x.category.id === r.category.id);
              if (srcIdx === -1 || tgtIdx === -1) return;
              const reordered = [...g.rows];
              const [moved] = reordered.splice(srcIdx, 1);
              reordered.splice(tgtIdx, 0, moved!);
              reordered.forEach((row, i) => {
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

function CreditGroupHeader({
  g,
  collapsed,
  onToggle,
}: {
  g: GroupRow;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center px-5 py-2.5" style={{ background: "var(--panel-2)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
      <button onClick={onToggle} className="flex items-center gap-1" style={{ color: "var(--faint)" }}>
        {collapsed ? <IconChevronRight width={16} height={16} /> : <IconChevronDown width={16} height={16} />}
      </button>
      <span className="ml-2" style={{ color: "var(--muted)" }}>
        <IconCard width={17} height={17} />
      </span>
      <span className="ml-2 text-[15px] font-bold" style={{ color: "var(--text)" }}>
        {g.group.name}
      </span>
      <div className="flex-1" />
      <div className={`${COL_A} tnum text-right text-[14.5px] font-bold`} style={{ color: "var(--text)" }}>
        {fmt(g.assigned)}
      </div>
      <div className={`${COL_O} tnum text-right text-[14.5px] font-bold`} style={{ color: g.outflow < 0 ? "var(--text)" : "var(--muted)" }}>
        {fmt(g.outflow)}
      </div>
      <div className={`${COL_V} tnum pr-1 text-right text-[14.5px] font-bold`} style={{ color: "var(--text)" }}>
        {fmt(g.available)}
      </div>
    </div>
  );
}

function CategoryRow({
  r,
  onAssign,
  onEdit,
  onDelete,
  readOnly,
  isDragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  r: CatRow;
  onAssign: (id: number, amt: number) => void;
  onEdit: () => void;
  onDelete: () => void;
  readOnly?: boolean;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const goal = r.category.goalTarget ? num(r.category.goalTarget) : null;
  const goalFunded = goal ? Math.max(0, Math.min(r.available, goal)) : 0;
  const goalPct = goal ? Math.round((goalFunded / goal) * 100) : 0;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const v = parseFloat(draft.replace(/[^0-9.-]/g, ""));
    if (!Number.isNaN(v)) onAssign(r.category.id, v);
    setEditing(false);
  };

  const availColor =
    r.available < 0 ? "var(--danger)" : r.available === 0 ? "var(--muted)" : "var(--accent)";

  return (
    <div
      data-cat-row
      className="group/row flex items-center px-5 py-2 transition-colors hover:bg-[var(--panel-3)]"
      style={{
        borderTop: isDragOver ? "2px solid var(--accent)" : "1px solid var(--border)",
        background: isDragOver ? "var(--accent-soft)" : undefined,
        transition: "background 0.1s, border-top-color 0.1s",
      }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; onDragOver?.(); }}
      onDragLeave={(e) => { e.stopPropagation(); onDragLeave?.(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop?.(); }}
    >
      {/* Grip handle — only this part is draggable so clicking the row still works */}
      <span
        className="cursor-grab active:cursor-grabbing"
        style={{ color: "var(--faint)" }}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          onDragStart?.();
        }}
        aria-label={`Drag to reorder ${r.category.name}`}
      >
        <IconGrip width={16} height={16} />
      </span>
      <span className="ml-1 grid h-[18px] w-[18px] place-items-center rounded-full" style={{ border: "1.6px solid var(--border-strong)" }} />

      <div className="ml-2.5 flex w-[168px] shrink-0 flex-col gap-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[14.5px] font-medium" style={{ color: "var(--text)" }}>
            {r.category.name}
          </span>
          {!readOnly && (
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
              <button onClick={onEdit} className="rounded p-0.5" style={{ color: "var(--muted)" }} title="Edit">
                <IconPencil width={13} height={13} />
              </button>
              <button onClick={onDelete} className="rounded p-0.5" style={{ color: "var(--muted)" }} title="Delete">
                <IconTrash width={13} height={13} />
              </button>
            </span>
          )}
        </div>
        {Math.abs(r.carryoverIn) > 0.004 && (
          <span className="tnum text-[10.5px]" style={{ color: r.carryoverIn < 0 ? "var(--danger)" : "var(--faint)" }}>
            ↩ {fmt(r.carryoverIn)} carried
          </span>
        )}
      </div>

      <div className="mx-4 flex-1">
        {goal ? (
          <div>
            <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--track)" }}>
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, goalPct)}%`, background: "var(--accent)" }} />
            </div>
            <div className="mt-1 flex justify-between text-[11.5px]">
              <span style={{ color: "var(--accent)" }}>
                <span className="tnum font-semibold">{fmt(goalFunded)}</span>{" "}
                <span style={{ color: "var(--muted)" }}>of {fmt(goal)}</span>
              </span>
              <span className="tnum font-semibold" style={{ color: "var(--muted)" }}>
                {goalPct}%
              </span>
            </div>
          </div>
        ) : r.available < 0 ? (
          <div className="h-2 rounded-full" style={{ background: "var(--track)" }} />
        ) : (
          <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--track)" }}>
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, r.fundedPct * 100)}%`, background: "var(--accent)" }} />
          </div>
        )}
      </div>

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
            className="tnum w-[110px] rounded-md px-2 py-1 text-right text-[14.5px] outline-none focus:ring-2"
            style={{ background: "var(--panel)", border: "1px solid var(--accent)", color: "var(--text)" }}
          />
        ) : (
          <button
            onClick={() => {
              if (readOnly) return;
              setDraft(r.assigned.toFixed(2));
              setEditing(true);
            }}
            className="tnum rounded-md px-2 py-1 text-[14.5px] font-semibold transition-colors hover:bg-[var(--panel)]"
            style={{ color: "var(--text)", cursor: readOnly ? "default" : "text" }}
          >
            {fmt(r.assigned)}
          </button>
        )}
      </div>

      <div className={`${COL_O} tnum text-right text-[14.5px] font-semibold`} style={{ color: r.outflow < 0 ? "var(--text-2)" : "var(--muted)" }}>
        {fmt(r.outflow)}
      </div>

      <div className={`${COL_V} flex justify-end pr-1`}>
        <span
          className="tnum inline-block min-w-[76px] rounded-lg px-2.5 py-1 text-center text-[13.5px] font-bold"
          style={
            r.available === 0
              ? { background: "var(--panel)", border: "1px solid var(--border-strong)", color: "var(--muted)" }
              : r.available < 0
              ? { background: "var(--danger)", color: "#fff" }
              : { background: "var(--accent)", color: "#fff" }
          }
        >
          {fmt(r.available)}
        </span>
      </div>
    </div>
  );
}
