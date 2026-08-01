"use client";

import { useMemo } from "react";
import type { BudgetData } from "@ynab/logic";
import { fmt, num } from "@ynab/logic";
import { Icon, Toolbar, Button, Panel, MathCell, Pill } from "@ynab/theme";

export function RecurringView({
  data,
  onAdd,
  onEdit,
  onDelete,
  onPost,
  onToggleActive,
}: {
  data: BudgetData;
  onAdd: () => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onPost: (id: number) => void;
  onToggleActive: (id: number, active: boolean) => void;
}) {
  const accMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);

  const monthlyOut = data.recurring
    .filter((r) => r.active && num(r.amount) < 0 && r.frequency === "monthly")
    .reduce((s, r) => s + num(r.amount), 0);
  const monthlyIn = data.recurring
    .filter((r) => r.active && num(r.amount) > 0 && r.frequency === "monthly")
    .reduce((s, r) => s + num(r.amount), 0);

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="clock" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>Recurring Transactions</span>
        </div>
        <div className="ml-auto">
          <Button onClick={onAdd} variant="primary">
            <Icon name="plus" size={11} color="#fff" /> Add Recurring
          </Button>
        </div>
      </Toolbar>

      <div className="y-subbar flex gap-3 px-3 py-2.5">
        <MathCell label="Monthly Income" value={fmt(monthlyIn)} tone="green" className="flex-1" style={{ minWidth: 120 }} />
        <MathCell label="Monthly Bills" value={fmt(monthlyOut)} tone="red" className="flex-1" style={{ minWidth: 120 }} />
        <MathCell
          label="Net Monthly"
          value={fmt(monthlyIn + monthlyOut)}
          tone={monthlyIn + monthlyOut >= 0 ? "green" : "red"}
          className="flex-1"
          style={{ minWidth: 120 }}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-4 y-scroll">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.recurring.map((r) => {
            const amt = num(r.amount);
            return (
              <Panel key={r.id} bodyClass="!p-3">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-bold" style={{ color: "var(--y-ink)" }}>
                      {r.payee}
                    </div>
                    <div className="y-hint mt-[1px]">
                      {accMap.get(r.accountId)}
                      {r.categoryId ? ` · ${catMap.get(r.categoryId)}` : ""}
                    </div>
                  </div>
                  <span
                    className="y-num text-[14px] font-bold ml-2"
                    style={{ color: amt < 0 ? "var(--y-red)" : "var(--y-green-dk)" }}
                  >
                    {fmt(amt)}
                  </span>
                </div>
                <div className="mt-2">
                  <Pill
                    tone={r.active ? "green" : "grey"}
                    onClick={() => onToggleActive(r.id, !r.active)}
                    title={r.active ? "Click to pause" : "Click to resume"}
                    aria-label={r.active ? `Pause ${r.payee}` : `Resume ${r.payee}`}
                    style={{ minWidth: 0, padding: "1px 8px" }}
                  >
                    <span
                      className="inline-block h-[6px] w-[6px] rounded-full mr-[5px]"
                      style={{ background: "#fff" }}
                    />
                    {r.active ? "Active" : "Paused"}
                  </Pill>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span
                    className="y-caps"
                    style={{
                      background: "var(--y-panel-alt)",
                      color: "var(--y-ink-soft)",
                      padding: "2px 7px",
                      borderRadius: 8,
                      border: "1px solid var(--y-line)",
                    }}
                  >
                    {r.frequency}
                  </span>
                  <span className="y-hint">
                    Next: <span className="y-num" style={{ color: "var(--y-ink-soft)" }}>{r.nextDate}</span>
                  </span>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    onClick={() => onPost(r.id)}
                    size="sm"
                    variant="blue"
                    className="flex-1"
                  >
                    Post Now
                  </Button>
                  <Button
                    onClick={() => onEdit(r.id)}
                    size="sm"
                    aria-label={`Edit ${r.payee}`}
                    title="Edit"
                  >
                    <Icon name="edit" size={12} />
                  </Button>
                  <Button
                    onClick={() => onDelete(r.id)}
                    size="sm"
                    aria-label={`Delete ${r.payee}`}
                    title="Delete"
                  >
                    <Icon name="trash" size={12} />
                  </Button>
                </div>
              </Panel>
            );
          })}
        </div>
        {data.recurring.length === 0 && (
          <div className="py-12 text-center y-hint">
            No recurring transactions yet.
          </div>
        )}
      </div>
    </div>
  );
}
