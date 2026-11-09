"use client";

import { useState } from "react";
import type { DuplicateGroup, Transaction } from "@ynab/logic";
import { num } from "@ynab/logic";
import { Button, Tooltip, Notice, money, cx } from "@ynab/theme";
import { Modal, Btn } from "../ui.js";

export function DuplicateGroupModal({
  transactionId,
  group,
  transactions,
  accountById,
  categoryById,
  showAccountColumn,
  onEdit,
  onDelete,
  onClearMarker,
  onDismiss,
  onShowInRegister,
  onClose,
}: {
  transactionId: number;
  group: DuplicateGroup | null;
  transactions: Transaction[];
  accountById: Map<number, { name: string }>;
  categoryById: Map<number, { name: string }>;
  showAccountColumn: boolean;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onClearMarker: (id: number) => void;
  onDismiss?: (fingerprint: string) => Promise<void> | void;
  onShowInRegister: () => void;
  onClose: () => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const inspected = transactions.find((t) => t.id === transactionId);
  if (!inspected) {
    return (
      <Modal
        wide
        title="Duplicate transactions"
        onClose={onClose}
        footer={
          <Btn variant="primary" onClick={onClose}>
            Close
          </Btn>
        }
      >
        <Notice tone="info" title="Transaction deleted">
          This transaction no longer exists.
        </Notice>
      </Modal>
    );
  }

  if (!group) {
    return (
      <Modal
        wide
        title="Duplicate transactions"
        onClose={onClose}
        footer={
          <>
            <Btn
              onClick={() => {
                onClearMarker(transactionId);
                onClose();
              }}
            >
              Clear marker
            </Btn>
            <Btn variant="primary" onClick={onClose}>
              Close
            </Btn>
          </>
        }
      >
        <Notice tone="warn" title="No other matching transactions">
          This transaction no longer matches any other row — the other side was likely deleted or
          edited. Clear the marker, or rerun Flag Duplicates to clear it automatically.
        </Notice>
      </Modal>
    );
  }

  const ids = [group.keeper.id, ...group.duplicates.map((d) => d.id)].filter(
    (id): id is number => id != null
  );
  const groupRows = ids
    .map((id) => transactions.find((t) => t.id === id))
    .filter((t): t is Transaction => t != null);

  const doDismiss = async () => {
    if (!onDismiss || dismissing) return;
    setDismissing(true);
    setDismissError(null);
    try {
      await onDismiss(group.fingerprint);
      onClose();
    } catch (e: unknown) {
      setDismissError(e instanceof Error ? e.message : String(e));
      setDismissing(false);
    }
  };

  return (
    <Modal
      wide
      title="Duplicate transactions"
      onClose={onClose}
      footer={
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Btn onClick={onClose}>Close</Btn>
            {onDismiss && (
              <Tooltip tip="Confirm these transactions are all legitimate — they won't be flagged again">
                <Btn onClick={doDismiss} disabled={dismissing}>
                  {dismissing ? "Confirming" : "Not duplicates"}
                </Btn>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Btn variant="primary" onClick={onShowInRegister}>
              Show all in register
            </Btn>
          </div>
        </>
      }
    >
      {dismissError && (
        <Notice tone="danger" title="Could not confirm">
          {dismissError}
        </Notice>
      )}
      <p className="y-hint text-[12px] leading-relaxed mb-3">
        These {groupRows.length} transactions match on account, date, amount, payee and memo. Keep
        one and delete the rest — or confirm they are all legitimate.
      </p>
      <div className="border rounded overflow-auto" style={{ borderColor: "var(--y-line)" }}>
        <table className="y-table w-full text-left">
          <thead>
            <tr>
              <th>Date</th>
              {showAccountColumn && <th>Account</th>}
              <th>Payee</th>
              <th>Category</th>
              <th>Memo</th>
              <th className="num">Amount</th>
              <th className="text-center">C</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {groupRows.map((row) => {
              const isCurrent = row.id === transactionId;
              const isReconciled = row.status === "r";
              const catName =
                row.categoryId != null ? (categoryById.get(row.categoryId)?.name ?? "") : "";
              return (
                <tr
                  key={row.id}
                  className={cx("y-row", isCurrent && "y-row--selected is-sel")}
                  data-duplicate-id={row.id}
                >
                  <td className="y-num whitespace-nowrap">{row.date}</td>
                  {showAccountColumn && (
                    <td className="truncate" style={{ color: "var(--y-ink-soft)" }}>
                      {accountById.get(row.accountId)?.name ?? ""}
                    </td>
                  )}
                  <td className="truncate">{row.payee || <span className="y-hint">—</span>}</td>
                  <td className="truncate" style={{ color: "var(--y-ink-soft)" }}>
                    {catName || <span className="y-hint">—</span>}
                  </td>
                  <td className="truncate italic" style={{ color: "var(--y-ink-faint)" }}>
                    {row.memo || <span className="y-hint">—</span>}
                  </td>
                  <td className="num y-num">{money(num(row.amount))}</td>
                  <td className="text-center">
                    <span className={cx("y-cleared", `y-cleared--${row.status}`)}>
                      {row.status === "u" ? "U" : row.status === "r" ? "R" : "C"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <span className="inline-flex items-center gap-1">
                      <Tooltip tip="Edit transaction">
                        <Button
                          size="sm"
                          aria-label={`Edit transaction ${row.payee || row.id}`}
                          onClick={() => onEdit(row.id)}
                        >
                          Edit
                        </Button>
                      </Tooltip>
                      <Tooltip
                        tip={
                          isReconciled
                            ? "Reconciled transactions are locked — unreconcile before deleting"
                            : "Delete transaction"
                        }
                      >
                        <Button
                          size="sm"
                          variant="danger"
                          aria-label={`Delete transaction ${row.payee || row.id}`}
                          disabled={isReconciled}
                          onClick={() => onDelete(row.id)}
                        >
                          Delete
                        </Button>
                      </Tooltip>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
