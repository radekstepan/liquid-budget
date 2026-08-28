"use client";

import { useState, useMemo } from "react";
import type {
  Account,
  BulkUpdateTransactionPatch,
  Category,
  CategoryGroup,
  ClearedStatus,
  Transaction,
  TransactionFlagColor,
} from "@ynab/logic";
import {
  todayISO,
  evalAmount,
  nextMonthKey,
  adjustDateShortcut,
  num,
  dollarsToCents,
} from "@ynab/logic";
import {
  Button,
  TextField,
  Select,
  Checkbox,
  Notice,
  FlagPicker,
  SearchList,
  money,
  cx,
  type SearchListOption,
} from "@ynab/theme";
import { Modal, Btn } from "./ui.js";
import { AmountPreview } from "./AmountInput.js";

const inputClass = "w-full py-[3px]";

export function BulkEditTransactionsModal({
  transactionIds,
  transactions = [],
  accounts,
  categories,
  groups,
  payees,
  onClose,
  onSave,
}: {
  transactionIds: number[];
  transactions?: Transaction[];
  accounts: Account[];
  categories: Category[];
  groups?: CategoryGroup[];
  payees?: SearchListOption[];
  onClose: () => void;
  onSave: (patch: BulkUpdateTransactionPatch, ids?: number[]) => Promise<void> | void;
}) {
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [saving, setSaving] = useState(false);

  // Field toggles (which fields should be changed)
  const [editDate, setEditDate] = useState(false);
  const [editPayee, setEditPayee] = useState(false);
  const [editCategory, setEditCategory] = useState(false);
  const [editMemo, setEditMemo] = useState(false);
  const [editAccount, setEditAccount] = useState(false);
  const [editAmount, setEditAmount] = useState(false);
  const [editStatus, setEditStatus] = useState(false);
  const [editFlag, setEditFlag] = useState(false);

  // Field values
  const availableAccounts = useMemo(() => {
    return accounts.filter((a) => !a.archived);
  }, [accounts]);

  const [date, setDate] = useState(todayISO());
  const [payee, setPayee] = useState("");
  const [categoryId, setCategoryId] = useState<number | "" | "__deferred__">("");
  const [deferredMonth, setDeferredMonth] = useState<string>(() =>
    nextMonthKey(todayISO().slice(0, 7))
  );
  const [memo, setMemo] = useState("");
  const [accountId, setAccountId] = useState<number>(
    availableAccounts[0]?.id ?? accounts[0]?.id ?? 0
  );
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<ClearedStatus>("c");
  const [flagColor, setFlagColor] = useState<TransactionFlagColor | null>(null);

  const editableTransactions = useMemo(() => {
    if (transactions && transactions.length > 0) {
      return transactions.filter((t) => t.status !== "r");
    }
    return [];
  }, [transactions]);

  const reconciledCount = useMemo(() => {
    if (transactions && transactions.length > 0) {
      return transactions.filter((t) => t.status === "r").length;
    }
    return 0;
  }, [transactions]);

  const hasReconciled = reconciledCount > 0;
  const allReconciled =
    transactions && transactions.length > 0 && editableTransactions.length === 0;

  const editableIds = useMemo(() => {
    if (transactions && transactions.length > 0) {
      return editableTransactions.map((t) => t.id);
    }
    return transactionIds;
  }, [transactions, editableTransactions, transactionIds]);

  const editableCount = editableIds.length;

  const activeFieldCount =
    (editDate ? 1 : 0) +
    (editPayee ? 1 : 0) +
    (editCategory ? 1 : 0) +
    (editMemo ? 1 : 0) +
    (editAccount ? 1 : 0) +
    (editAmount ? 1 : 0) +
    (editStatus ? 1 : 0) +
    (editFlag ? 1 : 0);

  const isValid = useMemo(() => {
    if (allReconciled) return false;
    if (activeFieldCount === 0) return false;
    if (editPayee && !payee.trim()) return false;
    if (editAmount) {
      const a = evalAmount(amount);
      if (a == null || Number.isNaN(a)) return false;
    }
    if (editAccount && !accountId) return false;
    return true;
  }, [allReconciled, activeFieldCount, editPayee, payee, editAmount, amount, editAccount, accountId]);

  const categoryLabel = useMemo(() => {
    if (categoryId === "") return "Income: Available this month";
    if (categoryId === "__deferred__") return `Income: Available ${deferredMonth || "next month"}`;
    const found = categories.find((c) => c.id === Number(categoryId));
    return found ? found.name : `Category #${categoryId}`;
  }, [categoryId, categories, deferredMonth]);

  const accountLabel = useMemo(() => {
    const found = accounts.find((a) => a.id === Number(accountId));
    return found ? found.name : `Account #${accountId}`;
  }, [accountId, accounts]);

  const handleSave = async () => {
    if (!isValid || saving || editableIds.length === 0) return;
    setSaving(true);
    try {
      const patch: BulkUpdateTransactionPatch = {};
      if (editDate) patch.date = date;
      if (editPayee) patch.payee = payee.trim();
      if (editCategory) {
        const isDeferred = categoryId === "__deferred__";
        patch.categoryId = categoryId === "" || isDeferred ? null : Number(categoryId);
        if (isDeferred) {
          patch.incomeMonth = deferredMonth || nextMonthKey(editDate ? date.slice(0, 7) : todayISO().slice(0, 7));
        } else {
          patch.incomeMonth = null;
        }
      }
      if (editMemo) patch.memo = memo.trim();
      if (editAccount) patch.accountId = Number(accountId);
      if (editAmount) {
        const a = evalAmount(amount);
        if (a != null) patch.amount = dollarsToCents(a);
      }
      if (editStatus) patch.status = status;
      if (editFlag) patch.flagColor = flagColor;

      await onSave(patch, editableIds);
    } finally {
      setSaving(false);
    }
  };

  const count = transactionIds.length;

  return (
    <Modal
      wide={step === "confirm"}
      title={
        step === "confirm"
          ? `Confirm Changes (${hasReconciled ? `${editableCount} of ${count}` : count} Transactions)`
          : `Edit ${count} Transactions`
      }
      onClose={onClose}
      footer={
        step === "confirm" ? (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={() => setStep("edit")} disabled={saving}>
                ← Back
              </Btn>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn variant="primary" onClick={handleSave} disabled={saving || editableCount === 0}>
                {saving
                  ? "Updating…"
                  : hasReconciled
                  ? `Confirm & Update ${editableCount} of ${count} Transactions`
                  : `Confirm & Update ${count} Transactions`}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={onClose}>Cancel</Btn>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn
                variant="primary"
                onClick={() => setStep("confirm")}
                disabled={!isValid}
              >
                Review Changes ({activeFieldCount}) →
              </Btn>
            </div>
          </>
        )
      }
    >
      {step === "confirm" ? (
        <div className="space-y-4 text-[12.5px] leading-relaxed" style={{ color: "var(--y-ink)" }}>
          <Notice tone="info" title={`Updating ${editableCount} transaction${editableCount === 1 ? "" : "s"}`}>
            Only the fields listed below will be modified. All other fields (such as dates and amounts not explicitly edited) will remain unchanged on each transaction.
            {hasReconciled && (
              <div className="mt-1 font-normal">
                {reconciledCount} reconciled transaction{reconciledCount === 1 ? " is" : "s are"} locked and will be skipped.
              </div>
            )}
          </Notice>

          <div
            className="rounded border p-3 space-y-2"
            style={{
              backgroundColor: "var(--y-gray-50, #f8fafc)",
              borderColor: "var(--y-line, #e2e8f0)",
            }}
          >
            <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--y-ink-soft)]">
              Fields to be updated
            </div>
            <div className="grid grid-cols-[140px_1fr] gap-y-2 gap-x-4 items-center">
              {editDate && (
                <>
                  <span className="font-semibold">Date:</span>
                  <span className="font-mono text-[12px]">{date}</span>
                </>
              )}
              {editPayee && (
                <>
                  <span className="font-semibold">Payee:</span>
                  <span>{payee.trim()}</span>
                </>
              )}
              {editCategory && (
                <>
                  <span className="font-semibold">Category:</span>
                  <span>{categoryLabel}</span>
                </>
              )}
              {editMemo && (
                <>
                  <span className="font-semibold">Memo:</span>
                  <span>{memo.trim() ? memo.trim() : <em className="text-[var(--y-ink-soft)]">(Empty / Cleared)</em>}</span>
                </>
              )}
              {editAccount && (
                <>
                  <span className="font-semibold">Account:</span>
                  <span>{accountLabel}</span>
                </>
              )}
              {editAmount && (
                <>
                  <span className="font-semibold">Amount:</span>
                  <span className="font-mono font-bold">
                    {evalAmount(amount) != null
                      ? money(dollarsToCents(evalAmount(amount)))
                      : amount}
                  </span>
                </>
              )}
              {editStatus && (
                <>
                  <span className="font-semibold">Cleared Status:</span>
                  <span className="capitalize">{status === "c" ? "Cleared" : "Uncleared"}</span>
                </>
              )}
              {editFlag && (
                <>
                  <span className="font-semibold">Flag:</span>
                  <span className="capitalize">{flagColor ?? "No Flag"}</span>
                </>
              )}
            </div>
          </div>

          {editableTransactions.length > 0 && (
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--y-ink-soft)] mb-1.5 flex items-center justify-between">
                <span>Target Transactions ({editableTransactions.length})</span>
                {editableTransactions.length > 10 && (
                  <span className="text-[10.5px] font-normal normal-case text-[var(--y-ink-soft)]">
                    Showing first 10
                  </span>
                )}
              </div>
              <div
                className="y-scroll max-h-48 overflow-auto rounded border"
                style={{
                  borderColor: "var(--y-line, #c9c9c5)",
                  background: "var(--y-row)",
                }}
              >
                <table className="y-table w-full text-left">
                  <thead className="y-thead--sticky">
                    <tr>
                      <th style={{ width: 95 }}>Date</th>
                      <th>Payee</th>
                      <th className="num" style={{ width: 100 }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editableTransactions.slice(0, 10).map((t, idx) => (
                      <tr
                        key={t.id}
                        className={cx("y-row", idx % 2 === 1 && "alt")}
                      >
                        <td className="y-num whitespace-nowrap text-[11.5px]">{t.date}</td>
                        <td className="font-medium truncate text-[11.5px]" title={t.payee || ""}>
                          {t.payee || <span className="y-hint">No Payee</span>}
                        </td>
                        <td className="num y-num font-medium text-[11.5px] whitespace-nowrap">
                          {money(num(t.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {editableTransactions.length > 10 && (
                  <div
                    className="px-2.5 py-1.5 text-[11px] text-[var(--y-ink-soft)] text-center border-t"
                    style={{
                      borderColor: "var(--y-line-soft, #e0e0dc)",
                      backgroundColor: "var(--y-row-alt, #f4f4f2)",
                    }}
                  >
                    + {editableTransactions.length - 10} more transactions will be updated
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3.5">
          <p className="text-[12px] text-[var(--y-ink-soft)] leading-snug">
            Check the fields you want to change across all {count} selected transactions. Unchecked fields will remain untouched.
          </p>

          {hasReconciled && (
            <Notice tone="warn" title="Reconciled transactions selected">
              {allReconciled
                ? "All selected transactions are reconciled and locked. They cannot be modified unless unreconciled."
                : `${reconciledCount} selected transaction${reconciledCount === 1 ? " is" : "s are"} reconciled and locked. ${reconciledCount === 1 ? "It" : "They"} will be skipped and remain unchanged (${editableCount} of ${count} will be updated).`}
            </Notice>
          )}

          {/* Date */}
          <div className="rounded border p-2.5 space-y-1.5" style={{ borderColor: editDate ? "var(--y-green)" : "var(--y-line)" }}>
            <div className="flex items-center justify-between">
              <Checkbox
                checked={editDate}
                onChange={(checked) => setEditDate(checked)}
                label="Date"
              />
              {editDate && (
                <button
                  type="button"
                  onClick={() => setEditDate(false)}
                  className="text-[11px] text-[var(--y-ink-soft)] hover:underline"
                >
                  Keep existing
                </button>
              )}
            </div>
            {editDate ? (
              <TextField
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                onKeyDown={(e) => {
                  const adjusted = adjustDateShortcut(date, e.key);
                  if (adjusted) {
                    e.preventDefault();
                    setDate(adjusted);
                  }
                }}
                className={inputClass}
                autoFocus
              />
            ) : (
              <div
                className="text-[11.5px] italic text-[var(--y-ink-soft)] cursor-pointer py-0.5"
                onClick={() => setEditDate(true)}
              >
                (Keep existing dates)
              </div>
            )}
          </div>

          {/* Payee */}
          <div className="rounded border p-2.5 space-y-1.5" style={{ borderColor: editPayee ? "var(--y-green)" : "var(--y-line)" }}>
            <div className="flex items-center justify-between">
              <Checkbox
                checked={editPayee}
                onChange={(checked) => setEditPayee(checked)}
                label="Payee"
              />
              {editPayee && (
                <button
                  type="button"
                  onClick={() => setEditPayee(false)}
                  className="text-[11px] text-[var(--y-ink-soft)] hover:underline"
                >
                  Keep existing
                </button>
              )}
            </div>
            {editPayee ? (
              <SearchList
                value={payee}
                onChange={(val) => {
                  setPayee(val);
                }}
                options={payees}
                allowCreate
                placeholder="e.g. Target"
                className={inputClass}
                autoFocus
              />
            ) : (
              <div
                className="text-[11.5px] italic text-[var(--y-ink-soft)] cursor-pointer py-0.5"
                onClick={() => setEditPayee(true)}
              >
                (Keep existing payees)
              </div>
            )}
          </div>

          {/* Category */}
          <div className="rounded border p-2.5 space-y-1.5" style={{ borderColor: editCategory ? "var(--y-green)" : "var(--y-line)" }}>
            <div className="flex items-center justify-between">
              <Checkbox
                checked={editCategory}
                onChange={(checked) => setEditCategory(checked)}
                label="Category"
              />
              {editCategory && (
                <button
                  type="button"
                  onClick={() => setEditCategory(false)}
                  className="text-[11px] text-[var(--y-ink-soft)] hover:underline"
                >
                  Keep existing
                </button>
              )}
            </div>
            {editCategory ? (
              <Select
                value={categoryId}
                onChange={(v) => {
                  setCategoryId(v === "" || v === "__deferred__" ? v : Number(v));
                }}
                className="w-full"
                searchable
                autoFocus
              >
                <option value="">Income: Available this month</option>
                <option value="__deferred__">Income: Available next month</option>
                {groups && groups.length > 0 ? (
                  groups.map((g) => (
                    <optgroup key={g.id} label={g.name}>
                      {categories
                        .filter((c) => c.groupId === g.id)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </optgroup>
                  ))
                ) : (
                  categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))
                )}
              </Select>
            ) : (
              <div
                className="text-[11.5px] italic text-[var(--y-ink-soft)] cursor-pointer py-0.5"
                onClick={() => setEditCategory(true)}
              >
                (Keep existing categories)
              </div>
            )}
            {editCategory && categoryId === "__deferred__" && (
              <div className="pt-2">
                <label className="text-[11px] text-[var(--y-ink-soft)] block mb-1">
                  Deferred to month
                </label>
                <TextField
                  type="month"
                  value={deferredMonth}
                  onChange={(e) => setDeferredMonth(e.target.value)}
                  className={inputClass}
                />
              </div>
            )}
          </div>

          {/* Memo */}
          <div className="rounded border p-2.5 space-y-1.5" style={{ borderColor: editMemo ? "var(--y-green)" : "var(--y-line)" }}>
            <div className="flex items-center justify-between">
              <Checkbox
                checked={editMemo}
                onChange={(checked) => setEditMemo(checked)}
                label="Memo"
              />
              {editMemo && (
                <button
                  type="button"
                  onClick={() => setEditMemo(false)}
                  className="text-[11px] text-[var(--y-ink-soft)] hover:underline"
                >
                  Keep existing
                </button>
              )}
            </div>
            {editMemo ? (
              <div>
                <TextField
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="Leave empty to clear memo"
                  className={inputClass}
                  autoFocus
                />
                <div className="text-[10.5px] text-[var(--y-ink-soft)] mt-0.5">
                  Leaving this field empty will clear memos on all selected transactions.
                </div>
              </div>
            ) : (
              <div
                className="text-[11.5px] italic text-[var(--y-ink-soft)] cursor-pointer py-0.5"
                onClick={() => setEditMemo(true)}
              >
                (Keep existing memos)
              </div>
            )}
          </div>

          {/* Account */}
          <div className="rounded border p-2.5 space-y-1.5" style={{ borderColor: editAccount ? "var(--y-green)" : "var(--y-line)" }}>
            <div className="flex items-center justify-between">
              <Checkbox
                checked={editAccount}
                onChange={(checked) => setEditAccount(checked)}
                label="Account"
              />
              {editAccount && (
                <button
                  type="button"
                  onClick={() => setEditAccount(false)}
                  className="text-[11px] text-[var(--y-ink-soft)] hover:underline"
                >
                  Keep existing
                </button>
              )}
            </div>
            {editAccount ? (
              <Select
                value={accountId}
                onChange={(v) => setAccountId(Number(v))}
                className="w-full"
                searchable
                autoFocus
              >
                {availableAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            ) : (
              <div
                className="text-[11.5px] italic text-[var(--y-ink-soft)] cursor-pointer py-0.5"
                onClick={() => setEditAccount(true)}
              >
                (Keep existing accounts)
              </div>
            )}
          </div>

          {/* Amount */}
          <div className="rounded border p-2.5 space-y-1.5" style={{ borderColor: editAmount ? "var(--y-green)" : "var(--y-line)" }}>
            <div className="flex items-center justify-between">
              <Checkbox
                checked={editAmount}
                onChange={(checked) => setEditAmount(checked)}
                label="Amount"
              />
              {editAmount && (
                <button
                  type="button"
                  onClick={() => setEditAmount(false)}
                  className="text-[11px] text-[var(--y-ink-soft)] hover:underline"
                >
                  Keep existing
                </button>
              )}
            </div>
            {editAmount ? (
              <div>
                <TextField
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                  className={inputClass}
                  autoFocus
                />
                <AmountPreview value={amount} />
              </div>
            ) : (
              <div
                className="text-[11.5px] italic text-[var(--y-ink-soft)] cursor-pointer py-0.5"
                onClick={() => setEditAmount(true)}
              >
                (Keep existing amounts)
              </div>
            )}
          </div>

          {/* Cleared Status */}
          <div className="rounded border p-2.5 space-y-1.5" style={{ borderColor: editStatus ? "var(--y-green)" : "var(--y-line)" }}>
            <div className="flex items-center justify-between">
              <Checkbox
                checked={editStatus}
                onChange={(checked) => setEditStatus(checked)}
                label="Cleared Status"
              />
              {editStatus && (
                <button
                  type="button"
                  onClick={() => setEditStatus(false)}
                  className="text-[11px] text-[var(--y-ink-soft)] hover:underline"
                >
                  Keep existing
                </button>
              )}
            </div>
            {editStatus ? (
              <div className="y-seg w-full">
                <Button
                  size="sm"
                  variant={status === "c" ? "primary" : "default"}
                  active={status === "c"}
                  onClick={() => setStatus("c")}
                  className="flex-1"
                >
                  Cleared
                </Button>
                <Button
                  size="sm"
                  variant={status === "u" ? "primary" : "default"}
                  active={status === "u"}
                  onClick={() => setStatus("u")}
                  className="flex-1"
                >
                  Uncleared
                </Button>
              </div>
            ) : (
              <div
                className="text-[11.5px] italic text-[var(--y-ink-soft)] cursor-pointer py-0.5"
                onClick={() => setEditStatus(true)}
              >
                (Keep existing cleared status)
              </div>
            )}
          </div>

          {/* Flag */}
          <div className="rounded border p-2.5 space-y-1.5" style={{ borderColor: editFlag ? "var(--y-green)" : "var(--y-line)" }}>
            <div className="flex items-center justify-between">
              <Checkbox
                checked={editFlag}
                onChange={(checked) => setEditFlag(checked)}
                label="Flag"
              />
              {editFlag && (
                <button
                  type="button"
                  onClick={() => setEditFlag(false)}
                  className="text-[11px] text-[var(--y-ink-soft)] hover:underline"
                >
                  Keep existing
                </button>
              )}
            </div>
            {editFlag ? (
              <div className="pt-0.5">
                <FlagPicker
                  value={flagColor}
                  onChange={(c) => setFlagColor(c)}
                />
              </div>
            ) : (
              <div
                className="text-[11.5px] italic text-[var(--y-ink-soft)] cursor-pointer py-0.5"
                onClick={() => setEditFlag(true)}
              >
                (Keep existing flags)
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
