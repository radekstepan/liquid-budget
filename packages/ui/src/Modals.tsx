"use client";

import { useState } from "react";
import type { Account, Category, Recurring, Transaction } from "@ynab/logic";
import { todayISO, num } from "@ynab/logic";
import { Modal, Field, Btn, inputCls } from "./ui.js";

const inputClass = `${inputCls} py-[3px]`;

export function TransactionModal({
  accounts,
  categories,
  defaultAccountId,
  defaultDate,
  initial,
  onClose,
  onSave,
}: {
  accounts: Account[];
  categories: Category[];
  defaultAccountId: number | null;
  defaultDate?: string;
  initial?: Transaction;
  onClose: () => void;
  onSave: (t: {
    id?: number;
    accountId: number;
    categoryId: number | null;
    date: string;
    payee: string;
    memo: string;
    amount: number;
    cleared: boolean;
  }) => void;
}) {
  const [accountId, setAccountId] = useState(
    initial?.accountId ?? defaultAccountId ?? accounts[0]?.id ?? 0
  );
  const initialAmt = initial ? num(initial.amount) : 0;
  const [categoryId, setCategoryId] = useState<number | "">(initial?.categoryId ?? "");
  const [date, setDate] = useState(initial?.date ?? defaultDate ?? todayISO());
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [amount, setAmount] = useState(
    initial ? Math.abs(initialAmt).toFixed(2) : ""
  );
  const [type, setType] = useState<"outflow" | "inflow">(
    initial ? (initialAmt >= 0 ? "inflow" : "outflow") : "outflow"
  );
  const [cleared, setCleared] = useState(initial?.cleared ?? true);

  const save = () => {
    const a = Math.abs(parseFloat(amount));
    if (Number.isNaN(a) || !accountId || !payee.trim()) return;
    onSave({
      id: initial?.id,
      accountId,
      categoryId: categoryId === "" ? null : Number(categoryId),
      date,
      payee: payee.trim(),
      memo: memo.trim(),
      amount: type === "outflow" ? -a : a,
      cleared,
    });
  };

  return (
    <Modal
      title={initial ? "Edit Transaction" : "Add Transaction"}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>
            {initial ? "Save Changes" : "Save Transaction"}
          </Btn>
        </>
      }
    >
      <div className="y-seg mb-3 w-full">
        {(["outflow", "inflow"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`y-btn y-btn--sm flex-1 capitalize ${type === t ? "y-btn--primary is-on" : ""}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" className={inputClass} />
        </Field>
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
        </Field>
      </div>
      <Field label="Payee">
        <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. Whole Foods" className={inputClass} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <span className="y-select-wrap">
            <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} className="y-select w-full">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </span>
        </Field>
        <Field label="Category">
          <span className="y-select-wrap">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))} className="y-select w-full">
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </span>
        </Field>
      </div>
      <Field label="Memo (optional)">
        <input value={memo} onChange={(e) => setMemo(e.target.value)} className={inputClass} />
      </Field>
      <label className="mt-2 mb-0 flex items-center gap-[6px] text-[11.5px]" style={{ color: "var(--y-ink-soft)" }}>
        <input
          type="checkbox"
          checked={cleared}
          onChange={(e) => setCleared(e.target.checked)}
          className="sr-only"
        />
        <span
          aria-hidden
          className={`y-check ${cleared ? "is-on" : ""}`}
        />
        Cleared (posted to bank)
      </label>
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
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputClass} />
      </Field>
      <label className="mb-2 flex items-center gap-[6px] text-[11.5px]" style={{ color: "var(--y-ink-soft)" }}>
        <input
          type="checkbox"
          checked={hasGoal}
          onChange={(e) => setHasGoal(e.target.checked)}
          className="sr-only"
        />
        <span aria-hidden className={`y-check ${hasGoal ? "is-on" : ""}`} />
        Set a funding goal
      </label>
      {hasGoal && (
        <Field label="Goal Target">
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="1000.00" inputMode="decimal" className={inputClass} />
        </Field>
      )}
      <label className="mb-2 flex items-center gap-[6px] text-[11.5px]" style={{ color: "var(--y-ink-soft)" }}>
        <input
          type="checkbox"
          checked={hasCarryover}
          onChange={(e) => setHasCarryover(e.target.checked)}
          className="sr-only"
        />
        <span aria-hidden className={`y-check ${hasCarryover ? "is-on" : ""}`} />
        Set opening carryover balance
      </label>
      {hasCarryover && (
        <Field label="Carryover Amount">
          <input value={carryover} onChange={(e) => setCarryover(e.target.value)} placeholder="0.00" inputMode="decimal" className={inputClass} />
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
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputClass} />
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
  initial?: Recurring;
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
  }) => void;
}) {
  const initialAmt = initial ? num(initial.amount) : 0;
  const [accountId, setAccountId] = useState(initial?.accountId ?? accounts[0]?.id ?? 0);
  const [categoryId, setCategoryId] = useState<number | "">(initial?.categoryId ?? "");
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [amount, setAmount] = useState(initial ? Math.abs(initialAmt).toFixed(2) : "");
  const [type, setType] = useState<"outflow" | "inflow">(
    initial ? (initialAmt >= 0 ? "inflow" : "outflow") : "outflow"
  );
  const [frequency, setFrequency] = useState(initial?.frequency ?? "monthly");
  const [nextDate, setNextDate] = useState(initial?.nextDate ?? todayISO());
  const [active, setActive] = useState(initial?.active ?? true);

  const save = () => {
    const a = Math.abs(parseFloat(amount));
    if (Number.isNaN(a) || !payee.trim()) return;
    onSave({
      id: initial?.id,
      accountId,
      categoryId: categoryId === "" ? null : Number(categoryId),
      payee: payee.trim(),
      amount: type === "outflow" ? -a : a,
      frequency,
      nextDate,
      active,
    });
  };

  return (
    <Modal
      title={initial ? "Edit Recurring Transaction" : "Add Recurring Transaction"}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>
            {initial ? "Save Changes" : "Save"}
          </Btn>
        </>
      }
    >
      <div className="y-seg mb-3 w-full">
        {(["outflow", "inflow"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`y-btn y-btn--sm flex-1 capitalize ${type === t ? "y-btn--primary is-on" : ""}`}
          >
            {t}
          </button>
        ))}
      </div>
      <Field label="Payee">
        <input value={payee} onChange={(e) => setPayee(e.target.value)} className={inputClass} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" className={inputClass} />
        </Field>
        <Field label="Frequency">
          <span className="y-select-wrap">
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="y-select w-full">
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </span>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <span className="y-select-wrap">
            <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} className="y-select w-full">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </span>
        </Field>
        <Field label="Category">
          <span className="y-select-wrap">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))} className="y-select w-full">
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </span>
        </Field>
      </div>
      <Field label="Next Date">
        <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} className={inputClass} />
      </Field>
      <label className="mt-2 mb-0 flex items-center gap-[6px] text-[11.5px]" style={{ color: "var(--y-ink-soft)" }}>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="sr-only"
        />
        <span aria-hidden className={`y-check ${active ? "is-on" : ""}`} />
        Active
      </label>
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
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputClass} />
      </Field>
      <Field label="Type">
        <span className="y-select-wrap">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "liquid" | "credit" | "offbudget")}
            className="y-select w-full"
          >
            <option value="liquid">Liquid (Cash / Checking / Savings)</option>
            <option value="credit">Credit Card</option>
            <option value="offbudget">Off-Budget (Retirement / Asset)</option>
          </select>
        </span>
      </Field>
      <Field label="Current Balance">
        <input value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" inputMode="decimal" className={inputClass} />
      </Field>
    </Modal>
  );
}
