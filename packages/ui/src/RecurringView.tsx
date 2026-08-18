import { useState, useMemo } from "react";
import type { BudgetData } from "@ynab/logic";
import {
  fmt,
  num,
  netMonthlyAmount,
  frequencyMonthlyMultiplier,
  frequencyLabel,
  recurringFlavour,
} from "@ynab/logic";
import { Icon, Toolbar, Button, Panel, MathCell, Pill } from "@ynab/theme";
import { Modal, Btn } from "./ui.js";

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
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const deletingRecurring = useMemo(
    () => (deletingId != null ? data.recurring.find((r) => r.id === deletingId) ?? null : null),
    [data.recurring, deletingId]
  );
  const accMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);

  // Calculate monthly flow across all frequencies and accounts.
  const monthlyOut = data.recurring
    .filter((r) => r.active)
    .reduce((s, r) => {
      const v = netMonthlyAmount(r, r.subTransactions ?? [], data.accounts);
      const mult = frequencyMonthlyMultiplier(r.frequency);
      const monthlyV = v * mult;
      return s + (monthlyV < 0 ? monthlyV : 0);
    }, 0);
  const monthlyIn = data.recurring
    .filter((r) => r.active)
    .reduce((s, r) => {
      const v = netMonthlyAmount(r, r.subTransactions ?? [], data.accounts);
      const mult = frequencyMonthlyMultiplier(r.frequency);
      const monthlyV = v * mult;
      return s + (monthlyV > 0 ? monthlyV : 0);
    }, 0);

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
            const flavour = recurringFlavour(r, r.subTransactions ?? []);
            const sourceName = accMap.get(r.accountId) ?? "";
            const destName =
              flavour === "transfer" && r.transferAccountId != null
                ? accMap.get(r.transferAccountId) ?? ""
                : "";
            const children = r.subTransactions ?? [];
            const displayAmt =
              flavour === "split" ? children.reduce((s, c) => s + num(c.amount), 0) : num(r.amount);
            return (
              <Panel key={r.id} bodyClass="!p-3">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-bold" style={{ color: "var(--y-ink)" }}>
                      {r.payee}
                    </div>
                    <div className="y-hint mt-[1px]">
                      {flavour === "transfer" ? (
                        <>
                          {sourceName} → {destName}
                        </>
                      ) : flavour === "split" ? (
                        <>
                          {sourceName} · {children.length} categories
                        </>
                      ) : (
                        <>
                          {sourceName}
                          {r.categoryId ? ` · ${catMap.get(r.categoryId)}` : ""}
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className="y-num text-[14px] font-bold ml-2"
                    style={{ color: displayAmt < 0 ? "var(--y-red)" : "var(--y-green-dk)" }}
                  >
                    {fmt(displayAmt)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
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
                  {flavour !== "single" && (
                    <Pill
                      tone="grey"
                      style={{ minWidth: 0, padding: "1px 8px", fontSize: 9.5, letterSpacing: "0.07em", textTransform: "uppercase" }}
                    >
                      {flavour}
                    </Pill>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <Pill
                    tone="grey"
                    style={{ minWidth: 0, padding: "2px 8px", fontSize: 9.5, letterSpacing: "0.07em", textTransform: "uppercase" }}
                  >
                    {frequencyLabel(r.frequency)}
                  </Pill>
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
                    onClick={() => setDeletingId(r.id)}
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

      {deletingRecurring && (
        <Modal
          title="Delete Recurring Transaction"
          onClose={() => setDeletingId(null)}
          footer={
            <>
              <Btn onClick={() => setDeletingId(null)}>Cancel</Btn>
              <Btn
                variant="danger"
                onClick={() => {
                  onDelete(deletingRecurring.id);
                  setDeletingId(null);
                }}
              >
                Delete Recurring Rule
              </Btn>
            </>
          }
        >
          <div className="py-2 text-[13px] leading-relaxed" style={{ color: "var(--y-ink-soft)" }}>
            Are you sure you want to delete the scheduled recurring rule for{" "}
            <strong style={{ color: "var(--y-ink)" }}>{deletingRecurring.payee}</strong> ({fmt(num(deletingRecurring.amount))})?
            Future automatic occurrences will no longer be generated.
          </div>
        </Modal>
      )}
    </div>
  );
}
