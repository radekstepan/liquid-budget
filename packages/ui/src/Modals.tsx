"use client";

import { useState } from "react";
import type { Account, Category, Recurring, Transaction } from "@ynab/logic";
import { todayISO, num } from "@ynab/logic";
import { Modal, Field, Btn, inputCls, inputStyle } from "./ui.js";

export function TransactionModal({
  accounts,
  categories,
  defaultAccountId,
  initial,
  onClose,
  onSave,
}: {
  accounts: Account[];
  categories: Category[];
  defaultAccountId: number | null;
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
  }) => void;
}) {
  const [accountId, setAccountId] = useState(
    initial?.accountId ?? defaultAccountId ?? accounts[0]?.id ?? 0
  );
  const initialAmt = initial ? num(initial.amount) : 0;
  const [categoryId, setCategoryId] = useState<number | "">(initial?.categoryId ?? "");
  const [date, setDate] = useState(initial?.date ?? todayISO());
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [amount, setAmount] = useState(
    initial ? Math.abs(initialAmt).toFixed(2) : ""
  );
  const [type, setType] = useState<"outflow" | "inflow">(
    initial ? (initialAmt >= 0 ? "inflow" : "outflow") : "outflow"
  );

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
      <div className="mb-3 flex gap-2">
        {(["outflow", "inflow"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className="flex-1 rounded-lg py-2 text-[13px] font-semibold capitalize transition-all"
            style={{
              background: type === t ? "var(--accent)" : "var(--panel-2)",
              color: type === t ? "var(--accent-fg)" : "var(--text-2)",
              border: `1px solid ${type === t ? "var(--accent)" : "var(--border-strong)"}`,
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" className={inputCls} style={inputStyle} />
        </Field>
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} style={inputStyle} />
        </Field>
      </div>
      <Field label="Payee">
        <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. Whole Foods" className={inputCls} style={inputStyle} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} className={inputCls} style={inputStyle}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))} className={inputCls} style={inputStyle}>
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Memo (optional)">
        <input value={memo} onChange={(e) => setMemo(e.target.value)} className={inputCls} style={inputStyle} />
      </Field>
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
  onSave: (v: { name: string; goalTarget: number | null }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [hasGoal, setHasGoal] = useState(!!initial?.goalTarget);
  const [goal, setGoal] = useState(initial?.goalTarget ?? "");

  return (
    <Modal
      title={initial ? "Edit Category" : "New Category"}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={() => name.trim() && onSave({ name: name.trim(), goalTarget: hasGoal ? Number(goal) || 0 : null })}>Save</Btn>
        </>
      }
    >
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputCls} style={inputStyle} />
      </Field>
      <label className="mb-2 flex items-center gap-2 text-[13.5px]" style={{ color: "var(--text-2)" }}>
        <input type="checkbox" checked={hasGoal} onChange={(e) => setHasGoal(e.target.checked)} />
        Set a funding goal
      </label>
      {hasGoal && (
        <Field label="Goal Target">
          <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="1000.00" inputMode="decimal" className={inputCls} style={inputStyle} />
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
          <Btn variant="primary" onClick={() => name.trim() && onSave(name.trim())}>Save</Btn>
        </>
      }
    >
      <Field label="Group Name">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputCls} style={inputStyle} />
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
      <div className="mb-3 flex gap-2">
        {(["outflow", "inflow"] as const).map((t) => (
          <button key={t} onClick={() => setType(t)} className="flex-1 rounded-lg py-2 text-[13px] font-semibold capitalize" style={{ background: type === t ? "var(--accent)" : "var(--panel-2)", color: type === t ? "var(--accent-fg)" : "var(--text-2)", border: `1px solid ${type === t ? "var(--accent)" : "var(--border-strong)"}` }}>{t}</button>
        ))}
      </div>
      <Field label="Payee">
        <input value={payee} onChange={(e) => setPayee(e.target.value)} className={inputCls} style={inputStyle} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" className={inputCls} style={inputStyle} />
        </Field>
        <Field label="Frequency">
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className={inputCls} style={inputStyle}>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} className={inputCls} style={inputStyle}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))} className={inputCls} style={inputStyle}>
            <option value="">Uncategorized</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Next Date">
        <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} className={inputCls} style={inputStyle} />
      </Field>
      <label className="mt-2 flex items-center gap-2 text-[13.5px]" style={{ color: "var(--text-2)" }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active
      </label>
    </Modal>
  );
}

export function AccountModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (v: {
    name: string;
    kind: "liquid" | "credit" | "offbudget";
    groupLabel: string;
    balance: number;
    onBudget: boolean;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"liquid" | "credit" | "offbudget">("liquid");
  const [balance, setBalance] = useState("");

  const groupLabel = kind === "liquid" ? "Liquid" : kind === "credit" ? "Credit Cards" : "Retirement";
  const save = () => {
    if (!name.trim()) return;
    const b = parseFloat(balance) || 0;
    onSave({ name: name.trim(), kind, groupLabel, balance: b, onBudget: kind !== "offbudget" });
  };
  return (
    <Modal
      title="Add Account"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>Add Account</Btn>
        </>
      }
    >
      <Field label="Account Name">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputCls} style={inputStyle} />
      </Field>
      <Field label="Type">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "liquid" | "credit" | "offbudget")}
          className={inputCls}
          style={inputStyle}
        >
          <option value="liquid">Liquid (Cash / Checking / Savings)</option>
          <option value="credit">Credit Card</option>
          <option value="offbudget">Off-Budget (Retirement / Asset)</option>
        </select>
      </Field>
      <Field label="Current Balance">
        <input value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" inputMode="decimal" className={inputCls} style={inputStyle} />
      </Field>
    </Modal>
  );
}
