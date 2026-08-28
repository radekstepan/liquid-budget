import { autoPostDueRecurringTransactions, getBudgetData, getDefaultDb, isSeeded, seedDatabase } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDefaultDb();
  // Only seed once — skip the work on every subsequent request.
  const seeded = await isSeeded(db);
  if (!seeded) {
    await seedDatabase(db);
  }
  let autoPostedCount = 0;
  try {
    const autoPosted = await autoPostDueRecurringTransactions(db);
    autoPostedCount = autoPosted.length;
  } catch (err) {
    console.error("autoPostDueRecurringTransactions failed in GET /api/budget:", err);
  }
  const data = await getBudgetData(db);
  return Response.json({
    ...data,
    autoPostedRecurringCount: autoPostedCount,
  });
}
