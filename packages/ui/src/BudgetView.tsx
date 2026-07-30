"use client";

import { useState, useRef, useEffect } from "react";
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
}) {
  const { month0 } = parseMonthKey(month);
  const totalBudget = groups.reduce((s, g) => s + g.available, 0);
  const creditGroup = groups.find((g) => g.group.isCreditCardPayments);
  const creditAccounts = accounts.filter((a) => a.kind === "credit");

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
          <button className="ml-1"><IconDots width={16} height={16} /></button>
          <button><IconFilter width={16} height={16} /></button>
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
              <CategoryRow key={r.category.id} r={r} onAssign={onAssign} onEdit={() => {}} onDelete={() => {}} readOnly />
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
}: {
  g: GroupRow;
  collapsed: boolean;
  onToggle: () => void;
  onAssign: (id: number, amt: number) => void;
  onAddCategory: () => void;
  onEditCategory: (id: number) => void;
  onDeleteCategory: (id: number) => void;
  onEditGroup: () => void;
}) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
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
}: {
  r: CatRow;
  onAssign: (id: number, amt: number) => void;
  onEdit: () => void;
  onDelete: () => void;
  readOnly?: boolean;
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
    <div className="group/row flex items-center px-5 py-2 transition-colors hover:bg-[var(--panel-3)]" style={{ borderTop: "1px solid var(--border)" }}>
      <span className="cursor-grab" style={{ color: "var(--faint)" }}>
        <IconGrip width={16} height={16} />
      </span>
      <span className="ml-1 grid h-[18px] w-[18px] place-items-center rounded-full" style={{ border: "1.6px solid var(--border-strong)" }} />

      <div className="ml-2.5 flex w-[168px] shrink-0 items-center gap-1.5">
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
