import { and, eq, isNotNull, sql } from "drizzle-orm";
import AdmZip from "adm-zip";
import { dollarsToCents, nextMonthKey, TRANSACTION_DUPLICATE_FLAG, type ImportSkippedEntry, type ImportSummary, type TransactionFlagColor } from "@ynab/logic";
import { duplicateFingerprint } from "@ynab/logic";
import type { Db } from "./client.js";
import { withTransaction } from "./transaction.js";
import { accounts, assignments, categoryGroups, categories, recurring, recurringSubTransactions, transactions } from "./schema.js";
import { resetDatabase } from "./seed.js";

export interface Ynab4Settings {
  currencySymbol?: string;
  currencyISOSymbol?: string;
  decimalSeparator?: string;
  groupSeparator?: string;
  dateFormat?: string;
  budgetName?: string;
}

export interface ExtractedYnab4Data {
  ynabData: any;
  settingsXml?: string;
  settings?: Ynab4Settings;
}

export function parseYnab4SettingsXml(xmlStr?: string): Ynab4Settings {
  const settings: Ynab4Settings = {};
  if (!xmlStr) return settings;

  const matchTag = (tag: string) => {
    const match = xmlStr.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
    return match ? match[1]?.trim() : undefined;
  };

  settings.currencySymbol = matchTag("currencySymbol");
  settings.currencyISOSymbol = matchTag("currencyISOSymbol") || matchTag("currencyISO");
  settings.decimalSeparator = matchTag("decimalSeparator") || matchTag("currencyDecimalSeparator");
  settings.groupSeparator = matchTag("groupSeparator") || matchTag("currencyGroupSeparator");
  settings.dateFormat = matchTag("dateFormat") || matchTag("shortDateFormat");
  settings.budgetName = matchTag("budgetName") || matchTag("budgetTitle");

  return settings;
}

/** YNAB4 flag color name → our enum. Unknown/missing values map to null. */
export function ynabFlagToColor(flag: unknown): TransactionFlagColor | null {
  if (typeof flag !== "string") return null;
  const normalized = flag.trim().toLowerCase();
  switch (normalized) {
    case "red":
      return "red";
    case "orange":
      return "orange";
    case "yellow":
      return "yellow";
    case "green":
      return "green";
    case "blue":
      return "blue";
    case "purple":
      return "purple";
    default:
      return null;
  }
}

/**
 * Stage 1: Extract and parse YNAB4 data from a .y4backup or .zip archive buffer.
 */
export function extractYnab4DataFromZip(buffer: Buffer | ArrayBuffer): ExtractedYnab4Data {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const zip = new AdmZip(buf);
  const zipEntries = zip.getEntries();

  let ynab4JsonStr = "";
  let settingsXml: string | undefined = undefined;

  for (const entry of zipEntries) {
    if (entry.entryName.endsWith(".ynab4")) {
      ynab4JsonStr = zip.readAsText(entry);
    } else if (entry.entryName.endsWith(".ybsettings")) {
      settingsXml = zip.readAsText(entry);
    }
  }

  if (!ynab4JsonStr) {
    throw new Error("Could not find .ynab4 data file inside the zip archive");
  }

  const ynabData = JSON.parse(ynab4JsonStr);
  const settings = settingsXml ? parseYnab4SettingsXml(settingsXml) : undefined;
  return { ynabData, settingsXml, settings };
}

export async function importYnab4(db: Db, ynabData: any, settingsXmlOrObj?: string | Ynab4Settings) {
  return withTransaction(db, async () => {
    // 1. Wipe current data
    await resetDatabase(db, true);

    const yAccounts = ynabData.accounts || [];
    const yPayees = ynabData.payees || [];
    const yMasterCategories = ynabData.masterCategories || [];
    const yTransactions = ynabData.transactions || [];
    const yScheduled = ynabData.scheduledTransactions || [];
    const yBudgets = ynabData.monthlyBudgets || [];

    // Payees mapping (payeeId -> name)
    const payeeMap = new Map<string, string>();
    for (const p of yPayees) {
      if (!p.isTombstone) {
        payeeMap.set(p.entityId, p.name);
      }
    }

    // 2. Insert Accounts
    const accountIdMap = new Map<string, number>();
    const accOnBudgetMap = new Map<string, boolean>();
    let accountSort = 0;
    const nonTombstoneAccounts = yAccounts
      .filter((a: any) => !a.isTombstone)
      .sort((a: any, b: any) => (a.sortableIndex ?? 0) - (b.sortableIndex ?? 0));

    for (const acc of nonTombstoneAccounts) {
      accOnBudgetMap.set(acc.entityId, !!acc.onBudget);
      const kind =
        acc.accountType === "CreditCard" || acc.accountType === "LineofCredit"
          ? "credit"
          : acc.onBudget
          ? "liquid"
          : "offbudget";

      const groupLabel = acc.onBudget
        ? kind === "credit"
          ? "Credit Cards"
          : "Budget Accounts"
        : "Off Budget";

      const isArchived = Boolean(acc.hidden || acc.closed || acc.isClosed);

      const [row] = await db
        .insert(accounts)
        .values({
          name: acc.accountName,
          kind,
          groupLabel,
          balance: 0, // To be computed from transactions
          onBudget: !!acc.onBudget,
          sort: accountSort++,
          lastReconciledAt: acc.lastReconciledDate || null,
          lastReconciledBalance:
            acc.lastReconciledBalance != null
              ? dollarsToCents(Number(acc.lastReconciledBalance))
              : null,
          archived: isArchived,
        })
        .returning();

      accountIdMap.set(acc.entityId, row!.id);
    }

    // 3. Insert Category Groups and Categories
    const categoryIdMap = new Map<string, number>();
    let groupSort = 0;

    const nonTombstoneMC = yMasterCategories
      .filter((mc: any) => !mc.isTombstone && mc.type === "OUTFLOW" && mc.name !== "__Internal__")
      .sort((a: any, b: any) => {
        const aHidden = a.name === "Hidden Categories" || a.name?.toLowerCase() === "hidden categories";
        const bHidden = b.name === "Hidden Categories" || b.name?.toLowerCase() === "hidden categories";
        if (aHidden !== bHidden) return aHidden ? 1 : -1;
        return (a.sortableIndex ?? 0) - (b.sortableIndex ?? 0);
      });

    for (const mc of nonTombstoneMC) {
      const [gRow] = await db
        .insert(categoryGroups)
        .values({
          name: mc.name,
          sort: groupSort++,
          isCreditCardPayments: false,
        })
        .returning();

      let catSort = 0;
      const nonTombstoneSC = (mc.subCategories || [])
        .filter((sc: any) => !sc.isTombstone)
        .sort((a: any, b: any) => (a.sortableIndex ?? 0) - (b.sortableIndex ?? 0));

      for (const sc of nonTombstoneSC) {
        const overspendCarriesOver =
          sc.overspendingHandling === "OverspendCarriedForward" ||
          sc.entityVersion?.overspendingHandling === "OverspendCarriedForward";
        const [cRow] = await db
          .insert(categories)
          .values({
            groupId: gRow!.id,
            name: sc.name,
            sort: catSort++,
            carryover: 0,
            goalTarget: null,
            overspendCarriesOver: overspendCarriesOver || false,
          })
          .returning();

        categoryIdMap.set(sc.entityId, cRow!.id);
      }
    }

    // Create special "Credit Card Payments" group
    const [ccGroup] = await db
      .insert(categoryGroups)
      .values({
        name: "Credit Card Payments",
        sort: groupSort++,
        isCreditCardPayments: true,
      })
      .returning();

    const creditAccounts = await db.select().from(accounts).where(eq(accounts.kind, "credit"));
    let ccCatSort = 0;
    for (const acc of creditAccounts) {
      await db.insert(categories).values({
        groupId: ccGroup!.id,
        name: acc.name,
        sort: ccCatSort++,
        carryover: 0,
        goalTarget: null,
        linkedAccountId: acc.id,
      });
    }

    // 4. Insert Assignments (Monthly Budgets)
    for (const mb of yBudgets) {
      if (mb.isTombstone) continue;
      if (!mb.monthlySubCategoryBudgets) continue;
      const month = mb.month.substring(0, 7); // Convert "2014-08-01" -> "2014-08"

      for (const msb of mb.monthlySubCategoryBudgets) {
        if (msb.isTombstone) continue;
        if (msb.budgeted !== 0 && msb.budgeted != null) {
          const catId = categoryIdMap.get(msb.categoryId);
          if (catId) {
            const amt = dollarsToCents(msb.budgeted);
            await db
              .insert(assignments)
              .values({
                categoryId: catId,
                month,
                amount: amt,
              })
              .onConflictDoUpdate({
                target: [assignments.categoryId, assignments.month],
                set: { amount: amt },
              });
          }
        }
      }
    }

    // 5. Insert Transactions
    const accNameMap = new Map<number, string>();
    const allAccountsForMap = await db.select().from(accounts);
    for (const a of allAccountsForMap) accNameMap.set(a.id, a.name);

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
    let totalImportedTxCount = 0;
    // Fingerprints of already-encountered plain regular rows (used to flag
    // suspected duplicate entries within the backup). Split rows and
    // transfers are intentionally excluded.
    const plainFingerprints = new Set<string>();
    const skippedDuplicates: ImportSkippedEntry[] = [];

    for (const t of yTransactions) {
      if (t.isTombstone) continue;

      const accId = accountIdMap.get(t.accountId);
      if (!accId) continue;

      const hasSubs = Array.isArray(t.subTransactions) && t.subTransactions.length > 0;

      if (hasSubs) {
        // Split transaction parent
        let payee = payeeMap.get(t.payeeId) || "";
        const isParentDeferred = t.categoryId === "Category/__DeferredIncome__";
        const isParentIncome = (t.categoryId === "Category/__ImmediateIncome__" || isParentDeferred) && (t.amount || 0) > 0;
        const parentIncomeMonth = isParentDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null;
        const [insertedT] = await db
          .insert(transactions)
          .values({
            accountId: accId,
            categoryId: null,
            date: t.date,
            payee,
            memo: t.memo || "",
            amount: dollarsToCents(t.amount),
            status:
              t.cleared === "Reconciled"
                ? "r"
                : t.cleared === "Uncleared"
                  ? "u"
                  : "c",
            flagColor: ynabFlagToColor(t.flag),
            transferAccountId: null,
            parentId: null,
            isIncome: isParentIncome,
            incomeMonth: parentIncomeMonth,
            reconciledAt: t.cleared === "Reconciled" ? (t.date || null) : null,
          })
          .returning();

        totalImportedTxCount++;

        if (insertedT) {
          for (const st of t.subTransactions) {
            if (st.isTombstone) continue;
            const accIsOnBudget = accOnBudgetMap.get(t.accountId) ?? true;
            let subCatId = (accIsOnBudget && categoryIdMap.get(st.categoryId)) || null;
            let subPayee = "";
            let subTransferAccountId: number | null = null;

            if (st.payeeId && st.payeeId.startsWith("Payee/Transfer:")) {
              const targetId = st.payeeId.split(":")[1];
              const foundTarget = targetId ? accountIdMap.get(targetId) : null;
              if (foundTarget) {
                subTransferAccountId = foundTarget;
                subPayee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
              }
            } else if (st.targetAccountId) {
              const foundTarget = accountIdMap.get(st.targetAccountId);
              if (foundTarget) {
                subTransferAccountId = foundTarget;
                subPayee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
              }
            } else if (st.payeeId) {
              subPayee = payeeMap.get(st.payeeId) || "";
            }

            const isChildDeferred = st.categoryId === "Category/__DeferredIncome__";
            const isChildIncome =
              accIsOnBudget &&
              (st.categoryId === "Category/__ImmediateIncome__" ||
                isChildDeferred ||
                (subCatId === null && subTransferAccountId === null)) &&
              (st.amount || 0) > 0;
            const childIncomeMonth = isChildDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null;

            await db.insert(transactions).values({
              accountId: accId,
              categoryId: subCatId,
              date: t.date,
              payee: subPayee,
              memo: st.memo || "",
              amount: dollarsToCents(st.amount),
              status:
                t.cleared === "Reconciled"
                  ? "r"
                  : t.cleared === "Uncleared"
                    ? "u"
                    : "c",
              transferAccountId: subTransferAccountId,
              parentId: insertedT.id,
              isIncome: isChildIncome,
              incomeMonth: childIncomeMonth,
              reconciledAt: t.cleared === "Reconciled" ? (t.date || null) : null,
            });
            totalImportedTxCount++;
          }
        }
      } else {
        // Non-split transaction
        // Check if this is the standalone side of a split transfer in YNAB4
        const linkedSub = t.transferTransactionId ? subTxById.get(t.transferTransactionId) : null;
        if (linkedSub && accountIdMap.has(linkedSub.parent.accountId)) {
          // This was the duplicate counterpart of a split subtransaction in YNAB4.
          // Since the subtransaction on the parent split now carries transferAccountId,
          // the transfer is already fully accounted for without needing this duplicate row.
          skippedDuplicates.push({
            accountName: accNameMap.get(accId) || "",
            date: t.date,
            payee: payeeMap.get(t.payeeId) || "",
            memo: t.memo || "",
            amount: dollarsToCents(t.amount),
            reason: "Duplicate counterpart of a split transfer",
          });
          continue;
        } else if (t.transferTransactionId) {
          // Top-level regular transfer pair
          if (processedTransferIds.has(t.entityId)) {
            // Already imported from counterpart
            skippedDuplicates.push({
              accountName: accNameMap.get(accId) || "",
              date: t.date,
              payee: payeeMap.get(t.payeeId) || "",
              memo: t.memo || "",
              amount: dollarsToCents(t.amount),
              reason: "Duplicate transfer counterpart",
            });
            continue;
          }

          const partner = txById.get(t.transferTransactionId);
          const partnerAccId = partner ? accountIdMap.get(partner.accountId) : undefined;
          processedTransferIds.add(t.entityId);
          if (partner) processedTransferIds.add(partner.entityId);

          if (partner && partnerAccId) {
            // Both sides of transfer pair have valid accounts in DB: import as single linked transfer
            let sourceAccEntityId = t.accountId;
            let destAccEntityId = partner.accountId;
            let rawAmount = t.amount || 0;
            let memo = t.memo || "";
            let cleared = t.cleared;
            let catEntityId = t.categoryId;

            // Normalize transfer orientation:
            // - Cross-budget-boundary (one on-budget, one off-budget):
            //   always use the on-budget account as the source so the amount sign
            //   is meaningful relative to the budget (negative = spending,
            //   positive = inflow to budget).
            // - Same-budget (both on or both off):
            //   use the negative-amount (outflow) side as the source.
            const tOnBudget = accOnBudgetMap.get(t.accountId);
            const pOnBudget = accOnBudgetMap.get(partner.accountId);
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
                cleared = partner.cleared;
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
                cleared = partner.cleared;
                catEntityId = partner.categoryId || t.categoryId;
              }
            }

            // Pull category from partner if current side has none.
            if (partner.categoryId && !catEntityId) {
              catEntityId = partner.categoryId;
            }

            const sourceAccId = accountIdMap.get(sourceAccEntityId)!;
            const destAccId = accountIdMap.get(destAccEntityId)!;
            const payee = "Transfer : " + (accNameMap.get(destAccId) || "Unknown");

            const sourceIsOnBudget = accOnBudgetMap.get(sourceAccEntityId) ?? true;
            const destIsOnBudget = accOnBudgetMap.get(destAccEntityId) ?? true;
            const isCrossBoundaryTransfer = sourceIsOnBudget !== destIsOnBudget;
            const netOnBudget = (sourceIsOnBudget ? rawAmount : 0) + (destIsOnBudget ? -rawAmount : 0);
            const catId = (catEntityId && categoryIdMap.get(catEntityId)) || null;
            const isSpecialIncomeCat =
              catEntityId === "Category/__ImmediateIncome__" ||
              catEntityId === "Category/__DeferredIncome__";
            const isTransferIncome = isCrossBoundaryTransfer && (catId === null || isSpecialIncomeCat) && netOnBudget > 0;
            const finalTransferCatId = !isCrossBoundaryTransfer ? null : isSpecialIncomeCat ? null : catId;

            await db.insert(transactions).values({
              accountId: sourceAccId,
              categoryId: finalTransferCatId,
              date: t.date,
              payee,
              memo,
              amount: dollarsToCents(rawAmount),
              status:
                cleared === "Reconciled"
                  ? "r"
                  : cleared === "Uncleared"
                    ? "u"
                    : "c",
              flagColor: ynabFlagToColor(t.flag),
              transferAccountId: destAccId,
              parentId: null,
              isIncome: isTransferIncome,
              reconciledAt: cleared === "Reconciled" ? (t.date || null) : null,
            });
            totalImportedTxCount++;
          } else {
            // Partner is missing or its account is not in accountIdMap (e.g. deleted/tombstoned account).
            // Fall back to importing the resolvable side as a regular transaction on accId.
            let memo = t.memo || (partner?.memo || "");
            let cleared = t.cleared;
            let catEntityId = t.categoryId || (partner?.categoryId || null);
            let payee = (t.payeeId ? payeeMap.get(t.payeeId) : "") || (partner?.payeeId ? payeeMap.get(partner.payeeId) || "" : "") || "";

            const accIsOnBudget = accOnBudgetMap.get(t.accountId) ?? true;
            let catId = (accIsOnBudget && catEntityId && categoryIdMap.get(catEntityId)) || null;
            const isTxDeferred = catEntityId === "Category/__DeferredIncome__";
            const isSpecialIncomeCat =
              catEntityId === "Category/__ImmediateIncome__" ||
              isTxDeferred;
            if (
              isSpecialIncomeCat ||
              catEntityId === "Category/__Split__"
            ) {
              catId = null;
            }

            const isTxIncome =
              accIsOnBudget &&
              (isSpecialIncomeCat || catId === null) &&
              (t.amount || 0) > 0;
            const txIncomeMonth = isTxDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null;

            await db.insert(transactions).values({
              accountId: accId,
              categoryId: catId,
              date: t.date,
              payee,
              memo,
              amount: dollarsToCents(t.amount),
              status:
                cleared === "Reconciled"
                  ? "r"
                  : cleared === "Uncleared"
                    ? "u"
                    : "c",
              flagColor: ynabFlagToColor(t.flag),
              transferAccountId: null,
              parentId: null,
              isIncome: isTxIncome,
              incomeMonth: txIncomeMonth,
              reconciledAt: cleared === "Reconciled" ? (t.date || null) : null,
            });
            totalImportedTxCount++;
          }
        } else {
          // Plain transaction (or standalone transfer without transferTransactionId)
          let targetAccEntityId = t.targetAccountId || (t.payeeId && t.payeeId.startsWith("Payee/Transfer:") ? t.payeeId.split(":")[1] : null);
          let destAccId = targetAccEntityId ? accountIdMap.get(targetAccEntityId) || null : null;
          let payee = "";
          if (destAccId) {
            payee = "Transfer : " + (accNameMap.get(destAccId) || "Unknown");
          } else {
            payee = payeeMap.get(t.payeeId) || "";
          }

          const accIsOnBudget = accOnBudgetMap.get(t.accountId) ?? true;
          let catId = (accIsOnBudget && categoryIdMap.get(t.categoryId)) || null;
          const isTxDeferred = t.categoryId === "Category/__DeferredIncome__";
          const isSpecialIncomeCat =
            t.categoryId === "Category/__ImmediateIncome__" ||
            isTxDeferred;
          if (
            isSpecialIncomeCat ||
            t.categoryId === "Category/__Split__"
          ) {
            catId = null;
          }

          const srcOnBudget = accOnBudgetMap.get(t.accountId) ?? true;
          const destOnBudget = destAccId ? (accOnBudgetMap.get(targetAccEntityId!) ?? false) : false;
          const isCrossBoundaryTx = destAccId !== null && srcOnBudget !== destOnBudget;
          if (destAccId !== null && !isCrossBoundaryTx) {
            catId = null;
          }
          const netOnBudgetTx = (srcOnBudget ? (t.amount || 0) : 0) + (destOnBudget ? -(t.amount || 0) : 0);
          const isTxIncome =
            (srcOnBudget && (isSpecialIncomeCat || (catId === null && destAccId === null)) && (t.amount || 0) > 0) ||
            (isCrossBoundaryTx && (catId === null || isSpecialIncomeCat) && netOnBudgetTx > 0);
          const txIncomeMonth = isTxDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null;

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
              amount: dollarsToCents(t.amount),
            });
            if (plainFingerprints.has(fp)) {
              if (t.cleared !== "Reconciled" && flagColor === null) {
                flagColor = TRANSACTION_DUPLICATE_FLAG;
              }
            } else {
              plainFingerprints.add(fp);
            }
          }

          await db.insert(transactions).values({
            accountId: accId,
            categoryId: catId,
            date: t.date,
            payee,
            memo: t.memo || "",
            amount: dollarsToCents(t.amount),
            status:
              t.cleared === "Reconciled"
                ? "r"
                : t.cleared === "Uncleared"
                  ? "u"
                  : "c",
            flagColor,
            transferAccountId: destAccId,
            parentId: null,
            isIncome: isTxIncome,
            incomeMonth: txIncomeMonth,
            reconciledAt: t.cleared === "Reconciled" ? (t.date || null) : null,
          });
          totalImportedTxCount++;
        }
      }
    }

    // 6. Compute real balances of accounts
    await recomputeAccountBalances(db);

    // 6b. Initialize Credit Card Payment category carryover from card starting balance if present
    for (const acc of creditAccounts) {
      const [startingTx] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, acc.id),
            sql`lower(${transactions.payee}) like '%starting balance%'`
          )
        )
        .limit(1);

      if (startingTx && Number(startingTx.amount) < 0) {
        await db
          .update(categories)
          .set({ carryover: Math.abs(Number(startingTx.amount)) })
          .where(
            and(
              eq(categories.groupId, ccGroup!.id),
              eq(categories.linkedAccountId, acc.id)
            )
          );
      }
    }

    // 7. Insert Scheduled (Recurring) Transactions
    for (const st of yScheduled) {
      if (st.isTombstone) continue;

      const accId = accountIdMap.get(st.accountId);
      if (!accId) continue;

      let payee = payeeMap.get(st.payeeId) || "";
      let transferAccountId = st.targetAccountId ? accountIdMap.get(st.targetAccountId) || null : null;

      if (st.payeeId && st.payeeId.startsWith("Payee/Transfer:")) {
        const targetId = st.payeeId.split(":")[1];
        const foundTarget = targetId ? accountIdMap.get(targetId) : null;
        if (foundTarget) {
          transferAccountId = foundTarget;
          payee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
        }
      }

      const accIsOnBudget = accOnBudgetMap.get(st.accountId) ?? true;
      let catId = (accIsOnBudget && categoryIdMap.get(st.categoryId)) || null;
      if (
        st.categoryId === "Category/__ImmediateIncome__" ||
        st.categoryId === "Category/__DeferredIncome__" ||
        st.categoryId === "Category/__Split__"
      ) {
        catId = null;
      }

      // Splits cannot have a top-level category.
      const hasSubs = Array.isArray(st.subTransactions) && st.subTransactions.length > 0;
      if (hasSubs) {
        catId = null;
      }

      let frequency = (st.frequency || "monthly").toLowerCase();
      if (frequency === "everyotherweek") frequency = "biweekly";
      if (frequency === "everyotheryear") frequency = "every2years";
      if (frequency === "never") frequency = "once";
      const validFrequencies = [
        "daily",
        "weekly",
        "biweekly",
        "everyotherweek",
        "twiceamonth",
        "every4weeks",
        "monthly",
        "everyothermonth",
        "every3months",
        "every4months",
        "twiceayear",
        "yearly",
        "every2years",
        "once",
        "never",
      ];
      if (!validFrequencies.includes(frequency)) {
        frequency = "monthly";
      }

      const [insertedR] = await db
        .insert(recurring)
        .values({
          accountId: accId,
          categoryId: catId,
          payee,
          amount: dollarsToCents(st.amount),
          frequency,
          nextDate: st.date,
          anchorDay: parseInt(st.date.slice(8, 10), 10),
          active: true,
          transferAccountId,
        })
        .returning();

      if (hasSubs && insertedR) {
        let sort = 0;
        for (const sub of st.subTransactions) {
          if (sub.isTombstone) continue;
          let subCatId = (accIsOnBudget && categoryIdMap.get(sub.categoryId)) || null;
          if (
            sub.categoryId === "Category/__ImmediateIncome__" ||
            sub.categoryId === "Category/__DeferredIncome__" ||
            sub.categoryId === "Category/__Split__"
          ) {
            subCatId = null;
          }

          let subTransferAccountId: number | null = sub.targetAccountId
            ? accountIdMap.get(sub.targetAccountId) || null
            : null;
          if (sub.payeeId && sub.payeeId.startsWith("Payee/Transfer:")) {
            const targetId = sub.payeeId.split(":")[1];
            const foundTarget = targetId ? accountIdMap.get(targetId) : null;
            if (foundTarget) {
              subTransferAccountId = foundTarget;
            }
          }

          await db.insert(recurringSubTransactions).values({
            recurringId: insertedR.id,
            categoryId: subCatId,
            amount: dollarsToCents(sub.amount),
            memo: sub.memo || "",
            sort: sort++,
            transferAccountId: subTransferAccountId,
          });
        }
      }
    }

    const settings =
      typeof settingsXmlOrObj === "string"
        ? parseYnab4SettingsXml(settingsXmlOrObj)
        : settingsXmlOrObj;

    const result: ImportSummary = {
      accounts: accountIdMap.size,
      categoryGroups: groupSort,
      categories: categoryIdMap.size,
      transactions: totalImportedTxCount,
      settings,
      duplicatesSkipped: skippedDuplicates,
    };
    return result;
  });
}

/**
 * Recompute every account's `balance` from the current set of
 * transactions. Exported for testability.
 *
 * Outflows: non-parent rows posted to this account as the source.
 * Inflows: non-parent rows where this account is the transfer destination
 *   (the source row is stored against the source's `accountId` with negative amount;
 *   the destination's balance is `-sourceAmount`).
 */
export async function recomputeAccountBalances(db: Db): Promise<void> {
  const allAccs = await db.select().from(accounts);
  for (const a of allAccs) {
    const outRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, a.id),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    const inRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.transferAccountId, a.id),
          isNotNull(transactions.transferAccountId),
          sql`${transactions.id} NOT IN (SELECT parent_id FROM transactions WHERE parent_id IS NOT NULL)`
        )
      );

    const outgoing = Number(outRes[0]?.sum || 0);
    const incomingFromTransfers = Number(inRes[0]?.sum || 0);
    const sum = outgoing - incomingFromTransfers;
    await db.update(accounts).set({ balance: sum }).where(eq(accounts.id, a.id));
  }
}
