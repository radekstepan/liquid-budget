import { eq } from "drizzle-orm";
import {
  classifyBoundaryTransfer,
  duplicateFingerprint,
  nextMonthKey,
  repairSplitForImport,
  TRANSACTION_DUPLICATE_FLAG,
} from "@ynab/logic";
import type { Db } from "../../client.js";
import { accounts, transactions } from "../../schema.js";
import { extractYnab4TxLineage, ynabFlagToColor } from "../lineage.js";
import {
  incomeSentinelOffset,
  LEGACY_INCOME_SENTINELS,
  type IncomeSentinelOffset,
} from "../sentinels.js";
import type { Ynab4ImportContext } from "../types.js";
import { getOrCreateFallbackTransferCategory } from "./shared.js";

function noteIncomeSentinel(categoryId: unknown, ctx: Ynab4ImportContext): void {
  if (typeof categoryId === "string" && LEGACY_INCOME_SENTINELS.has(categoryId)) {
    ctx.legacyIncomeSentinelCount++;
    ctx.legacyIncomeSentinelKinds.add(categoryId);
  }
}

export async function importTransactions(
  db: Db,
  ynabData: any,
  ctx: Ynab4ImportContext
): Promise<void> {
  const yTransactions = ynabData.transactions || [];
  const yScheduled = ynabData.scheduledTransactions || [];
  // 5. Insert Transactions
  // G-05: YNAB4 import-match workflow fields we deliberately do not
  // model (`matchedTransactions`, `parentTransactionIdIfMatched`,
  // `dateEnteredFromSchedule`, and `accepted`). Our match workflow
  // differs, so every row imports as accepted and the link fields are
  // dropped — counted here so the loss is reported in warnings,
  // never silent. (Export hardcodes `accepted: true` for the same
  // reason; see export-ynab4.ts.)
  {
    let unacceptedCount = 0;
    let matchedCount = 0;
    let scheduleLinkCount = 0;
    const countRow = (row: any) => {
      if (row?.accepted === false) unacceptedCount++;
      if (
        Array.isArray(row?.matchedTransactions) &&
        row.matchedTransactions.some((m: any) => !m?.isTombstone)
      ) {
        matchedCount++;
      }
      if (typeof row?.parentTransactionIdIfMatched === "string" && row.parentTransactionIdIfMatched.trim() !== "") {
        matchedCount++;
      }
      const entered = row?.dateEnteredFromSchedule;
      if ((typeof entered === "string" && entered.trim() !== "") || typeof entered === "number") {
        scheduleLinkCount++;
      }
    };
    for (const t of yTransactions) {
      if (t.isTombstone) continue;
      countRow(t);
      for (const st of t.subTransactions || []) {
        if (!st?.isTombstone) countRow(st);
      }
    }
    for (const st of yScheduled) {
      if (st?.isTombstone) continue;
      countRow(st);
      for (const sub of st.subTransactions || []) {
        if (!sub?.isTombstone) countRow(sub);
      }
    }
    if (unacceptedCount > 0) {
      ctx.warnings.push(
        `Dropped "accepted === false" match state on ${unacceptedCount} YNAB4 row(s); our match workflow differs, so all rows import as accepted`
      );
    }
    if (matchedCount > 0) {
      ctx.warnings.push(
        `Dropped YNAB4 import-match links (matchedTransactions/parentTransactionIdIfMatched) on ${matchedCount} row(s); our match workflow differs`
      );
    }
    if (scheduleLinkCount > 0) {
      ctx.warnings.push(
        `Dropped YNAB4 schedule-entry links (dateEnteredFromSchedule) on ${scheduleLinkCount} row(s); recurring history is not linked to schedules`
      );
    }
  }

  ctx.allAccounts = await db.select().from(accounts);
  for (const a of ctx.allAccounts) ctx.accNameMap.set(a.id, a.name);

  // Fallback category for cross-budget-boundary transfer outflows with missing categories (BUG-03)

  // Build subTransactions and transactions lookup
  const subTxById = new Map<string, { parent: any; sub: any }>();
  const txById = new Map<string, any>();
  for (const t of yTransactions) {
    if (!t.isTombstone) {
      txById.set(t.entityId, t);
      for (const st of t.subTransactions || []) {
        if (!st.isTombstone) {
          subTxById.set(st.entityId, { parent: t, sub: st });
        }
      }
    }
  }

  const processedTransferIds = new Set<string>();
  // Count of transaction legs whose category used a legacy YNAB4 income
  // serialization name (`__SupplementalIncome__` / `__PrimaryIncome__`).
  // They classify exactly like their modern counterparts, but the
  // spelling is surfaced once in warnings so the mapping is never
  // silent.
  // G-split: unbalanced splits repaired with an auto-balance filler leg
  // (see repairSplitForImport). Aggregated into one warning below.
  // Fingerprints of already-encountered plain regular rows (used to flag
  // suspected duplicate entries within the backup). Split rows and
  // transfers are intentionally excluded.
  const plainFingerprints = new Set<string>();

  for (const t of yTransactions) {
    if (t.isTombstone) continue;

    const accId = ctx.accountIdMap.get(t.accountId);
    if (!accId) continue;

    const hasSubs = Array.isArray(t.subTransactions) && t.subTransactions.length > 0;

    if (hasSubs) {
      // Split transaction parent
      // G-06: import every live leg verbatim, including 0-amount legs
      // (they are valid YNAB4 rows). Only a parent with literally no
      // non-tombstone children is skipped — there is nothing to
      // import. Zero-sum parents import with amount 0 (the DB no
      // longer forbids zero amounts; balance math is unaffected
      // because split parents are excluded from balance sums and
      // zero legs contribute 0).
      const payee = ctx.payeeMap.get(t.payeeId) || "";
      const parentPayeeId = (t.payeeId && ctx.payeeDbIdMap.get(t.payeeId)) || null;
      const liveSubs = (t.subTransactions || []).filter((st: any) => !st.isTombstone);

      if (liveSubs.length === 0) {
        ctx.skippedDuplicates.push({
          accountName: ctx.accNameMap.get(accId) || "",
          date: t.date,
          payee,
          memo: t.memo || "",
          amount: 0,
          reason: "Split transaction with no live children",
        });
        continue;
      }

      const parentSentinelOffset = incomeSentinelOffset(t.categoryId);
      noteIncomeSentinel(t.categoryId, ctx);
      const isParentDeferred = parentSentinelOffset === "deferred";
      const isParentIncome = parentSentinelOffset !== null && (t.amount || 0) > 0;
      const parentIncomeRaw = isParentIncome && typeof t.categoryId === "string" ? t.categoryId : null;
      const parentIncomeMonth = isParentIncome
        ? (t.incomeMonth || (isParentDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
        : null;
      const isParentReconciled = t.cleared === "Reconciled" || Boolean(t.reconciliationId);
      const parentRecId = t.reconciliationId
        ? ctx.reconciliationIdMap.get(t.reconciliationId) ?? ctx.accountReconciliationIdMap.get(t.accountId) ?? null
        : isParentReconciled
        ? ctx.accountReconciliationIdMap.get(t.accountId) ?? null
        : null;
      const parentRecDate = t.reconciliationId
        ? ctx.reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? ctx.accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
        : isParentReconciled
        ? ctx.accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
        : null;
      // G-09: a YNAB4 `cleared: "Reconciled"` flag always maps to
      // status "r" (with the derived date, even when no explicit
      // reconciliation row exists to link — `reconciliationId` stays
      // null for stock files). The lock state is real source data;
      // only the statement row was phantom.
      const effectiveParentStatus = isParentReconciled
        ? "r"
        : t.cleared === "Uncleared" ? "u" : "c";

      // G-split: explicit import-time repair policy. YNAB4 renders an
      // unbalanced split with an auto-filler leg instead of rejecting
      // it, while our UI validator (`assertSplitsBalanced`) rejects such
      // splits on write — so the import repairs instead of throwing. A
      // filler leg preserves YNAB4's register total on the parent;
      // single-leg splits are kept verbatim (rebased to the leg).
      const splitRepair = repairSplitForImport(
        ctx.convertAmount(t.amount),
        liveSubs.map((st: any) => ({ amount: ctx.convertAmount(st.amount) }))
      );
      if (splitRepair.repaired) {
        ctx.splitRepairedCount++;
      }
      const parentSplitAmount = splitRepair.parentAmount;

      const parentLineage = extractYnab4TxLineage(t);
      const [insertedT] = await db
        .insert(transactions)
        .values({
          entityId: t.entityId,
          accountId: accId,
          categoryId: null,
          date: t.date,
          payee,
          payeeId: parentPayeeId,
          memo: t.memo || "",
          amount: parentSplitAmount,
          status: effectiveParentStatus,
          flagColor: ynabFlagToColor(t.flag),
          checkNumber: parentLineage.checkNumber,
          fitid: parentLineage.fitid,
          ynabId: parentLineage.ynabId,
          importedPayee: parentLineage.importedPayee,
          source: parentLineage.source,
          transferAccountId: null,
          parentId: null,
          isIncome: isParentIncome,
          incomeMonth: parentIncomeMonth,
          incomeCategoryRaw: parentIncomeRaw,
          reconciledAt: effectiveParentStatus === "r" ? parentRecDate : null,
          reconciliationId: effectiveParentStatus === "r" ? parentRecId : null,
        })
        .returning();

      ctx.totalImportedTxCount++;

      if (insertedT) {
        let allChildrenReconciled = liveSubs.length > 0;

        // YNAB4 first-inflow-child-wins per offset: `MonthlyBudget`
        // relevance (`isTransactionRelevantIncome`) consults only the
        // first inflow child of a split, so siblings on the other
        // offset never count as income. The winner is the offset of
        // the first positive non-transfer child carrying an income
        // sentinel; transfer legs (boundary-classified) and
        // non-sentinel legs never vote.
        let splitIncomeWinner: IncomeSentinelOffset | null = null;
        for (const st of liveSubs) {
          let votesAsTransfer = false;
          if (st.payeeId && st.payeeId.startsWith("Payee/Transfer:")) {
            const targetId = st.payeeId.split(":")[1];
            votesAsTransfer = Boolean(targetId && ctx.accountIdMap.has(targetId));
          } else if (st.targetAccountId) {
            votesAsTransfer = ctx.accountIdMap.has(st.targetAccountId);
          }
          if (votesAsTransfer) continue;
          if ((st.amount || 0) <= 0) continue;
          const offset = incomeSentinelOffset(st.categoryId);
          if (offset !== null) {
            splitIncomeWinner = offset;
            break;
          }
        }

        for (const st of liveSubs) {
          const accIsOnBudget = ctx.accOnBudgetMap.get(t.accountId) ?? true;
          let subCatId = (accIsOnBudget && ctx.categoryIdMap.get(st.categoryId)) || null;
          let subPayee = "";
          let subPayeeId: number | null = null;
          let subTransferAccountId: number | null = null;

          if (st.payeeId && st.payeeId.startsWith("Payee/Transfer:")) {
            const targetId = st.payeeId.split(":")[1];
            const foundTarget = targetId ? ctx.accountIdMap.get(targetId) : null;
            if (foundTarget) {
              subTransferAccountId = foundTarget;
              subPayee = "Transfer : " + (ctx.accNameMap.get(foundTarget) || "Unknown");
            }
          } else if (st.targetAccountId) {
            const foundTarget = ctx.accountIdMap.get(st.targetAccountId);
            if (foundTarget) {
              subTransferAccountId = foundTarget;
              subPayee = "Transfer : " + (ctx.accNameMap.get(foundTarget) || "Unknown");
            }
          } else if (st.payeeId) {
            subPayee = ctx.payeeMap.get(st.payeeId) || payee;
            subPayeeId = ctx.payeeDbIdMap.get(st.payeeId) ?? parentPayeeId;
          } else {
            subPayee = payee;
            subPayeeId = parentPayeeId;
          }

          const childAmt = ctx.convertAmount(st.amount);
          let isChildIncome = false;
          let childIncomeMonth: string | null = null;
          // Verbatim sentinel for export round-trip (kept for winners
          // and first-wins losers alike, so a re-import classifies
          // identically; consulted only when the row has no category).
          const childSentinelOffset = incomeSentinelOffset(st.categoryId);
          noteIncomeSentinel(st.categoryId, ctx);
          const childIncomeRaw = childSentinelOffset !== null && typeof st.categoryId === "string" ? st.categoryId : null;

          if (subTransferAccountId != null) {
            const destAccEntity = st.targetAccountId || (st.payeeId?.startsWith("Payee/Transfer:") ? st.payeeId.split(":")[1] : "");
            const destIsOnBudget = destAccEntity ? (ctx.accOnBudgetMap.get(destAccEntity) ?? false) : (ctx.allAccounts.find((a) => a.id === subTransferAccountId)?.onBudget ?? false);
            const isCrossBoundary = accIsOnBudget !== destIsOnBudget;
            const netOnBudgetDelta = (accIsOnBudget ? childAmt : 0) + (destIsOnBudget ? -childAmt : 0);
            if (isCrossBoundary && netOnBudgetDelta < 0 && subCatId === null) {
              subCatId = await getOrCreateFallbackTransferCategory(db, ctx);
            }
            const classification = classifyBoundaryTransfer({
              srcOnBudget: accIsOnBudget,
              destOnBudget: destIsOnBudget,
              amount: childAmt,
              categoryId: subCatId,
            });
            subCatId = classification.categoryId;
            isChildIncome = classification.isIncome;
          } else {
            const childOffset = childSentinelOffset;
            const isChildDeferred = childOffset === "deferred";
            const accKind = ctx.accKindMap.get(t.accountId) ?? "liquid";
            isChildIncome =
              accIsOnBudget &&
              accKind !== "credit" &&
              (childOffset !== null ||
                (subCatId === null && subTransferAccountId === null)) &&
              (st.amount || 0) > 0;
            // First-inflow-child-wins: a sentinel child on the losing
            // offset is not income (its verbatim category is still
            // kept in incomeCategoryRaw so export/re-import agree).
            if (
              isChildIncome &&
              childOffset !== null &&
              splitIncomeWinner !== null &&
              childOffset !== splitIncomeWinner
            ) {
              isChildIncome = false;
            }
            childIncomeMonth = isChildIncome
              ? (st.incomeMonth || (isChildDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
              : null;
          }

          const isChildReconciled = isParentReconciled || st.cleared === "Reconciled" || Boolean(st.reconciliationId);
          const childRecId = st.reconciliationId
            ? ctx.reconciliationIdMap.get(st.reconciliationId) ?? parentRecId ?? ctx.accountReconciliationIdMap.get(t.accountId) ?? null
            : isChildReconciled
            ? parentRecId ?? ctx.accountReconciliationIdMap.get(t.accountId) ?? null
            : null;
          const childRecDate = st.reconciliationId
            ? ctx.reconciliationDateMap.get(st.reconciliationId) ?? st.reconciledAt ?? parentRecDate ?? ctx.accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
            : isChildReconciled
            ? parentRecDate ?? ctx.accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
            : null;
          const effectiveChildStatus = isChildReconciled
            ? "r"
            : (t.cleared === "Uncleared" || st.cleared === "Uncleared") ? "u" : "c";

          let effectiveChildDestStatus: "u" | "c" | "r" | null = null;
          let childDestRecId: number | null = null;
          let childDestRecDate: string | null = null;
          let childDestTxEntityId: string | null = null;
          let childDestPartner: any = null;
          if (subTransferAccountId != null) {
            const destPartner = st.transferTransactionId ? txById.get(st.transferTransactionId) : null;
            childDestTxEntityId = destPartner?.entityId ?? st.transferTransactionId ?? null;
            if (destPartner) {
              childDestPartner = destPartner;
              const destAccEntId = destPartner.accountId;
              const isDestReconciled = destPartner.cleared === "Reconciled" || Boolean(destPartner.reconciliationId);
              const destRecEntityId = destPartner.reconciliationId;
              childDestRecId = destRecEntityId
                ? ctx.reconciliationIdMap.get(destRecEntityId) ?? ctx.accountReconciliationIdMap.get(destAccEntId) ?? null
                : isDestReconciled
                ? ctx.accountReconciliationIdMap.get(destAccEntId) ?? null
                : null;
              childDestRecDate = destRecEntityId
                ? ctx.reconciliationDateMap.get(destRecEntityId) ?? destPartner.reconciledAt ?? ctx.accountReconciliationDateMap.get(destAccEntId) ?? t.date ?? null
                : isDestReconciled
                ? ctx.accountReconciliationDateMap.get(destAccEntId) ?? t.date ?? null
                : null;
              effectiveChildDestStatus = isDestReconciled
                ? "r"
                : destPartner.cleared === "Uncleared" ? "u" : "c";
            } else {
              effectiveChildDestStatus = effectiveChildStatus;
              childDestRecId = effectiveChildStatus === "r" ? childRecId : null;
              childDestRecDate = effectiveChildStatus === "r" ? childRecDate : null;
            }
          }

          if (effectiveChildStatus !== "r") {
            allChildrenReconciled = false;
          }

          const childLineage = extractYnab4TxLineage(st);
          // Dest-leg lineage lives on the paired counterpart row; when
          // it exists its memo + OFX fields persist verbatim for the
          // exporter's fabricated dest leg (null otherwise, which reads
          // as "no independent dest value" and falls back to the source).
          const childDestLineage = childDestPartner ? extractYnab4TxLineage(childDestPartner) : null;
          await db.insert(transactions).values({
            entityId: st.entityId,
            transferEntityId: childDestTxEntityId,
            accountId: accId,
            categoryId: subCatId,
            date: t.date,
            payee: subPayee,
            payeeId: subPayeeId,
            memo: st.memo || "",
            amount: ctx.convertAmount(st.amount),
            status: effectiveChildStatus,
            transferStatus: effectiveChildDestStatus,
            flagColor: ynabFlagToColor(st.flag),
            checkNumber: childLineage.checkNumber,
            fitid: childLineage.fitid,
            ynabId: childLineage.ynabId,
            importedPayee: childLineage.importedPayee,
            source: childLineage.source,
            transferMemo: childDestPartner ? (childDestPartner.memo ?? "") : null,
            transferCheckNumber: childDestLineage?.checkNumber ?? null,
            transferFitid: childDestLineage?.fitid ?? null,
            transferYnabId: childDestLineage?.ynabId ?? null,
            transferImportedPayee: childDestLineage?.importedPayee ?? null,
            transferSource: childDestLineage?.source ?? null,
            transferAccountId: subTransferAccountId,
            parentId: insertedT.id,
            isIncome: isChildIncome,
            incomeMonth: childIncomeMonth,
            incomeCategoryRaw: childIncomeRaw,
            reconciledAt: effectiveChildStatus === "r" ? childRecDate : null,
            reconciliationId: effectiveChildStatus === "r" ? childRecId : null,
            transferReconciledAt: effectiveChildDestStatus === "r" ? childDestRecDate : null,
            transferReconciliationId: effectiveChildDestStatus === "r" ? childDestRecId : null,
          });
          ctx.totalImportedTxCount++;
        }

        // G-split: append the repair filler leg (if any) YNAB4-style. It
        // is synthetic, so it never claims reconciled precision — even
        // under a reconciled parent it imports as merely cleared — and
        // it opts out of the all-children-reconciled parent upgrade.
        if (splitRepair.kind === "filler-added") {
          const filler = splitRepair.children[splitRepair.children.length - 1]!;
          const fillerOnBudget = ctx.accOnBudgetMap.get(t.accountId) ?? true;
          const fillerAccKind = ctx.accKindMap.get(t.accountId) ?? "liquid";
          await db.insert(transactions).values({
            accountId: accId,
            categoryId: null,
            date: t.date,
            payee,
            payeeId: parentPayeeId,
            memo: typeof filler.memo === "string" ? filler.memo : "",
            amount: filler.amount,
            status: effectiveParentStatus === "r" ? "c" : effectiveParentStatus,
            transferStatus: null,
            flagColor: null,
            transferAccountId: null,
            parentId: insertedT.id,
            isIncome: fillerOnBudget && fillerAccKind !== "credit" && filler.amount > 0,
            incomeMonth: null,
            reconciledAt: null,
            reconciliationId: null,
            transferReconciledAt: null,
            transferReconciliationId: null,
          });
          ctx.totalImportedTxCount++;
          allChildrenReconciled = false;
        }

        // If all children are reconciled and parent is not yet 'r', reconcile parent
        if (allChildrenReconciled && effectiveParentStatus !== "r" && parentRecId != null) {
          await db
            .update(transactions)
            .set({
              status: "r",
              reconciledAt: parentRecDate,
              reconciliationId: parentRecId,
            })
            .where(eq(transactions.id, insertedT.id));
        }
      }
    } else {
      // Non-split transaction
      // Check if this is the standalone side of a split transfer in YNAB4
      const linkedSub = t.transferTransactionId ? subTxById.get(t.transferTransactionId) : null;
      if (linkedSub && ctx.accountIdMap.has(linkedSub.parent.accountId)) {
        // This was the duplicate counterpart of a split subtransaction in YNAB4.
        // Since the subtransaction on the parent split now carries transferAccountId,
        // the transfer is already fully accounted for without needing this duplicate row.
        ctx.skippedDuplicates.push({
          accountName: ctx.accNameMap.get(accId) || "",
          date: t.date,
          payee: ctx.payeeMap.get(t.payeeId) || "",
          memo: t.memo || "",
          amount: ctx.convertAmount(t.amount),
          reason: "Duplicate counterpart of a split transfer",
        });
        continue;
      } else if (t.transferTransactionId) {
        // Top-level regular transfer pair
        if (processedTransferIds.has(t.entityId)) {
          // Already imported from counterpart
          ctx.skippedDuplicates.push({
            accountName: ctx.accNameMap.get(accId) || "",
            date: t.date,
            payee: ctx.payeeMap.get(t.payeeId) || "",
            memo: t.memo || "",
            amount: ctx.convertAmount(t.amount),
            reason: "Duplicate transfer counterpart",
          });
          continue;
        }

        const partner = txById.get(t.transferTransactionId);
        const partnerAccId = partner ? ctx.accountIdMap.get(partner.accountId) : undefined;
        processedTransferIds.add(t.entityId);
        if (partner) processedTransferIds.add(partner.entityId);

        if (partner && partnerAccId) {
          // Both sides of transfer pair have valid accounts in DB: import as single linked transfer
          let sourceAccEntityId = t.accountId;
          let destAccEntityId = partner.accountId;
          let rawAmount = t.amount || 0;
          let memo = t.memo || "";
          let catEntityId = t.categoryId;

          // Normalize transfer orientation:
          // - Cross-budget-boundary (one on-budget, one off-budget):
          //   always use the on-budget account as the source so the amount sign
          //   is meaningful relative to the budget (negative = spending,
          //   positive = inflow to budget).
          // - Same-budget (both on or both off):
          //   use the negative-amount (outflow) side as the source.
          const tOnBudget = ctx.accOnBudgetMap.get(t.accountId);
          const pOnBudget = ctx.accOnBudgetMap.get(partner.accountId);
          const isCrossBoundary =
            tOnBudget !== undefined && pOnBudget !== undefined && tOnBudget !== pOnBudget;

          if (isCrossBoundary) {
            if (!tOnBudget && pOnBudget) {
              // Source is off-budget, partner is on-budget (liquidation/sale).
              // Flip to use the on-budget side as source with its sign.
              sourceAccEntityId = partner.accountId;
              destAccEntityId = t.accountId;
              rawAmount = partner.amount || 0;
              if (!memo && partner.memo) memo = partner.memo;
              catEntityId = partner.categoryId || t.categoryId;
            }
            // If source is already on-budget, no flip needed.
          } else {
            // Same budget: normalize to negative-amount (outflow) side as source.
            if (rawAmount > 0 && (partner.amount || 0) < 0) {
              sourceAccEntityId = partner.accountId;
              destAccEntityId = t.accountId;
              rawAmount = partner.amount || 0;
              if (!memo && partner.memo) memo = partner.memo;
              catEntityId = partner.categoryId || t.categoryId;
            }
          }

          // Pull category from partner if current side has none.
          if (partner.categoryId && !catEntityId) {
            catEntityId = partner.categoryId;
          }

          const sourceAccId = ctx.accountIdMap.get(sourceAccEntityId)!;
          const destAccId = ctx.accountIdMap.get(destAccEntityId)!;
          const payee = "Transfer : " + (ctx.accNameMap.get(destAccId) || "Unknown");

          const sourceIsOnBudget = ctx.accOnBudgetMap.get(sourceAccEntityId) ?? true;
          const destIsOnBudget = ctx.accOnBudgetMap.get(destAccEntityId) ?? true;
          const isCrossBoundaryTransfer = sourceIsOnBudget !== destIsOnBudget;
          const rawCents = ctx.convertAmount(rawAmount);
          if (rawCents === 0) {
            ctx.skippedDuplicates.push({
              accountName: ctx.accNameMap.get(sourceAccId) || "",
              date: t.date,
              payee,
              memo,
              amount: 0,
              reason: "Zero-amount transfer transaction",
            });
            continue;
          }
          const netOnBudget = (sourceIsOnBudget ? rawCents : 0) + (destIsOnBudget ? -rawCents : 0);
          const catId = (catEntityId && ctx.categoryIdMap.get(catEntityId)) || null;
          const transferSentinelOffset = incomeSentinelOffset(catEntityId);
          noteIncomeSentinel(catEntityId, ctx);
          const isSpecialIncomeCat = transferSentinelOffset !== null;
          let effectiveCatId = isSpecialIncomeCat ? null : catId;
          if (isCrossBoundaryTransfer && netOnBudget < 0 && effectiveCatId === null) {
            effectiveCatId = await getOrCreateFallbackTransferCategory(db, ctx);
          }
          const classification = classifyBoundaryTransfer({
            srcOnBudget: sourceIsOnBudget,
            destOnBudget: destIsOnBudget,
            amount: rawCents,
            categoryId: effectiveCatId,
          });
          const finalTransferCatId = classification.categoryId;
          const isTransferIncome = classification.isIncome;

          const sourceYTx = sourceAccEntityId === t.accountId ? t : partner;
          const destYTx = destAccEntityId === t.accountId ? t : partner;

          const isSrcReconciled = sourceYTx?.cleared === "Reconciled" || Boolean(sourceYTx?.reconciliationId);
          const srcRecEntityId = sourceYTx?.reconciliationId;
          const srcRecId = srcRecEntityId
            ? ctx.reconciliationIdMap.get(srcRecEntityId) ?? ctx.accountReconciliationIdMap.get(sourceAccEntityId) ?? null
            : isSrcReconciled
            ? ctx.accountReconciliationIdMap.get(sourceAccEntityId) ?? null
            : null;
          const srcRecDate = srcRecEntityId
            ? ctx.reconciliationDateMap.get(srcRecEntityId) ?? sourceYTx?.reconciledAt ?? ctx.accountReconciliationDateMap.get(sourceAccEntityId) ?? t.date ?? null
            : isSrcReconciled
            ? ctx.accountReconciliationDateMap.get(sourceAccEntityId) ?? t.date ?? null
            : null;
          const effectiveSrcStatus = isSrcReconciled
            ? "r"
            : (sourceYTx?.cleared === "Uncleared" ? "u" : "c");

          const isDestReconciled = destYTx?.cleared === "Reconciled" || Boolean(destYTx?.reconciliationId);
          const destRecEntityId = destYTx?.reconciliationId;
          const destRecId = destRecEntityId
            ? ctx.reconciliationIdMap.get(destRecEntityId) ?? ctx.accountReconciliationIdMap.get(destAccEntityId) ?? null
            : isDestReconciled
            ? ctx.accountReconciliationIdMap.get(destAccEntityId) ?? null
            : null;
          const destRecDate = destRecEntityId
            ? ctx.reconciliationDateMap.get(destRecEntityId) ?? destYTx?.reconciledAt ?? ctx.accountReconciliationDateMap.get(destAccEntityId) ?? t.date ?? null
            : isDestReconciled
            ? ctx.accountReconciliationDateMap.get(destAccEntityId) ?? t.date ?? null
            : null;
          const effectiveDestStatus = isDestReconciled
            ? "r"
            : (destYTx?.cleared === "Uncleared" ? "u" : "c");

          const sourceLineage = extractYnab4TxLineage(sourceYTx);
          // The dest leg's own memo + OFX lineage persist verbatim for
          // the exporter's fabricated dest leg (never the source's).
          const destLineage = extractYnab4TxLineage(destYTx);
          await db.insert(transactions).values({
            entityId: sourceYTx?.entityId ?? t.entityId,
            transferEntityId: destYTx?.entityId ?? (partner?.entityId || t.transferTransactionId || null),
            accountId: sourceAccId,
            categoryId: finalTransferCatId,
            date: t.date,
            payee,
            payeeId: null,
            memo,
            amount: rawCents,
            status: effectiveSrcStatus,
            transferStatus: effectiveDestStatus,
            flagColor: ynabFlagToColor(t.flag),
            checkNumber: sourceLineage.checkNumber,
            fitid: sourceLineage.fitid,
            ynabId: sourceLineage.ynabId,
            importedPayee: sourceLineage.importedPayee,
            source: sourceLineage.source,
            transferMemo: destYTx?.memo ?? "",
            transferCheckNumber: destLineage.checkNumber,
            transferFitid: destLineage.fitid,
            transferYnabId: destLineage.ynabId,
            transferImportedPayee: destLineage.importedPayee,
            transferSource: destLineage.source,
            transferAccountId: destAccId,
            parentId: null,
            isIncome: isTransferIncome,
            incomeCategoryRaw:
              isTransferIncome && typeof catEntityId === "string" && transferSentinelOffset !== null
                ? catEntityId
                : null,
            reconciledAt: effectiveSrcStatus === "r" ? srcRecDate : null,
            reconciliationId: effectiveSrcStatus === "r" ? srcRecId : null,
            transferReconciledAt: effectiveDestStatus === "r" ? destRecDate : null,
            transferReconciliationId: effectiveDestStatus === "r" ? destRecId : null,
          });
          ctx.totalImportedTxCount++;
        } else {
          // Partner is missing or its account is not in accountIdMap (e.g. deleted/tombstoned account).
          // Fall back to importing the resolvable side as a regular transaction on accId.
          const fallbackAmt = ctx.convertAmount(t.amount);
          const memo = t.memo || (partner?.memo || "");
          const cleared = t.cleared;
          const catEntityId = t.categoryId || (partner?.categoryId || null);
          const payee = (t.payeeId ? ctx.payeeMap.get(t.payeeId) : "") || (partner?.payeeId ? ctx.payeeMap.get(partner.payeeId) || "" : "") || "";

          if (fallbackAmt === 0) {
            ctx.skippedDuplicates.push({
              accountName: ctx.accNameMap.get(accId) || "",
              date: t.date,
              payee,
              memo,
              amount: 0,
              reason: "Zero-amount fallback transfer transaction",
            });
            continue;
          }

          const fallbackPayeeId =
            (t.payeeId ? ctx.payeeDbIdMap.get(t.payeeId) : undefined) ??
            (partner?.payeeId ? ctx.payeeDbIdMap.get(partner.payeeId) : undefined) ??
            null;

          const accIsOnBudget = ctx.accOnBudgetMap.get(t.accountId) ?? true;
          let catId = (accIsOnBudget && catEntityId && ctx.categoryIdMap.get(catEntityId)) || null;
          const fallbackSentinelOffset = incomeSentinelOffset(catEntityId);
          noteIncomeSentinel(catEntityId, ctx);
          const isTxDeferred = fallbackSentinelOffset === "deferred";
          const isSpecialIncomeCat = fallbackSentinelOffset !== null;
          if (
            isSpecialIncomeCat ||
            catEntityId === "Category/__Split__"
          ) {
            catId = null;
          }

          const accKind = ctx.accKindMap.get(t.accountId) ?? "liquid";
          const isTxIncome =
            accIsOnBudget &&
            accKind !== "credit" &&
            (isSpecialIncomeCat || catId === null) &&
            (t.amount || 0) > 0;
          const txIncomeMonth = isTxIncome
            ? (t.incomeMonth || (isTxDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
            : null;

          const isTxReconciled = cleared === "Reconciled" || Boolean(t.reconciliationId);
          const txRecId = t.reconciliationId
            ? ctx.reconciliationIdMap.get(t.reconciliationId) ?? ctx.accountReconciliationIdMap.get(t.accountId) ?? null
            : isTxReconciled
            ? ctx.accountReconciliationIdMap.get(t.accountId) ?? null
            : null;
          const txRecDate = t.reconciliationId
            ? ctx.reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? ctx.accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
            : isTxReconciled
            ? ctx.accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
            : null;

          const fallbackLineage = extractYnab4TxLineage(t);
          await db.insert(transactions).values({
            entityId: t.entityId,
            accountId: accId,
            categoryId: catId,
            date: t.date,
            payee,
            payeeId: fallbackPayeeId,
            memo,
            amount: fallbackAmt,
            status:
              isTxReconciled
                ? "r"
                : cleared === "Uncleared"
                  ? "u"
                  : "c",
            flagColor: ynabFlagToColor(t.flag),
            checkNumber: fallbackLineage.checkNumber,
            fitid: fallbackLineage.fitid,
            ynabId: fallbackLineage.ynabId,
            importedPayee: fallbackLineage.importedPayee,
            source: fallbackLineage.source,
            transferAccountId: null,
            parentId: null,
            isIncome: isTxIncome,
            incomeMonth: txIncomeMonth,
            incomeCategoryRaw:
              isTxIncome && typeof catEntityId === "string" && fallbackSentinelOffset !== null
                ? catEntityId
                : null,
            reconciledAt: isTxReconciled ? txRecDate : null,
            reconciliationId: isTxReconciled ? txRecId : null,
          });
          ctx.totalImportedTxCount++;
        }
      } else {
        // Plain transaction (or standalone transfer without transferTransactionId)
        const regularAmt = ctx.convertAmount(t.amount);
        const targetAccEntityId = t.targetAccountId || (t.payeeId && t.payeeId.startsWith("Payee/Transfer:") ? t.payeeId.split(":")[1] : null);
        const destAccId = targetAccEntityId ? ctx.accountIdMap.get(targetAccEntityId) || null : null;
        let payee = "";
        if (destAccId) {
          payee = "Transfer : " + (ctx.accNameMap.get(destAccId) || "Unknown");
        } else {
          payee = ctx.payeeMap.get(t.payeeId) || "";
        }

        if (regularAmt === 0) {
          ctx.skippedDuplicates.push({
            accountName: ctx.accNameMap.get(accId) || "",
            date: t.date,
            payee,
            memo: t.memo || "",
            amount: 0,
            reason: "Zero-amount transaction",
          });
          continue;
        }

        const plainPayeeId = destAccId ? null : (t.payeeId ? ctx.payeeDbIdMap.get(t.payeeId) ?? null : null);

        const accIsOnBudget = ctx.accOnBudgetMap.get(t.accountId) ?? true;
        let catId = (accIsOnBudget && ctx.categoryIdMap.get(t.categoryId)) || null;
        const plainSentinelOffset = incomeSentinelOffset(t.categoryId);
        noteIncomeSentinel(t.categoryId, ctx);
        const isTxDeferred = plainSentinelOffset === "deferred";
        const isSpecialIncomeCat = plainSentinelOffset !== null;
        if (
          isSpecialIncomeCat ||
          t.categoryId === "Category/__Split__"
        ) {
          catId = null;
        }

        const srcOnBudget = ctx.accOnBudgetMap.get(t.accountId) ?? true;
        const destOnBudget = destAccId ? (ctx.accOnBudgetMap.get(targetAccEntityId!) ?? false) : false;
        const isCrossBoundaryTx = destAccId !== null && srcOnBudget !== destOnBudget;
        if (destAccId !== null && !isCrossBoundaryTx) {
          catId = null;
        }
        const netOnBudgetTx = (srcOnBudget ? (t.amount || 0) : 0) + (destOnBudget ? -(t.amount || 0) : 0);
        if (isCrossBoundaryTx && netOnBudgetTx < 0 && catId === null) {
          catId = await getOrCreateFallbackTransferCategory(db, ctx);
        }
        const srcKind = ctx.accKindMap.get(t.accountId) ?? "liquid";
        const isTxIncome =
          (srcOnBudget && srcKind !== "credit" && (isSpecialIncomeCat || (catId === null && destAccId === null)) && (t.amount || 0) > 0) ||
          (isCrossBoundaryTx && (catId === null || isSpecialIncomeCat) && netOnBudgetTx > 0);
        const txIncomeMonth = isTxIncome
          ? (t.incomeMonth || (isTxDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
          : null;

        let flagColor: string | null = ynabFlagToColor(t.flag);

        // Track plain regular rows to detect duplicate entries within the backup.
        // All non-tombstone rows are imported (two identical transactions on the same
        // day are legitimate). Suspected unflagged, unreconciled duplicates are
        // flagged with TRANSACTION_DUPLICATE_FLAG for user review.
        if (destAccId === null) {
          const fp = duplicateFingerprint({
            accountId: accId,
            date: t.date,
            payee,
            memo: t.memo || "",
            amount: regularAmt,
          });
          if (plainFingerprints.has(fp)) {
            if (t.cleared !== "Reconciled" && flagColor === null) {
              flagColor = TRANSACTION_DUPLICATE_FLAG;
            }
          } else {
            plainFingerprints.add(fp);
          }
        }

        const isTxReconciled = t.cleared === "Reconciled" || Boolean(t.reconciliationId);
        const txRecId = t.reconciliationId
          ? ctx.reconciliationIdMap.get(t.reconciliationId) ?? ctx.accountReconciliationIdMap.get(t.accountId) ?? null
          : isTxReconciled
          ? ctx.accountReconciliationIdMap.get(t.accountId) ?? null
          : null;
        const txRecDate = t.reconciliationId
          ? ctx.reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? ctx.accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
          : isTxReconciled
          ? ctx.accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
          : null;

        const plainLineage = extractYnab4TxLineage(t);
        await db.insert(transactions).values({
          entityId: t.entityId,
          accountId: accId,
          categoryId: catId,
          date: t.date,
          payee,
          payeeId: plainPayeeId,
          memo: t.memo || "",
          amount: regularAmt,
          status:
            isTxReconciled
              ? "r"
              : t.cleared === "Uncleared"
                ? "u"
                : "c",
          flagColor,
          checkNumber: plainLineage.checkNumber,
          fitid: plainLineage.fitid,
          ynabId: plainLineage.ynabId,
          importedPayee: plainLineage.importedPayee,
          source: plainLineage.source,
          transferAccountId: destAccId,
          parentId: null,
          isIncome: isTxIncome,
          incomeMonth: txIncomeMonth,
          incomeCategoryRaw:
            isTxIncome && typeof t.categoryId === "string" && plainSentinelOffset !== null
              ? t.categoryId
              : null,
          reconciledAt: isTxReconciled ? txRecDate : null,
          reconciliationId: isTxReconciled ? txRecId : null,
        });
        ctx.totalImportedTxCount++;
      }
    }
  }
}
