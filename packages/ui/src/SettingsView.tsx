"use client";

import { useMemo, useState } from "react";
import type {
  RenameRule,
  RenameSuggestResponse,
  RenameSuggestStatusResponse,
} from "@ynab/logic";
import {
  countRenameRuleMatches,
  isPatternRule,
  renameRulePayeeFilter,
  RENAME_SUGGEST_BATCH_SIZE,
} from "@ynab/logic";
import { Checkbox, Icon, Notice, Button, Tooltip } from "@ynab/theme";
import { Modal, Field, Btn, inputCls } from "./ui.js";

type RuleDraft = {
  sourcePattern: string;
  targetPayee: string;
};

export type ApplyRuleResult = {
  updated: number;
  skippedLocked: number;
};

export type SuggestRulesResult = Pick<RenameSuggestResponse, "suggestions" | "skipped" | "model">;

export type SuggestBatchResult = Pick<
  RenameSuggestResponse,
  "suggestions" | "skipped" | "model" | "processed"
>;

export type AcceptSuggestionsResult = {
  /** Rules created by this accept (before learning merges). */
  created: number;
  updated: number;
  skippedLocked: number;
  generalised: boolean;
};

function toError(title: string, e: any): { title: string; message: string } {
  return { title, message: e?.message ? String(e.message) : String(e) };
}

export function SettingsView({
  rules,
  onAdd,
  onUpdate,
  onDelete,
  existingPayees,
  onApply,
  onViewMatches,
  suggestStatus,
  onSuggestRules,
  onAcceptSuggestions,
}: {
  rules: RenameRule[];
  onAdd: (sourcePattern: string, targetPayee: string) => Promise<void>;
  onUpdate: (id: number, sourcePattern: string, targetPayee: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** Payee names of stored transactions; enables per-rule match counts. */
  existingPayees?: string[];
  /** Rewrite stored transactions matching a rule; enables the Apply button. */
  onApply?: (id: number) => Promise<ApplyRuleResult>;
  /**
   * Jump to the transaction register filtered to a rule's matches; enables
   * the Source link (only rendered when the rule matches something).
   */
  onViewMatches?: (rule: RenameRule) => void;
  /**
   * AI suggestion availability + uncovered payees. The AI button is hidden
   * unless this is present, `enabled`, and `onSuggestRules` is set — the
   * server reports `enabled: false` when no LLM is configured via .env.
   */
  suggestStatus?: RenameSuggestStatusResponse | null;
  /** Ask the LLM to clean up one page of uncovered payees; the view walks the whole queue in batches. */
  onSuggestRules?: (offset: number, limit: number) => Promise<SuggestBatchResult>;
  /** Persist reviewed drafts as rules, optionally rewriting stored rows. */
  onAcceptSuggestions?: (
    suggestions: { sourcePattern: string; targetPayee: string }[],
    applyToExisting: boolean
  ) => Promise<{ updated: number; skippedLocked: number; generalised: boolean }>;
}) {
  const [editing, setEditing] = useState<RenameRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [applyResult, setApplyResult] = useState<
    (ApplyRuleResult & { sourcePattern: string }) | null
  >(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestProgress, setSuggestProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [suggestResult, setSuggestResult] = useState<SuggestRulesResult | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptResult, setAcceptResult] = useState<AcceptSuggestionsResult | null>(null);
  const [filter, setFilter] = useState("");

  const sorted = useMemo(
    () => [...rules].sort((a, b) => a.sourcePattern.localeCompare(b.sourcePattern)),
    [rules]
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (r) =>
        r.sourcePattern.toLowerCase().includes(q) ||
        r.targetPayee.toLowerCase().includes(q)
    );
  }, [sorted, filter]);

  // Rows each rule would rewrite: matching stored payees not already at
  // the target (mirrors the server's apply semantics). Unknown without
  // existingPayees, in which case no count is shown.
  const matchCounts = useMemo(() => {
    if (!existingPayees) return new Map<number, number>();
    return countRenameRuleMatches(sorted, existingPayees);
  }, [sorted, existingPayees]);

  const applyRule = async (r: RenameRule) => {
    if (!onApply || applyingId != null) return;
    setError(null);
    setApplyResult(null);
    setApplyingId(r.id);
    try {
      const res = await onApply(r.id);
      setApplyResult({ ...res, sourcePattern: r.sourcePattern });
    } catch (e: any) {
      setError(toError("Rule not applied", e));
    } finally {
      setApplyingId(null);
    }
  };

  const aiAvailable = suggestStatus?.enabled === true && onSuggestRules != null;
  const uncoveredCount = suggestStatus?.totalUnique ?? 0;

  const runSuggest = async () => {
    if (!onSuggestRules || suggesting) return;
    setError(null);
    setApplyResult(null);
    setAcceptResult(null);
    setSuggesting(true);
    // The % denominator: every uncovered payee is visited once. Failed
    // batches count as attempted (not retried) so progress never stalls.
    const planned = uncoveredCount;
    setSuggestProgress({ done: 0, total: planned });
    const suggestions: RenameSuggestResponse["suggestions"] = [];
    const skipped: RenameSuggestResponse["skipped"] = [];
    let model = "";
    const failures: string[] = [];
    let attempts = 0;
    let done = 0;
    try {
      while (done < planned) {
        let res: SuggestBatchResult;
        try {
          res = await onSuggestRules(done, RENAME_SUGGEST_BATCH_SIZE);
        } catch (e: any) {
          failures.push(e?.message ? String(e.message) : String(e));
          attempts += 1;
          done += RENAME_SUGGEST_BATCH_SIZE;
          setSuggestProgress({ done: Math.min(done, planned), total: planned });
          continue;
        }
        attempts += 1;
        suggestions.push(...res.suggestions);
        skipped.push(...res.skipped);
        model = res.model;
        // The server sends nothing more once the per-click cap is hit.
        if (res.processed === 0) break;
        done += res.processed;
        setSuggestProgress({ done: Math.min(done, planned), total: planned });
      }
    } finally {
      setSuggesting(false);
      setSuggestProgress(null);
    }
    if (failures.length === 0) {
      setSuggestResult({ suggestions, skipped, model });
      return;
    }
    if (suggestions.length > 0 || skipped.length > 0) {
      setSuggestResult({ suggestions, skipped, model });
      setError({
        title: "Some AI batches failed",
        message: `${failures.length} of ${attempts} batches failed: ${failures[0]} Accept these rules, then click Suggest with AI again for the rest.`,
      });
      return;
    }
    setError({ title: "AI suggestions failed", message: failures[0] ?? "Unknown error" });
  };

  const suggestLabel = (() => {
    if (!suggesting) {
      return `Suggest with AI${uncoveredCount > 0 ? ` (${uncoveredCount})` : ""}`;
    }
    if (suggestProgress != null && suggestProgress.total > 0 && suggestProgress.done > 0) {
      const pct = Math.round((suggestProgress.done / suggestProgress.total) * 100);
      return `Thinking… ${pct}%`;
    }
    return "Thinking…";
  })();

  const acceptSuggestions = async (
    drafts: { sourcePattern: string; targetPayee: string }[],
    applyToExisting: boolean
  ) => {
    if (!onAcceptSuggestions) return;
    setError(null);
    setAccepting(true);
    try {
      const res = await onAcceptSuggestions(drafts, applyToExisting);
      setSuggestResult(null);
      setAcceptResult({
        created: drafts.length,
        updated: res.updated,
        skippedLocked: res.skippedLocked,
        generalised: res.generalised,
      });
    } catch (e: any) {
      setError(toError("AI rules not created", e));
    } finally {
      setAccepting(false);
    }
  };

  const openCreate = () => {
    setError(null);
    setEditing(null);
    setCreating(true);
  };

  const save = async (draft: RuleDraft) => {
    setError(null);
    setBusy(true);
    try {
      if (creating) {
        await onAdd(draft.sourcePattern, draft.targetPayee);
      } else if (editing) {
        await onUpdate(editing.id, draft.sourcePattern, draft.targetPayee);
      }
      setCreating(false);
      setEditing(null);
    } catch (e: any) {
      setError(toError("Rule not saved", e));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (deletingId == null) return;
    setError(null);
    setBusy(true);
    try {
      await onDelete(deletingId);
      setDeletingId(null);
    } catch (e: any) {
      setError(toError("Rule not deleted", e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "var(--y-row)" }}>
      <div className="flex-shrink-0 px-5 pt-5 pb-3 max-w-[760px] w-full">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-[16px] font-bold" style={{ color: "var(--y-ink)" }}>
              Payee Rename Rules
            </h1>
            <p className="y-hint text-[12px] mt-1 max-w-[560px]">
              These rules are applied automatically to payees in future CSV imports.
              They are learned when you rename a transaction payee (for example{" "}
              <span className="y-num">BCF1</span> → <span className="y-num">BC Ferries</span>).
              Renaming <span className="y-num">BCF2</span> the same way generalises the rule
              to <span className="y-num">BCF[N] → BC Ferries</span>, where <span className="y-num">[N]</span>{" "}
              matches one or more digits and <span className="y-num">[X]</span> matches a
              bank reference code (letters and digits).
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {aiAvailable && (
              <Tooltip
                tip={
                  uncoveredCount === 0
                    ? "No imported payees need rules"
                    : `Clean up ${uncoveredCount} imported payee${uncoveredCount === 1 ? "" : "s"} with AI`
                }
              >
                <Button
                  size="sm"
                  onClick={() => void runSuggest()}
                  disabled={suggesting || uncoveredCount === 0}
                  aria-label="Suggest rename rules with AI"
                >
                  {suggestLabel}
                </Button>
              </Tooltip>
            )}
            <Button size="sm" variant="primary" onClick={openCreate} aria-label="Add rename rule">
              <Icon name="plus" size={12} /> Add rule
            </Button>
          </div>
        </div>

        {sorted.length > 0 && (
          <div className="flex items-center gap-2 mt-3">
            <input
              className={inputCls}
              style={{ maxWidth: 260 }}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter rules"
              aria-label="Filter rename rules"
            />
            {filter.trim() && (
              <span className="y-hint text-[11px]">
                {visible.length} of {sorted.length} rule{sorted.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}

        {error && (
          <Notice tone="danger" title={error.title} className="mt-3">
            {error.message}
          </Notice>
        )}

        {applyResult && (
          <Notice tone="ok" title="Rule applied" className="mt-3">
            <span className="y-num">{applyResult.sourcePattern}</span> renamed{" "}
            {applyResult.updated} existing transaction
            {applyResult.updated === 1 ? "" : "s"}
            {applyResult.skippedLocked > 0 &&
              ` (${applyResult.skippedLocked} reconciled left untouched)`}
            .
          </Notice>
        )}

        {acceptResult && (
          <Notice tone="ok" title="AI rules created" className="mt-3">
            Created {acceptResult.created} rename rule
            {acceptResult.created === 1 ? "" : "s"}
            {acceptResult.generalised && " (some generalised into [N]/[X] patterns)"}
            {acceptResult.updated > 0 &&
              ` and renamed ${acceptResult.updated} existing transaction${acceptResult.updated === 1 ? "" : "s"}`}
            {acceptResult.skippedLocked > 0 &&
              ` (${acceptResult.skippedLocked} reconciled left untouched)`}
            .
          </Notice>
        )}
      </div>

      <div className="flex-1 min-h-0 px-5 pb-5 max-w-[760px] w-full flex flex-col">
        {sorted.length === 0 ? (
          <div className="mt-1">
            <Notice tone="info" title="No rename rules yet">
              Rename a payee on a transaction after a CSV import, or add a rule manually, to
              keep future imports tidy.
            </Notice>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-1">
            <Notice tone="info" title="No matches">
              {`No rules match "${filter.trim()}".`}
            </Notice>
          </div>
        ) : (
          <div
            data-testid="rules-scroll"
            className="flex-1 min-h-0 overflow-auto y-scroll border rounded"
            style={{ borderColor: "var(--y-line)" }}
          >
            <table className="y-table w-full text-left">
              <thead className="y-thead--sticky">
                <tr>
                  <th>Source</th>
                  <th>Renamed to</th>
                  <th className="w-[84px]">Matches</th>
                  <th className="w-[92px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const matches = matchCounts.get(r.id);
                  const canView =
                    onViewMatches != null &&
                    matches != null &&
                    matches > 0 &&
                    renameRulePayeeFilter(r.sourcePattern) != null;
                  return (
                    <tr key={r.id} className="y-row">
                      <td className="y-num whitespace-nowrap">
                        {canView ? (
                          <Tooltip tip="Show matching transactions">
                            <button
                              type="button"
                              className="hover:underline cursor-pointer"
                              style={{ color: "var(--y-blue)" }}
                              onClick={() => onViewMatches!(r)}
                              aria-label={`Show transactions matching ${r.sourcePattern}`}
                            >
                              {r.sourcePattern}
                            </button>
                          </Tooltip>
                        ) : (
                          r.sourcePattern
                        )}
                      </td>
                      <td className="truncate">{r.targetPayee}</td>
                      <td className="y-num">
                        {matches == null ? (
                          <span className="y-hint">—</span>
                        ) : (
                          <span
                            aria-label={
                              matches === 1
                                ? `1 transaction matches ${r.sourcePattern}`
                                : `${matches} transactions match ${r.sourcePattern}`
                            }
                          >
                            {matches}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          {onApply && (
                            <Tooltip tip="Apply to existing transactions">
                              <button
                                className="y-icon-btn"
                                aria-label={`Apply rule ${r.sourcePattern} to existing transactions`}
                                disabled={applyingId != null || matches === 0}
                                onClick={() => void applyRule(r)}
                              >
                                <Icon name="check" size={12} />
                              </button>
                            </Tooltip>
                          )}
                          <Tooltip tip="Edit rule">
                            <button
                              className="y-icon-btn"
                              aria-label={`Edit rule ${r.sourcePattern}`}
                              onClick={() => {
                                setError(null);
                                setCreating(false);
                                setEditing(r);
                              }}
                            >
                              <Icon name="edit" size={12} />
                            </button>
                          </Tooltip>
                          <Tooltip tip="Delete rule">
                            <button
                              className="y-icon-btn"
                              aria-label={`Delete rule ${r.sourcePattern}`}
                              onClick={() => setDeletingId(r.id)}
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deletingId != null && (
        <Modal
          title="Delete rename rule"
          onClose={() => setDeletingId(null)}
          footer={
            <>
              <Btn onClick={() => setDeletingId(null)} disabled={busy}>
                Cancel
              </Btn>
              <Btn variant="danger" onClick={confirmDelete} disabled={busy}>
                {busy ? "Deleting" : "Yes, delete it"}
              </Btn>
            </>
          }
        >
          <div className="text-[12.5px]" style={{ color: "var(--y-ink)" }}>
            <p>
              Are you sure you want to delete this rename rule? It will no longer be applied
              during CSV imports.
            </p>
          </div>
        </Modal>
      )}

      {(creating || editing) && (
        <RuleFormModal
          title={creating ? "Add rename rule" : "Edit rename rule"}
          initial={
            editing
              ? { sourcePattern: editing.sourcePattern, targetPayee: editing.targetPayee }
              : { sourcePattern: "", targetPayee: "" }
          }
          busy={busy}
          onClose={() => {
            if (!busy) {
              setCreating(false);
              setEditing(null);
            }
          }}
          onSave={save}
        />
      )}

      {suggestResult && onAcceptSuggestions && (
        <SuggestRulesModal
          result={suggestResult}
          busy={accepting}
          onClose={() => {
            if (!accepting) setSuggestResult(null);
          }}
          onAccept={acceptSuggestions}
        />
      )}
    </div>
  );
}

function RuleFormModal({
  title,
  initial,
  busy,
  onClose,
  onSave,
}: {
  title: string;
  initial: RuleDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: RuleDraft) => void;
}) {
  const [sourcePattern, setSourcePattern] = useState(initial.sourcePattern);
  const [targetPayee, setTargetPayee] = useState(initial.targetPayee);

  const valid = sourcePattern.trim().length > 0 && targetPayee.trim().length > 0;

  return (
    <Modal
      title={title}
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
              if (sourcePattern.trim() && targetPayee.trim()) {
                onSave({ sourcePattern, targetPayee });
              }
            }}
          >
            Save rule
          </Btn>
        </>
      }
    >
      <Field label="Source">
        <input
          className={inputCls}
          value={sourcePattern}
          onChange={(e) => setSourcePattern(e.target.value)}
          placeholder='e.g. BCF1 or BCF[N]'
          aria-label="Source pattern"
        />
      </Field>
      <Field label="Renamed to">
        <input
          className={inputCls}
          value={targetPayee}
          onChange={(e) => setTargetPayee(e.target.value)}
          placeholder="e.g. BC Ferries"
          aria-label="Target payee"
        />
      </Field>
      <p className="y-hint text-[11px] -mt-1">
        Use <span className="y-num">[N]</span> to match one or more digits, e.g.{" "}
        <span className="y-num">BCF[N]</span> matches <span className="y-num">BCF1</span>,{" "}
        <span className="y-num">BCF2</span>, <span className="y-num">BCF10</span>. Use{" "}
        <span className="y-num">[X]</span> for a bank reference code (letters and digits).
        Leave both out for an exact match.
      </p>
      {isPatternRule(sourcePattern) && (
        <div className="mt-3">
          <Notice tone="ok" title="Pattern detected">
            <span className="y-num">{sourcePattern}</span> will match any payee whose digits
            vary, and rename it to <span className="y-num">{targetPayee || "…"}</span>.
          </Notice>
        </div>
      )}
    </Modal>
  );
}

type SuggestRow = {
  sourcePattern: string;
  targetPayee: string;
  count: number;
  memos: string[];
  selected: boolean;
};

function SuggestRulesModal({
  result,
  busy,
  onClose,
  onAccept,
}: {
  result: SuggestRulesResult;
  busy: boolean;
  onClose: () => void;
  onAccept: (
    drafts: { sourcePattern: string; targetPayee: string }[],
    applyToExisting: boolean
  ) => void;
}) {
  const [rows, setRows] = useState<SuggestRow[]>(() =>
    result.suggestions.map((s) => ({ ...s, memos: s.memos ?? [], selected: true }))
  );
  const [applyToExisting, setApplyToExisting] = useState(true);

  const selected = rows.filter(
    (r) => r.selected && r.targetPayee.trim().length > 0
  );

  const setRow = (index: number, patch: Partial<SuggestRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  return (
    <Modal
      wide
      title={`AI suggestions${result.model ? ` — ${result.model}` : ""}`}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={selected.length === 0 || busy}
            onClick={() =>
              onAccept(
                selected.map((r) => ({
                  sourcePattern: r.sourcePattern,
                  targetPayee: r.targetPayee.trim(),
                })),
                applyToExisting
              )
            }
          >
            {busy ? "Creating" : `Create ${selected.length} rule${selected.length === 1 ? "" : "s"}`}
          </Btn>
        </>
      }
    >
      {rows.length === 0 ? (
        <Notice tone="info" title="Nothing to suggest">
          The AI found no payees worth renaming
          {result.skipped.length > 0 && " — everything sent was already clean"}.
        </Notice>
      ) : (
        <>
          <p className="y-hint text-[12px] mb-2">
            Review each rename before creating the rule. Uncheck rows to skip
            them, or edit the name inline.
          </p>
          <div
            className="y-scroll max-h-[320px] overflow-auto border rounded"
            style={{ borderColor: "var(--y-line)" }}
          >
            <table className="y-table w-full text-left">
              <thead className="y-thead--sticky">
                <tr>
                  <th className="w-[34px]">
                    <span className="sr-only">Create this rule</span>
                  </th>
                  <th>Imported payee</th>
                  <th>Suggested name</th>
                  <th className="w-[64px]">Uses</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.sourcePattern}-${i}`} className="y-row">
                    <td>
                      <Checkbox
                        checked={r.selected}
                        disabled={busy}
                        onChange={(v) => setRow(i, { selected: v })}
                      />
                    </td>
                    <td className="y-num">
                      <div className="whitespace-nowrap">{r.sourcePattern}</div>
                      {r.memos.length > 0 && (
                        <div className="y-hint text-[11px] font-normal max-w-[300px] whitespace-normal break-words">
                          Memo{r.memos.length === 1 ? "" : "s"}:{" "}
                          {r.memos.map((m) => `“${m}”`).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td>
                      <input
                        className={inputCls}
                        value={r.targetPayee}
                        disabled={busy}
                        onChange={(e) => setRow(i, { targetPayee: e.target.value })}
                        aria-label={`Suggested name for ${r.sourcePattern}`}
                      />
                    </td>
                    <td className="y-num">×{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Checkbox
              checked={applyToExisting}
              disabled={busy}
              onChange={setApplyToExisting}
              label="Also rename matching transactions already in the budget"
            />
          </div>
        </>
      )}
      {result.skipped.length > 0 && (
        <div className="mt-3">
          <Notice tone="info" title={`${result.skipped.length} payee${result.skipped.length === 1 ? "" : "s"} skipped`}>
            <ul className="list-disc pl-4">
              {result.skipped.slice(0, 6).map((s, i) => (
                <li key={`${s.source}-${i}`}>
                  {s.source ? <span className="y-num">{s.source}</span> : "Response"} — {s.reason}
                </li>
              ))}
              {result.skipped.length > 6 && <li>…and {result.skipped.length - 6} more</li>}
            </ul>
          </Notice>
        </div>
      )}
    </Modal>
  );
}
