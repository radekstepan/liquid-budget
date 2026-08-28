import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import AdmZip from "adm-zip";
import {
  classifyBoundaryTransfer,
  dollarsToCents,
  nextMonthKey,
  todayISO,
  TRANSACTION_DUPLICATE_FLAG,
  type ImportSkippedEntry,
  type ImportSummary,
  type TransactionFlagColor,
} from "@ynab/logic";
import { duplicateFingerprint } from "@ynab/logic";
import type { Db } from "./client.js";
import { withTransaction } from "./transaction.js";
import { accounts, assignments, categoryGroups, categories, reconciliations, recurring, recurringSubTransactions, transactions } from "./schema.js";
import { resetDatabase } from "./seed.js";
import { recomputeAccountBalances } from "./queries/diagnostics.js";

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

function unescapeXml(str: string | null | undefined): string {
  if (str == null) return "";
  return String(str)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function parseYnab4SettingsXml(xmlStr?: string): Ynab4Settings {
  const settings: Ynab4Settings = {};
  if (!xmlStr) return settings;

  const matchTag = (tag: string) => {
    const match = xmlStr.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
    return match ? unescapeXml(match[1]?.trim()) : undefined;
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

    // 2. Insert Accounts and Reconciliations
    const accountIdMap = new Map<string, number>();
    const accOnBudgetMap = new Map<string, boolean>();
    const reconciliationIdMap = new Map<string, number>();
    const reconciliationDateMap = new Map<string, string>();
    const accountReconciliationIdMap = new Map<string, number>();
    const accountReconciliationDateMap = new Map<string, string>();
    let accountSort = 0;
    const nonTombstoneAccounts = yAccounts
      .filter((a: any) => !a.isTombstone)
      .sort((a: any, b: any) => (a.sortableIndex ?? 0) - (b.sortableIndex ?? 0));

    const yReconciliations = (ynabData.reconciliations || []).filter((r: any) => !r.isTombstone);
    const hasExplicitReconciliations = yReconciliations.length > 0;

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

      let recDate: string | null = null;
      let recBalance: number | null = null;

      if (hasExplicitReconciliations) {
        const accRecs = yReconciliations.filter((r: any) => r.accountId === acc.entityId);
        if (accRecs.length > 0) {
          const latestRec = accRecs[accRecs.length - 1]!;
          recDate = acc.lastReconciledDate || latestRec.statementDate || latestRec.reconciledAt || todayISO();
          recBalance =
            acc.lastReconciledBalance != null
              ? dollarsToCents(Number(acc.lastReconciledBalance))
              : dollarsToCents(latestRec.statementBalance);
        } else if (acc.lastReconciledDate != null) {
          recDate = acc.lastReconciledDate;
          recBalance = acc.lastReconciledBalance != null ? dollarsToCents(Number(acc.lastReconciledBalance)) : null;
        }
      } else {
        // Check if account has reconciled transactions or lastReconciledDate
        const reconciledTxDates: string[] = [];
        let reconciledSumCents = 0;
        let hasReconciledRows = false;

        for (const t of yTransactions) {
          if (t.isTombstone) continue;
          const isParentOnAccount = t.accountId === acc.entityId;
          const isTopLevelReconciled = t.cleared === "Reconciled";
          const hasSubs = Array.isArray(t.subTransactions) && t.subTransactions.length > 0;

          if (isParentOnAccount) {
            if (hasSubs) {
              if (isTopLevelReconciled) {
                hasReconciledRows = true;
                if (t.date) reconciledTxDates.push(t.date);
                reconciledSumCents += dollarsToCents(t.amount || 0);
              } else {
                for (const st of t.subTransactions) {
                  if (!st.isTombstone && st.cleared === "Reconciled") {
                    hasReconciledRows = true;
                    if (t.date) reconciledTxDates.push(t.date);
                    reconciledSumCents += dollarsToCents(st.amount || 0);
                  }
                }
              }
            } else {
              if (isTopLevelReconciled) {
                hasReconciledRows = true;
                if (t.date) reconciledTxDates.push(t.date);
                reconciledSumCents += dollarsToCents(t.amount || 0);
              }
            }
          } else {
            const isTopTransferTarget =
              t.targetAccountId === acc.entityId ||
              (t.payeeId && t.payeeId === `Payee/Transfer:${acc.entityId}`);
            if (isTopTransferTarget && isTopLevelReconciled && !hasSubs) {
              hasReconciledRows = true;
              if (t.date) reconciledTxDates.push(t.date);
              reconciledSumCents += -dollarsToCents(t.amount || 0);
            } else if (hasSubs) {
              for (const st of t.subTransactions) {
                if (st.isTombstone) continue;
                const isSubTransferTarget =
                  st.targetAccountId === acc.entityId ||
                  (st.payeeId && st.payeeId === `Payee/Transfer:${acc.entityId}`);
                if (isSubTransferTarget && (isTopLevelReconciled || st.cleared === "Reconciled")) {
                  hasReconciledRows = true;
                  if (t.date) reconciledTxDates.push(t.date);
                  reconciledSumCents += -dollarsToCents(st.amount || 0);
                }
              }
            }
          }
        }

        const hasReconciled = Boolean(acc.lastReconciledDate) || hasReconciledRows;

        if (hasReconciled) {
          let latestDate = acc.lastReconciledDate;
          if (!latestDate && reconciledTxDates.length > 0) {
            reconciledTxDates.sort();
            latestDate = reconciledTxDates[reconciledTxDates.length - 1];
          }
          recDate = latestDate || todayISO();

          if (acc.lastReconciledBalance != null) {
            recBalance = dollarsToCents(Number(acc.lastReconciledBalance));
          } else {
            recBalance = reconciledSumCents;
          }
        }
      }

      const [row] = await db
        .insert(accounts)
        .values({
          name: acc.accountName,
          kind,
          groupLabel,
          balance: 0, // To be computed from transactions
          onBudget: !!acc.onBudget,
          sort: accountSort++,
          lastReconciledAt: recDate,
          lastReconciledBalance: recBalance,
          archived: isArchived,
        })
        .returning();

      accountIdMap.set(acc.entityId, row!.id);

      if (hasExplicitReconciliations) {
        const accRecs = yReconciliations.filter((r: any) => r.accountId === acc.entityId);
        for (const r of accRecs) {
          const rDate = r.reconciledAt || r.statementDate || recDate || todayISO();
          const sDate = r.statementDate || r.reconciledAt || recDate || todayISO();
          const sBal = dollarsToCents(r.statementBalance);
          const [rec] = await db
            .insert(reconciliations)
            .values({
              accountId: row!.id,
              reconciledAt: rDate,
              statementDate: sDate,
              statementBalance: sBal,
              adjustmentTransactionId: null,
            })
            .returning();
          if (rec) {
            reconciliationIdMap.set(r.entityId, rec.id);
            reconciliationDateMap.set(r.entityId, rDate);
            accountReconciliationIdMap.set(acc.entityId, rec.id);
            accountReconciliationDateMap.set(acc.entityId, rDate);
          }
        }
      } else if (recDate != null && recBalance != null) {
        const [rec] = await db
          .insert(reconciliations)
          .values({
            accountId: row!.id,
            reconciledAt: recDate,
            statementDate: recDate,
            statementBalance: recBalance,
            adjustmentTransactionId: null,
          })
          .returning();

        if (rec) {
          accountReconciliationIdMap.set(acc.entityId, rec.id);
          accountReconciliationDateMap.set(acc.entityId, recDate);
        }
      }
    }

    // 3. Insert Category Groups and Categories
    const categoryIdMap = new Map<string, number>();
    let groupSort = 0;

    const nonTombstoneMC = yMasterCategories
      .filter(
        (mc: any) =>
          !mc.isTombstone &&
          mc.type === "OUTFLOW" &&
          mc.name !== "__Internal__" &&
          !mc.isCreditCardPayments &&
          mc.name !== "Credit Card Payments" &&
          mc.entityId !== "MasterCategory/CreditCardPayments"
      )
      .sort((a: any, b: any) => {
        const aHidden = a.entityId === "MasterCategory/__Hidden__" || a.name === "Hidden Categories" || a.name?.toLowerCase() === "hidden categories";
        const bHidden = b.entityId === "MasterCategory/__Hidden__" || b.name === "Hidden Categories" || b.name?.toLowerCase() === "hidden categories";
        if (aHidden !== bHidden) return aHidden ? 1 : -1;
        return (a.sortableIndex ?? 0) - (b.sortableIndex ?? 0);
      });

    for (const mc of nonTombstoneMC) {
      const isHidden =
        mc.entityId === "MasterCategory/__Hidden__" ||
        mc.name === "Hidden Categories" ||
        mc.name?.toLowerCase() === "hidden categories";
      const [gRow] = await db
        .insert(categoryGroups)
        .values({
          name: mc.name,
          sort: groupSort++,
          isCreditCardPayments: false,
          isHidden,
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

    const exportedCcMC = yMasterCategories.find(
      (mc: any) =>
        !mc.isTombstone &&
        (mc.isCreditCardPayments ||
          mc.name === "Credit Card Payments" ||
          mc.entityId === "MasterCategory/CreditCardPayments")
    );
    const exportedCcSubs: any[] = exportedCcMC?.subCategories || [];

    const creditAccounts = await db.select().from(accounts).where(eq(accounts.kind, "credit"));
    let ccCatSort = 0;
    for (const acc of creditAccounts) {
      const accEntityId = Array.from(accountIdMap.entries()).find(([_, id]) => id === acc.id)?.[0];
      const matchingSc = exportedCcSubs.find(
        (sc: any) =>
          !sc.isTombstone &&
          ((accEntityId && sc.accountId === accEntityId) ||
            sc.name?.toLowerCase() === acc.name?.toLowerCase())
      );

      const overspendCarriesOver =
        matchingSc?.overspendingHandling === "OverspendCarriedForward" ||
        matchingSc?.entityVersion?.overspendingHandling === "OverspendCarriedForward" ||
        false;
      const initialCarryover = matchingSc?.cachedBalance
        ? dollarsToCents(Number(matchingSc.cachedBalance))
        : matchingSc?.carryover
        ? dollarsToCents(Number(matchingSc.carryover))
        : 0;

      const [cRow] = await db
        .insert(categories)
        .values({
          groupId: ccGroup!.id,
          name: acc.name,
          sort: ccCatSort++,
          carryover: initialCarryover,
          goalTarget: null,
          linkedAccountId: acc.id,
          overspendCarriesOver,
        })
        .returning();

      if (matchingSc) {
        categoryIdMap.set(matchingSc.entityId, cRow!.id);
      }
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

    // Fallback category for cross-budget-boundary transfer outflows with missing categories (BUG-03)
    let fallbackTransferCategoryId: number | null = null;
    async function getOrCreateFallbackTransferCategory(): Promise<number> {
      if (fallbackTransferCategoryId !== null) return fallbackTransferCategoryId;
      const [existingGroup] = await db
        .select()
        .from(categoryGroups)
        .where(eq(categoryGroups.name, "Other"))
        .limit(1);
      let grpId = existingGroup?.id;
      if (!grpId) {
        const [gRow] = await db
          .insert(categoryGroups)
          .values({
            name: "Other",
            sort: groupSort++,
            isCreditCardPayments: false,
          })
          .returning();
        grpId = gRow!.id;
      }
      const [existingCat] = await db
        .select()
        .from(categories)
        .where(and(eq(categories.groupId, grpId), eq(categories.name, "Uncategorized Transfers")))
        .limit(1);
      if (existingCat) {
        fallbackTransferCategoryId = existingCat.id;
      } else {
        const [cRow] = await db
          .insert(categories)
          .values({
            groupId: grpId,
            name: "Uncategorized Transfers",
            sort: 9999,
            carryover: 0,
            goalTarget: null,
          })
          .returning();
        fallbackTransferCategoryId = cRow!.id;
      }
      return fallbackTransferCategoryId;
    }

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
        const parentIncomeMonth = isParentIncome
          ? (t.incomeMonth || (isParentDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
          : null;
        const isParentReconciled = t.cleared === "Reconciled" || Boolean(t.reconciliationId);
        const parentRecId = t.reconciliationId
          ? reconciliationIdMap.get(t.reconciliationId) ?? accountReconciliationIdMap.get(t.accountId) ?? null
          : isParentReconciled
          ? accountReconciliationIdMap.get(t.accountId) ?? null
          : null;
        const parentRecDate = t.reconciliationId
          ? reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
          : isParentReconciled
          ? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
          : null;
        const effectiveParentStatus = isParentReconciled
          ? parentRecId != null ? "r" : "c"
          : t.cleared === "Uncleared" ? "u" : "c";

        const [insertedT] = await db
          .insert(transactions)
          .values({
            accountId: accId,
            categoryId: null,
            date: t.date,
            payee,
            memo: t.memo || "",
            amount: dollarsToCents(t.amount),
            status: effectiveParentStatus,
            flagColor: ynabFlagToColor(t.flag),
            transferAccountId: null,
            parentId: null,
            isIncome: isParentIncome,
            incomeMonth: parentIncomeMonth,
            reconciledAt: effectiveParentStatus === "r" ? parentRecDate : null,
            reconciliationId: effectiveParentStatus === "r" ? parentRecId : null,
          })
          .returning();

        totalImportedTxCount++;

        if (insertedT) {
          const nonTombstoneSubs = (t.subTransactions || []).filter((st: any) => !st.isTombstone);
          let allChildrenReconciled = nonTombstoneSubs.length > 0;

          for (const st of nonTombstoneSubs) {
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
              subPayee = payeeMap.get(st.payeeId) || payee;
            } else {
              subPayee = payee;
            }

            const childAmt = dollarsToCents(st.amount);
            let isChildIncome = false;
            let childIncomeMonth: string | null = null;

            if (subTransferAccountId != null) {
              const destAccEntity = st.targetAccountId || (st.payeeId?.startsWith("Payee/Transfer:") ? st.payeeId.split(":")[1] : "");
              const destIsOnBudget = destAccEntity ? (accOnBudgetMap.get(destAccEntity) ?? false) : (allAccountsForMap.find((a) => a.id === subTransferAccountId)?.onBudget ?? false);
              const isCrossBoundary = accIsOnBudget !== destIsOnBudget;
              const netOnBudgetDelta = (accIsOnBudget ? childAmt : 0) + (destIsOnBudget ? -childAmt : 0);
              if (isCrossBoundary && netOnBudgetDelta < 0 && subCatId === null) {
                subCatId = await getOrCreateFallbackTransferCategory();
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
              const isChildDeferred = st.categoryId === "Category/__DeferredIncome__";
              isChildIncome =
                accIsOnBudget &&
                (st.categoryId === "Category/__ImmediateIncome__" ||
                  isChildDeferred ||
                  (subCatId === null && subTransferAccountId === null)) &&
                (st.amount || 0) > 0;
              childIncomeMonth = isChildIncome
                ? (st.incomeMonth || (isChildDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
                : null;
            }

            const isChildReconciled = isParentReconciled || st.cleared === "Reconciled" || Boolean(st.reconciliationId);
            const childRecId = st.reconciliationId
              ? reconciliationIdMap.get(st.reconciliationId) ?? parentRecId ?? accountReconciliationIdMap.get(t.accountId) ?? null
              : isChildReconciled
              ? parentRecId ?? accountReconciliationIdMap.get(t.accountId) ?? null
              : null;
            const childRecDate = st.reconciliationId
              ? reconciliationDateMap.get(st.reconciliationId) ?? st.reconciledAt ?? parentRecDate ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
              : isChildReconciled
              ? parentRecDate ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
              : null;
            const effectiveChildStatus = isChildReconciled
              ? childRecId != null ? "r" : "c"
              : (t.cleared === "Uncleared" || st.cleared === "Uncleared") ? "u" : "c";

            if (effectiveChildStatus !== "r") {
              allChildrenReconciled = false;
            }

            await db.insert(transactions).values({
              accountId: accId,
              categoryId: subCatId,
              date: t.date,
              payee: subPayee,
              memo: st.memo || "",
              amount: dollarsToCents(st.amount),
              status: effectiveChildStatus,
              flagColor: ynabFlagToColor(st.flag),
              transferAccountId: subTransferAccountId,
              parentId: insertedT.id,
              isIncome: isChildIncome,
              incomeMonth: childIncomeMonth,
              reconciledAt: effectiveChildStatus === "r" ? childRecDate : null,
              reconciliationId: effectiveChildStatus === "r" ? childRecId : null,
            });
            totalImportedTxCount++;
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
            const rawCents = dollarsToCents(rawAmount);
            const netOnBudget = (sourceIsOnBudget ? rawCents : 0) + (destIsOnBudget ? -rawCents : 0);
            const catId = (catEntityId && categoryIdMap.get(catEntityId)) || null;
            const isSpecialIncomeCat =
              catEntityId === "Category/__ImmediateIncome__" ||
              catEntityId === "Category/__DeferredIncome__";
            let effectiveCatId = isSpecialIncomeCat ? null : catId;
            if (isCrossBoundaryTransfer && netOnBudget < 0 && effectiveCatId === null) {
              effectiveCatId = await getOrCreateFallbackTransferCategory();
            }
            const classification = classifyBoundaryTransfer({
              srcOnBudget: sourceIsOnBudget,
              destOnBudget: destIsOnBudget,
              amount: rawCents,
              categoryId: effectiveCatId,
            });
            const finalTransferCatId = classification.categoryId;
            const isTransferIncome = classification.isIncome;

            const isTxReconciled = cleared === "Reconciled" || Boolean(t.reconciliationId) || Boolean(partner?.reconciliationId);
            const recEntityId = t.reconciliationId || partner?.reconciliationId;
            const txRecId = recEntityId
              ? reconciliationIdMap.get(recEntityId) ?? accountReconciliationIdMap.get(sourceAccEntityId) ?? null
              : isTxReconciled
              ? accountReconciliationIdMap.get(sourceAccEntityId) ?? null
              : null;
            const txRecDate = recEntityId
              ? reconciliationDateMap.get(recEntityId) ?? t.reconciledAt ?? partner?.reconciledAt ?? accountReconciliationDateMap.get(sourceAccEntityId) ?? t.date ?? null
              : isTxReconciled
              ? accountReconciliationDateMap.get(sourceAccEntityId) ?? t.date ?? null
              : null;

            await db.insert(transactions).values({
              accountId: sourceAccId,
              categoryId: finalTransferCatId,
              date: t.date,
              payee,
              memo,
              amount: dollarsToCents(rawAmount),
              status:
                isTxReconciled
                  ? txRecId != null ? "r" : "c"
                  : cleared === "Uncleared"
                    ? "u"
                    : "c",
              flagColor: ynabFlagToColor(t.flag),
              transferAccountId: destAccId,
              parentId: null,
              isIncome: isTransferIncome,
              reconciledAt: isTxReconciled ? txRecDate : null,
              reconciliationId: isTxReconciled ? txRecId : null,
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
            const txIncomeMonth = isTxIncome
              ? (t.incomeMonth || (isTxDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
              : null;

            const isTxReconciled = cleared === "Reconciled" || Boolean(t.reconciliationId);
            const txRecId = t.reconciliationId
              ? reconciliationIdMap.get(t.reconciliationId) ?? accountReconciliationIdMap.get(t.accountId) ?? null
              : isTxReconciled
              ? accountReconciliationIdMap.get(t.accountId) ?? null
              : null;
            const txRecDate = t.reconciliationId
              ? reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
              : isTxReconciled
              ? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
              : null;

            await db.insert(transactions).values({
              accountId: accId,
              categoryId: catId,
              date: t.date,
              payee,
              memo,
              amount: dollarsToCents(t.amount),
              status:
                isTxReconciled
                  ? txRecId != null ? "r" : "c"
                  : cleared === "Uncleared"
                    ? "u"
                    : "c",
              flagColor: ynabFlagToColor(t.flag),
              transferAccountId: null,
              parentId: null,
              isIncome: isTxIncome,
              incomeMonth: txIncomeMonth,
              reconciledAt: isTxReconciled ? txRecDate : null,
              reconciliationId: isTxReconciled ? txRecId : null,
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
          if (isCrossBoundaryTx && netOnBudgetTx < 0 && catId === null) {
            catId = await getOrCreateFallbackTransferCategory();
          }
          const isTxIncome =
            (srcOnBudget && (isSpecialIncomeCat || (catId === null && destAccId === null)) && (t.amount || 0) > 0) ||
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

          const isTxReconciled = t.cleared === "Reconciled" || Boolean(t.reconciliationId);
          const txRecId = t.reconciliationId
            ? reconciliationIdMap.get(t.reconciliationId) ?? accountReconciliationIdMap.get(t.accountId) ?? null
            : isTxReconciled
            ? accountReconciliationIdMap.get(t.accountId) ?? null
            : null;
          const txRecDate = t.reconciliationId
            ? reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
            : isTxReconciled
            ? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
            : null;

          await db.insert(transactions).values({
            accountId: accId,
            categoryId: catId,
            date: t.date,
            payee,
            memo: t.memo || "",
            amount: dollarsToCents(t.amount),
            status:
              isTxReconciled
                ? txRecId != null ? "r" : "c"
                : t.cleared === "Uncleared"
                  ? "u"
                  : "c",
            flagColor,
            transferAccountId: destAccId,
            parentId: null,
            isIncome: isTxIncome,
            incomeMonth: txIncomeMonth,
            reconciledAt: isTxReconciled ? txRecDate : null,
            reconciliationId: isTxReconciled ? txRecId : null,
          });
          totalImportedTxCount++;
        }
      }
    }

    // 6. Compute real balances of accounts
    await recomputeAccountBalances(db);

    // 6b. Initialize Credit Card Payment category carryover from card starting balance if present
    for (const acc of creditAccounts) {
      // Check if carryover was already set from exported CC Payment category
      const [existingCat] = await db
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.groupId, ccGroup!.id),
            eq(categories.linkedAccountId, acc.id)
          )
        )
        .limit(1);

      if (existingCat && Number(existingCat.carryover) > 0) {
        continue;
      }

      // Check opening debt via back-calculation: initialBalance = currentBalance - lifetimeDelta
      const [currAcc] = await db.select().from(accounts).where(eq(accounts.id, acc.id));
      const currentBal = Number(currAcc?.balance ?? 0);

      const outRes = await db
        .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, acc.id),
            isNull(transactions.parentId)
          )
        );
      const inRes = await db
        .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.transferAccountId, acc.id),
            isNotNull(transactions.transferAccountId),
            isNull(transactions.parentId)
          )
        );
      const lifetimeDelta = Number(outRes[0]?.sum || 0) - Number(inRes[0]?.sum || 0);
      const initialBalance = currentBal - lifetimeDelta;

      let openingDebt = 0;
      if (initialBalance < 0) {
        openingDebt = Math.abs(initialBalance);
      } else {
        // Find explicit starting balance transaction: match standard and multi-language starting payees
        const [startingTx] = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.accountId, acc.id),
              isNull(transactions.parentId),
              isNull(transactions.transferAccountId),
              or(
                sql`lower(${transactions.payee}) like '%starting balance%'`,
                sql`lower(${transactions.payee}) like '%opening balance%'`,
                sql`lower(${transactions.payee}) like '%initial balance%'`,
                sql`lower(${transactions.payee}) like '%solde initial%'`,
                sql`lower(${transactions.payee}) like '%anfangssaldo%'`,
                sql`lower(${transactions.payee}) like '%saldo inicial%'`,
                sql`lower(${transactions.payee}) like '%saldo iniziale%'`,
                sql`lower(${transactions.payee}) like '%startsaldo%'`,
                sql`lower(${transactions.payee}) like '%beginsaldo%'`,
                sql`lower(${transactions.payee}) like '%debt balance%'`,
                sql`lower(${transactions.payee}) like '%old debt%'`,
                sql`lower(${transactions.payee}) like '%opening debt%'`
              )
            )
          )
          .orderBy(asc(transactions.date), asc(transactions.id))
          .limit(1);

        if (startingTx && Number(startingTx.amount) < 0) {
          openingDebt = Math.abs(Number(startingTx.amount));
        }
      }

      if (openingDebt > 0) {
        await db
          .update(categories)
          .set({ carryover: openingDebt })
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
      if (transferAccountId === accId) {
        transferAccountId = null;
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

      const rawSubs = (st.subTransactions || []).filter((sub: any) => !sub.isTombstone);
      const hasSubs = rawSubs.length >= 2;

      let parentAmount = dollarsToCents(st.amount);
      if (hasSubs) {
        catId = null;
        transferAccountId = null;
        // Rebalance parent amount to match the sum of sub-transactions to guarantee split balance invariant
        parentAmount = rawSubs.reduce((sum: number, sub: any) => sum + dollarsToCents(sub.amount), 0);
      } else if (rawSubs.length === 1) {
        // A single child is not a valid split; collapse to a regular recurring transaction
        const single = rawSubs[0]!;
        parentAmount = dollarsToCents(single.amount);
        catId = (accIsOnBudget && categoryIdMap.get(single.categoryId)) || null;
        if (
          single.categoryId === "Category/__ImmediateIncome__" ||
          single.categoryId === "Category/__DeferredIncome__" ||
          single.categoryId === "Category/__Split__"
        ) {
          catId = null;
        }
        if (single.targetAccountId) {
          transferAccountId = accountIdMap.get(single.targetAccountId) || null;
        } else if (single.payeeId && single.payeeId.startsWith("Payee/Transfer:")) {
          const tid = single.payeeId.split(":")[1];
          transferAccountId = tid ? accountIdMap.get(tid) || null : null;
        }
        if (transferAccountId === accId) {
          transferAccountId = null;
        }
      }

      if (transferAccountId != null) {
        const destAccEntity = st.targetAccountId || (st.payeeId?.startsWith("Payee/Transfer:") ? st.payeeId.split(":")[1] : "");
        const destIsOnBudget = destAccEntity ? (accOnBudgetMap.get(destAccEntity) ?? false) : (allAccountsForMap.find((a) => a.id === transferAccountId)?.onBudget ?? false);
        const isCross = accIsOnBudget !== destIsOnBudget;
        const netOnBudget = (accIsOnBudget ? parentAmount : 0) + (destIsOnBudget ? -parentAmount : 0);
        if (isCross) {
          if (netOnBudget < 0 && catId === null) {
            catId = await getOrCreateFallbackTransferCategory();
          }
        } else {
          catId = null;
        }
      }

      let rawFreq = (st.frequency || "monthly").toLowerCase().replace(/[\s_-]+/g, "");
      let frequency = rawFreq;
      if (rawFreq === "everyotherweek" || rawFreq === "biweekly") frequency = "biweekly";
      else if (rawFreq === "semimonthly" || rawFreq === "twiceamonth") frequency = "twiceamonth";
      else if (rawFreq === "everyothermonth" || rawFreq === "bimonthly") frequency = "everyothermonth";
      else if (rawFreq === "quarterly" || rawFreq === "every3months") frequency = "every3months";
      else if (rawFreq === "semiannually" || rawFreq === "twiceayear") frequency = "twiceayear";
      else if (rawFreq === "annually" || rawFreq === "yearly") frequency = "yearly";
      else if (rawFreq === "everyotheryear" || rawFreq === "every2years") frequency = "every2years";
      else if (rawFreq === "never" || rawFreq === "once") frequency = "never";
      const validFrequencies = [
        "daily",
        "weekly",
        "biweekly",
        "everyotherweek",
        "twiceamonth",
        "semimonthly",
        "every4weeks",
        "monthly",
        "everyothermonth",
        "bimonthly",
        "every3months",
        "quarterly",
        "every4months",
        "twiceayear",
        "semiannually",
        "yearly",
        "annually",
        "every2years",
        "everyotheryear",
        "once",
        "never",
      ];
      if (!validFrequencies.includes(frequency)) {
        frequency = "monthly";
      }

      const active = st.active !== undefined ? Boolean(st.active) : true;
      const parsedAnchor =
        typeof st.anchorDay === "number" && !isNaN(st.anchorDay) && st.anchorDay >= 1 && st.anchorDay <= 31
          ? Math.floor(st.anchorDay)
          : st.date && /^\d{4}-\d{2}-\d{2}$/.test(st.date)
          ? parseInt(st.date.slice(8, 10), 10)
          : 1;
      const anchorDay = Math.min(31, Math.max(1, parsedAnchor));

      const [insertedR] = await db
        .insert(recurring)
        .values({
          accountId: accId,
          categoryId: catId,
          payee,
          memo: st.memo || "",
          flagColor: ynabFlagToColor(st.flag),
          amount: parentAmount,
          frequency,
          nextDate: st.date,
          anchorDay,
          active,
          transferAccountId,
        })
        .returning();

      if (hasSubs && insertedR) {
        let sort = 0;
        for (const sub of rawSubs) {
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
          if (subTransferAccountId === accId) {
            subTransferAccountId = null;
          }

          const childAmt = dollarsToCents(sub.amount);
          if (subTransferAccountId != null) {
            const destAccEntity = sub.targetAccountId || (sub.payeeId?.startsWith("Payee/Transfer:") ? sub.payeeId.split(":")[1] : "");
            const destIsOnBudget = destAccEntity ? (accOnBudgetMap.get(destAccEntity) ?? false) : (allAccountsForMap.find((a) => a.id === subTransferAccountId)?.onBudget ?? false);
            const isCross = accIsOnBudget !== destIsOnBudget;
            const netOnBudget = (accIsOnBudget ? childAmt : 0) + (destIsOnBudget ? -childAmt : 0);
            if (isCross) {
              if (netOnBudget < 0 && subCatId === null) {
                subCatId = await getOrCreateFallbackTransferCategory();
              }
            } else {
              subCatId = null;
            }
          }

          await db.insert(recurringSubTransactions).values({
            recurringId: insertedR.id,
            categoryId: subCatId,
            amount: childAmt,
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

export { recomputeAccountBalances } from "./queries/diagnostics.js";

