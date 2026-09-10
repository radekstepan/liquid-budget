"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Category, CategoryGroup, Payee } from "@ynab/logic";
import { Icon, Notice, Button } from "@ynab/theme";
import { Modal, Field, Btn, inputCls } from "./ui.js";

export type PayeeManagerEntry = {
  /** Null when the name only appears as free text (no payees row yet). */
  id: number | null;
  name: string;
  autoCategoryId: number | null;
  transactionCount: number;
  recurringCount: number;
};

function isTransferName(name: string): boolean {
  return /^transfer\s*:/i.test(name.trim());
}

function buildEntries(
  payees: Payee[],
  transactions: { payee: string; parentId?: number | null }[],
  recurring: { payee: string }[]
): PayeeManagerEntry[] {
  const byName = new Map<string, PayeeManagerEntry>();
  for (const p of payees) {
    if (isTransferName(p.name)) continue;
    byName.set(p.name, {
      id: p.id,
      name: p.name,
      autoCategoryId: p.autoCategoryId,
      transactionCount: 0,
      recurringCount: 0,
    });
  }
  const ensureText = (name: string) => {
    const t = name.trim();
    if (!t || isTransferName(t)) return null;
    let e = byName.get(t);
    if (!e) {
      e = { id: null, name: t, autoCategoryId: null, transactionCount: 0, recurringCount: 0 };
      byName.set(t, e);
    }
    return e;
  };
  for (const t of transactions) {
    // Split children inherit the parent's payee for display; count each
    // register row once by skipping them so "uses" matches the register.
    if (t.parentId != null) continue;
    const e = byName.get(t.payee.trim()) ?? ensureText(t.payee);
    if (e) e.transactionCount += 1;
  }
  for (const r of recurring) {
    const e = byName.get(r.payee.trim()) ?? ensureText(r.payee);
    if (e) e.recurringCount += 1;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function PayeesView({
  payees,
  transactions,
  recurring,
  categories,
  groups,
  onEnsurePayee,
  onRename,
  onSetDefaultCategory,
  onMerge,
  onDelete,
}: {
  payees: Payee[];
  transactions: { payee: string; parentId?: number | null }[];
  recurring: { payee: string }[];
  categories: Category[];
  groups: CategoryGroup[];
  /** Create (or fetch) the payees row for a text-only name. Resolves to the row id. */
  onEnsurePayee: (name: string) => Promise<number>;
  onRename: (id: number, name: string) => Promise<void>;
  onSetDefaultCategory: (id: number, categoryId: number | null) => Promise<void>;
  onMerge: (targetId: number, sourceIds: number[]) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<PayeeManagerEntry | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [deleting, setDeleting] = useState<PayeeManagerEntry | null>(null);
  const [categoryTarget, setCategoryTarget] = useState<PayeeManagerEntry | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // New filter = new list: jump back to the top.
    // scrollTop assignment works everywhere (unlike scrollTo, which jsdom
    // and some embeds lack); assignment is synchronous, no smooth-scroll.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [filter]);

  const entries = useMemo(
    () => buildEntries(payees, transactions, recurring),
    [payees, transactions, recurring]
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    return list;
  }, [entries, filter]);

  const byKey = useMemo(() => {
    const m = new Map<string, PayeeManagerEntry>();
    for (const e of entries) m.set(e.id != null ? `id:${e.id}` : `name:${e.name}`, e);
    return m;
  }, [entries]);

  // Drop selection keys that no longer exist after a reload.
  const activeSelected = selected.filter((k) => byKey.has(k));

  const categoryName = useMemo(() => {
    const groupName = new Map<number, string>();
    for (const g of groups) groupName.set(g.id, g.name);
    const m = new Map<number, string>();
    for (const c of categories) {
      const g = groupName.get(c.groupId);
      m.set(c.id, g ? `${g}: ${c.name}` : c.name);
    }
    return m;
  }, [categories, groups]);

  const run = async (fn: () => Promise<void>, after?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      after?.();
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resolveId = async (entry: PayeeManagerEntry): Promise<number> => {
    if (entry.id != null) return entry.id;
    return onEnsurePayee(entry.name);
  };

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const openRename = useCallback((entry: PayeeManagerEntry) => {
    setError(null);
    setRenaming(entry);
  }, []);

  const openDelete = useCallback((entry: PayeeManagerEntry) => {
    setDeleting(entry);
  }, []);

  const openCategoryPicker = useCallback((entry: PayeeManagerEntry) => {
    setError(null);
    setCategoryFilter("");
    setCategoryTarget(entry);
  }, []);

  const selectedEntries = activeSelected
    .map((k) => byKey.get(k)!)
    .filter(Boolean);

  const openMerge = () => {
    // Sensible default survivor: the most-used payee, ties broken by name.
    const ordered = [...selectedEntries].sort(
      (a, b) =>
        b.transactionCount + b.recurringCount - (a.transactionCount + a.recurringCount) ||
        a.name.localeCompare(b.name)
    );
    const first = ordered[0];
    setMergeTarget(first ? (first.id != null ? `id:${first.id}` : `name:${first.name}`) : null);
    setConfirmingMerge(true);
  };

  const confirmMerge = async () => {
    const target = mergeTarget ? byKey.get(mergeTarget) : undefined;
    if (!target) return;
    await run(async () => {
      const targetId = await resolveId(target);
      const sourceIds: number[] = [];
      for (const s of selectedEntries) {
        if (s === target) continue;
        sourceIds.push(await resolveId(s));
      }
      if (sourceIds.length === 0) throw new Error("Choose at least one other payee to merge");
      await onMerge(targetId, sourceIds);
    }, () => {
      setConfirmingMerge(false);
      setSelected([]);
      setMergeTarget(null);
    });
  };

  const saveRename = async (name: string) => {
    if (!renaming) return;
    await run(async () => {
      const id = await resolveId(renaming);
      await onRename(id, name);
    }, () => setRenaming(null));
  };

  const confirmDelete = async () => {
    if (!deleting || deleting.id == null) return;
    const id = deleting.id;
    await run(async () => {
      await onDelete(id);
    }, () => setDeleting(null));
  };

  const saveDefaultCategory = async (categoryId: number | null) => {
    if (!categoryTarget) return;
    const entry = categoryTarget;
    await run(async () => {
      const id = await resolveId(entry);
      await onSetDefaultCategory(id, categoryId);
    }, () => {
      setCategoryTarget(null);
      setCategoryFilter("");
    });
  };

  const pickerCategories = useMemo(() => {
    const q = categoryFilter.trim().toLowerCase();
    return groups
      .map((g) => ({
        group: g,
        cats: categories.filter(
          (c) => c.groupId === g.id && (!q || c.name.toLowerCase().includes(q))
        ),
      }))
      .filter((s) => s.cats.length > 0);
  }, [groups, categories, categoryFilter]);

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "var(--y-row)" }}>
      <div className="flex-shrink-0 px-5 pt-5 pb-3 max-w-[860px]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-[16px] font-bold" style={{ color: "var(--y-ink)" }}>
              Payees Manager
            </h1>
            <p className="y-hint text-[12px] mt-1 max-w-[600px]">
              Rename payees, merge duplicates into a single payee, or set the
              default category new transactions for a payee are assigned to.
              Transfer payees are managed by transfers and are not listed here.
            </p>
          </div>
          <input
            className={inputCls}
            style={{ maxWidth: 220 }}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter payees"
            aria-label="Filter payees"
          />
        </div>

        {error && (
          <Notice tone="danger" title="Payee not saved" className="mt-3">
            {error}
          </Notice>
        )}

        {activeSelected.length >= 2 && (
          <div
            className="mt-3 px-3 py-2 flex items-center gap-2 flex-wrap rounded border"
            style={{ borderColor: "var(--y-line)", background: "var(--y-panel-alt)" }}
          >
            <span className="text-[12px]" style={{ color: "var(--y-ink)" }}>
              {activeSelected.length} payees selected
            </span>
            <Button size="sm" variant="primary" onClick={openMerge} disabled={busy}>
              Merge into one…
            </Button>
            <button
              className="y-icon-btn"
              aria-label="Clear payee selection"
              onClick={() => setSelected([])}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 px-5 pb-5 max-w-[860px] w-full flex flex-col">
        {visible.length === 0 ? (
          <div className="mt-1">
            <Notice tone="info" title={entries.length === 0 ? "No payees yet" : "No matches"}>
              {entries.length === 0
                ? "Payees appear here once transactions or scheduled transactions use them."
                : `No payees match "${filter.trim()}".`}
            </Notice>
          </div>
        ) : (
          <div
            data-testid="payees-scroll"
            ref={scrollRef}
            className="flex-1 overflow-y-auto overflow-x-auto y-scroll border rounded"
            style={{ borderColor: "var(--y-line)", minHeight: 120 }}
          >
            <table className="y-table w-full text-left" aria-rowcount={visible.length + 1}>
              <thead className="y-thead--sticky">
                <tr>
                  <th className="w-[34px]">
                    <span className="sr-only">Select for merge</span>
                  </th>
                  <th>Payee</th>
                  <th className="w-[110px]">Uses</th>
                  <th className="w-[220px]">Default Category</th>
                  <th className="w-[48px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => {
                  const key = e.id != null ? `id:${e.id}` : `name:${e.name}`;
                  return (
                    <PayeeRow
                      key={key}
                      rowKey={key}
                      entry={e}
                      checked={activeSelected.includes(key)}
                      uses={e.transactionCount + e.recurringCount}
                      categoryLabel={
                        e.autoCategoryId == null
                          ? null
                          : categoryName.get(e.autoCategoryId) ?? "Unknown category"
                      }
                      busy={busy}
                      onToggle={toggleSelect}
                      onRename={openRename}
                      onDelete={openDelete}
                      onSetCategory={openCategoryPicker}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
      </div>

      {renaming && (
        <PayeeRenameModal
          key={renaming.id != null ? `id:${renaming.id}` : `name:${renaming.name}`}
          initialName={renaming.name}
          busy={busy}
          onClose={() => {
            if (!busy) setRenaming(null);
          }}
          onSave={(name) => void saveRename(name)}
        />
      )}

      {confirmingMerge && (
        <Modal
          title="Merge payees"
          onClose={() => {
            if (!busy) setConfirmingMerge(false);
          }}
          footer={
            <>
              <Btn onClick={() => setConfirmingMerge(false)} disabled={busy}>
                Cancel
              </Btn>
              <Btn variant="primary" onClick={() => void confirmMerge()} disabled={busy || !mergeTarget}>
                {busy ? "Merging" : "Merge payees"}
              </Btn>
            </>
          }
        >
          <div className="text-[12.5px] space-y-3" style={{ color: "var(--y-ink)" }}>
            <p>
              All transactions and scheduled transactions for the merged payees
              will be moved to the surviving payee. This cannot be undone
              except by renaming them back individually.
            </p>
            <Field label="Keep (surviving payee)">
              <select
                className={inputCls}
                value={mergeTarget ?? ""}
                disabled={busy}
                onChange={(e) => setMergeTarget(e.target.value)}
                aria-label="Surviving payee"
              >
                {selectedEntries.map((s) => {
                  const k = s.id != null ? `id:${s.id}` : `name:${s.name}`;
                  return (
                    <option key={k} value={k}>
                      {s.name} ({s.transactionCount + s.recurringCount} uses)
                    </option>
                  );
                })}
              </select>
            </Field>
            <p className="y-hint text-[11.5px]">
              Merging:{" "}
              {selectedEntries
                .filter((s) => {
                  const k = s.id != null ? `id:${s.id}` : `name:${s.name}`;
                  return k !== mergeTarget;
                })
                .map((s) => s.name)
                .join(", ") || "—"}
            </p>
          </div>
        </Modal>
      )}

      {deleting && deleting.id != null && (
        <Modal
          title="Delete payee"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Btn onClick={() => setDeleting(null)} disabled={busy}>
                Cancel
              </Btn>
              <Btn variant="danger" onClick={() => void confirmDelete()} disabled={busy}>
                {busy ? "Deleting" : "Yes, delete it"}
              </Btn>
            </>
          }
        >
          <div className="text-[12.5px]" style={{ color: "var(--y-ink)" }}>
            <p>
              Are you sure you want to delete the payee{" "}
              <strong>{deleting.name}</strong>?
              {(deleting.transactionCount + deleting.recurringCount) > 0 && (
                <>
                  {" "}
                  {deleting.transactionCount + deleting.recurringCount} transaction
                  {(deleting.transactionCount + deleting.recurringCount) === 1 ? "" : "s"} still
                  reference this name and will keep it as plain text.
                </>
              )}
            </p>
          </div>
        </Modal>
      )}

      {categoryTarget && (
        <Modal
          title={`Default category — ${categoryTarget.name}`}
          onClose={() => {
            if (!busy) {
              setCategoryTarget(null);
              setCategoryFilter("");
            }
          }}
          footer={
            <Btn
              onClick={() => {
                setCategoryTarget(null);
                setCategoryFilter("");
              }}
              disabled={busy}
            >
              Close
            </Btn>
          }
        >
          <div className="space-y-3">
            <Field label="Filter categories">
              <input
                className={inputCls}
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                placeholder="Type to filter"
                aria-label="Filter categories"
              />
            </Field>
            <div className="y-scroll max-h-[320px] overflow-y-auto space-y-3">
              <button
                className="y-menu-item w-full text-left"
                disabled={busy}
                onClick={() => void saveDefaultCategory(null)}
              >
                No default
              </button>
              {pickerCategories.map(({ group, cats }) => (
                <div key={group.id}>
                  <div className="y-hint text-[11px] font-bold px-1 mb-1">{group.name}</div>
                  {cats.map((c) => (
                    <button
                      key={c.id}
                      className="y-menu-item w-full text-left"
                      disabled={busy}
                      onClick={() => void saveDefaultCategory(c.id)}
                      aria-label={`Use ${c.name} as default category`}
                    >
                      <span className="truncate">
                        {c.name}
                        {categoryTarget.autoCategoryId === c.id ? " ✓" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {pickerCategories.length === 0 && (
                <p className="y-hint text-[11.5px]">No categories match.</p>
              )}
            </div>
            <p className="y-hint text-[11px]">
              New transactions for this payee are assigned to the default
              category when the statement carries none.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * Memoized table row: the manager renders thousands of these, so each row
 * must skip re-rendering when unrelated state (filter text, other modals,
 * selection of other rows) changes. Props are primitives + stable callbacks.
 * Cells deliberately avoid the stateful <Tooltip> (one per cell made both
 * mount and modal-open crawl with multi-thousand-payee budgets); the full
 * payee name stays available via the rename action and the filter box.
 */
const PayeeRow = memo(function PayeeRow({
  rowKey,
  entry,
  checked,
  uses,
  categoryLabel,
  busy,
  onToggle,
  onRename,
  onDelete,
  onSetCategory,
}: {
  rowKey: string;
  entry: PayeeManagerEntry;
  checked: boolean;
  uses: number;
  categoryLabel: string | null;
  busy: boolean;
  onToggle: (key: string) => void;
  onRename: (entry: PayeeManagerEntry) => void;
  onDelete: (entry: PayeeManagerEntry) => void;
  onSetCategory: (entry: PayeeManagerEntry) => void;
}) {
  return (
    <tr className="y-row y-payee-row">
      <td>
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={() => onToggle(rowKey)}
          aria-label={`Select payee ${entry.name} for merge`}
        />
      </td>
      <td className="truncate max-w-[260px]">
        <button
          type="button"
          className="truncate text-left text-[12px] hover:underline cursor-pointer"
          style={{ color: "var(--y-blue)" }}
          disabled={busy}
          onClick={() => onRename(entry)}
          aria-label={`Rename payee ${entry.name}`}
        >
          {entry.name}
          {entry.id == null && (
            <span className="y-hint text-[10.5px] ml-1.5">text-only</span>
          )}
        </button>
      </td>
      <td className="y-num whitespace-nowrap">
        <span>{uses}</span>
      </td>
      <td>
        <button
          className="block max-w-[200px] truncate text-left text-[12px] hover:underline cursor-pointer"
          style={{ color: "var(--y-blue)" }}
          disabled={busy}
          onClick={() => onSetCategory(entry)}
          aria-label={`Set default category for ${entry.name}`}
        >
          {categoryLabel ?? "No default"}
        </button>
      </td>
      <td>
        <div className="flex items-center gap-1">
          <button
            className="y-icon-btn"
            aria-label={`Delete payee ${entry.name}`}
            disabled={busy || entry.id == null}
            onClick={() => onDelete(entry)}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      </td>
    </tr>
  );
});

function PayeeRenameModal({
  initialName,
  busy,
  onClose,
  onSave,
}: {
  initialName: string;
  busy: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const valid = name.trim().length > 0 && name.trim() !== initialName;
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // Focus + select-all once on open so the user can type over the name or
    // adjust the selection without extra clicks.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <Modal
      title="Rename payee"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={!valid || busy}
            onClick={() => {
              if (name.trim() && name.trim() !== initialName) onSave(name.trim());
            }}
          >
            Save payee
          </Btn>
        </>
      }
    >
      <Field label="Payee name">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Payee name"
          ref={inputRef}
        />
      </Field>
      <p className="y-hint text-[11px] -mt-1">
        The new name is applied to every transaction and scheduled transaction
        using this payee. If a payee with that name already exists, merge them
        instead.
      </p>
    </Modal>
  );
}
