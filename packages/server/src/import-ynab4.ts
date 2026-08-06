import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { accounts, assignments, categoryGroups, categories, recurring, recurringSubTransactions, transactions } from "./schema.js";
import { resetDatabase } from "./seed.js";

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
    await resetDatabase(db);

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
    for (const acc of yAccounts) {
      if (acc.isTombstone) continue;

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

      const [row] = await db
        .insert(accounts)
        .values({
          name: acc.accountName,
          kind,
          groupLabel,
          balance: 0, // To be computed from transactions
          onBudget: !!acc.onBudget,
          sort: accountSort++,
        })
        .returning();

      accountIdMap.set(acc.entityId, row!.id);
    }

    // 3. Insert Category Groups and Categories
    const categoryIdMap = new Map<string, number>();
    let groupSort = 0;

    for (const mc of yMasterCategories) {
      if (mc.isTombstone) continue;
      // Skip Hidden Categories and special system ones that are not OUTFLOW
      if (mc.name === "Hidden Categories" || mc.type !== "OUTFLOW") continue;

      const [gRow] = await db
        .insert(categoryGroups)
        .values({
          name: mc.name,
          sort: groupSort++,
          isCreditCardPayments: false,
        })
        .returning();

      let catSort = 0;
      for (const sc of mc.subCategories || []) {
        if (sc.isTombstone) continue;

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
        if (msb.budgeted !== 0) {
          const catId = categoryIdMap.get(msb.categoryId);
          if (catId) {
            await db
              .insert(assignments)
              .values({
                categoryId: catId,
                month,
                amount: msb.budgeted,
              })
              .onConflictDoUpdate({
                target: [assignments.categoryId, assignments.month],
                set: { amount: msb.budgeted },
              });
          }
        }
      }
    }

    // 5. Insert Transactions
    const accNameMap = new Map<number, string>();
    const allAccountsForMap = await db.select().from(accounts);
    for (const a of allAccountsForMap) accNameMap.set(a.id, a.name);

    for (const t of yTransactions) {
      if (t.isTombstone) continue;

      const accId = accountIdMap.get(t.accountId);
      if (!accId) continue;

      let payee = payeeMap.get(t.payeeId) || "";
      let transferAccountId = t.targetAccountId ? accountIdMap.get(t.targetAccountId) || null : null;

      if (t.payeeId && t.payeeId.startsWith("Payee/Transfer:")) {
        const targetId = t.payeeId.split(":")[1];
        const foundTarget = targetId ? accountIdMap.get(targetId) : null;
        if (foundTarget) {
          transferAccountId = foundTarget;
          payee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
        }
      }

      let catId = categoryIdMap.get(t.categoryId) || null;
      if (
        t.categoryId === "Category/__ImmediateIncome__" ||
        t.categoryId === "Category/__DeferredIncome__" ||
        t.categoryId === "Category/__Split__"
      ) {
        catId = null;
      }

      const [insertedT] = await db
        .insert(transactions)
        .values({
          accountId: accId,
          categoryId: catId,
          date: t.date,
          payee,
          memo: t.memo || "",
          amount: t.amount || 0,
          status:
            t.cleared === "Reconciled"
              ? "r"
              : t.cleared === "Uncleared"
                ? "u"
                : "c",
          transferAccountId,
        })
        .returning();

      if (t.subTransactions && t.subTransactions.length > 0 && insertedT) {
        for (const st of t.subTransactions) {
          if (st.isTombstone) continue;
          let subCatId = categoryIdMap.get(st.categoryId) || null;
          let subTransferAccId = st.targetAccountId ? accountIdMap.get(st.targetAccountId) || null : null;
          let subPayee = "";

          if (st.payeeId && st.payeeId.startsWith("Payee/Transfer:")) {
            const targetId = st.payeeId.split(":")[1];
            const foundTarget = targetId ? accountIdMap.get(targetId) : null;
            if (foundTarget) {
              subTransferAccId = foundTarget;
              subPayee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
            }
          } else if (st.targetAccountId) {
             const foundTarget = accountIdMap.get(st.targetAccountId);
             if (foundTarget) {
               subTransferAccId = foundTarget;
               subPayee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
             }
          }

          await db.insert(transactions).values({
            accountId: accId,
            categoryId: subCatId,
            date: t.date,
            payee: subPayee,
            memo: st.memo || "",
            amount: st.amount || 0,
            status:
              t.cleared === "Reconciled"
                ? "r"
                : t.cleared === "Uncleared"
                  ? "u"
                  : "c",
            transferAccountId: subTransferAccId,
            parentId: insertedT.id
          });
        }
      }
    }

    // 6. Compute real balances of accounts. (Extracted for testability — see
    // `recomputeAccountBalances` below for the bug fix that accounts for
    // incoming transfers.)
    await recomputeAccountBalances(db);

    // 7. Insert Scheduled (Recurring) Transactions
    for (const st of yScheduled) {
      if (st.isTombstone) continue;

      const accId = accountIdMap.get(st.accountId);
      if (!accId) continue;

      let payee = payeeMap.get(st.payeeId) || "";
      let transferAccountId = st.targetAccountId ? accountIdMap.get(st.targetAccountId) || null : null;

      // YNAB4's transfer convention is `Payee/Transfer:<AccountId>`. Honour it
      // for scheduled transactions the same way the transactions importer
      // does (lines 158-165 above).
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

      let frequency = st.frequency || "monthly";
      frequency = frequency.toLowerCase();
      if (!["monthly", "weekly", "biweekly", "yearly"].includes(frequency)) {
        frequency = "monthly"; // default fallback
      }

      const [insertedR] = await db
        .insert(recurring)
        .values({
          accountId: accId,
          categoryId: catId,
          payee,
          amount: st.amount || 0,
          frequency,
          nextDate: st.date,
          active: true,
          transferAccountId,
        })
        .returning();

      if (hasSubs && insertedR) {
        // Recurring splits don't support transfer sub-rows (the
        // `recurring_sub_transactions` schema has no transferAccountId),
        // matching the no-transfer-in-a-split YNAB4 rule. Sub-row
        // `targetAccountId` is intentionally ignored.
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
          if (!subCatId) continue;
          await db.insert(recurringSubTransactions).values({
            recurringId: insertedR.id,
            categoryId: subCatId,
            amount: sub.amount || 0,
            memo: sub.memo || "",
            sort: sort++,
          });
        }
      }
    }

    const result = {
      accounts: accountIdMap.size,
      categoryGroups: groupSort,
      categories: categoryIdMap.size,
      transactions: yTransactions.length,
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
 * Outflows: rows posted to this account as the source
 *   (regular + transfer source — both live on the source's `accountId`).
 * Inflows: rows where this account is the transfer destination
 *   (the source row is stored against the source's `accountId`; the
 *   destination's balance is `-sourceAmount`, mirroring `createTransfer`).
 *
 * The previous implementation only summed rows where
 * `accountId === a.id`, which silently dropped every incoming transfer
 * and left imported destination-account balances permanently wrong.
 */
export async function recomputeAccountBalances(db: Db): Promise<void> {
  const allAccs = await db.select().from(accounts);
  for (const a of allAccs) {
    const outRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(eq(transactions.accountId, a.id));

    const inRes = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.transferAccountId, a.id),
          isNotNull(transactions.transferAccountId)
        )
      );

    const outgoing = Number(outRes[0]?.sum || 0);
    const incomingFromTransfers = Number(inRes[0]?.sum || 0);
    const sum = outgoing - incomingFromTransfers;
    await db.update(accounts).set({ balance: sum }).where(eq(accounts.id, a.id));
  }
}
