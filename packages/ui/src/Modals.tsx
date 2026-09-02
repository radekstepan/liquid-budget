"use client";

import { useState, useMemo, useEffect } from "react";
import type { Account, Category, CategoryGroup, Recurring, RecurringSubTransaction, SubTransaction, Transaction, TransactionDuplicateFlag, TransactionFlagColor } from "@ynab/logic";
import { todayISO, num, evalAmount, getSplitChildren, assertSplitsBalanced, nextMonthKey, adjustDateShortcut, RECURRING_FREQUENCIES, dollarsToCents } from "@ynab/logic";
import { Button, TextField, Select, Checkbox, Notice, FlagPicker, SearchList, type SearchListOption } from "@ynab/theme";
import { Modal, Field, Btn } from "./ui.js";
import { AmountPreview } from "./AmountInput.js";

export { BulkEditTransactionsModal } from "./BulkEditModal.js";

const inputClass = "w-full py-[3px]";

export type TransactionSavePayload = {
  id?: number;
  accountId: number;
  categoryId: number | null;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  status: "u" | "c" | "r";
  /**
   * When omitted the server leaves the flag untouched (preserving an
   * internal "duplicate" marker the user did not change). When present it
   * replaces the flag; null clears it.
   */
  flagColor?: TransactionFlagColor | null;
  transferAccountId?: number | null;
  incomeMonth?: string | null;
  /**
   * When set, the server will create a split: insert the parent with
   * the top-level fields and these N children, atomically. Mutually
   * exclusive with `transferAccountId` and a top-level `categoryId`.
   */
  subTransactions?: SubTransaction[];
};

export type DraftSubRow = {
  id?: number;
  payee?: string;
  categoryId: number | null;
  transferAccountId: number | null;
  amount: string;
  memo: string;
};

/**
 * The single transaction entry point. Supports three modes that the user
 * picks via a segmented toggle:
 *
 *   - "single" (default): one row, account + category + amount.
 *   - "transfer": one row, the payee becomes "Transfer : <other>" and
 *     the Category dropdown is hidden; an Account dropdown picks the
 *     destination.
 *   - "split": the top-level amount is a sum of N sub-rows (Category +
 *     Amount per row). Children must sum to the parent to the cent.
 *
 * When editing a row whose `parentId` references an existing split
 * parent, the modal opens in split mode with the existing children
 * pre-populated; saving issues a full-replace of the children.
 */
export function TransactionModal({
  accounts,
  categories,
  groups,
  payees,
  defaultAccountId,
  defaultDate,
  initialMode,
  allTransactions,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  accounts: Account[];
  categories: Category[];
  groups?: CategoryGroup[];
  /** Existing payee names for the searchable payee field. */
  payees?: SearchListOption[];
  defaultAccountId: number | null;
  defaultDate?: string;
  initialMode?: "single" | "transfer" | "split";
  /** All transactions in the budget, used to look up split children when editing. */
  allTransactions?: Transaction[];
  initial?: Transaction;
  onClose: () => void;
  onSave: (t: TransactionSavePayload) => void;
  /** Edit-only. Triggers a two-step confirm panel; the caller wires the actual API call. */
  onDelete?: () => Promise<void> | void;
}) {
  const initialAmt = initial ? num(initial.amount) / 100 : 0;

  // Detect if `initial` is a split parent and pre-populate children.
  const initialChildren = useMemo(() => {
    if (!initial || !allTransactions) return undefined;
    const children = getSplitChildren(allTransactions, initial.id);
    return [...children].sort((a, b) => a.id - b.id);
  }, [initial, allTransactions]);

  const isInitialTransfer = !!initial?.transferAccountId;
  const isInitialSplit =
    !isInitialTransfer &&
    initial?.parentId == null &&
    !!initialChildren &&
    initialChildren.length > 0;

  const isEdit = !!initial;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingUnreconcile, setConfirmingUnreconcile] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setConfirmingDelete(false);
    setConfirmingUnreconcile(false);
    setDeleting(false);
  }, [initial?.id]);

  const [mode, setMode] = useState<"single" | "transfer" | "split">(
    isInitialTransfer ? "transfer" : isInitialSplit ? "split" : (initialMode ?? "single")
  );

  const availableAccounts = useMemo(() => {
    return accounts.filter((a) => !a.archived || a.id === initial?.accountId);
  }, [accounts, initial?.accountId]);

  const [accountId, setAccountId] = useState(
    initial?.accountId ?? defaultAccountId ?? availableAccounts[0]?.id ?? accounts[0]?.id ?? 0
  );
  const selectedAccount = useMemo(() => {
    return accounts.find((a) => a.id === accountId);
  }, [accounts, accountId]);
  const isOffBudget = selectedAccount ? !selectedAccount.onBudget : false;

  const isInitialDeferred =
    initial?.categoryId == null &&
    !!initial?.incomeMonth &&
    initial.incomeMonth > (initial.date ? initial.date.slice(0, 7) : "");
  const [categoryId, setCategoryId] = useState<number | "" | "__deferred__">(
    initial?.categoryId ?? (isInitialDeferred ? "__deferred__" : "")
  );
  const [date, setDate] = useState(initial?.date ?? defaultDate ?? todayISO());
  const [incomeMonth, setIncomeMonth] = useState<string>(
    initial?.incomeMonth ??
      nextMonthKey(
        initial?.date
          ? initial.date.slice(0, 7)
          : defaultDate
          ? defaultDate.slice(0, 7)
          : todayISO().slice(0, 7)
      )
  );
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [amount, setAmount] = useState(
    initial ? initialAmt.toFixed(2) : ""
  );
  const [cleared, setCleared] = useState<boolean>(initial?.status === "c" || initial?.status === "r" || initial?.status == null);
  const [flagColor, setFlagColor] = useState<TransactionFlagColor | TransactionDuplicateFlag | null>(
    initial?.flagColor ?? null
  );

  // The internal "duplicate" marker is not a pickable color; we keep it
  // around so editing other fields preserves it, and it is dropped once the
  // user picks a manual color or clears the flag.
  const isDuplicateFlag = flagColor === "duplicate";
  const pickerFlagColor: TransactionFlagColor | null = isDuplicateFlag ? null : flagColor;
  const savedFlagColor: TransactionFlagColor | null | undefined = isDuplicateFlag
    ? undefined
    : flagColor;

  // Transfer destination
  const [transferAccountId, setTransferAccountId] = useState<number | "">(
    initial?.transferAccountId ?? ""
  );

  const transferDestAccount = useMemo(() => {
    return transferAccountId ? accounts.find((a) => a.id === Number(transferAccountId)) : null;
  }, [accounts, transferAccountId]);

  const isTransferBoundary =
    mode === "transfer" &&
    transferDestAccount != null &&
    Boolean(selectedAccount?.onBudget) !== Boolean(transferDestAccount.onBudget);

  const transferAmountCents = dollarsToCents(evalAmount(amount));
  const srcOnBudget = Boolean(selectedAccount?.onBudget);
  const destOnBudget = Boolean(transferDestAccount?.onBudget);
  const transferNetOnBudgetDelta = isTransferBoundary
    ? (srcOnBudget ? transferAmountCents : 0) + (destOnBudget ? -transferAmountCents : 0)
    : 0;
  const isBoundaryOutflow = isTransferBoundary && transferNetOnBudgetDelta <= 0;
  const isBoundaryInflow = isTransferBoundary && transferNetOnBudgetDelta > 0;

  // Split sub-rows
  const [subRows, setSubRows] = useState<DraftSubRow[]>(
    initialChildren
      ? initialChildren.map((c) => ({
          id: c.id,
          payee: c.payee,
          categoryId: c.categoryId ?? null,
          transferAccountId: c.transferAccountId ?? null,
          amount: (num(c.amount) / 100).toFixed(2),
          memo: c.memo ?? "",
        }))
      : [
          { categoryId: null, transferAccountId: null, amount: "", memo: "" },
          { categoryId: null, transferAccountId: null, amount: "", memo: "" },
        ]
  );

  const otherAccounts = availableAccounts.filter((a) => a.id !== accountId);

  // Signed parent amount and signed child total in dollars for UI display
  const parentAmount = evalAmount(amount) ?? 0;
  const subTotal = subRows.reduce((s, r) => s + (evalAmount(r.amount) ?? 0), 0);
  const subValidation = useMemo(() => {
    if (mode !== "split") return null;
    const parentCents = dollarsToCents(parentAmount);
    try {
      assertSplitsBalanced(
        parentCents,
        subRows.map((r) => ({
          ...r,
          amount: dollarsToCents(evalAmount(r.amount)),
        }))
      );
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [mode, parentAmount, subRows]);

  const switchingMode = (next: "single" | "transfer" | "split") => {
    setMode(next);
    if (next === "single") {
      setTransferAccountId("");
      setSubRows([
        { categoryId: null, transferAccountId: null, amount: "", memo: "" },
        { categoryId: null, transferAccountId: null, amount: "", memo: "" },
      ]);
    } else if (next === "transfer") {
      if (!isInitialTransfer) {
        setCategoryId("");
      }
      setSubRows([
        { categoryId: null, transferAccountId: null, amount: "", memo: "" },
        { categoryId: null, transferAccountId: null, amount: "", memo: "" },
      ]);
    } else {
      setTransferAccountId("");
      setCategoryId("");
    }
  };

  const confirmDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  const save = () => {
    const a = evalAmount(amount);
    if (a == null || !accountId) return;
    const amountCents = dollarsToCents(a);
    const finalStatus: "u" | "c" | "r" = cleared
      ? (initial?.status === "r" ? "r" : "c")
      : "u";

    if (mode === "transfer") {
      if (!payee.trim() && !transferAccountId) return;
      if (!transferAccountId) return;
      if (Number(transferAccountId) === accountId) return;
      if (isBoundaryOutflow && (categoryId === "" || categoryId === "__deferred__" || categoryId == null)) {
        return;
      }
      const destName = otherAccounts.find((a) => a.id === Number(transferAccountId))?.name ?? "";
      let finalCatId: number | null = null;
      let incMonth: string | null = null;
      if (isTransferBoundary) {
        if (isBoundaryOutflow) {
          finalCatId = Number(categoryId);
        } else {
          const isDeferred = categoryId === "__deferred__";
          finalCatId = categoryId === "" || isDeferred ? null : Number(categoryId);
          incMonth = isDeferred ? (incomeMonth || nextMonthKey(date.slice(0, 7))) : null;
        }
      }
      onSave({
        id: initial?.id,
        accountId,
        categoryId: finalCatId,
        date,
        payee: payee.trim() || `Transfer : ${destName}`,
        memo: memo.trim(),
        amount: amountCents,
        status: finalStatus,
        flagColor: savedFlagColor,
        transferAccountId: Number(transferAccountId),
        incomeMonth: incMonth,
      });
      return;
    }

    if (mode === "split") {
      if (!payee.trim()) return;
      if (subValidation) return;
      onSave({
        id: initial?.id,
        accountId,
        categoryId: null,
        date,
        payee: payee.trim(),
        memo: memo.trim(),
        amount: amountCents,
        status: finalStatus,
        flagColor: savedFlagColor,
        subTransactions: subRows.map((r) => {
          const dest = r.transferAccountId ? otherAccounts.find((a) => a.id === r.transferAccountId) : null;
          const isBoundary = dest != null && Boolean(selectedAccount?.onBudget) !== Boolean(dest.onBudget);
          let finalCatId: number | null = null;
          if (r.transferAccountId) {
            finalCatId = isBoundary ? (r.categoryId ? Number(r.categoryId) : null) : null;
          } else if (isOffBudget) {
            finalCatId = null;
          } else {
            finalCatId = r.categoryId ? Number(r.categoryId) : null;
          }
          return {
            id: r.id,
            payee: r.payee,
            categoryId: finalCatId,
            transferAccountId: r.transferAccountId ?? null,
            amount: dollarsToCents(evalAmount(r.amount)),
            memo: r.memo,
          };
        }),
      });
      return;
    }

    // single
    if (!payee.trim()) return;
    const isDeferred = !isOffBudget && categoryId === "__deferred__";
    const finalCatId = isOffBudget || categoryId === "" || isDeferred ? null : Number(categoryId);
    const incMonth = isDeferred ? (incomeMonth || nextMonthKey(date.slice(0, 7))) : null;

    onSave({
      id: initial?.id,
      accountId,
      categoryId: finalCatId,
      date,
      payee: payee.trim(),
      memo: memo.trim(),
      amount: amountCents,
      status: finalStatus,
      flagColor: savedFlagColor,
      incomeMonth: incMonth,
    });
  };

  const canSave = (() => {
    const evaled = evalAmount(amount);
    if (evaled == null || Number.isNaN(evaled) || dollarsToCents(evaled) === 0 || !accountId) return false;
    if (mode === "transfer") {
      if (!transferAccountId || Number(transferAccountId) === accountId) return false;
      if (isBoundaryOutflow) {
        return categoryId !== "" && categoryId !== "__deferred__" && categoryId != null;
      }
      return true;
    }
    if (mode === "split") {
      const hasInvalidBoundaryChild = subRows.some((r) => {
        if (!r.transferAccountId) return false;
        const dest = otherAccounts.find((a) => a.id === r.transferAccountId);
        if (!dest) return false;
        const isBoundary = Boolean(selectedAccount?.onBudget) !== Boolean(dest.onBudget);
        if (!isBoundary) return false;
        const rAmount = dollarsToCents(evalAmount(r.amount));
        const netDelta = (selectedAccount?.onBudget ? rAmount : 0) + (dest.onBudget ? -rAmount : 0);
        if (netDelta <= 0) {
          return !r.categoryId;
        }
        return false;
      });
      if (hasInvalidBoundaryChild) return false;
      return Boolean(payee.trim()) && subValidation === null;
    }
    return Boolean(payee.trim());
  })();

  return (
    <Modal
      wide={!confirmingDelete && !confirmingUnreconcile && mode === "split"}
      title={
        confirmingDelete
          ? initial?.payee?.trim()
            ? `Delete "${initial.payee.trim()}"?`
            : "Delete Transaction?"
          : confirmingUnreconcile
            ? "Unreconcile Transaction?"
            : initial
              ? "Edit Transaction"
              : "Add Transaction"
      }
      onClose={onClose}
      footer={
        confirmingDelete ? (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                Cancel
              </Btn>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn variant="danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? "Deleting" : "Yes, delete it"}
              </Btn>
            </div>
          </>
        ) : confirmingUnreconcile ? (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={() => setConfirmingUnreconcile(false)}>
                Cancel
              </Btn>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn
                variant="danger"
                onClick={() => {
                  setCleared(false);
                  setConfirmingUnreconcile(false);
                }}
              >
                Yes, unreconcile
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={onClose}>Cancel</Btn>
              {isEdit && onDelete && (
                <Btn variant="danger" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </Btn>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn variant="primary" onClick={save} disabled={!canSave}>
                {initial ? "Save Changes" : "Save Transaction"}
              </Btn>
            </div>
          </>
        )
      }
    >
      {confirmingDelete ? (
        <div className="space-y-2 text-[12.5px] leading-relaxed" style={{ color: "var(--y-ink)" }}>
          <p>
            Are you sure you want to delete this transaction{initial?.payee ? <> (<strong>{initial.payee}</strong>)</> : null}?
          </p>
          {isInitialTransfer ? (
            <Notice tone="warn" title="Linked transfer">
              Deleting this transfer will also remove the corresponding transaction in the linked account.
            </Notice>
          ) : isInitialSplit ? (
            <Notice tone="warn" title="Split transaction">
              Deleting this transaction will also delete all of its {initialChildren?.length ?? 0} sub-transactions.
            </Notice>
          ) : (
            <p className="y-hint text-[11.5px]">This transaction will be permanently removed.</p>
          )}
        </div>
      ) : confirmingUnreconcile ? (
        <div className="space-y-2 text-[12.5px] leading-relaxed" style={{ color: "var(--y-ink)" }}>
          <p>
            Are you sure you want to mark this transaction as uncleared?
          </p>
          <Notice tone="warn" title="Past reconciliation affected">
            Unreconciling a transaction will affect past reconciliation rounds.
          </Notice>
        </div>
      ) : (
        <>
          <div className="y-seg mb-3 w-full">
            {(["single", "transfer", "split"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? "primary" : "default"}
                active={mode === m}
                onClick={() => switchingMode(m)}
                className="flex-1 capitalize"
                disabled={(!!isInitialSplit && m === "single") || (!!isInitialTransfer && m !== "transfer")}
              >
                {m === "single" ? "Single" : m === "transfer" ? "Transfer" : "Split"}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
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
              />
            </Field>
            <Field label={mode === "split" ? "Total Amount" : "Amount"}>
              <TextField
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                autoFocus
                className={inputClass}
              />
              <AmountPreview value={amount} />
            </Field>
          </div>

          {mode !== "transfer" && (
            <Field label="Payee">
              <SearchList
                value={payee}
                onChange={setPayee}
                options={payees}
                allowCreate
                placeholder="e.g. Whole Foods"
                className={inputClass}
              />
            </Field>
          )}

          <div className={mode === "single" && isOffBudget ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3"}>
            <Field label="Account">
              <Select
                value={accountId}
                onChange={(v) => setAccountId(Number(v))}
                className="w-full"
                searchable
                disabled={mode === "transfer"}
              >
                {availableAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
            </Field>
            {mode === "transfer" ? (
              <Field label="Transfer to">
                <Select
                  value={transferAccountId}
                  onChange={(v) => setTransferAccountId(v === "" ? "" : Number(v))}
                  className="w-full"
                  searchable
                  disabled={isInitialTransfer}
                >
                  <option value="" disabled>Select account…</option>
                  {otherAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </Select>
              </Field>
            ) : mode === "split" ? null : isOffBudget ? null : (
              <Field label="Category">
                <Select
                  value={categoryId}
                  onChange={(v) => setCategoryId(v === "" || v === "__deferred__" ? v : Number(v))}
                  className="w-full"
                  searchable
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
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))
                  )}
                </Select>
              </Field>
            )}
          </div>

          {mode === "single" && !isOffBudget && categoryId === "__deferred__" && (
            <Field label="Deferred to month">
              <TextField
                type="month"
                value={incomeMonth}
                onChange={(e) => setIncomeMonth(e.target.value)}
                className={inputClass}
              />
            </Field>
          )}

          {mode === "transfer" && isTransferBoundary && (
            <Field label={isBoundaryOutflow ? "Category (required for boundary transfer outflow)" : "Category"}>
              <Select
                value={categoryId}
                onChange={(v) => setCategoryId(v === "" || v === "__deferred__" ? v : Number(v))}
                className="w-full"
                searchable
              >
                {isBoundaryOutflow ? (
                  <option value="" disabled>Select category…</option>
                ) : (
                  <>
                    <option value="">Income: Available this month</option>
                    <option value="__deferred__">Income: Available next month</option>
                  </>
                )}
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
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))
                )}
              </Select>
            </Field>
          )}

          {mode === "transfer" && isTransferBoundary && !isBoundaryOutflow && categoryId === "__deferred__" && (
            <Field label="Deferred to month">
              <TextField
                type="month"
                value={incomeMonth}
                onChange={(e) => setIncomeMonth(e.target.value)}
                className={inputClass}
              />
            </Field>
          )}

          {mode === "transfer" && (
            <Field label="Payee (auto-generated, override optional)">
              <SearchList
                value={
                  payee.startsWith("Transfer : ")
                    ? `Transfer : ${otherAccounts.find((a) => a.id === Number(transferAccountId))?.name ?? ""}`
                    : payee
                }
                onChange={setPayee}
                options={payees}
                allowCreate
                placeholder={
                  transferAccountId
                    ? `Transfer : ${otherAccounts.find((a) => a.id === Number(transferAccountId))?.name ?? ""}`
                    : "Transfer : <other account>"
                }
                className={inputClass}
              />
            </Field>
          )}

          {mode === "split" && (
            <div className="mt-1">
              <div className="y-label mb-1.5 block">Sub-transactions</div>
              <div className="space-y-1.5">
                {subRows.map((row, i) => {
                  const targetAcc = row.transferAccountId ? otherAccounts.find((a) => a.id === row.transferAccountId) : null;
                  const isRowBoundary = targetAcc != null && Boolean(selectedAccount?.onBudget) !== Boolean(targetAcc.onBudget);
                  const rowAmtCents = dollarsToCents(evalAmount(row.amount));
                  const rowNetOnBudget = isRowBoundary
                    ? (selectedAccount?.onBudget ? rowAmtCents : 0) + (targetAcc?.onBudget ? -rowAmtCents : 0)
                    : 0;
                  const isRowBoundaryOutflow = isRowBoundary && rowNetOnBudget <= 0;

                  const selectValue = row.transferAccountId
                    ? `transfer:${row.transferAccountId}`
                    : row.categoryId
                      ? `category:${row.categoryId}`
                      : "";
                  return (
                    <div key={i} className="space-y-1">
                      <div className="grid grid-cols-[1fr_1fr_92px_28px] gap-2 items-start">
                        <Select
                          value={selectValue}
                          onChange={(v) => {
                            if (v.startsWith("transfer:")) {
                              const nextAcc = Number(v.slice("transfer:".length));
                              const target = otherAccounts.find((a) => a.id === nextAcc);
                              const isBoundary = target != null && Boolean(selectedAccount?.onBudget) !== Boolean(target.onBudget);
                              setSubRows((rs) =>
                                rs.map((r, j) =>
                                  i === j
                                    ? { ...r, transferAccountId: nextAcc, categoryId: isBoundary ? r.categoryId : null }
                                    : r
                                )
                              );
                            } else if (v.startsWith("category:")) {
                              const nextCat = Number(v.slice("category:".length));
                              setSubRows((rs) =>
                                rs.map((r, j) =>
                                  i === j
                                    ? { ...r, categoryId: nextCat, transferAccountId: null }
                                    : r
                                )
                              );
                            } else {
                              setSubRows((rs) =>
                                rs.map((r, j) =>
                                  i === j
                                    ? { ...r, categoryId: null, transferAccountId: null }
                                    : r
                                )
                              );
                            }
                          }}
                          className="w-full"
                          searchable
                        >
                          <option value="">Category or Transfer…</option>
                          {!isOffBudget && (groups && groups.length > 0 ? (
                            groups.map((g) => (
                              <optgroup key={g.id} label={g.name}>
                                {categories
                                  .filter((c) => c.groupId === g.id)
                                  .map((c) => (
                                    <option key={c.id} value={`category:${c.id}`}>
                                      {c.name}
                                    </option>
                                  ))}
                              </optgroup>
                            ))
                          ) : (
                            <optgroup label="Categories">
                              {categories.map((c) => (
                                <option key={c.id} value={`category:${c.id}`}>
                                  {c.name}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                          <optgroup label="Transfers">
                            {otherAccounts.map((a) => (
                              <option key={a.id} value={`transfer:${a.id}`}>
                                Transfer : {a.name}
                              </option>
                            ))}
                          </optgroup>
                        </Select>
                        <TextField
                          value={row.memo ?? ""}
                          onChange={(e) => {
                            const memoVal = e.target.value;
                            setSubRows((rs) =>
                              rs.map((r, j) => (i === j ? { ...r, memo: memoVal } : r))
                            );
                          }}
                          placeholder="Memo"
                          className={inputClass}
                          aria-label={`Sub-transaction ${i + 1} memo`}
                        />
                        <TextField
                          value={row.amount}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSubRows((rs) =>
                              rs.map((r, j) => (i === j ? { ...r, amount: val } : r))
                            );
                          }}
                          placeholder="0.00"
                          inputMode="decimal"
                          className={inputClass}
                          aria-label={`Sub-transaction ${i + 1} amount`}
                        />
                        <button
                          type="button"
                          aria-label="Remove sub-transaction"
                          className="y-btn y-btn--default px-2 py-[3px] text-[12px]"
                          onClick={() =>
                            setSubRows((rs) => (rs.length > 2 ? rs.filter((_, j) => j !== i) : rs))
                          }
                          disabled={subRows.length <= 2}
                        >
                          ×
                        </button>
                      </div>
                      {isRowBoundary && (
                        <div className="pl-2">
                          <Field label={isRowBoundaryOutflow ? "Category (required for boundary transfer outflow)" : "Category"}>
                            <Select
                              value={row.categoryId ?? ""}
                              onChange={(v) => {
                                const nextCat = v === "" || v === "__deferred__" ? null : Number(v);
                                setSubRows((rs) =>
                                  rs.map((r, j) => (i === j ? { ...r, categoryId: nextCat } : r))
                                );
                              }}
                              className="w-full"
                              searchable
                            >
                              {isRowBoundaryOutflow ? (
                                <option value="" disabled>Select category…</option>
                              ) : (
                                <option value="">Income: Available this month</option>
                              )}
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
                                  <option key={c.id} value={c.id}>{c.name}</option>
                                ))
                              )}
                            </Select>
                          </Field>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Button
                  size="sm"
                  onClick={() =>
                    setSubRows((rs) => [...rs, { categoryId: null, transferAccountId: null, amount: "", memo: "" }])
                  }
                >
                  + Add sub-transaction
                </Button>
                <span
                  className="ml-auto text-[11.5px] y-num"
                  style={{
                    color:
                      Math.abs(dollarsToCents(subTotal) - dollarsToCents(parentAmount)) === 0
                        ? "var(--y-green-dk)"
                        : "var(--y-red)",
                    fontWeight: 700,
                  }}
                >
                  Σ {subTotal.toFixed(2)} / {parentAmount.toFixed(2)}
                </span>
              </div>
              {subValidation && (
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: "var(--y-red)" }}
                >
                  {subValidation}
                </div>
              )}
            </div>
          )}

          <Field label="Memo">
            <TextField
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Optional notes"
              className={inputClass}
            />
          </Field>

          <div className="pt-1">
            <Checkbox
              checked={cleared}
              onChange={(nextChecked) => {
                if (!nextChecked && initial?.status === "r") {
                  setConfirmingUnreconcile(true);
                } else {
                  setCleared(nextChecked);
                }
              }}
              label="Cleared (bank has processed this)"
            />
          </div>

          <div className="pt-1 flex items-center gap-2">
            <span className="y-label">Flag</span>
            {isDuplicateFlag ? (
              <span className="flex items-center gap-2">
                <span className="y-cleared y-cleared--duplicate">D</span>
                <span className="y-hint">
                  Duplicate — remove one of the matching transactions and rerun
                  the duplicate check to clear this flag.
                </span>
              </span>
            ) : (
              <FlagPicker
                value={pickerFlagColor}
                onChange={(c) => setFlagColor(c)}
                disabled={initial?.status === "r"}
              />
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

export function CategoryModal({
  initial,
  transactionCount = 0,
  otherCategories = [],
  groups,
  onClose,
  onSave,
  onDelete,
}: {
  initial?: Category;
  transactionCount?: number;
  otherCategories?: Category[];
  groups?: CategoryGroup[];
  onClose: () => void;
  onSave: (v: { name: string; goalTarget: number | null; carryover?: number; overspendCarriesOver?: boolean }) => void;
  onDelete?: (opts?: { moveToCategoryId?: number }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [hasGoal, setHasGoal] = useState(!!initial?.goalTarget);
  const initGoal = initial?.goalTarget ? num(initial.goalTarget) / 100 : 0;
  const [goal, setGoal] = useState(initGoal !== 0 ? initGoal.toFixed(2) : "");
  const initCarryover = initial?.carryover ? num(initial.carryover) / 100 : 0;
  const [hasCarryover, setHasCarryover] = useState(initCarryover !== 0);
  const [carryover, setCarryover] = useState(
    initCarryover !== 0 ? initCarryover.toFixed(2) : ""
  );
  const [overspendCarriesOver, setOverspendCarriesOver] = useState(
    Boolean(initial?.overspendCarriesOver)
  );

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moveToCategoryId, setMoveToCategoryId] = useState<number | "">(
    otherCategories[0]?.id ?? ""
  );

  const confirmDelete = async () => {
    if (!onDelete) return;
    if (transactionCount > 0 && !moveToCategoryId) return;
    setDeleting(true);
    try {
      await onDelete(
        transactionCount > 0 ? { moveToCategoryId: Number(moveToCategoryId) } : undefined
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={
        confirmingDelete
          ? `Delete "${initial?.name}"?`
          : initial
            ? "Edit Category"
            : "New Category"
      }
      onClose={onClose}
      footer={
        confirmingDelete ? (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                Cancel
              </Btn>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn
                variant="danger"
                onClick={confirmDelete}
                disabled={deleting || (transactionCount > 0 && !moveToCategoryId)}
              >
                {deleting ? "Deleting" : "Yes, delete it"}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={onClose}>Cancel</Btn>
              {initial && onDelete && (
                <Btn variant="danger" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </Btn>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn
                variant="primary"
                onClick={() =>
                  name.trim() &&
                  onSave({
                    name: name.trim(),
                    goalTarget: hasGoal && evalAmount(goal) != null ? dollarsToCents(evalAmount(goal)) : null,
                    carryover: hasCarryover && evalAmount(carryover) != null ? dollarsToCents(evalAmount(carryover)) : 0,
                    overspendCarriesOver,
                  })
                }
              >
                Save
              </Btn>
            </div>
          </>
        )
      }
    >
      {confirmingDelete ? (
        <div className="space-y-3 text-[12.5px] leading-relaxed" style={{ color: "var(--y-ink)" }}>
          <p>
            Are you sure you want to delete <strong>{initial?.name}</strong>?
          </p>
          {transactionCount > 0 ? (
            <div>
              <Notice tone="warn" title="Existing transactions">
                This category is referenced by {transactionCount} transaction(s).
                Please select another category to reassign them to before deleting.
              </Notice>
              <div className="mt-3">
                <Field label="Move transactions to">
                  <Select
                    value={moveToCategoryId}
                    onChange={(v) => setMoveToCategoryId(v === "" ? "" : Number(v))}
                    className="w-full"
                    searchable
                  >
                    <option value="">Select replacement category…</option>
                    {groups && groups.length > 0 ? (
                      groups.map((g) => (
                        <optgroup key={g.id} label={g.name}>
                          {otherCategories
                            .filter((c) => c.groupId === g.id)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </optgroup>
                      ))
                    ) : (
                      otherCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))
                    )}
                  </Select>
                </Field>
              </div>
            </div>
          ) : (
            <p className="y-hint text-[11.5px]">This category has no transactions and will be removed.</p>
          )}
        </div>
      ) : (
        <>
          <Field label="Name">
            <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputClass} />
          </Field>
          <div className="mb-2">
            <Checkbox
              checked={hasGoal}
              onChange={setHasGoal}
              label="Set a funding goal"
            />
          </div>
          {hasGoal && (
            <Field label="Goal Target">
              <TextField
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="1000.00"
                inputMode="decimal"
                className={inputClass}
              />
              <AmountPreview value={goal} />
            </Field>
          )}
          <div className="mb-2">
            <Checkbox
              checked={hasCarryover}
              onChange={setHasCarryover}
              label="Set opening carryover balance"
            />
          </div>
          {hasCarryover && (
            <Field label="Carryover Amount">
              <TextField
                value={carryover}
                onChange={(e) => setCarryover(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className={inputClass}
              />
              <AmountPreview value={carryover} />
            </Field>
          )}
          <div className="mb-2">
            <Checkbox
              checked={overspendCarriesOver}
              onChange={setOverspendCarriesOver}
              label="Red Arrow: Carry negative balance over to next month"
            />
          </div>
        </>
      )}
    </Modal>
  );
}

export function GroupModal({
  initialName,
  onClose,
  onSave,
}: {
  initialName?: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  return (
    <Modal
      title={initialName ? "Rename Group" : "New Category Group"}
      onClose={onClose}
      footer={
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Btn onClick={onClose}>Cancel</Btn>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Btn
              variant="primary"
              onClick={() => name.trim() && onSave(name.trim())}
            >
              Save
            </Btn>
          </div>
        </>
      }
    >
      <Field label="Group Name">
        <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputClass} />
      </Field>
    </Modal>
  );
}

export function RecurringModal({
  accounts,
  categories,
  groups,
  payees,
  defaultAccountId,
  initialMode,
  initial,
  onClose,
  onSave,
  onPost,
}: {
  accounts: Account[];
  categories: Category[];
  groups?: CategoryGroup[];
  /** Existing payee names for the searchable payee field. */
  payees?: SearchListOption[];
  defaultAccountId?: number | null;
  initialMode?: "single" | "transfer" | "split";
  initial?: Recurring & { subTransactions?: RecurringSubTransaction[] };
  onClose: () => void;
  onSave: (v: {
    id?: number;
    accountId: number;
    categoryId: number | null;
    payee: string;
    memo?: string;
    amount: number;
    frequency: string;
    nextDate: string;
    active: boolean;
    flagColor?: TransactionFlagColor | null;
    transferAccountId?: number | null;
    subTransactions?: { categoryId: number | null; transferAccountId?: number | null; amount: number; memo?: string }[];
  }) => void;
  onPost?: (id: number, date?: string) => Promise<void>;
}) {
  const initialAmt = initial ? num(initial.amount) / 100 : 0;
  const initialChildren = initial?.subTransactions ?? [];

  const isInitialTransfer = !!initial?.transferAccountId;
  const isInitialSplit = !isInitialTransfer && initialChildren.length > 0;

  const [mode, setMode] = useState<"single" | "transfer" | "split">(
    isInitialTransfer ? "transfer" : isInitialSplit ? "split" : (initialMode ?? "single")
  );

  const availableAccounts = useMemo(() => {
    return accounts.filter((a) => !a.archived || a.id === initial?.accountId);
  }, [accounts, initial?.accountId]);

  const [accountId, setAccountId] = useState(
    initial?.accountId ?? defaultAccountId ?? availableAccounts[0]?.id ?? accounts[0]?.id ?? 0
  );
  const selectedAccount = useMemo(() => {
    return accounts.find((a) => a.id === accountId);
  }, [accounts, accountId]);
  const isOffBudget = selectedAccount ? !selectedAccount.onBudget : false;
  const [categoryId, setCategoryId] = useState<number | "">(initial?.categoryId ?? "");
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [flagColor, setFlagColor] = useState<TransactionFlagColor | null>(initial?.flagColor ?? null);
  const [amount, setAmount] = useState(initial ? initialAmt.toFixed(2) : "");
  const [frequency, setFrequency] = useState(initial?.frequency ?? "monthly");
  const [nextDate, setNextDate] = useState(initial?.nextDate ?? todayISO());
  const [active, setActive] = useState(initial?.active ?? true);

  // Transfer destination
  const [transferAccountId, setTransferAccountId] = useState<number | "">(
    initial?.transferAccountId ?? ""
  );

  const transferDestAccount = useMemo(() => {
    return transferAccountId ? accounts.find((a) => a.id === Number(transferAccountId)) : null;
  }, [accounts, transferAccountId]);

  const isTransferBoundary =
    mode === "transfer" &&
    transferDestAccount != null &&
    Boolean(selectedAccount?.onBudget) !== Boolean(transferDestAccount.onBudget);

  const transferAmountCents = dollarsToCents(evalAmount(amount));
  const srcOnBudget = Boolean(selectedAccount?.onBudget);
  const destOnBudget = Boolean(transferDestAccount?.onBudget);
  const transferNetOnBudgetDelta = isTransferBoundary
    ? (srcOnBudget ? transferAmountCents : 0) + (destOnBudget ? -transferAmountCents : 0)
    : 0;
  const isBoundaryOutflow = isTransferBoundary && transferNetOnBudgetDelta <= 0;

  // Split sub-rows
  const [subRows, setSubRows] = useState<DraftSubRow[]>(
    initialChildren.length > 0
      ? initialChildren.map((c) => ({
          categoryId: c.categoryId,
          transferAccountId: c.transferAccountId ?? null,
          amount: (num(c.amount) / 100).toFixed(2),
          memo: c.memo ?? "",
        }))
      : [
          { categoryId: null, transferAccountId: null, amount: "", memo: "" },
          { categoryId: null, transferAccountId: null, amount: "", memo: "" },
        ]
  );

  const otherAccounts = availableAccounts.filter((a) => a.id !== accountId);

  // Signed parent amount and signed child total in dollars for UI display
  const parentAmount = evalAmount(amount) ?? 0;
  const subTotal = subRows.reduce((s, r) => s + (evalAmount(r.amount) ?? 0), 0);
  const subValidation = useMemo(() => {
    if (mode !== "split") return null;
    const parentCents = dollarsToCents(parentAmount);
    try {
      assertSplitsBalanced(
        parentCents,
        subRows.map((r) => ({
          ...r,
          amount: dollarsToCents(evalAmount(r.amount)),
        }))
      );
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [mode, parentAmount, subRows]);

  const switchingMode = (next: "single" | "transfer" | "split") => {
    setMode(next);
    if (next === "single") {
      setTransferAccountId("");
      setSubRows([
        { categoryId: null, transferAccountId: null, amount: "", memo: "" },
        { categoryId: null, transferAccountId: null, amount: "", memo: "" },
      ]);
    } else if (next === "transfer") {
      if (!isInitialTransfer) {
        setCategoryId("");
      }
      setSubRows([
        { categoryId: null, transferAccountId: null, amount: "", memo: "" },
        { categoryId: null, transferAccountId: null, amount: "", memo: "" },
      ]);
    } else {
      setTransferAccountId("");
      setCategoryId("");
    }
  };

  const save = () => {
    const a = evalAmount(amount);
    if (a == null || !accountId) return;
    const amountCents = dollarsToCents(a);

    if (mode === "transfer") {
      if (!transferAccountId) return;
      if (Number(transferAccountId) === accountId) return;
      if (isBoundaryOutflow && (categoryId === "" || categoryId == null)) {
        return;
      }
      const destName = otherAccounts.find((x) => x.id === Number(transferAccountId))?.name ?? "";
      let finalCatId: number | null = null;
      if (isTransferBoundary) {
        if (isBoundaryOutflow) {
          finalCatId = Number(categoryId);
        } else {
          finalCatId = categoryId === "" ? null : Number(categoryId);
        }
      }
      onSave({
        id: initial?.id,
        accountId,
        categoryId: finalCatId,
        payee: payee.trim() || `Transfer : ${destName}`,
        memo: memo.trim(),
        amount: amountCents,
        frequency,
        nextDate,
        active,
        flagColor,
        transferAccountId: Number(transferAccountId),
      });
      return;
    }

    if (mode === "split") {
      if (!payee.trim()) return;
      if (subValidation) return;
      onSave({
        id: initial?.id,
        accountId,
        categoryId: null,
        payee: payee.trim(),
        memo: memo.trim(),
        amount: amountCents,
        frequency,
        nextDate,
        active,
        flagColor,
        subTransactions: subRows.map((r) => {
          const dest = r.transferAccountId ? otherAccounts.find((a) => a.id === r.transferAccountId) : null;
          const isBoundary = dest != null && Boolean(selectedAccount?.onBudget) !== Boolean(dest.onBudget);
          let finalCatId: number | null = null;
          if (r.transferAccountId) {
            finalCatId = isBoundary ? (r.categoryId ? Number(r.categoryId) : null) : null;
          } else if (isOffBudget) {
            finalCatId = null;
          } else {
            finalCatId = r.categoryId ? Number(r.categoryId) : null;
          }
          return {
            categoryId: finalCatId,
            transferAccountId: r.transferAccountId ?? null,
            amount: dollarsToCents(evalAmount(r.amount)),
            memo: r.memo,
          };
        }),
      });
      return;
    }

    // single
    if (!payee.trim()) return;
    onSave({
      id: initial?.id,
      accountId,
      categoryId: isOffBudget || categoryId === "" ? null : Number(categoryId),
      payee: payee.trim(),
      memo: memo.trim(),
      amount: amountCents,
      frequency,
      nextDate,
      active,
      flagColor,
    });
  };

  const canSave = (() => {
    const evaled = evalAmount(amount);
    if (evaled == null || Number.isNaN(evaled) || dollarsToCents(evaled) === 0 || !accountId) return false;
    if (mode === "transfer") {
      if (!transferAccountId || Number(transferAccountId) === accountId) return false;
      if (isBoundaryOutflow) {
        return categoryId !== "" && categoryId != null;
      }
      return true;
    }
    if (mode === "split") {
      const hasInvalidBoundaryChild = subRows.some((r) => {
        if (!r.transferAccountId) return false;
        const dest = otherAccounts.find((a) => a.id === r.transferAccountId);
        if (!dest) return false;
        const isBoundary = Boolean(selectedAccount?.onBudget) !== Boolean(dest.onBudget);
        if (!isBoundary) return false;
        const rAmount = dollarsToCents(evalAmount(r.amount));
        const netDelta = (selectedAccount?.onBudget ? rAmount : 0) + (dest.onBudget ? -rAmount : 0);
        if (netDelta <= 0) {
          return !r.categoryId;
        }
        return false;
      });
      if (hasInvalidBoundaryChild) return false;
      return Boolean(payee.trim()) && subValidation === null;
    }
    return Boolean(payee.trim());
  })();

  return (
    <Modal
      wide={mode === "split"}
      title={initial ? "Edit Recurring Transaction" : "Add Recurring Transaction"}
      onClose={onClose}
      footer={
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Btn onClick={onClose}>Cancel</Btn>
            {initial && onPost && (
              <Btn
                variant="primary"
                onClick={async () => {
                  await onPost(initial.id);
                  onClose();
                }}
              >
                Enter Now
              </Btn>
            )}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Btn variant="primary" onClick={save} disabled={!canSave}>
              {initial ? "Save Changes" : "Save"}
            </Btn>
          </div>
        </>
      }
    >
      <div className="y-seg mb-3 w-full">
        {(["single", "transfer", "split"] as const).map((m) => (
          <Button
            key={m}
            size="sm"
            variant={mode === m ? "primary" : "default"}
            active={mode === m}
            onClick={() => switchingMode(m)}
            className="flex-1 capitalize"
            disabled={!!isInitialSplit && m === "single"}
          >
            {m === "single" ? "Single" : m === "transfer" ? "Transfer" : "Split"}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={mode === "split" ? "Total" : "Amount"}>
          <TextField
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            className={inputClass}
          />
          <AmountPreview value={amount} />
        </Field>
        <Field label="Frequency">
          <Select
            value={frequency}
            onChange={(v) => setFrequency(v)}
            className="w-full"
          >
            {RECURRING_FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {mode !== "transfer" && (
        <Field label="Payee">
          <SearchList
            value={payee}
            onChange={setPayee}
            options={payees}
            allowCreate
            placeholder="e.g. Whole Foods"
            className={inputClass}
          />
        </Field>
      )}

      <div className={mode === "single" && isOffBudget ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3"}>
        <Field label="Account">
          <Select
            value={accountId}
            onChange={(v) => setAccountId(Number(v))}
            className="w-full"
            searchable
            disabled={mode === "transfer"}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </Field>
        {mode === "transfer" ? (
          <Field label="Transfer to">
            <Select
              value={transferAccountId}
              onChange={(v) => setTransferAccountId(v === "" ? "" : Number(v))}
              className="w-full"
              searchable
            >
              <option value="" disabled>Select account…</option>
              {otherAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </Field>
        ) : mode === "split" ? null : isOffBudget ? null : (
          <Field label="Category">
            <Select
              value={categoryId}
              onChange={(v) => setCategoryId(v === "" ? "" : Number(v))}
              className="w-full"
              searchable
            >
              <option value="">Uncategorized</option>
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
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))
              )}
            </Select>
          </Field>
        )}
      </div>

      {mode === "transfer" && isTransferBoundary && (
        <Field label={isBoundaryOutflow ? "Category (required for boundary transfer outflow)" : "Category"}>
          <Select
            value={categoryId}
            onChange={(v) => setCategoryId(v === "" ? "" : Number(v))}
            className="w-full"
            searchable
          >
            {isBoundaryOutflow ? (
              <option value="" disabled>Select category…</option>
            ) : (
              <option value="">Income: Available this month</option>
            )}
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
                <option key={c.id} value={c.id}>{c.name}</option>
              ))
            )}
          </Select>
        </Field>
      )}

      {mode === "transfer" && (
        <Field label="Payee (auto-generated, override optional)">
          <SearchList
            value={payee}
            onChange={setPayee}
            options={payees}
            allowCreate
            placeholder={
              transferAccountId
                ? `Transfer : ${otherAccounts.find((a) => a.id === Number(transferAccountId))?.name ?? ""}`
                : "Transfer : <other account>"
            }
            className={inputClass}
          />
        </Field>
      )}

      {mode === "split" && (
        <div className="mt-1">
          <div className="y-label mb-1.5 block">Sub-transactions</div>
          <div className="space-y-1.5">
            {subRows.map((row, i) => {
              const targetAcc = row.transferAccountId ? otherAccounts.find((a) => a.id === row.transferAccountId) : null;
              const isRowBoundary = targetAcc != null && Boolean(selectedAccount?.onBudget) !== Boolean(targetAcc.onBudget);
              const rowAmtCents = dollarsToCents(evalAmount(row.amount));
              const rowNetOnBudget = isRowBoundary
                ? (selectedAccount?.onBudget ? rowAmtCents : 0) + (targetAcc?.onBudget ? -rowAmtCents : 0)
                : 0;
              const isRowBoundaryOutflow = isRowBoundary && rowNetOnBudget <= 0;

              const selectValue = row.transferAccountId
                ? `transfer:${row.transferAccountId}`
                : row.categoryId
                  ? `category:${row.categoryId}`
                  : "";
              return (
                <div key={i} className="space-y-1">
                  <div className="grid grid-cols-[1fr_1fr_92px_28px] gap-2 items-start">
                    <Select
                      value={selectValue}
                      onChange={(v) => {
                        if (v.startsWith("transfer:")) {
                          const nextAcc = Number(v.slice("transfer:".length));
                          const target = otherAccounts.find((a) => a.id === nextAcc);
                          const isBoundary = target != null && Boolean(selectedAccount?.onBudget) !== Boolean(target.onBudget);
                          setSubRows((rs) =>
                            rs.map((r, j) =>
                              i === j
                                ? { ...r, transferAccountId: nextAcc, categoryId: isBoundary ? r.categoryId : null }
                                : r
                            )
                          );
                        } else if (v.startsWith("category:")) {
                          const nextCat = Number(v.slice("category:".length));
                          setSubRows((rs) =>
                            rs.map((r, j) =>
                              i === j
                                ? { ...r, categoryId: nextCat, transferAccountId: null }
                                : r
                            )
                          );
                        } else {
                          setSubRows((rs) =>
                            rs.map((r, j) =>
                              i === j
                                ? { ...r, categoryId: null, transferAccountId: null }
                                : r
                            )
                          );
                        }
                      }}
                      className="w-full"
                      searchable
                    >
                      <option value="">Category or Transfer…</option>
                      {!isOffBudget && (groups && groups.length > 0 ? (
                        groups.map((g) => (
                          <optgroup key={g.id} label={g.name}>
                            {categories
                              .filter((c) => c.groupId === g.id)
                              .map((c) => (
                                <option key={c.id} value={`category:${c.id}`}>
                                  {c.name}
                                </option>
                              ))}
                          </optgroup>
                        ))
                      ) : (
                        <optgroup label="Categories">
                          {categories.map((c) => (
                            <option key={c.id} value={`category:${c.id}`}>
                              {c.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      <optgroup label="Transfers">
                        {otherAccounts.map((a) => (
                          <option key={a.id} value={`transfer:${a.id}`}>
                            Transfer : {a.name}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                    <TextField
                      value={row.memo ?? ""}
                      onChange={(e) => {
                        const memoVal = e.target.value;
                        setSubRows((rs) =>
                          rs.map((r, j) => (i === j ? { ...r, memo: memoVal } : r))
                        );
                      }}
                      placeholder="Memo"
                      className={inputClass}
                      aria-label={`Sub-transaction ${i + 1} memo`}
                    />
                    <TextField
                      value={row.amount}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSubRows((rs) =>
                          rs.map((r, j) => (i === j ? { ...r, amount: val } : r))
                        );
                      }}
                      placeholder="0.00"
                      inputMode="decimal"
                      className={inputClass}
                      aria-label={`Sub-transaction ${i + 1} amount`}
                    />
                    <button
                      type="button"
                      aria-label="Remove sub-transaction"
                      className="y-btn y-btn--default px-2 py-[3px] text-[12px]"
                      onClick={() =>
                        setSubRows((rs) => (rs.length > 2 ? rs.filter((_, j) => j !== i) : rs))
                      }
                      disabled={subRows.length <= 2}
                    >
                      ×
                    </button>
                  </div>
                  {isRowBoundary && (
                    <div className="pl-2">
                      <Field label={isRowBoundaryOutflow ? "Category (required for boundary transfer outflow)" : "Category"}>
                        <Select
                          value={row.categoryId ?? ""}
                          onChange={(v) => {
                            const nextCat = v === "" ? null : Number(v);
                            setSubRows((rs) =>
                              rs.map((r, j) => (i === j ? { ...r, categoryId: nextCat } : r))
                            );
                          }}
                          className="w-full"
                          searchable
                        >
                          {isRowBoundaryOutflow ? (
                            <option value="" disabled>Select category…</option>
                          ) : (
                            <option value="">Income: Available this month</option>
                          )}
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
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))
                          )}
                        </Select>
                      </Field>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Button
              size="sm"
              onClick={() =>
                setSubRows((rs) => [...rs, { categoryId: null, transferAccountId: null, amount: "", memo: "" }])
              }
            >
              + Add sub-transaction
            </Button>
            <span
              className="ml-auto text-[11.5px] y-num"
              style={{
                color:
                  Math.abs(dollarsToCents(subTotal) - dollarsToCents(parentAmount)) === 0
                    ? "var(--y-green-dk)"
                    : "var(--y-red)",
                fontWeight: 700,
              }}
            >
              Σ {subTotal.toFixed(2)} / {parentAmount.toFixed(2)}
            </span>
          </div>
          {subValidation && (
            <div
              className="mt-1 text-[11px]"
              style={{ color: "var(--y-red)" }}
            >
              {subValidation}
            </div>
          )}
        </div>
      )}

      <Field label="Next Date">
        <TextField
          type="date"
          value={nextDate}
          onChange={(e) => setNextDate(e.target.value)}
          onKeyDown={(e) => {
            const adjusted = adjustDateShortcut(nextDate, e.key);
            if (adjusted) {
              e.preventDefault();
              setNextDate(adjusted);
            }
          }}
          className={inputClass}
        />
      </Field>

      {mode !== "split" && (
        <Field label="Memo">
          <TextField
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Optional notes"
            className={inputClass}
          />
        </Field>
      )}

      <div className="pt-1 flex items-center gap-2">
        <span className="y-label">Flag</span>
        <FlagPicker
          value={flagColor}
          onChange={(c) => setFlagColor(c)}
        />
      </div>

      <div className="pt-1">
        <Checkbox
          checked={active}
          onChange={setActive}
          label="Active"
        />
      </div>
    </Modal>
  );
}

export function AccountModal({
  initial,
  transactionCount,
  onClose,
  onSave,
  onDelete,
  onArchive,
  onUnarchive,
}: {
  initial?: Account;
  /** Number of transactions tied to this account. Used only in edit mode to size the delete confirm copy. */
  transactionCount?: number;
  onClose: () => void;
  onSave: (v: {
    name: string;
    kind: "liquid" | "credit" | "offbudget";
    groupLabel: string;
    balance: number;
    onBudget: boolean;
  }) => void;
  /** Edit-only. Triggers a two-step confirm panel; the caller wires the actual API call. */
  onDelete?: () => Promise<void>;
  onArchive?: () => Promise<void>;
  onUnarchive?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"liquid" | "credit" | "offbudget">(initial?.kind ?? "liquid");
  const [balance, setBalance] = useState(
    initial != null ? (Math.abs(num(initial.balance)) / 100).toFixed(2) : ""
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [unarchiving, setUnarchiving] = useState(false);

  useEffect(() => {
    setConfirmingDelete(false);
    setDeleting(false);
    setConfirmingArchive(false);
    setArchiving(false);
    setUnarchiving(false);
  }, [initial?.id]);

  const groupLabel = kind === "liquid" ? "Liquid" : kind === "credit" ? "Credit Cards" : "Retirement";
  const save = () => {
    if (!name.trim()) return;
    const b = evalAmount(balance) ?? 0;
    const bCents = dollarsToCents(b);
    const finalBalance = kind === "credit" ? -Math.abs(bCents) : bCents;
    onSave({ name: name.trim(), kind, groupLabel, balance: finalBalance, onBudget: kind !== "offbudget" });
  };
  const isEdit = !!initial;
  const isArchived = Boolean(initial?.archived);
  const txCount = transactionCount ?? 0;

  const confirmDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  const confirmArchive = async () => {
    if (!onArchive) return;
    setArchiving(true);
    try {
      await onArchive();
    } finally {
      setArchiving(false);
    }
  };

  const handleUnarchive = async () => {
    if (!onUnarchive) return;
    setUnarchiving(true);
    try {
      await onUnarchive();
    } finally {
      setUnarchiving(false);
    }
  };

  return (
    <Modal
      title={
        confirmingDelete
          ? `Delete "${initial?.name ?? "Account"}"?`
          : confirmingArchive
            ? `Archive "${initial?.name ?? "Account"}"?`
            : isEdit
              ? isArchived
                ? "Edit Account (Archived)"
                : "Edit Account"
              : "Add Account"
      }
      onClose={onClose}
      footer={
        confirmingDelete ? (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                Cancel
              </Btn>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn variant="danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? "Deleting" : "Yes, delete it"}
              </Btn>
            </div>
          </>
        ) : confirmingArchive ? (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={() => setConfirmingArchive(false)} disabled={archiving}>
                Cancel
              </Btn>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn variant="primary" onClick={confirmArchive} disabled={archiving}>
                {archiving ? "Archiving" : "Yes, archive it"}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={onClose}>Cancel</Btn>
              {isEdit && !isArchived && onArchive && (
                <Btn onClick={() => setConfirmingArchive(true)}>Archive account</Btn>
              )}
              {isEdit && isArchived && onUnarchive && (
                <Btn onClick={handleUnarchive} disabled={unarchiving}>
                  {unarchiving ? "Unarchiving" : "Unarchive account"}
                </Btn>
              )}
              {isEdit && onDelete && (
                <Btn variant="danger" onClick={() => setConfirmingDelete(true)}>
                  Delete account
                </Btn>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn variant="primary" onClick={save} disabled={!name.trim()}>
                {isEdit ? "Save Changes" : "Add Account"}
              </Btn>
            </div>
          </>
        )
      }
    >
      {confirmingDelete ? (
        <div className="space-y-2 text-[12.5px] leading-relaxed" style={{ color: "var(--y-ink)" }}>
          <p>
            Are you sure you want to delete <strong>{initial?.name}</strong>?
          </p>
          {txCount > 0 ? (
            <Notice tone="warn" title="Associated transactions will be removed">
              This account has {txCount} transaction{txCount === 1 ? "" : "s"}. Deleting it
              will permanently remove them and recalculate category balances.
            </Notice>
          ) : (
            <p className="y-hint text-[11.5px]">This account has no transactions and can be safely deleted.</p>
          )}
        </div>
      ) : confirmingArchive ? (
        <div className="space-y-2 text-[12.5px] leading-relaxed" style={{ color: "var(--y-ink)" }}>
          <p>
            Archive <strong>{initial?.name}</strong>?
          </p>
          <p className="y-hint text-[11.5px]">
            Archived accounts are hidden from the sidebar and new transaction dropdowns,
            but all transaction history and reports are preserved. You can unarchive it
            at any time.
          </p>
        </div>
      ) : (
        <>
          <Field label="Name">
            <TextField
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. TD Chequing"
              autoFocus
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Account Type">
              <Select
                value={kind}
                onChange={(v) => setKind(v as "liquid" | "credit" | "offbudget")}
                className="w-full"
                disabled={isEdit}
              >
                <option value="liquid">Checking / Savings / Cash</option>
                <option value="credit">Credit Card</option>
                <option value="offbudget">Tracking (Investment/Property)</option>
              </Select>
            </Field>
            <Field label="Starting Balance">
              <TextField
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className={inputClass}
                disabled={isEdit}
              />
              {!isEdit && <AmountPreview value={balance} />}
              {!isEdit && kind === "credit" && (
                <div className="y-hint text-[11px] pt-1">
                  Credit card balance represents debt owed (stored as a negative starting balance).
                </div>
              )}
            </Field>
          </div>
          {isEdit && (
            <div className="y-hint text-[11px] pt-1">
              Account type and starting balance are locked after creation. To adjust the
              working balance, add a transaction or use the Reconcile flow.
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
