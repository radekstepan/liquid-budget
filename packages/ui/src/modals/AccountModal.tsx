"use client";

import { useState, useEffect } from "react";
import type { Account } from "@ynab/logic";
import { dollarsToCents, evalAmount, num } from "@ynab/logic";
import { TextField, Select, Notice } from "@ynab/theme";
import { Modal, Field, Btn } from "../ui.js";
import { AmountPreview } from "../AmountInput.js";
import { inputClass } from "./shared.js";

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
    balance?: number;
    onBudget: boolean;
    notes: string;
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
  const [notes, setNotes] = useState(initial?.notes ?? "");
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
    setNotes(initial?.notes ?? "");
  }, [initial?.id]);

  const isEdit = !!initial;
  const isArchived = Boolean(initial?.archived);
  const txCount = transactionCount ?? 0;

  const groupLabel = kind === "liquid" ? "Liquid" : kind === "credit" ? "Credit Cards" : "Retirement";
  const save = () => {
    if (!name.trim()) return;
    const b = evalAmount(balance) ?? 0;
    const bCents = dollarsToCents(b);
    const finalBalance = kind === "credit" ? -Math.abs(bCents) : bCents;
    const trimmedNotes = notes.trim().slice(0, 2000);
    if (isEdit) {
      onSave({ name: name.trim(), kind, groupLabel, onBudget: kind !== "offbudget", notes: trimmedNotes });
    } else {
      onSave({ name: name.trim(), kind, groupLabel, balance: finalBalance, onBudget: kind !== "offbudget", notes: trimmedNotes });
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
            ? `Close "${initial?.name ?? "Account"}"?`
            : isEdit
              ? isArchived
                ? "Edit Account (Closed)"
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
                {archiving ? "Closing" : "Yes, close it"}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={onClose}>Cancel</Btn>
              {isEdit && !isArchived && onArchive && (
                <Btn onClick={() => setConfirmingArchive(true)}>Close account</Btn>
              )}
              {isEdit && isArchived && onUnarchive && (
                <Btn onClick={handleUnarchive} disabled={unarchiving}>
                  {unarchiving ? "Reopening" : "Reopen account"}
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
            Close <strong>{initial?.name}</strong>?
          </p>
          <p className="y-hint text-[11.5px]">
            Closed accounts collapse under Closed Accounts and are excluded from new
            transaction dropdowns, but all transaction history and reports are
            preserved. You can reopen it at any time.
          </p>
          {initial != null && num(initial.balance) !== 0 && (
            <Notice tone="warn" title={`Balance is ${(num(initial.balance) / 100).toFixed(2)}`}>
              This account still has a non-zero balance. Closing keeps the balance in
              net worth — transfer it to $0 first if you want a clean close.
            </Notice>
          )}
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
                disabled={isEdit && txCount > 0}
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
          {isEdit && txCount > 0 && (
            <div className="y-hint text-[11px] pt-1">
              Account type is locked because this account has {txCount} transaction{txCount === 1 ? "" : "s"}.
            </div>
          )}
          {isEdit && txCount === 0 && (
            <div className="y-hint text-[11px] pt-1">
              Starting balance is locked after creation. To adjust the working balance, add a transaction or use the Reconcile flow.
            </div>
          )}
          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 2000))}
              placeholder="Optional note — e.g. why this account was closed"
              rows={2}
              maxLength={2000}
              className="y-input w-full py-[3px] min-h-[44px]"
            />
          </Field>
        </>
      )}
    </Modal>
  );
}
