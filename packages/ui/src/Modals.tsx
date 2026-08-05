"use client";

import { useState, useMemo } from "react";
import type { Account, Category, Recurring, RecurringSubTransaction, SubTransaction, Transaction } from "@ynab/logic";
import { todayISO, num, getSplitChildren, validateSubTransactions, validateRecurringSubTransactions } from "@ynab/logic";
import { Button, TextField, Select, Checkbox } from "@ynab/theme";
import { Modal, Field, Btn } from "./ui.js";

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
  transferAccountId?: number | null;
  /**
   * When set, the server will create a split: insert the parent with
   * the top-level fields and these N children, atomically. Mutually
   * exclusive with `transferAccountId` and a top-level `categoryId`.
   */
  subTransactions?: SubTransaction[];
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
  defaultAccountId,
  defaultDate,
  allTransactions,
  initial,
  onClose,
  onSave,
}: {
  accounts: Account[];
  categories: Category[];
  defaultAccountId: number | null;
  defaultDate?: string;
  /** All transactions in the budget, used to look up split children when editing. */
  allTransactions?: Transaction[];
  initial?: Transaction;
  onClose: () => void;
  onSave: (t: TransactionSavePayload) => void;
}) {
  const initialAmt = initial ? num(initial.amount) : 0;

  // Detect if `initial` is a split parent and pre-populate children.
  const initialChildren = useMemo(() => {
    if (!initial || !allTransactions) return undefined;
    return getSplitChildren(allTransactions, initial.id);
  }, [initial, allTransactions]);

  const isInitialTransfer = !!initial?.transferAccountId;
  const isInitialSplit =
    !isInitialTransfer &&
    initial?.parentId == null &&
    !!initialChildren &&
    initialChildren.length > 0;

  const [mode, setMode] = useState<"single" | "transfer" | "split">(
    isInitialTransfer ? "transfer" : isInitialSplit ? "split" : "single"
  );

  const [accountId, setAccountId] = useState(
    initial?.accountId ?? defaultAccountId ?? accounts[0]?.id ?? 0
  );
  const [categoryId, setCategoryId] = useState<number | "">(initial?.categoryId ?? "");
  const [date, setDate] = useState(initial?.date ?? defaultDate ?? todayISO());
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [amount, setAmount] = useState(
    initial ? initialAmt.toFixed(2) : ""
  );
  const [cleared, setCleared] = useState<boolean>(initial?.status === "c" || initial?.status === "r" || initial?.status == null);

  // Transfer destination
  const [transferAccountId, setTransferAccountId] = useState<number | "">(
    initial?.transferAccountId ?? ""
  );

  // Split sub-rows
  const [subRows, setSubRows] = useState<SubTransaction[]>(
    initialChildren
      ? initialChildren.map((c) => ({
          categoryId: c.categoryId ?? 0,
          // Preserve the child's signed amount on edit (no Math.abs coercion).
          // Mixed-sign splits (e.g. Paycheck with a tax deduction) are supported
          // by the validation layer.
          amount: num(c.amount),
          memo: c.memo ?? "",
        }))
      : [
          { categoryId: 0, amount: 0, memo: "" },
          { categoryId: 0, amount: 0, memo: "" },
        ]
  );

  const otherAccounts = accounts.filter((a) => a.id !== accountId);

  // Signed parent amount and signed child total — validation is sign-aware
  // and the sub-row "Σ … / …" footer uses Math.abs() for the colour check only.
  const parentAmount = parseFloat(amount) || 0;
  const subTotal = subRows.reduce((s, r) => s + Number(r.amount) || 0, 0);
  const subValidation = useMemo(() => {
    if (mode !== "split") return null;
    return validateSubTransactions(parentAmount, subRows);
  }, [mode, parentAmount, subRows]);

  const switchingMode = (next: "single" | "transfer" | "split") => {
    setMode(next);
    if (next === "single") {
      setTransferAccountId("");
      setSubRows([
        { categoryId: 0, amount: 0, memo: "" },
        { categoryId: 0, amount: 0, memo: "" },
      ]);
    } else if (next === "transfer") {
      setCategoryId("");
      setSubRows([
        { categoryId: 0, amount: 0, memo: "" },
        { categoryId: 0, amount: 0, memo: "" },
      ]);
    } else {
      setTransferAccountId("");
      setCategoryId("");
    }
  };

  const save = () => {
    // Use the typed value as-is (sign is part of the input). The user
    // is expected to type the sign: positive for inflows, negative for
    // outflows. (No outflow/inflow toggle in this modal.)
    const a = parseFloat(amount);
    if (Number.isNaN(a) || !accountId) return;

    if (mode === "transfer") {
      if (!payee.trim() && !transferAccountId) return;
      if (!transferAccountId) return;
      if (Number(transferAccountId) === accountId) return;
      const destName = otherAccounts.find((a) => a.id === Number(transferAccountId))?.name ?? "";
      onSave({
        id: initial?.id,
        accountId,
        categoryId: null,
        date,
        payee: payee.trim() || `Transfer : ${destName}`,
        memo: memo.trim(),
        amount: a,
        status: cleared ? "c" : "u",
        transferAccountId: Number(transferAccountId),
      });
      return;
    }

    if (mode === "split") {
      if (!payee.trim()) return;
      if (subValidation) return; // disable save via validation
      onSave({
        id: initial?.id,
        accountId,
        categoryId: null,
        date,
        payee: payee.trim(),
        memo: memo.trim(),
        amount: a,
        status: cleared ? "c" : "u",
        subTransactions: subRows.map((r) => ({
          categoryId: r.categoryId,
          // Sub-row amounts are passed through verbatim (signed) so the
          // server-side validation sees the same numbers the user typed.
          // Mixed-sign splits (e.g. +5000 gross pay, -1000 tax) are
          // supported by the validation layer.
          amount: Number(r.amount),
          memo: r.memo,
        })),
      });
      return;
    }

    // single
    if (!payee.trim()) return;
    onSave({
      id: initial?.id,
      accountId,
      categoryId: categoryId === "" ? null : Number(categoryId),
      date,
      payee: payee.trim(),
      memo: memo.trim(),
      amount: a,
      status: cleared ? "c" : "u",
    });
  };

  const canSave = (() => {
    const a = Math.abs(parseFloat(amount));
    if (Number.isNaN(a) || !accountId) return false;
    if (mode === "transfer") {
      return Boolean(transferAccountId) && Number(transferAccountId) !== accountId;
    }
    if (mode === "split") {
      return Boolean(payee.trim()) && subValidation === null;
    }
    return Boolean(payee.trim());
  })();

  return (
    <Modal
      wide={mode === "split"}
      title={initial ? "Edit Transaction" : "Add Transaction"}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={!canSave}>
            {initial ? "Save Changes" : "Save Transaction"}
          </Btn>
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
        </Field>
        <Field label="Date">
          <TextField
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      {mode !== "transfer" && (
        <Field label="Payee">
          <TextField
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            placeholder="e.g. Whole Foods"
            className={inputClass}
          />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <Select
            value={accountId}
            onChange={(e) => setAccountId(Number(e.target.value))}
            className="w-full"
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
              onChange={(e) => setTransferAccountId(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full"
            >
              <option value="">Select account…</option>
              {otherAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </Field>
        ) : mode === "split" ? null : (
          <Field label="Category">
            <Select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full"
            >
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {mode === "transfer" && (
        <Field label="Payee (auto-generated, override optional)">
          <TextField
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
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
            {subRows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_92px_28px] gap-2 items-start">
                <Select
                  value={row.categoryId || ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? 0 : Number(e.target.value);
                    setSubRows((rs) =>
                      rs.map((r, j) => (i === j ? { ...r, categoryId: v } : r))
                    );
                  }}
                  className="w-full"
                >
                  <option value="">Category…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
                <TextField
                  value={row.amount || ""}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSubRows((rs) =>
                      rs.map((r, j) => (i === j ? { ...r, amount: Number.isNaN(v) ? 0 : v } : r))
                    );
                  }}
                  placeholder="0.00"
                  inputMode="decimal"
                  className={inputClass}
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
            ))}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Button
              size="sm"
              onClick={() =>
                setSubRows((rs) => [...rs, { categoryId: 0, amount: 0, memo: "" }])
              }
            >
              + Add sub-transaction
            </Button>
            <span
              className="ml-auto text-[11.5px] y-num"
              style={{
                color:
                  Math.abs(subTotal - parentAmount) < 0.005
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

      <Field label="Memo (optional)">
        <TextField value={memo} onChange={(e) => setMemo(e.target.value)} className={inputClass} />
      </Field>
      <div className="mt-2 mb-0">
        <Checkbox
          checked={cleared}
          onChange={setCleared}
          label="Cleared (posted to bank)"
        />
      </div>
    </Modal>
  );
}

export function CategoryModal({
  initial,
  onClose,
  onSave,
}: {
  initial?: Category;
  onClose: () => void;
  onSave: (v: { name: string; goalTarget: number | null; carryover?: number }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [hasGoal, setHasGoal] = useState(!!initial?.goalTarget);
  const [goal, setGoal] = useState(initial?.goalTarget ?? "");
  const initCarryover = initial?.carryover ? Number(initial.carryover) : 0;
  const [hasCarryover, setHasCarryover] = useState(initCarryover !== 0);
  const [carryover, setCarryover] = useState(
    initCarryover !== 0 ? String(initCarryover) : ""
  );

  return (
    <Modal
      title={initial ? "Edit Category" : "New Category"}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            variant="primary"
            onClick={() =>
              name.trim() &&
              onSave({
                name: name.trim(),
                goalTarget: hasGoal ? Number(goal) || 0 : null,
                carryover: hasCarryover ? parseFloat(carryover) || 0 : undefined,
              })
            }
          >
            Save
          </Btn>
        </>
      }
    >
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
        </Field>
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
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            variant="primary"
            onClick={() => name.trim() && onSave(name.trim())}
          >
            Save
          </Btn>
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
  initial,
  onClose,
  onSave,
}: {
  accounts: Account[];
  categories: Category[];
  initial?: Recurring & { subTransactions?: RecurringSubTransaction[] };
  onClose: () => void;
  onSave: (v: {
    id?: number;
    accountId: number;
    categoryId: number | null;
    payee: string;
    amount: number;
    frequency: string;
    nextDate: string;
    active: boolean;
    transferAccountId?: number | null;
    subTransactions?: { categoryId: number | null; amount: number; memo?: string }[];
  }) => void;
}) {
  const initialAmt = initial ? num(initial.amount) : 0;
  const initialChildren = initial?.subTransactions ?? [];

  const isInitialTransfer = !!initial?.transferAccountId;
  const isInitialSplit = !isInitialTransfer && initialChildren.length > 0;

  const [mode, setMode] = useState<"single" | "transfer" | "split">(
    isInitialTransfer ? "transfer" : isInitialSplit ? "split" : "single"
  );

  const [accountId, setAccountId] = useState(initial?.accountId ?? accounts[0]?.id ?? 0);
  const [categoryId, setCategoryId] = useState<number | "">(initial?.categoryId ?? "");
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [amount, setAmount] = useState(initial ? initialAmt.toFixed(2) : "");
  const [frequency, setFrequency] = useState(initial?.frequency ?? "monthly");
  const [nextDate, setNextDate] = useState(initial?.nextDate ?? todayISO());
  const [active, setActive] = useState(initial?.active ?? true);

  // Transfer destination
  const [transferAccountId, setTransferAccountId] = useState<number | "">(
    initial?.transferAccountId ?? ""
  );

  // Split sub-rows
  const [subRows, setSubRows] = useState<SubTransaction[]>(
    initialChildren.length > 0
      ? initialChildren.map((c) => ({
          categoryId: c.categoryId,
          // Preserve the child's signed amount on edit (no Math.abs coercion).
          // Mixed-sign splits (e.g. Paycheck with a tax deduction) are supported
          // by the validation layer.
          amount: num(c.amount),
          memo: c.memo ?? "",
        }))
      : [
          { categoryId: 0, amount: 0, memo: "" },
          { categoryId: 0, amount: 0, memo: "" },
        ]
  );

  const otherAccounts = accounts.filter((a) => a.id !== accountId);

  // Signed parent amount and signed child total — validation is sign-aware.
  const parentAmount = parseFloat(amount) || 0;
  const subTotal = subRows.reduce((s, r) => s + Number(r.amount) || 0, 0);
  const subValidation = useMemo(() => {
    if (mode !== "split") return null;
    return validateRecurringSubTransactions(parentAmount, subRows);
  }, [mode, parentAmount, subRows]);

  const switchingMode = (next: "single" | "transfer" | "split") => {
    setMode(next);
    if (next === "single") {
      setTransferAccountId("");
      setSubRows([
        { categoryId: 0, amount: 0, memo: "" },
        { categoryId: 0, amount: 0, memo: "" },
      ]);
    } else if (next === "transfer") {
      setCategoryId("");
      setSubRows([
        { categoryId: 0, amount: 0, memo: "" },
        { categoryId: 0, amount: 0, memo: "" },
      ]);
    } else {
      setTransferAccountId("");
      setCategoryId("");
    }
  };

  const save = () => {
    const a = parseFloat(amount);
    if (Number.isNaN(a) || !accountId) return;

    if (mode === "transfer") {
      if (!transferAccountId) return;
      if (Number(transferAccountId) === accountId) return;
      const destName = otherAccounts.find((x) => x.id === Number(transferAccountId))?.name ?? "";
      onSave({
        id: initial?.id,
        accountId,
        categoryId: null,
        payee: payee.trim() || `Transfer : ${destName}`,
        amount: a,
        frequency,
        nextDate,
        active,
        transferAccountId: Number(transferAccountId),
      });
      return;
    }

    if (mode === "split") {
      if (!payee.trim()) return;
      if (subValidation) return; // disable save via validation
      onSave({
        id: initial?.id,
        accountId,
        categoryId: null,
        payee: payee.trim(),
        amount: a,
        frequency,
        nextDate,
        active,
        subTransactions: subRows.map((r) => ({
          categoryId: r.categoryId,
          // Sub-row amounts are passed through verbatim (signed) so the
          // server-side validation sees the same numbers the user typed.
          // Mixed-sign splits (e.g. +5000 gross pay, -1000 tax) are
          // supported by the validation layer.
          amount: Number(r.amount),
          memo: r.memo,
        })),
      });
      return;
    }

    // single
    if (!payee.trim()) return;
    onSave({
      id: initial?.id,
      accountId,
      categoryId: categoryId === "" ? null : Number(categoryId),
      payee: payee.trim(),
      amount: a,
      frequency,
      nextDate,
      active,
    });
  };

  const canSave = (() => {
    const a = Math.abs(parseFloat(amount));
    if (Number.isNaN(a) || !accountId) return false;
    if (mode === "transfer") {
      return Boolean(transferAccountId) && Number(transferAccountId) !== accountId;
    }
    if (mode === "split") {
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
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={!canSave}>
            {initial ? "Save Changes" : "Save"}
          </Btn>
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
        </Field>
        <Field label="Frequency">
          <Select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            className="w-full"
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </Select>
        </Field>
      </div>

      {mode !== "transfer" && (
        <Field label="Payee">
          <TextField
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            placeholder="e.g. Whole Foods"
            className={inputClass}
          />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <Select
            value={accountId}
            onChange={(e) => setAccountId(Number(e.target.value))}
            className="w-full"
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
              onChange={(e) => setTransferAccountId(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full"
            >
              <option value="">Select account…</option>
              {otherAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </Field>
        ) : mode === "split" ? null : (
          <Field label="Category">
            <Select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full"
            >
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {mode === "transfer" && (
        <Field label="Payee (auto-generated, override optional)">
          <TextField
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
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
            {subRows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_92px_28px] gap-2 items-start">
                <Select
                  value={row.categoryId || ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? 0 : Number(e.target.value);
                    setSubRows((rs) =>
                      rs.map((r, j) => (i === j ? { ...r, categoryId: v } : r))
                    );
                  }}
                  className="w-full"
                >
                  <option value="">Category…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
                <TextField
                  value={row.amount || ""}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSubRows((rs) =>
                      rs.map((r, j) => (i === j ? { ...r, amount: Number.isNaN(v) ? 0 : v } : r))
                    );
                  }}
                  placeholder="0.00"
                  inputMode="decimal"
                  className={inputClass}
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
            ))}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Button
              size="sm"
              onClick={() =>
                setSubRows((rs) => [...rs, { categoryId: 0, amount: 0, memo: "" }])
              }
            >
              + Add sub-transaction
            </Button>
            <span
              className="ml-auto text-[11.5px] y-num"
              style={{
                color:
                  Math.abs(subTotal - parentAmount) < 0.005
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

      <div className="grid grid-cols-2 gap-3">
        <Field label="Next Date">
          <TextField
            type="date"
            value={nextDate}
            onChange={(e) => setNextDate(e.target.value)}
            className={inputClass}
          />
        </Field>
        <div className="flex items-end pb-1">
          <Checkbox
            checked={active}
            onChange={setActive}
            label="Active"
          />
        </div>
      </div>
    </Modal>
  );
}

export function AccountModal({
  initial,
  onClose,
  onSave,
}: {
  initial?: { name: string; kind: "liquid" | "credit" | "offbudget"; balance: number | string };
  onClose: () => void;
  onSave: (v: {
    name: string;
    kind: "liquid" | "credit" | "offbudget";
    groupLabel: string;
    balance: number;
    onBudget: boolean;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"liquid" | "credit" | "offbudget">(initial?.kind ?? "liquid");
  const [balance, setBalance] = useState(
    initial != null ? String(Math.abs(Number(initial.balance))) : ""
  );

  const groupLabel = kind === "liquid" ? "Liquid" : kind === "credit" ? "Credit Cards" : "Retirement";
  const save = () => {
    if (!name.trim()) return;
    const b = parseFloat(balance) || 0;
    onSave({ name: name.trim(), kind, groupLabel, balance: b, onBudget: kind !== "offbudget" });
  };
  const isEdit = !!initial;
  return (
    <Modal
      title={isEdit ? "Edit Account" : "Add Account"}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>
            {isEdit ? "Save Changes" : "Add Account"}
          </Btn>
        </>
      }
    >
      <Field label="Account Name">
        <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputClass} />
      </Field>
      <Field label="Type">
        <Select
          value={kind}
          onChange={(e) => setKind(e.target.value as "liquid" | "credit" | "offbudget")}
          className="w-full"
        >
          <option value="liquid">Liquid (Cash / Checking / Savings)</option>
          <option value="credit">Credit Card</option>
          <option value="offbudget">Off-Budget (Retirement / Asset)</option>
        </Select>
      </Field>
      <Field label="Current Balance">
        <TextField
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          className={inputClass}
        />
      </Field>
    </Modal>
  );
}
