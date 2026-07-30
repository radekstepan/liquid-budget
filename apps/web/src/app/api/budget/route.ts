import { getBudgetData, getDefaultDb, seedDatabase } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDefaultDb();
  await seedDatabase(db);
  const data = await getBudgetData(db);
  return Response.json(data);
}
