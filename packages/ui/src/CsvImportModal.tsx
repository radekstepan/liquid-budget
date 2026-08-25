"use client";

import { useEffect, useMemo, useState } from "react";
import type { Account, DuplicateEntry, RenameRule, Transaction } from "@ynab/logic";
import { applyRenameRules, parseCsvImport, swapPayeeMemo, findDuplicateGroups } from "@ynab/logic";
import { Checkbox, Notice, Select, money, cx } from "@ynab/theme";
import { Modal, Field, Btn } from "./ui.js";

export function CsvImportModal({
  accounts,
  transactions,
  renameRules,
  defaultAccountId,
  file,
  onClose,
  onImport,
}: {
  accounts: Account[];
  transactions: Transaction[];
  renameRules?: RenameRule[];
  defaultAccountId: number | null;
  file: File;
  onClose: () => void;
  onImport: (input: { accountId: number; swap: boolean; dateFormat?: "auto" | "dmy" | "mdy"; csv: string }) => Promise<void>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [swap, setSwap] = useState(false);
  const [dateFormat, setDateFormat] = useState<"auto" | "dmy" | "mdy">("auto");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    file
      .text()
      .then((t) => {
        if (alive) setText(t);
      })
      .catch((e: unknown) => {
        if (alive) setReadError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [file]);

  const availableAccounts = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const [accountId, setAccountId] = useState<number>(
    defaultAccountId ?? availableAccounts[0]?.id ?? 0
  );

  const parsed = useMemo(() => (text != null ? parseCsvImport(text, { dateFormat }) : null), [text, dateFormat]);
  const rows = useMemo(() => {
    if (!parsed) return [];
    // The server applies rename rules after the swap, so the preview mirrors
    // that exactly — this keeps duplicate detection in sync with the import.
    const rules = renameRules ?? [];
    return swapPayeeMemo(parsed.rows, swap).map((r) =>
      r.error ? r : { ...r, payee: applyRenameRules(rules, r.payee ?? "") }
    );
  }, [parsed, swap, renameRules]);
  const validRows = useMemo(() => rows.filter((r) => !r.error), [rows]);
  const errorRows = useMemo(() => rows.filter((r) => r.error), [rows]);

  // Rows that are an exact duplicate of an existing transaction (same
  // account + date + amount + normalized payee/memo) or of an earlier
  // row in this file. These will be skipped on import.
  const duplicateRowNumbers = useMemo(() => {
    if (validRows.length === 0) return new Set<number>();
    const existing: DuplicateEntry[] = transactions
      .filter((t) => t.accountId === accountId)
      .map((t) => ({
        id: t.id,
        accountId: t.accountId,
        date: t.date,
        payee: t.payee,
        memo: t.memo,
        amount: Number(t.amount),
        parentId: t.parentId ?? null,
        transferAccountId: t.transferAccountId ?? null,
      }));
    const incoming: DuplicateEntry[] = validRows.map((r) => ({
      rowNumber: r.rowNumber,
      accountId,
      date: r.date ?? "",
      payee: r.payee ?? "",
      memo: r.memo ?? "",
      amount: r.amountCents ?? 0,
    }));
    const groups = findDuplicateGroups([...existing, ...incoming]);
    const set = new Set<number>();
    for (const g of groups) {
      for (const d of g.duplicates) {
        if (d.rowNumber != null) set.add(d.rowNumber);
      }
    }
    return set;
  }, [transactions, accountId, validRows]);

  const duplicateRows = useMemo(
    () => validRows.filter((r) => duplicateRowNumbers.has(r.rowNumber)),
    [validRows, duplicateRowNumbers]
  );
  const importableRows = useMemo(
    () => validRows.filter((r) => !duplicateRowNumbers.has(r.rowNumber)),
    [validRows, duplicateRowNumbers]
  );

  const canImport =
    importableRows.length > 0 && errorRows.length === 0 && accountId > 0 && !importing;

  const doImport = async () => {
    if (!canImport || !text) return;
    setImporting(true);
    setError(null);
    try {
      await onImport({ accountId, swap, dateFormat, csv: text });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(false);
    }
  };

  return (
    <Modal
      wide
      title={`Import CSV${file.name ? ` — ${file.name}` : ""}`}
      onClose={() => !importing && onClose()}
      footer={
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Btn onClick={onClose} disabled={importing}>
              Cancel
            </Btn>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Btn variant="primary" onClick={doImport} disabled={!canImport}>
              {importing
                ? "Importing"
                : `Import ${importableRows.length} transaction${importableRows.length === 1 ? "" : "s"}`}
            </Btn>
          </div>
        </>
      }
    >
      {readError && (
        <Notice tone="danger" title="Could not read the file">
          {readError}
        </Notice>
      )}
      {parsed?.headerError && (
        <Notice tone="danger" title="Invalid CSV">
          {parsed.headerError}
        </Notice>
      )}
      {error && (
        <Notice tone="danger" title="Import failed">
          {error}
        </Notice>
      )}

      <Field label="Account">
        <Select
          value={accountId}
          onChange={(v) => setAccountId(Number(v))}
          className="w-full"
          searchable
          ariaLabel="Import account"
        >
          {availableAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <Checkbox checked={swap} onChange={setSwap} label="Swap Payee and Memo" />
        <div className="flex items-center gap-1.5">
          <label htmlFor="csv-date-format" className="y-hint text-[11px] whitespace-nowrap">
            Date Format:
          </label>
          <select
            id="csv-date-format"
            value={dateFormat}
            onChange={(e) => setDateFormat(e.target.value as "auto" | "dmy" | "mdy")}
            className="text-[11px] bg-transparent border rounded px-1.5 py-0.5"
            style={{ borderColor: "var(--y-line)" }}
            aria-label="Date format"
          >
            <option value="auto">
              Auto-detect {parsed?.detectedDateFormat ? `(${parsed.detectedDateFormat.toUpperCase()})` : ""}
            </option>
            <option value="dmy">DD/MM/YYYY</option>
            <option value="mdy">MM/DD/YYYY</option>
          </select>
        </div>
        <span className="y-hint text-[11px] ml-auto">
          {importableRows.length} importable · {errorRows.length + duplicateRows.length} skipped
        </span>
      </div>

      {errorRows.length > 0 && (
        <Notice tone="warn" className="mb-3" title={`${errorRows.length} row(s) skipped`}>
          <ul className="list-disc pl-4">
            {errorRows.slice(0, 10).map((r) => (
              <li key={r.rowNumber}>
                Row {r.rowNumber}: {r.error}
              </li>
            ))}
            {errorRows.length > 10 && <li>…and {errorRows.length - 10} more</li>}
          </ul>
        </Notice>
      )}

      {duplicateRows.length > 0 && (
        <Notice
          tone="warn"
          className="mb-3"
          title={`${duplicateRows.length} row(s) are duplicates and will be skipped`}
        >
          <ul className="list-disc pl-4">
            {duplicateRows.slice(0, 10).map((r) => (
              <li key={r.rowNumber}>
                Row {r.rowNumber}: {r.date ?? ""} · {r.payee || "—"} · {money(r.amountCents ?? 0)}
              </li>
            ))}
            {duplicateRows.length > 10 && <li>…and {duplicateRows.length - 10} more</li>}
          </ul>
        </Notice>
      )}

      {rows.length === 0 && !parsed?.headerError && (
        <Notice tone="warn" title="Nothing to import">
          No importable rows were found in this file.
        </Notice>
      )}

      {rows.length > 0 && (
        <div className="y-scroll max-h-[320px] overflow-auto border rounded" style={{ borderColor: "var(--y-line)" }}>
          <table className="y-table w-full text-left">
            <thead className="y-thead--sticky">
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th>Memo</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.rowNumber}
                  className={cx(
                    "y-row",
                    r.error && "y-row--error",
                    !r.error && duplicateRowNumbers.has(r.rowNumber) && "y-row--warn",
                    swap && !r.error && !r.payee && "y-row--warn"
                  )}
                >
                  <td className="y-num whitespace-nowrap">{r.date ?? ""}</td>
                  <td>
                    {swap && !r.error && !r.payee ? (
                      <span className="y-hint" style={{ color: "#7d5a12" }}>
                        Uncategorized
                      </span>
                    ) : r.payee ? (
                      r.payee
                    ) : (
                      <span className="y-hint">—</span>
                    )}
                  </td>
                  <td>{r.memo || <span className="y-hint">—</span>}</td>
                  <td className="num y-num">
                    {r.error ? <span className="y-hint">—</span> : money(r.amountCents ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}