import { eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { accounts, assignments, categoryGroups, categories, recurring, transactions } from "./schema.js";
import { resetDatabase } from "./seed.js";

export async function importYnab4(db: Db, ynabData: any) {
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
  for (const t of yTransactions) {
    if (t.isTombstone) continue;

    const accId = accountIdMap.get(t.accountId);
    if (!accId) continue;

    const payee = payeeMap.get(t.payeeId) || "";

    let catId = categoryIdMap.get(t.categoryId) || null;
    if (
      t.categoryId === "Category/__ImmediateIncome__" ||
      t.categoryId === "Category/__DeferredIncome__"
    ) {
      catId = null;
    }

    await db.insert(transactions).values({
      accountId: accId,
      categoryId: catId,
      date: t.date,
      payee,
      memo: t.memo || "",
      amount: t.amount || 0,
      cleared: t.cleared !== "Uncleared",
    });
  }

  // 6. Compute real balances of accounts
  const allAccs = await db.select().from(accounts);
  for (const a of allAccs) {
    const res = await db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
      .from(transactions)
      .where(eq(transactions.accountId, a.id));

    const sum = res[0]?.sum || 0;
    await db.update(accounts).set({ balance: sum }).where(eq(accounts.id, a.id));
  }

  // 7. Insert Scheduled (Recurring) Transactions
  for (const st of yScheduled) {
    if (st.isTombstone) continue;

    const accId = accountIdMap.get(st.accountId);
    if (!accId) continue;

    const payee = payeeMap.get(st.payeeId) || "";

    let catId = categoryIdMap.get(st.categoryId) || null;
    if (
      st.categoryId === "Category/__ImmediateIncome__" ||
      st.categoryId === "Category/__DeferredIncome__"
    ) {
      catId = null;
    }

    let frequency = st.frequency || "monthly";
    frequency = frequency.toLowerCase();
    if (!["monthly", "weekly", "biweekly", "yearly"].includes(frequency)) {
      frequency = "monthly"; // default fallback
    }

    await db.insert(recurring).values({
      accountId: accId,
      categoryId: catId,
      payee,
      amount: st.amount || 0,
      frequency,
      nextDate: st.date,
      active: true,
    });
  }

  return {
    accounts: accountIdMap.size,
    categoryGroups: groupSort,
    categories: categoryIdMap.size,
    transactions: yTransactions.length,
  };
}
