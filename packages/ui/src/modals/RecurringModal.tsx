"use client";

import { useState, useMemo } from "react";
import type {
  Account,
  Category,
  CategoryGroup,
  Recurring,
  RecurringFormData,
  RecurringSavePayload,
  RecurringSubTransaction,
  TransactionFlagColor,
} from "@ynab/logic";
import {
  adjustDateShortcut,
  assertSplitsBalanced,
  canBuildRecurringPayload,
  dollarsToCents,
  evalAmount,
  num,
  RECURRING_FREQUENCIES,
  isValidISODate,
  todayISO,
  toRecurringPayload,
} from "@ynab/logic";
import { Button, TextField, Select, FlagPicker, SearchList, Tooltip, type SearchListOption } from "@ynab/theme";
import { Modal, Field, Btn } from "../ui.js";
import { AmountPreview, AmountFieldError, AmountFieldWithCalculator } from "../AmountInput.js";
import {
  DateFieldError,
  blankSubRow,
  fillSubRowDefaults,
  inputClass,
  type DraftSubRow,
} from "./shared.js";

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
  onSave: (v: RecurringSavePayload) => void;
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
      if (mode !== "split") {
        // Converting to a split defaults blank sub-rows from the parent's
        // memo/payee; re-clicking Split leaves existing rows untouched.
        setSubRows((prev) =>
          fillSubRowDefaults(
            prev.length >= 2 ? prev : [blankSubRow(memo, payee), blankSubRow(memo, payee)],
            memo,
            payee
          )
        );
      }
    }
  };

  const formData: RecurringFormData = {
    mode,
    id: initial?.id,
    accountId,
    categoryId,
    payee,
    memo,
    amount,
    frequency,
    nextDate,
    anchorDay: initial?.anchorDay,
    // New schedules are always active; edits preserve the rule's
    // current state (pause/resume lives on the list card instead).
    active: initial?.active ?? true,
    flagColor,
    transferAccountId,
    subRows,
  };
  const builderOptions = {
    accounts,
    initial,
  };

  const save = () => {
    const payload = toRecurringPayload(formData, builderOptions);
    if (payload) {
      onSave(payload);
    }
  };

  const canSave = canBuildRecurringPayload(formData, builderOptions);

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
              <Tooltip tip="Enter into register">
                <Btn
                  variant="primary"
                  onClick={async () => {
                    try {
                      await onPost(initial.id);
                    } catch {
                      // The mutation layer already toasted the failure; keep
                      // the modal open so the user can adjust and retry instead
                      // of surfacing an unhandled rejection.
                      return;
                    }
                    onClose();
                  }}
                >
                  Enter Now
                </Btn>
              </Tooltip>
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
          >
            {m === "single" ? "Single" : m === "transfer" ? "Transfer" : "Split"}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={mode === "split" ? "Total" : "Amount"}>
          <AmountFieldWithCalculator
            value={amount}
            onChange={setAmount}
            className={inputClass}
          />
          <AmountPreview value={amount} />
          <AmountFieldError value={amount} />
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
            disabled={mode === "transfer" || (!!initial && isInitialSplit)}
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
        <Field label="Payee">
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
          aria-invalid={!isValidISODate(nextDate)}
        />
        <DateFieldError value={nextDate} />
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

    </Modal>
  );
}
