import { and, eq } from "drizzle-orm";
import type { Db } from "../../client.js";
import { categories, categoryGroups } from "../../schema.js";
import type { Ynab4ImportContext } from "../types.js";

export async function getOrCreateFallbackTransferCategory(
  db: Db,
  ctx: Ynab4ImportContext
): Promise<number> {
    if (ctx.fallbackTransferCategoryId !== null) return ctx.fallbackTransferCategoryId;
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
          sort: ctx.groupSort++,
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
      ctx.fallbackTransferCategoryId = existingCat.id;
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
      ctx.fallbackTransferCategoryId = cRow!.id;
    }
    return ctx.fallbackTransferCategoryId;
}
