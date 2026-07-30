import { db } from "@/db";
import {
  accounts,
  categoryGroups,
  categories,
  assignments,
  transactions,
  recurring,
} from "@/db/schema";
import { seedDatabase } from "@/lib/seed";
import { asc, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  await seedDatabase();

  const [accts, groups, cats, assigns, txns, recur] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.sort)),
    db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort)),
    db.select().from(categories).orderBy(asc(categories.sort)),
    db.select().from(assignments),
    db.select().from(transactions).orderBy(desc(transactions.date), desc(transactions.id)),
    db.select().from(recurring).orderBy(asc(recurring.nextDate)),
  ]);

  return Response.json({
    accounts: accts,
    groups,
    categories: cats,
    assignments: assigns,
    transactions: txns,
    recurring: recur,
  });
}
