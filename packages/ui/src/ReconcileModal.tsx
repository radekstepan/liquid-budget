"use client";

import { useEffect, useMemo, useState } from "react";
import type { Category, CategoryGroup } from "@ynab/logic";
import { evalAmount, round2 } from "@ynab/logic";
import { Button, Notice, Select, TextField, money } from "@ynab/theme";
import { Btn, Field, Modal } from "./ui.js";
import { AmountPreview } from "./AmountInput.js";

/**
 * Server response from `POST /api/reconcile` with `action: "reconcile"`.
 * Mirrors the type exported from `@ynab/server` (`ReconcileResult`).
 */
export type ReconcileModalState = {
  accountId: number;
  accountName: string;
  workingBalance: number;
  unclearedTotal: number;
  unclearedCount: number;
  clearedCount: number;
  reconciledCount: number;
  lastReconciledAt: string | null;
  lastReconciledBalance: number | null;
};

export type ReconcileResultPayload = {
  reconciledCount: number;
  adjustmentTransactionId: number | null;
  finalDiff: number;
  lastReconciledAt: string;
};

/**
 * Modal for entering the bank's statement balance and reconciling an
 * account. Mirrors YNAB4's behaviour:
 *
 *   - Shows the working balance (cleared + reconciled total) so the
 *     user knows what to expect before typing.
 *   - Live "Difference" footer (green when 0, red otherwise).
 *   - When the difference is non-zero, a second panel lets the user
 *     pick a category and click "Create adjustment" — the diff is
 *     absorbed by a single auto-generated transaction before the
 *     reconcile button is enabled.
 *   - Footer primary action is disabled until diff === 0.
 */
export function ReconcileModal({
  state,
  categories,
  groups,
  onClose,
  onReconcile,
  onUnreconcile,
  busy,
}: {
  state: ReconcileModalState;
  categories: Category[];
  groups: CategoryGroup[];
  onClose: () => void;
  onReconcile: (input: {
    accountId: number;
    statementBalance: number;
    adjustmentCategoryId: number | null;
  }) => Promise<void>;
  onUnreconcile?: (accountId: number) => Promise<void>;
  busy?: boolean;
}) {
  const [statementInput, setStatementInput] = useState(
    (state.workingBalance / 100).toFixed(2)
  );
  const [adjustmentCategoryId, setAdjustmentCategoryId] = useState<number | "">(
    pickFirstCategory(categories, groups)
  );

  const statementBalance = useMemo(() => {
    const n = evalAmount(statementInput);
    return n != null && Number.isFinite(n) ? Math.round(n * 100) : NaN;
  }, [statementInput]);

  const diff = useMemo(() => {
    if (!Number.isFinite(statementBalance)) return NaN;
    return statementBalance - state.workingBalance;
  }, [statementBalance, state.workingBalance]);

  const balanced = Number.isFinite(diff) && diff === 0;
  const needsAdjustment = !balanced;
  const eligibleCategories = useMemo(
    () => categories.filter((c) => !isCreditCardCategory(c, groups)),
    [categories, groups]
  );

  // The "Mark for adjustment" button lets the user signal intent:
  // "Yes, I see the diff; create the synthetic transaction." The
  // diff is computed in the modal from the typed statement balance
  // and the server-side reconcileAccount() creates the adjustment
  // for `-diff` (= statement - working) so the working balance
  // lands on the statement value. The button is just acknowledgement
  // — toggling the "armed" state allows the primary "Reconcile"
  // button to submit even when the diff is non-zero.
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    // Re-arm whenever the statement balance changes so the user has
    // to consciously re-acknowledge the new diff.
    setArmed(false);
  }, [statementInput]);

  useEffect(() => {
    if (adjustmentCategoryId === "" && eligibleCategories.length > 0) {
      setAdjustmentCategoryId(eligibleCategories[0]!.id);
    }
  }, [adjustmentCategoryId, eligibleCategories]);

  const canSubmit =
    !!Number.isFinite(statementBalance) &&
    (balanced || (needsAdjustment && armed && adjustmentCategoryId !== ""));

  const onSubmit = async () => {
    if (!canSubmit) return;
    await onReconcile({
      accountId: state.accountId,
      statementBalance,
      adjustmentCategoryId: balanced
        ? null
        : adjustmentCategoryId === ""
          ? null
          : Number(adjustmentCategoryId),
    });
  };

  return (
    <Modal
      wide
      title={`Reconcile: ${state.accountName}`}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            variant="primary"
            onClick={onSubmit}
            disabled={!canSubmit || busy}
          >
            Reconcile
          </Btn>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3 mb-3">
        <SummaryStat
          label="Working Balance"
          value={state.workingBalance}
          hint={`${state.clearedCount + state.reconciledCount} cleared + reconciled`}
        />
        <SummaryStat
          label="Uncleared"
          value={state.unclearedTotal}
          hint={`${state.unclearedCount} not yet on a statement`}
          tone="soft"
        />
        <SummaryStat
          label="Last Reconciled"
          value={state.lastReconciledBalance}
          hint={
            state.lastReconciledAt
              ? `on ${state.lastReconciledAt}`
              : "never"
          }
          tone="soft"
        />
      </div>

      <Field label="Statement Balance">
        <TextField
          value={statementInput}
          onChange={(e) => setStatementInput(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          autoFocus
          className="w-full"
        />
        <AmountPreview value={statementInput} />
      </Field>

      <div
        className="rounded-[4px] px-3 py-2 mb-3 flex items-center gap-2"
        style={{
          background: balanced
            ? "var(--y-green-pale, rgba(34,139,86,0.08))"
            : "var(--y-red-pale, rgba(180,40,40,0.08))",
          border: balanced
            ? "1px solid var(--y-green)"
            : "1px solid var(--y-red)",
        }}
      >
        <span
          aria-hidden
          className="grid h-[18px] w-[18px] place-items-center rounded-full text-[11px] font-bold text-white"
          style={{ background: balanced ? "var(--y-green)" : "var(--y-red)" }}
        >
          {balanced ? "✓" : "!"}
        </span>
        <span
          className="text-[12px] font-bold y-num"
          style={{ color: balanced ? "var(--y-green-dk)" : "var(--y-red)" }}
        >
          {balanced
            ? "Balanced — ready to reconcile"
            : `Difference: ${diff > 0 ? "+" : ""}${money(diff, false)}`}
        </span>
        <span className="y-hint ml-auto text-[11px]">
          {balanced
            ? `${state.clearedCount} cleared will be locked as Reconciled`
            : "Enter the exact statement balance from your bank, or create an adjustment below."}
        </span>
      </div>

      {needsAdjustment && (
        <div
          className="rounded-[4px] p-3 mb-3"
          style={{
            background: "var(--y-panel-alt, rgba(0,0,0,0.03))",
            border: "1px solid var(--y-line)",
          }}
        >
          <div className="text-[12px] font-bold mb-1" style={{ color: "var(--y-ink)" }}>
            Absorb the difference
          </div>
          <div className="y-hint text-[11px] mb-2">
            YNAB4 records this as a single <em>Reconciliation balance</em> transaction
            so your register matches the bank's number.
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <Field label="Category">
              <Select
                value={adjustmentCategoryId}
                onChange={(v) =>
                  setAdjustmentCategoryId(
                    v === "" ? "" : Number(v)
                  )
                }
                className="w-full"
              >
                {eligibleCategories.length === 0 ? (
                  <option value="">No categories available</option>
                ) : (
                  eligibleCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))
                )}
              </Select>
            </Field>
            <Button
              size="md"
              variant={armed ? "primary" : "default"}
              onClick={() => setArmed(true)}
              disabled={adjustmentCategoryId === "" || balanced}
            >
              {armed ? "Will create adjustment" : "Mark for adjustment"}
            </Button>
          </div>
          {adjustmentCategoryId !== "" && (
            <div className="y-hint text-[11px] mt-2">
              When you click <strong>Reconcile</strong>, a single transaction for{" "}
              <span className="y-num">{money(-diff, false)}</span> will be created in{" "}
              <em>{eligibleCategories.find((c) => c.id === adjustmentCategoryId)?.name}</em>{" "}
              with memo "Reconciliation balance".
            </div>
          )}
        </div>
      )}

      {state.lastReconciledAt && onUnreconcile && (
        <Notice tone="info" title="Already reconciled">
          This account was last reconciled on {state.lastReconciledAt}. Reconciling again
          will lock <em>every currently-cleared</em> transaction — including any that have
          been entered since. You can{" "}
          <button
            type="button"
            className="underline"
            style={{ color: "var(--y-blue)" }}
            onClick={() => onUnreconcile(state.accountId)}
            disabled={busy}
          >
            undo the last reconciliation
          </button>{" "}
          if you need to back out.
        </Notice>
      )}
    </Modal>
  );
}

function SummaryStat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number | null;
  hint: string;
  tone?: "default" | "soft";
}) {
  return (
    <div className="y-mathbox">
      <div
        className="y-math-label"
        style={{ color: tone === "soft" ? "var(--y-ink-faint)" : undefined }}
      >
        {label}
      </div>
      <div className="y-math-val y-num">
        {value == null ? "—" : money(value)}
      </div>
      <div className="y-hint text-[10.5px] mt-[1px]">{hint}</div>
    </div>
  );
}

function pickFirstCategory(
  categories: Category[],
  groups: CategoryGroup[]
): number | "" {
  const eligible = categories.find((c) => !isCreditCardCategory(c, groups));
  return eligible?.id ?? "";
}

function isCreditCardCategory(c: Category, groups: CategoryGroup[]): boolean {
  // Categories in a credit-card payment group (e.g. "AMEX Cobalt",
  // "Scotia Passport Visa") are excluded from the adjustment
  // dropdown because they would double-count a CC payment as both
  // a category outflow and a balance change. The group is identified
  // by its `isCreditCardPayments` flag, not by name — see
  // `schema.ts:24` and `seed.ts:178`.
  const group = groups.find((g) => g.id === c.groupId);
  return !!group?.isCreditCardPayments;
}
