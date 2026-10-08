"use client";

import { useMemo, useState } from "react";
import type {
  Account,
  Category,
  CategoryGroup,
  MergeableTransaction,
  MergedTransactionFields,
  MergeOverrides,
  Transaction,
  TransactionFlagColor,
} from "@ynab/logic";
import {
  adjustDateShortcut,
  dollarsToCents,
  evalAmount,
  isValidISODate,
  nextMonthKey,
  num,
  pickMergePrimary,
  resolveMergedTransaction,
  validateAmountInput,
} from "@ynab/logic";
import { ClearedFlag, FlagPicker, Notice, SearchList, Select, TextField, money, type SearchListOption } from "@ynab/theme";
import { Modal, Btn, Field } from "./ui.js";
import { AmountPreview, AmountFieldError } from "./AmountInput.js";

function toMergeable(t: Transaction): MergeableTransaction {
  return { ...t, transferAccountId: t.transferAccountId ?? null, amount: num(t.amount) };
}

function DateFieldError({ value }: { value: string }) {
  if (isValidISODate(value)) return null;
  return (
    <div role="alert" className="mt-1 text-[11px]" style={{ color: "var(--y-red)" }}>
      Enter a valid date.
    </div>
  );
}

const inputClass = "w-full py-[3px]";

type CategorySelect = number | "" | "__deferred__";

/**
 * Merge preview laid out like the split editor: the resulting
 * transaction on top (editable like a single transaction,
 * prepopulated from the resolution) and its two constituents below
 * (like sub-transactions).
 */
function MergeEditorModal({
  accounts,
  categories,
  groups,
  payees,
  ids,
  primary,
  secondary,
  merged,
  onClose,
  onConfirm,
}: {
  accounts: Account[];
  categories: Category[];
  groups?: CategoryGroup[];
  /** Existing payee names for the searchable payee field. */
  payees?: SearchListOption[];
  ids: number[];
  primary: MergeableTransaction;
  secondary: MergeableTransaction;
  merged: MergedTransactionFields;
  onClose: () => void;
  onConfirm: (ids: number[], overrides: MergeOverrides) => Promise<void> | void;
}) {
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a] as const)), [accounts]);
  const categoryById = useMemo(
    () => new Map(categories.map((c) => [c.id, c] as const)),
    [categories]
  );

  // The merged shape is fixed: no switching between single and
  // transfer here, only editing the resolved fields.
  const isTransfer = merged.transferAccountId != null;

  const initialCategorySelect: CategorySelect =
    merged.categoryId != null
      ? merged.categoryId
      : merged.incomeMonth && merged.incomeMonth > merged.date.slice(0, 7)
        ? "__deferred__"
        : "";
  const initialIncomeMonth = merged.incomeMonth ?? nextMonthKey(merged.date.slice(0, 7));

  const [date, setDate] = useState(merged.date);
  const [amount, setAmount] = useState((merged.amount / 100).toFixed(2));
  const [payee, setPayee] = useState(merged.payee);
  const [memo, setMemo] = useState(merged.memo);
  const [accountId, setAccountId] = useState(merged.accountId);
  const [categoryId, setCategoryId] = useState<CategorySelect>(initialCategorySelect);
  const [incomeMonth, setIncomeMonth] = useState(initialIncomeMonth);
  const [cleared, setCleared] = useState(merged.status === "c");
  const [flagColor, setFlagColor] = useState<TransactionFlagColor | null>(merged.flagColor);
  const [transferAccountId, setTransferAccountId] = useState<number | "">(
    merged.transferAccountId ?? ""
  );

  const selectedAccount = accountById.get(accountId);
  const isOffBudget = selectedAccount ? !selectedAccount.onBudget : false;
  const transferDestAccount =
    transferAccountId !== "" ? (accountById.get(transferAccountId) ?? null) : null;
  const isTransferBoundary =
    isTransfer &&
    transferDestAccount != null &&
    Boolean(selectedAccount?.onBudget) !== Boolean(transferDestAccount.onBudget);

  const transferAmountCents = dollarsToCents(evalAmount(amount));
  const srcOnBudget = Boolean(selectedAccount?.onBudget);
  const destOnBudget = Boolean(transferDestAccount?.onBudget);
  const transferNetOnBudgetDelta = isTransferBoundary
    ? (srcOnBudget ? transferAmountCents : 0) + (destOnBudget ? -transferAmountCents : 0)
    : 0;
  const isBoundaryOutflow = isTransferBoundary && transferNetOnBudgetDelta <= 0;

  // Category is hidden for off-budget rows and same-boundary
  // transfers (the server forces it to null there anyway).
  const showCategory = isTransfer ? isTransferBoundary : !isOffBudget;

  const amountValidation = validateAmountInput(amount);
  const amountCents = amountValidation.cents;
  const canSave =
    isValidISODate(date) &&
    amountValidation.status === "valid" &&
    (!isTransfer || transferAccountId !== "") &&
    (!isBoundaryOutflow || typeof categoryId === "number");

  const dateDirty = date !== merged.date;
  const amountDirty = amountCents != null && amountCents !== merged.amount;
  const payeeDirty = payee !== merged.payee;
  const memoDirty = memo !== merged.memo;
  const accountDirty = accountId !== merged.accountId;
  const clearedDirty = cleared !== (merged.status === "c");
  const flagDirty = flagColor !== merged.flagColor;
  const transferDirty =
    isTransfer && transferAccountId !== "" && transferAccountId !== merged.transferAccountId;
  const categorySelectDirty = categoryId !== initialCategorySelect;
  const deferredMonthDirty = categoryId === "__deferred__" && incomeMonth !== initialIncomeMonth;
  const categoryDirty = showCategory && (categorySelectDirty || deferredMonthDirty);

  const doMerge = async () => {
    if (merging || !canSave) return;
    const overrides: MergeOverrides = {};
    if (dateDirty) overrides.date = date;
    if (amountDirty && amountCents != null) overrides.amount = amountCents;
    if (payeeDirty) overrides.payee = payee;
    if (memoDirty) overrides.memo = memo;
    if (accountDirty) overrides.accountId = accountId;
    if (clearedDirty) overrides.status = cleared ? "c" : "u";
    if (flagDirty) overrides.flagColor = flagColor;
    if (transferDirty) {
      overrides.transferAccountId = transferAccountId as number;
    }
    if (categoryDirty) {
      overrides.categoryId =
        categoryId === "" || categoryId === "__deferred__" ? null : categoryId;
      overrides.incomeMonth = categoryId === "__deferred__" ? incomeMonth || null : null;
    }
    setMerging(true);
    setError(null);
    try {
      await onConfirm(ids, overrides);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setMerging(false);
    }
  };

  const availableAccounts = useMemo(
    () => accounts.filter((a) => !a.archived || a.id === merged.accountId),
    [accounts, merged.accountId]
  );
  const otherAccounts = availableAccounts.filter((a) => a.id !== accountId);

  const changeTransferDestination = (next: number) => {
    setTransferAccountId(next);
    // A "Transfer : <old>" payee follows the destination so the saved
    // row never names the wrong account.
    if (payee.startsWith("Transfer : ")) {
      const dest = accountById.get(next);
      setPayee(`Transfer : ${dest?.name ?? ""}`);
    }
  };

  const payeeDisplay =
    isTransfer && payee.startsWith("Transfer : ")
      ? `Transfer : ${transferDestAccount?.name ?? ""}`
      : payee;

  const categoryOptions = (allowIncome: boolean) => (
    <>
      {allowIncome ? (
        <>
          <option value="">Income: Available this month</option>
          <option value="__deferred__">Income: Available next month</option>
        </>
      ) : (
        <option value="" disabled>
          Select category…
        </option>
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
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))
      )}
    </>
  );

  const categoryName = (id: number | null) =>
    id == null ? null : (categoryById.get(id)?.name ?? "Unknown category");

  const constituents = [primary, secondary];

  return (
    <Modal
      wide
      title="Merge transactions"
      onClose={() => !merging && onClose()}
      footer={
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Btn onClick={onClose} disabled={merging}>
              Cancel
            </Btn>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Btn variant="primary" onClick={doMerge} disabled={!canSave || merging}>
              {merging ? "Merging" : "Merge transactions"}
            </Btn>
          </div>
        </>
      }
    >
      {error && (
        <Notice tone="danger" title="Merge failed">
          {error}
        </Notice>
      )}
      <p className="y-hint text-[12px] leading-relaxed mb-3">
        These 2 transactions will be combined into one. Review and edit the result — imported data
        wins; manual details fill the gaps.
      </p>

      <div data-testid="merge-result">
        <div className="y-label mb-1.5 block">Resulting transaction</div>

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
          <Field label="Amount">
            <TextField
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              className={inputClass}
            />
            <AmountPreview value={amount} />
            <AmountFieldError value={amount} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Payee">
            <SearchList
              value={payeeDisplay}
              onChange={setPayee}
              options={payees}
              allowCreate
              placeholder={
                isTransfer
                  ? `Transfer : ${transferDestAccount?.name ?? "<other account>"}`
                  : "e.g. Whole Foods"
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

        <div
          className={isTransfer || showCategory ? "grid grid-cols-2 gap-3" : "grid grid-cols-1 gap-3"}
        >
          <Field label="Account">
            <Select
              value={accountId}
              onChange={(v) => setAccountId(Number(v))}
              className="w-full"
              searchable
              disabled={isTransfer}
            >
              {availableAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          {isTransfer ? (
            <Field label="Transfer to">
              <Select
                value={transferAccountId}
                onChange={(v) => {
                  if (v !== "") changeTransferDestination(Number(v));
                }}
                className="w-full"
                searchable
              >
                <option value="" disabled>
                  Select account…
                </option>
                {otherAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            showCategory && (
              <Field label="Category">
                <Select
                  value={categoryId}
                  onChange={(v) => setCategoryId(v === "" || v === "__deferred__" ? v : Number(v))}
                  className="w-full"
                  searchable
                >
                  {categoryOptions(true)}
                </Select>
              </Field>
            )
          )}
        </div>

        {isTransferBoundary && (
          <Field label={isBoundaryOutflow ? "Category (required for boundary transfer outflow)" : "Category"}>
            <Select
              value={categoryId}
              onChange={(v) => setCategoryId(v === "" || v === "__deferred__" ? v : Number(v))}
              className="w-full"
              searchable
            >
              {categoryOptions(!isBoundaryOutflow)}
            </Select>
          </Field>
        )}

        {showCategory && categoryId === "__deferred__" && (
          <Field label="Deferred to month">
            <TextField
              type="month"
              value={incomeMonth}
              onChange={(e) => setIncomeMonth(e.target.value)}
              className={inputClass}
            />
          </Field>
        )}

        <div className="pt-1 mb-3 flex items-center gap-2">
          <span className="y-label">Flag</span>
          <FlagPicker value={flagColor} onChange={setFlagColor} />
          <span className="ml-auto flex items-center gap-2">
            <span className="y-label">Cleared</span>
            <ClearedFlag state={cleared ? "c" : "u"} onCycle={() => setCleared(!cleared)} />
          </span>
        </div>
      </div>

      <div data-testid="merge-constituents">
        <div className="y-label mb-1.5 block">Merged from</div>
        <div className="border rounded overflow-auto" style={{ borderColor: "var(--y-line)" }}>
          <table className="y-table w-full text-left">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th>Category</th>
                <th>Memo</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {constituents.map((row) => (
                <tr key={row.id} className="y-row y-subrow">
                  <td className="y-num whitespace-nowrap">{row.date}</td>
                  <td>{row.payee || <span className="y-hint">—</span>}</td>
                  <td>
                    {row.transferAccountId != null
                      ? "Transfer"
                      : (categoryName(row.categoryId) ?? <span className="y-hint">—</span>)}
                  </td>
                  <td>{row.memo || <span className="y-hint">—</span>}</td>
                  <td className="num y-num">{money(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export function MergePreviewModal({
  accounts,
  categories,
  groups,
  payees,
  transactions,
  ids,
  onClose,
  onConfirm,
}: {
  accounts: Account[];
  categories: Category[];
  groups?: CategoryGroup[];
  /** Existing payee names for the searchable payee field. */
  payees?: SearchListOption[];
  transactions: Transaction[];
  /** Exactly two transaction ids to merge. */
  ids: number[];
  onClose: () => void;
  onConfirm: (ids: number[], overrides: MergeOverrides) => Promise<void> | void;
}) {
  const preview = useMemo(() => {
    if (ids.length !== 2) return null;
    const first = transactions.find((t) => t.id === ids[0]);
    const second = transactions.find((t) => t.id === ids[1]);
    if (!first || !second) return null;
    const [primary, secondary] = pickMergePrimary(toMergeable(first), toMergeable(second));
    const accountById = new Map(accounts.map((a) => [a.id, a] as const));
    const src = accountById.get(primary.accountId);
    const dest =
      primary.transferAccountId != null ? accountById.get(primary.transferAccountId) : null;
    const merged = resolveMergedTransaction({
      primary,
      secondary,
      sourceAccount: { onBudget: src?.onBudget ?? true, kind: src?.kind ?? "liquid" },
      destAccount: dest ? { onBudget: dest.onBudget } : null,
    });
    return { primary, secondary, merged };
  }, [accounts, ids, transactions]);

  if (!preview) return null;

  return (
    <MergeEditorModal
      accounts={accounts}
      categories={categories}
      groups={groups}
      payees={payees}
      ids={ids}
      primary={preview.primary}
      secondary={preview.secondary}
      merged={preview.merged}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
