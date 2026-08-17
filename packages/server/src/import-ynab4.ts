import { and, eq, isNotNull, sql } from "drizzle-orm";
import AdmZip from "adm-zip";
import { dollarsToCents, nextMonthKey } from "@ynab/logic";
import type { Db } from "./client.js";
import { accounts, assignments, categoryGroups, categories, recurring, recurringSubTransactions, transactions } from "./schema.js";
import { resetDatabase } from "./seed.js";

export interface ExtractedYnab4Data {
  ynabData: any;
  settingsXml?: string;
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
  return { ynabData, settingsXml };
}

export async function importYnab4(db: Db, ynabData: any) {
  // CRITICAL: Wrap the entire wipe-and-import in a SQLite transaction.
  // Without this, an unhandled exception halfway through (missing map
  // key, FK violation, OOM on huge imports) leaves the user's database
  // PERMANENTLY WIPED with corrupted/partial new data. The whole flow
  // must be atomic: either everything commits, or nothing changes.
  //
  // better-sqlite3 + drizzle's `db.transaction(async (tx) => …)` does
  // NOT work — better-sqlite3's transaction wrapper commits the moment
  // the callback returns, ignoring microtask-deferred `await`s. We use
  // manual BEGIN/COMMIT/ROLLBACK instead, mirroring Drizzle's own
  // SQLiteSyncDialect.migrate. All drizzle operations on better-
  // sqlite3 are synchronous under the hood, so the `await`s still
  // complete before the COMMIT/ROLLBACK runs.
  db.run(sql`BEGIN`);
  try {
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
    let accountSort = 0;
    const nonTombstoneAccounts = yAccounts
      .filter((a: any) => !a.isTombstone)
      .sort((a: any, b: any) => (a.sortableIndex ?? 0) - (b.sortableIndex ?? 0));

    for (const acc of nonTombstoneAccounts) {
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
        const [cRow] = await db
          .insert(categories)
          .values({
            groupId: gRow!.id,
            name: sc.name,
            sort: catSort++,
            carryover: 0,
            goalTarget: null,
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
      if (!mb.monthlySubCategoryBudgets) continue;
      const month = mb.month.substring(0, 7); // Convert "2014-08-01" -> "2014-08"

      for (const msb of mb.monthlySubCategoryBudgets) {
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
            let subCatId = categoryIdMap.get(st.categoryId) || null;
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

            if (subTransferAccountId != null) {
              subCatId = null;
            }

            const isChildDeferred = st.categoryId === "Category/__DeferredIncome__";
            const isChildIncome =
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
        if (linkedSub) {
          // This was the duplicate counterpart of a split subtransaction in YNAB4.
          // Since the subtransaction on the parent split now carries transferAccountId,
          // the transfer is already fully accounted for without needing this duplicate row.
          continue;
        } else if (t.transferTransactionId) {
          // Top-level regular transfer pair
          if (processedTransferIds.has(t.entityId)) {
            // Already imported from counterpart
            continue;
          }

          const partner = txById.get(t.transferTransactionId);
          processedTransferIds.add(t.entityId);
          if (partner) processedTransferIds.add(partner.entityId);

          let sourceAccEntityId = t.accountId;
          let destAccEntityId = t.targetAccountId || (t.payeeId && t.payeeId.startsWith("Payee/Transfer:") ? t.payeeId.split(":")[1] : null);
          let rawAmount = t.amount || 0;
          let memo = t.memo || "";
          let cleared = t.cleared;

          // Normalize so source is outflow (negative amount) if counterpart exists and is negative
          if (rawAmount > 0 && partner && (partner.amount || 0) < 0) {
            sourceAccEntityId = partner.accountId;
            destAccEntityId = t.accountId;
            rawAmount = partner.amount || 0;
            if (!memo && partner.memo) memo = partner.memo;
            cleared = partner.cleared;
          }

          const sourceAccId = accountIdMap.get(sourceAccEntityId);
          const destAccId = destAccEntityId ? accountIdMap.get(destAccEntityId) || null : null;

          if (!sourceAccId) continue;

          let payee = "";
          if (destAccId) {
            payee = "Transfer : " + (accNameMap.get(destAccId) || "Unknown");
          } else if (t.payeeId) {
            payee = payeeMap.get(t.payeeId) || "";
          }

          await db.insert(transactions).values({
            accountId: sourceAccId,
            categoryId: null,
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
            transferAccountId: destAccId,
            parentId: null,
            isIncome: false,
            reconciledAt: cleared === "Reconciled" ? (t.date || null) : null,
          });
          totalImportedTxCount++;
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

          let catId = categoryIdMap.get(t.categoryId) || null;
          const isTxDeferred = t.categoryId === "Category/__DeferredIncome__";
          const isSpecialIncomeCat =
            t.categoryId === "Category/__ImmediateIncome__" ||
            isTxDeferred;
          if (
            destAccId ||
            isSpecialIncomeCat ||
            t.categoryId === "Category/__Split__"
          ) {
            catId = null;
          }

          const isTxIncome =
            (isSpecialIncomeCat || (catId === null && destAccId === null)) &&
            (t.amount || 0) > 0;
          const txIncomeMonth = isTxDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null;

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

      let catId = categoryIdMap.get(st.categoryId) || null;
      if (
        st.categoryId === "Category/__ImmediateIncome__" ||
        st.categoryId === "Category/__DeferredIncome__" ||
        st.categoryId === "Category/__Split__"
      ) {
        catId = null;
      }

      // Transfers and splits cannot have a top-level category.
      const hasSubs = Array.isArray(st.subTransactions) && st.subTransactions.length > 0;
      if (transferAccountId != null || hasSubs) {
        catId = null;
      }

      let frequency = (st.frequency || "monthly").toLowerCase();
      if (frequency === "everyotherweek") frequency = "biweekly";
      const validFrequencies = [
        "daily",
        "weekly",
        "biweekly",
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
          active: true,
          transferAccountId,
        })
        .returning();

      if (hasSubs && insertedR) {
        let sort = 0;
        for (const sub of st.subTransactions) {
          if (sub.isTombstone) continue;
          let subCatId = categoryIdMap.get(sub.categoryId) || null;
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
          if (subTransferAccountId != null) {
            subCatId = null;
          }

          if (!subCatId && !subTransferAccountId) continue;

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

    const result = {
      accounts: accountIdMap.size,
      categoryGroups: groupSort,
      categories: categoryIdMap.size,
      transactions: totalImportedTxCount,
    };
    db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
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
