"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import type {
  Account,
  Category,
  CategoryGroup,
  SplitTemplate,
  Transaction,
  TransactionDuplicateFlag,
  TransactionFlagColor,
  TransactionFormData,
  TransactionSavePayload,
} from "@ynab/logic";
import {
  adjustDateShortcut,
  assertSplitsBalanced,
  canBuildTransactionPayload,
  dollarsToCents,
  evalAmount,
  getSplitChildren,
  nextMonthKey,
  num,
  isValidISODate,
  todayISO,
  toTransactionPayload,
} from "@ynab/logic";
import { Button, TextField, Select, Notice, FlagPicker, SearchList, Icon, ClearedFlag, type SearchListOption } from "@ynab/theme";
import { Modal, Field, Btn } from "../ui.js";
import { AmountPreview, AmountFieldError, AmountFieldWithCalculator } from "../AmountInput.js";
import {
  DateFieldError,
  templateToSubRows,
  blankSubRow,
  fillSubRowDefaults,
  inputClass,
  type DraftSubRow,
} from "./shared.js";

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
  splitTemplates,
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
  /** Named split templates offered in split mode to pre-fill sub-rows. */
  splitTemplates?: SplitTemplate[];
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
    return children.length > 0 ? [...children].sort((a, b) => a.id - b.id) : undefined;
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

  // Last-used category per payee (excluding the row being edited), so
  // typing a known payee into a blank category auto-fills it YNAB4-style.
  const lastCategoryByPayee = useMemo(() => {
    const map = new Map<string, { date: string; id: number; categoryId: number }>();
    for (const t of allTransactions ?? []) {
      if (t.categoryId == null) continue;
      if (initial?.id != null && t.id === initial.id) continue;
      const key = (t.payee ?? "").trim();
      if (!key) continue;
      const prev = map.get(key);
      if (!prev || t.date > prev.date || (t.date === prev.date && t.id > prev.id)) {
        map.set(key, { date: t.date, id: t.id, categoryId: t.categoryId });
      }
    }
    return map;
  }, [allTransactions, initial?.id]);

  const isInitialDeferred =
    initial?.categoryId == null &&
    !!initial?.incomeMonth &&
    initial.incomeMonth > (initial.date ? initial.date.slice(0, 7) : "");
  const initialCategoryPick: number | "" | "__income__" | "__deferred__" =
    initial?.categoryId ??
    (isInitialDeferred
      ? "__deferred__"
      : initial
        ? initial.isIncome
          ? "__income__"
          : ""
        : "");
  const [categoryId, setCategoryId] = useState<number | "" | "__income__" | "__deferred__">(
    initialCategoryPick
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

  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const templateControlsLocked = initial?.status === "r";
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const templateMenuRef = useRef<HTMLSpanElement>(null);
  const hasTemplateMenu = splitTemplates != null && splitTemplates.length > 0 && !templateControlsLocked;

  // Close the template menu when the user clicks outside of it.
  useEffect(() => {
    if (!templateMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (templateMenuRef.current && !templateMenuRef.current.contains(e.target as Node)) {
        setTemplateMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [templateMenuOpen]);

  const applyTemplateById = (templateId: number) => {
    const template = splitTemplates?.find((t) => t.id === templateId);
    if (!template) return;
    const totalCents = dollarsToCents(evalAmount(amount));
    if (!Number.isInteger(totalCents) || totalCents === 0) {
      setTemplateNotice("Enter the total amount first, then apply the template.");
      return;
    }
    const rows = templateToSubRows(template, totalCents);
    if (!rows) {
      setTemplateNotice(`Template "${template.name}" is no longer valid.`);
      return;
    }
    setTemplateNotice(null);
    if (mode !== "split") switchingMode("split");
    // Smart apply: when already editing a split with the same number of
    // rows, a category or memo the user already set is kept instead of
    // being cleared by a template leg that leaves it unset ("choose when
    // applying"). The template still supplies the amounts (the split
    // ratio), transfer destinations, and any preset categories or memos.
    const merged =
      mode === "split" && subRows.length === rows.length
        ? rows.map((row, i) => {
            const prev = subRows[i]!;
            let next = row;
            if (next.categoryId == null) {
              const prevCategory = prev.categoryId;
              if (prevCategory != null && prevCategory !== "") {
                next = { ...next, categoryId: prevCategory };
              }
            }
            if (!next.memo) {
              const prevMemo = prev.memo;
              if (prevMemo != null && prevMemo !== "") {
                next = { ...next, memo: prevMemo };
              }
            }
            return next;
          })
        : rows;
    setSubRows(fillSubRowDefaults(merged, memo, payee));
  };

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
          categoryId: r.categoryId ? Number(r.categoryId) : null,
          transferAccountId: r.transferAccountId ? Number(r.transferAccountId) : null,
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
      const converting = mode !== "split";
      setSubRows((prev) => {
        const rows =
          prev.length >= 2
            ? prev
            : [blankSubRow(memo, payee), blankSubRow(memo, payee)];
        // Converting to a split defaults blank sub-rows from the parent's
        // memo/payee; re-clicking Split leaves existing rows untouched.
        return converting ? fillSubRowDefaults(rows, memo, payee) : rows;
      });
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

  const formData: TransactionFormData = {
    mode,
    id: initial?.id,
    accountId,
    categoryId,
    date,
    payee,
    memo,
    amount,
    cleared,
    flagColor,
    transferAccountId,
    incomeMonth,
    subRows,
  };
  const builderOptions = {
    accounts,
    initial,
  };

  const save = () => {
    const payload = toTransactionPayload(formData, builderOptions);
    if (payload) {
      onSave(payload);
    }
  };

  const canSave = canBuildTransactionPayload(formData, builderOptions);

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
            {(["single", "transfer"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? "primary" : "default"}
                active={mode === m}
                onClick={() => switchingMode(m)}
                className="flex-1 capitalize"
              >
                {m === "single" ? "Single" : "Transfer"}
              </Button>
            ))}
            {hasTemplateMenu ? (
              <span className="flex-1 flex" role="group" aria-label="Split" style={{ marginLeft: -1 }}>
                <Button
                  size="sm"
                  variant={mode === "split" ? "primary" : "default"}
                  active={mode === "split"}
                  onClick={() => switchingMode("split")}
                  className="flex-1 capitalize"
                  style={{ borderRadius: 0 }}
                >
                  Split
                </Button>
                <span className="relative flex" ref={templateMenuRef} style={{ marginLeft: -1 }}>
                  <Button
                    size="sm"
                    variant={mode === "split" ? "primary" : "default"}
                    active={mode === "split"}
                    onClick={() => setTemplateMenuOpen((o) => !o)}
                    aria-label="Choose split template"
                    aria-haspopup="menu"
                    aria-expanded={templateMenuOpen}
                    style={{ borderRadius: "0 3px 3px 0", paddingLeft: 6, paddingRight: 6 }}
                  >
                    <Icon name="chevronDown" size={12} />
                  </Button>
                  {templateMenuOpen && (
                    <span
                      role="menu"
                      aria-label="Split templates"
                      className="absolute right-0 top-full z-20 mt-1"
                      style={{
                        width: 220,
                        padding: 4,
                        background: "linear-gradient(var(--y-chrome-top), var(--y-chrome-bot))",
                        border: "1px solid var(--y-chrome-line)",
                        borderRadius: 4,
                        boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setTemplateMenuOpen(false);
                      }}
                    >
                      {splitTemplates!.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          role="menuitem"
                          className="y-menu-item"
                          style={{ width: "100%" }}
                          onClick={() => {
                            setTemplateMenuOpen(false);
                            applyTemplateById(t.id);
                          }}
                        >
                          {t.name}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              </span>
            ) : (
              <Button
                size="sm"
                variant={mode === "split" ? "primary" : "default"}
                active={mode === "split"}
                onClick={() => switchingMode("split")}
                className="flex-1 capitalize"
              >
                Split
              </Button>
            )}
          </div>
          {templateNotice && (
            <div className="mb-2 text-[11px]" style={{ color: "var(--y-red)" }}>
              {templateNotice}
            </div>
          )}

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
                aria-invalid={!isValidISODate(date)}
              />
              <DateFieldError value={date} />
            </Field>
            <Field label={mode === "split" ? "Total Amount" : "Amount"}>
              <AmountFieldWithCalculator
                value={amount}
                onChange={setAmount}
                autoFocus
                className={inputClass}
              />
              <AmountPreview value={amount} />
              <AmountFieldError value={amount} />
            </Field>
          </div>

          {mode !== "transfer" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Payee">
                <SearchList
                  value={payee}
                  onChange={(v) => {
                    setPayee(v);
                    // Single mode with a blank category: fill from the last
                    // time this payee was used (never overwrites a pick).
                    if (mode === "single" && !isOffBudget && categoryId === "") {
                      const hit = lastCategoryByPayee.get(v.trim());
                      if (hit) setCategoryId(hit.categoryId);
                    }
                  }}
                  options={payees}
                  allowCreate
                  placeholder="e.g. Whole Foods"
                  className={inputClass}
                />
              </Field>
              <Field label="Memo">
                <TextField
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="Optional notes"
                  className={inputClass}
                />
              </Field>
            </div>
          )}

          <div className={mode === "single" && isOffBudget ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3"}>
            <Field label="Account">
              <Select
                value={accountId}
                onChange={(v) => setAccountId(Number(v))}
                className="w-full"
                searchable
                disabled={mode === "transfer" || (isEdit && isInitialSplit)}
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
                  onChange={(v) =>
                    setCategoryId(
                      v === "" || v === "__income__" || v === "__deferred__" ? v : Number(v)
                    )
                  }
                  className="w-full"
                  searchable
                >
                  <option value="" disabled>Select category…</option>
                  {selectedAccount?.kind !== "credit" && (
                    <>
                      <option value="__income__">Income: Available this month</option>
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
                onChange={(v) =>
                  setCategoryId(
                    v === "" || v === "__income__" || v === "__deferred__" ? v : Number(v)
                  )
                }
                className="w-full"
                searchable
              >
                {isBoundaryOutflow ? (
                  <option value="" disabled>Select category…</option>
                ) : (
                  <>
                    <option value="" disabled>Select category…</option>
                    <option value="__income__">Income: Available this month</option>
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
            <div className="grid grid-cols-2 gap-3">
              <Field label="Payee">
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
              <Field label="Memo">
                <TextField
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="Optional notes"
                  className={inputClass}
                />
              </Field>
            </div>
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
                        <AmountFieldWithCalculator
                          value={row.amount}
                          onChange={(val) =>
                            setSubRows((rs) =>
                              rs.map((r, j) => (i === j ? { ...r, amount: val } : r))
                            )
                          }
                          className={inputClass}
                          ariaLabel={`Sub-transaction ${i + 1} amount`}
                          calculatorLabel={`Open calculator for sub-transaction ${i + 1}`}
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
                    setSubRows((rs) => [...rs, blankSubRow(memo, payee)])
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
            <span className="ml-auto flex items-center gap-2">
              <span className="y-label">Cleared</span>
              <ClearedFlag
                state={cleared ? "c" : "u"}
                onCycle={() => {
                  if (cleared && initial?.status === "r") {
                    setConfirmingUnreconcile(true);
                  } else {
                    setCleared(!cleared);
                  }
                }}
              />
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}
