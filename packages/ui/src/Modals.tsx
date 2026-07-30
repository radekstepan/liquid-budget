"use client";

import { useState } from "react";
import type { Account, Category } from "@ynab/logic";
import { todayISO } from "@ynab/logic";
import { Modal, Field, Btn, inputCls, inputStyle } from "./ui.js";

export function TransactionModal({
  accounts,
  categories,
  defaultAccountId,
  onClose,
  onSave,
}: {
  accounts: Account[];
  categories: Category[];
  defaultAccountId: number | null;
  onClose: () => void;
  onSave: (t: {
    accountId: number;
    categoryId: number | null;
    date: string;
    payee: string;
    memo: string;
    amount: number;
  }) => void;
}) {
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? 0);
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [date, setDate] = useState(todayISO());
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"outflow" | "inflow">("outflow");

  const save = () => {
    const a = Math.abs(parseFloat(amount));
    if (Number.isNaN(a) || !accountId || !payee.trim()) return;
    onSave({
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
      title="Add Transaction"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>Save Transaction</Btn>
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
  onClose,
  onSave,
}: {
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSave: (v: {
    accountId: number;
    categoryId: number | null;
    payee: string;
    amount: number;
    frequency: string;
    nextDate: string;
  }) => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? 0);
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"outflow" | "inflow">("outflow");
  const [frequency, setFrequency] = useState("monthly");
  const [nextDate, setNextDate] = useState(todayISO());

  const save = () => {
    const a = Math.abs(parseFloat(amount));
    if (Number.isNaN(a) || !payee.trim()) return;
    onSave({
      accountId,
      categoryId: categoryId === "" ? null : Number(categoryId),
      payee: payee.trim(),
      amount: type === "outflow" ? -a : a,
      frequency,
      nextDate,
    });
  };

  return (
    <Modal
      title="Add Recurring Transaction"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>Save</Btn>
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
    </Modal>
  );
}

export function AccountModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (v: { name: string; kind: string; groupLabel: string; balance: number; onBudget: boolean }) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("liquid");
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
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls} style={inputStyle}>
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
