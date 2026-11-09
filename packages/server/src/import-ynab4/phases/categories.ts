import { eq } from "drizzle-orm";
import type { Db } from "../../client.js";
import { accounts, categories, categoryGroups } from "../../schema.js";
import { parseMangledHiddenName } from "../sentinels.js";
import type { Ynab4ImportContext } from "../types.js";

const isConfinedHandling = (v: unknown): boolean =>
  v === "Confined" || v === "OverspendCarriedForward";

export async function importCategories(
  db: Db,
  yMasterCategories: any[],
  yBudgets: any[],
  ctx: Ynab4ImportContext
): Promise<void> {
  // 3. Insert Category Groups and Categories
  // YNAB4 persists overspend behavior per-month on
  // MonthlySubCategoryBudgetVO.overspendingHandling ("Confined" = red-arrow
  // carry vs "AffectsBuffer" = deduct from TBB), never on SubCategoryVO.
  // Our model is a static per-category flag, so any "Confined" MSBVO for a
  // category maps to overspendCarriesOver=true. "OverspendCarriedForward"
  // is accepted too for backups written by our own pre-fix exporter.
  const confinedByCategoryEntityId = new Map<string, boolean>();
  for (const mb of yBudgets) {
    if ((mb as any)?.isTombstone) continue;
    for (const msb of (mb as any)?.monthlySubCategoryBudgets || []) {
      if (msb?.isTombstone || msb?.categoryId == null) continue;
      if (
        isConfinedHandling(msb.overspendingHandling) ||
        isConfinedHandling(msb.entityVersion?.overspendingHandling)
      ) {
        confinedByCategoryEntityId.set(msb.categoryId, true);
      }
    }
  }


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
        entityId: mc.entityId,
        name: mc.name,
        sort: ctx.groupSort++,
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
        isConfinedHandling(sc.overspendingHandling) ||
        isConfinedHandling(sc.entityVersion?.overspendingHandling) ||
        confinedByCategoryEntityId.get(sc.entityId) === true;
      // Hidden subs carry their original home as a mangled name
      // ("OldMaster ` Sub ` OldMasterEntityId"); demangle the display
      // name and persist the components so unhide/export can restore
      // the linkage. Non-hidden names never contain a backtick (YNAB4
      // rejects it in fresh names), so only parse under the hidden
      // master; anything unparseable keeps its verbatim name.
      const mangled = isHidden ? parseMangledHiddenName(sc.name) : null;
      const [cRow] = await db
        .insert(categories)
        .values({
          entityId: sc.entityId,
          groupId: gRow!.id,
          name: mangled?.subName ?? sc.name,
          sort: catSort++,
          carryover: 0,
          goalTarget: null,
          overspendCarriesOver: overspendCarriesOver || false,
          oldMasterName: mangled?.oldMasterName ?? null,
          oldMasterEntityId: mangled?.oldMasterEntityId ?? null,
        })
        .returning();

      ctx.categoryIdMap.set(sc.entityId, cRow!.id);
    }
  }

  const exportedCcMC = yMasterCategories.find(
    (mc: any) =>
      !mc.isTombstone &&
      (mc.isCreditCardPayments ||
        mc.name === "Credit Card Payments" ||
        mc.entityId === "MasterCategory/CreditCardPayments")
  );
  const exportedCcSubs: any[] = exportedCcMC?.subCategories || [];

  // Create special "Credit Card Payments" group
  const [ccGroup] = await db
    .insert(categoryGroups)
    .values({
      entityId: exportedCcMC?.entityId ?? null,
      name: "Credit Card Payments",
      sort: ctx.groupSort++,
      isCreditCardPayments: true,
    })
    .returning();
  ctx.ccGroupId = ccGroup?.id ?? null;

  const creditAccounts = await db.select().from(accounts).where(eq(accounts.kind, "credit"));
  let ccCatSort = 0;
  for (const acc of creditAccounts) {
    const accEntityId = Array.from(ctx.accountIdMap.entries()).find(([_, id]) => id === acc.id)?.[0];
    const matchingSc = exportedCcSubs.find(
      (sc: any) =>
        !sc.isTombstone &&
        ((accEntityId && sc.accountId === accEntityId) ||
          sc.name?.toLowerCase() === acc.name?.toLowerCase())
    );

    const overspendCarriesOver =
      isConfinedHandling(matchingSc?.overspendingHandling) ||
      isConfinedHandling(matchingSc?.entityVersion?.overspendingHandling) ||
      (matchingSc?.entityId != null &&
        confinedByCategoryEntityId.get(matchingSc.entityId) === true) ||
      false;
    const initialCarryover =
      matchingSc?.carryover !== undefined
        ? ctx.convertAmount(Number(matchingSc.carryover))
        : matchingSc?.cachedBalance !== undefined
        ? ctx.convertAmount(Number(matchingSc.cachedBalance))
        : 0;

    const [cRow] = await db
      .insert(categories)
      .values({
        entityId: matchingSc?.entityId ?? null,
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
      ctx.categoryIdMap.set(matchingSc.entityId, cRow!.id);
    }
  }
}
