import { autoPostDueRecurringTransactions, getBudgetData, getDefaultDb, isSeeded, seedDatabase } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDefaultDb();
  // Only seed once — skip the work on every subsequent request.
  const seeded = await isSeeded(db);
  if (!seeded) {
    await seedDatabase(db);
  }
  await autoPostDueRecurringTransactions(db);
  const data = await getBudgetData(db);
  return Response.json(data);
}
