import { todayISO } from "@ynab/logic";
import type { Db } from "../../client.js";
import { accounts, reconciliations } from "../../schema.js";
import type { Ynab4ImportContext } from "../types.js";

export async function importAccounts(
  db: Db,
  yAccounts: any[],
  yRecons: any[],
  ctx: Ynab4ImportContext
): Promise<void> {
  // 2. Insert Accounts and Reconciliations
  let accountSort = 0;
  const nonTombstoneAccounts = yAccounts
    .filter((a: any) => !a.isTombstone)
    .sort((a: any, b: any) => (a.sortableIndex ?? 0) - (b.sortableIndex ?? 0));

  const yReconciliations = (yRecons || []).filter((r: any) => !r.isTombstone);
  // G-09: `reconciliations[]` is our own extension — stock YNAB4 never
  // writes this array (it persists only `AccountVO.lastReconciledDate` /
  // `lastReconciledBalance` plus per-register `cleared` flags). It is
  // non-empty only for backups produced by our own exporter (or hand
  // edits); stock files take the account-fields-only path below.
  const hasExplicitReconciliations = yReconciliations.length > 0;

  // G-03: `lastEnteredCheckNumber` has no column (check-number support
  // is not modeled) — counted once here so the drop is reported in
  // warnings, never silent. YNAB4 defaults the field to -1.
  let droppedCheckNumberCount = 0;
  for (const acc of nonTombstoneAccounts) {
    const lec = acc?.lastEnteredCheckNumber;
    if (lec !== undefined && lec !== null && lec !== "" && Number(lec) !== -1) {
      droppedCheckNumberCount++;
    }
  }
  if (droppedCheckNumberCount > 0) {
    ctx.warnings.push(
      `Dropped lastEnteredCheckNumber on ${droppedCheckNumberCount} account(s); check-number tracking is not modeled`
    );
  }

  for (const acc of nonTombstoneAccounts) {
    ctx.accOnBudgetMap.set(acc.entityId, !!acc.onBudget);
    const kind =
      acc.accountType === "CreditCard" || acc.accountType === "LineofCredit"
        ? "credit"
        : acc.onBudget
        ? "liquid"
        : "offbudget";
    ctx.accKindMap.set(acc.entityId, kind);

    const groupLabel = acc.onBudget
      ? kind === "credit"
        ? "Credit Cards"
        : "Budget Accounts"
      : "Off Budget";

    const isArchived = Boolean(acc.hidden || acc.closed || acc.isClosed);

    let recDate: string | null = null;
    let recBalance: number | null = null;

    if (hasExplicitReconciliations) {
      const accRecs = yReconciliations.filter((r: any) => r.accountId === acc.entityId);
      if (accRecs.length > 0) {
        const latestRec = accRecs[accRecs.length - 1]!;
        recDate = acc.lastReconciledDate || latestRec.statementDate || latestRec.reconciledAt || todayISO();
        recBalance =
          acc.lastReconciledBalance != null
            ? ctx.convertAmount(Number(acc.lastReconciledBalance))
            : ctx.convertAmount(latestRec.statementBalance);
      } else if (acc.lastReconciledDate != null) {
        recDate = acc.lastReconciledDate;
        recBalance = acc.lastReconciledBalance != null ? ctx.convertAmount(Number(acc.lastReconciledBalance)) : null;
      }
    } else {
      // G-09 stock path: no `reconciliations[]` array (stock YNAB4 never
      // writes one). Carry just the account-level fields YNAB4 actually
      // persists (`AccountVO.lastReconciledDate/Balance`); never
      // synthesize reconciliation rows, so imported history claims no
      // phantom statement precision. Per-row `cleared: "Reconciled"`
      // flags still map to status "r" below (with the date but no
      // reconciliationId).
      recDate = acc.lastReconciledDate ?? null;
      recBalance =
        acc.lastReconciledBalance != null ? ctx.convertAmount(Number(acc.lastReconciledBalance)) : null;
    }

    const [row] = await db
      .insert(accounts)
      .values({
        entityId: acc.entityId,
        name: acc.accountName,
        kind,
        groupLabel,
        balance: 0, // To be computed from transactions
        onBudget: !!acc.onBudget,
        sort: accountSort++,
        lastReconciledAt: recDate,
        lastReconciledBalance: recBalance,
        archived: isArchived,
        // G-03 (cheap): preserve the YNAB4 account note verbatim.
        notes: typeof acc.note === "string" ? acc.note : "",
        // G-03: preserve the verbatim YNAB4 account type; `kind`
        // above keeps driving app logic, the exporter prefers this
        // raw value when present.
        accountTypeRaw:
          typeof acc.accountType === "string" && acc.accountType.trim() !== ""
            ? acc.accountType
            : null,
      })
      .returning();

    ctx.accountIdMap.set(acc.entityId, row!.id);

    if (hasExplicitReconciliations) {
      const accRecs = yReconciliations.filter((r: any) => r.accountId === acc.entityId);
      for (const r of accRecs) {
        const rDate = r.reconciledAt || r.statementDate || recDate || todayISO();
        const sDate = r.statementDate || r.reconciledAt || recDate || todayISO();
        const sBal = ctx.convertAmount(r.statementBalance);
        const [rec] = await db
          .insert(reconciliations)
          .values({
            entityId: r.entityId,
            accountId: row!.id,
            reconciledAt: rDate,
            statementDate: sDate,
            statementBalance: sBal,
            adjustmentTransactionId: null,
          })
          .returning();
        if (rec) {
          ctx.reconciliationIdMap.set(r.entityId, rec.id);
          ctx.reconciliationDateMap.set(r.entityId, rDate);
          ctx.accountReconciliationIdMap.set(acc.entityId, rec.id);
          ctx.accountReconciliationDateMap.set(acc.entityId, rDate);
        }
      }
    }
    // G-09: no row synthesis for stock files (no `reconciliations[]`
    // array) — only the account-level `lastReconciledAt/Balance`
    // fields above. Rows below are created solely for explicit
    // (exporter-shaped) reconciliation rounds.
  }
}
