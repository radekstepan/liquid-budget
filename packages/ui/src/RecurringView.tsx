import { useState, useMemo } from "react";
import type { BudgetData, Recurring, RecurringSubTransaction } from "@ynab/logic";
import {
  fmt,
  num,
  todayISO,
  netMonthlyAmount,
  frequencyMonthlyMultiplier,
  frequencyLabel,
  recurringFlavour,
  groupRecurringByTimeline,
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
  onPost: (id: number, date?: string) => void;
  onToggleActive: (id: number, active: boolean) => void;
}) {
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const deletingRecurring = useMemo(
    () => (deletingId != null ? data.recurring.find((r) => r.id === deletingId) ?? null : null),
    [data.recurring, deletingId]
  );
  const accMap = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c.name])), [data.categories]);
  const today = useMemo(() => todayISO(), []);

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

  const timeline = useMemo(() => {
    return groupRecurringByTimeline(data.recurring, today);
  }, [data.recurring, today]);

  const sections: {
    key: string;
    title: string;
    items: (Recurring & { subTransactions?: RecurringSubTransaction[] })[];
    tone: "red" | "orange" | "blue" | "grey";
  }[] = [
    { key: "overdue", title: "Overdue", items: timeline.overdue, tone: "red" },
    { key: "dueToday", title: "Due Today", items: timeline.dueToday, tone: "orange" },
    { key: "thisWeek", title: "Upcoming This Week", items: timeline.thisWeek, tone: "blue" },
    { key: "later", title: "Later", items: timeline.later, tone: "grey" },
    { key: "paused", title: "Paused", items: timeline.paused, tone: "grey" },
  ];

  const renderCard = (r: Recurring & { subTransactions?: RecurringSubTransaction[] }) => {
    const flavour = recurringFlavour(r, r.subTransactions ?? []);
    const sourceName = accMap.get(r.accountId) ?? "";
    const destName =
      flavour === "transfer" && r.transferAccountId != null
        ? accMap.get(r.transferAccountId) ?? ""
        : "";
    const children = r.subTransactions ?? [];
    const displayAmt =
      flavour === "split" ? children.reduce((s, c) => s + num(c.amount), 0) : num(r.amount);

    const isOverdue = r.active && r.nextDate < today;
    const isDueToday = r.active && r.nextDate === today;
    const isFuture = r.active && r.nextDate > today;

    return (
      <Panel key={r.id} bodyClass="!p-3">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-bold" style={{ color: "var(--y-ink)" }}>
                {r.payee}
              </span>
              {isOverdue && (
                <Pill tone="red" style={{ minWidth: 0, padding: "1px 6px", fontSize: 9, textTransform: "uppercase" }}>
                  Overdue
                </Pill>
              )}
              {isDueToday && (
                <Pill tone="orange" style={{ minWidth: 0, padding: "1px 6px", fontSize: 9, textTransform: "uppercase" }}>
                  Due Today
                </Pill>
              )}
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
              style={{
                minWidth: 0,
                padding: "1px 8px",
                fontSize: 9.5,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
              }}
            >
              {flavour}
            </Pill>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <Pill
            tone="grey"
            style={{
              minWidth: 0,
              padding: "2px 8px",
              fontSize: 9.5,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
            }}
          >
            {frequencyLabel(r.frequency)}
          </Pill>
          <span className="y-hint">
            {isOverdue ? (
              <>
                Due:{" "}
                <span className="y-num font-bold" style={{ color: "var(--y-red)" }}>
                  {r.nextDate}
                </span>
              </>
            ) : isDueToday ? (
              <>
                Due:{" "}
                <span className="y-num font-bold" style={{ color: "var(--y-orange-dk)" }}>
                  Today ({r.nextDate})
                </span>
              </>
            ) : (
              <>
                Next: <span className="y-num" style={{ color: "var(--y-ink-soft)" }}>{r.nextDate}</span>
              </>
            )}
          </span>
        </div>

        <div className="mt-3 flex gap-2">
          <Button
            onClick={() => {
              if (isFuture) {
                onPost(r.id, today);
              } else {
                onPost(r.id);
              }
            }}
            size="sm"
            variant="blue"
            className="flex-1"
            title={isFuture ? `Enter early into register as of today (${today})` : "Enter into register"}
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
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-center gap-2">
          <Icon name="clock" size={14} color="var(--y-ink)" />
          <span className="text-[13px] font-bold" style={{ color: "var(--y-ink)" }}>
            Recurring Transactions
          </span>
        </div>
        <div className="ml-auto">
          <Button onClick={onAdd} variant="primary">
            <Icon name="plus" size={11} color="#fff" /> Add Recurring
          </Button>
        </div>
      </Toolbar>

      <div className="y-subbar flex gap-3 px-3 py-2.5">
        <MathCell
          label="Monthly Income"
          value={fmt(monthlyIn)}
          tone="green"
          className="flex-1"
          style={{ minWidth: 120 }}
        />
        <MathCell
          label="Monthly Bills"
          value={fmt(monthlyOut)}
          tone="red"
          className="flex-1"
          style={{ minWidth: 120 }}
        />
        <MathCell
          label="Net Monthly"
          value={fmt(monthlyIn + monthlyOut)}
          tone={monthlyIn + monthlyOut >= 0 ? "green" : "red"}
          className="flex-1"
          style={{ minWidth: 120 }}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-4 y-scroll">
        {data.recurring.length === 0 ? (
          <div className="py-12 text-center y-hint">
            No recurring transactions yet.
          </div>
        ) : (
          sections
            .filter((sec) => sec.items.length > 0)
            .map((sec) => (
              <div key={sec.key} className="mb-6 last:mb-0">
                <div className="y-recurring-section-header">
                  <span>{sec.title}</span>
                  <Pill tone={sec.tone} style={{ minWidth: 0, padding: "0 6px", fontSize: 9 }}>
                    {sec.items.length}
                  </Pill>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {sec.items.map((r) => renderCard(r))}
                </div>
              </div>
            ))
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
            <strong style={{ color: "var(--y-ink)" }}>{deletingRecurring.payee}</strong> (
            {fmt(num(deletingRecurring.amount))})?
            Future automatic occurrences will no longer be generated.
          </div>
        </Modal>
      )}
    </div>
  );
}

