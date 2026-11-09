import type { Db } from "../../client.js";
import { assignments } from "../../schema.js";
import type { Ynab4ImportContext } from "../types.js";

export async function importBudgets(
  db: Db,
  yBudgets: any[],
  ctx: Ynab4ImportContext
): Promise<void> {
  // 4. Insert Assignments (Monthly Budgets)
  // G-07: import explicit-zero budgets verbatim whenever the month
  // exists in YNAB4 (only null-budgeted rows carry no amount and are
  // skipped). Per-category notes persist on `assignments.note`;
  // month-level `MonthlyBudget.note` has no home and is reported as
  // a dropped warning instead.
  let monthLevelNoteCount = 0;
  let droppedCategoryNoteCount = 0;
  for (const mb of yBudgets) {
    if (mb.isTombstone) continue;
    if (!mb.monthlySubCategoryBudgets) continue;
    const month = mb.month.substring(0, 7); // Convert "2014-08-01" -> "2014-08"
    if (typeof mb.note === "string" && mb.note.trim() !== "") monthLevelNoteCount++;

    for (const msb of mb.monthlySubCategoryBudgets) {
      if (msb.isTombstone) continue;
      if (msb.budgeted == null) continue;
      const catId = ctx.categoryIdMap.get(msb.categoryId);
      if (!catId) {
        if (typeof msb.note === "string" && msb.note.trim() !== "") droppedCategoryNoteCount++;
        continue;
      }
      const amt = ctx.convertAmount(msb.budgeted);
      const note = typeof msb.note === "string" ? msb.note : "";
      await db
        .insert(assignments)
        .values({
          categoryId: catId,
          month,
          amount: amt,
          note,
        })
        .onConflictDoUpdate({
          target: [assignments.categoryId, assignments.month],
          set: { amount: amt, note },
        });
    }
  }
  if (monthLevelNoteCount > 0) {
    ctx.warnings.push(
      `Dropped month-level budget notes on ${monthLevelNoteCount} month(s); only per-category notes are imported`
    );
  }
  if (droppedCategoryNoteCount > 0) {
    ctx.warnings.push(
      `Dropped per-category budget notes on ${droppedCategoryNoteCount} row(s) whose category was not imported`
    );
  }
}
