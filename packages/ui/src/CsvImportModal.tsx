"use client";

import { useEffect, useMemo, useState } from "react";
import type { Account, Category } from "@ynab/logic";
import { parseCsvImport, swapPayeeMemo } from "@ynab/logic";
import { Checkbox, Notice, Select, money, cx } from "@ynab/theme";
import { Modal, Field, Btn } from "./ui.js";

export function CsvImportModal({
  accounts,
  categories,
  defaultAccountId,
  file,
  onClose,
  onImport,
}: {
  accounts: Account[];
  categories: Category[];
  defaultAccountId: number | null;
  file: File;
  onClose: () => void;
  onImport: (input: { accountId: number; swap: boolean; csv: string }) => Promise<void>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [swap, setSwap] = useState(false);
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

  const parsed = useMemo(() => (text != null ? parseCsvImport(text) : null), [text]);
  const rows = useMemo(
    () => (parsed ? swapPayeeMemo(parsed.rows, swap) : []),
    [parsed, swap]
  );
  const validRows = useMemo(() => rows.filter((r) => !r.error), [rows]);
  const errorRows = useMemo(() => rows.filter((r) => r.error), [rows]);
  const categoryByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of categories) {
      const key = c.name.trim().toLowerCase();
      if (!m.has(key)) m.set(key, c.id);
    }
    return m;
  }, [categories]);
  const categoryNameById = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name] as const)),
    [categories]
  );

  const canImport =
    validRows.length > 0 && errorRows.length === 0 && accountId > 0 && !importing;

  const doImport = async () => {
    if (!canImport || !text) return;
    setImporting(true);
    setError(null);
    try {
      await onImport({ accountId, swap, csv: text });
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
          <Btn onClick={onClose} disabled={importing}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={doImport} disabled={!canImport}>
            {importing
              ? "Importing…"
              : `Import ${validRows.length} transaction${validRows.length === 1 ? "" : "s"}`}
          </Btn>
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
          ariaLabel="Import account"
        >
          {availableAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="mb-3 flex items-center justify-between">
        <Checkbox checked={swap} onChange={setSwap} label="Swap Payee and Memo" />
        <span className="y-hint text-[11px]">
          {validRows.length} importable · {errorRows.length} skipped
        </span>
      </div>

      {errorRows.length > 0 && (
        <Notice tone="warn" title={`${errorRows.length} row(s) skipped`}>
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
                <th>Category</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const matched = r.category ? categoryByName.get(r.category.trim().toLowerCase()) : null;
                return (
                  <tr key={r.rowNumber} className={cx("y-row", r.error && "y-row--error")}>
                    <td className="y-num whitespace-nowrap">{r.date ?? ""}</td>
                    <td>{r.payee || <span className="y-hint">—</span>}</td>
                    <td>{r.memo || <span className="y-hint">—</span>}</td>
                    <td>
                      {matched != null ? (
                        categoryNameById.get(matched) ?? r.category
                      ) : r.category ? (
                        <span className="y-hint">{r.category}</span>
                      ) : (
                        <span className="y-hint">Uncategorized</span>
                      )}
                    </td>
                    <td className="num y-num">
                      {r.error ? <span className="y-hint">—</span> : money(r.amountCents ?? 0)}
                    </td>
                    <td>{r.error && <span className="text-[#c0483a]">{r.error}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}