import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { isTransferPayee } from "@ynab/logic";
import type { Db } from "../../client.js";
import { payees, renameRules, transactions } from "../../schema.js";
import { findOrCreatePayee } from "../../queries/payees.js";
import { arrayField } from "../guards.js";
import type { Ynab4ImportContext } from "../types.js";

export function importPayees(db: Db, yPayees: any[], ctx: Ynab4ImportContext): void {
  // Payees mapping (payeeId -> name)
  // YNAB4 payee entityId -> local payees.id (BUG-16). The payees table is
  // populated so transactions can link via payeeId instead of carrying
  // duplicated text-only payees. Transfer payees (targetAccountId set) are
  // modeled via transferAccountId and never get a payees row.
  for (const p of yPayees) {
    if (!p.isTombstone) {
      ctx.payeeMap.set(p.entityId, p.name);
      if (p.targetAccountId) continue;
      if (typeof p.name !== "string" || !p.name.trim()) continue;
      const payeeRow = findOrCreatePayee(db, p.name, undefined, p.entityId);
      ctx.payeeDbIdMap.set(p.entityId, payeeRow.id);
      // G-04: YNAB4 `enabled === false` payees import as archived
      // (mirrors `accounts.archived`; written back as `enabled`).
      // Missing `enabled` means enabled (YNAB4 defaults it to true).
      if (p.enabled === false && !payeeRow.archived) {
        db.update(payees).set({ archived: true }).where(eq(payees.id, payeeRow.id)).run();
      }
    }
  }
}

export async function backfillPayeeDefaults(
  db: Db,
  yPayees: any[],
  ctx: Ynab4ImportContext
): Promise<void> {
  // 5b. Carry over per-payee defaults (Payees Manager "Default
  // Category" + autofill). YNAB4 stores them as
  // payee.autoFillCategoryId/autoFillMemo/autoFillAmount, which the
  // payee-creation pass above ignored, leaving every default empty.
  // Primary source is the YNAB4 auto-fill id resolved through the category
  // map; payees without a resolvable auto-fill fall back to the category
  // they use most often across regular (non-transfer, non-split-child)
  // transactions. Special income/split markers map to no default. The
  // memo/amount wire defaults persist verbatim (amount converted to
  // cents like every other amount) so blank rows for a payee with no
  // history still propose them. Skipped entirely when no payee rows
  // were created (nothing to backfill).
  if (ctx.payeeDbIdMap.size > 0) {
    const SPECIAL_AUTO_FILL = new Set([
      "Category/__ImmediateIncome__",
      "Category/__DeferredIncome__",
      "Category/__SupplementalIncome__",
      "Category/__PrimaryIncome__",
      "Category/__Split__",
    ]);
    const usage = await db
      .select({
        payeeId: transactions.payeeId,
        categoryId: transactions.categoryId,
        uses: sql<number>`count(*)`,
      })
      .from(transactions)
      .where(
        and(
          isNotNull(transactions.payeeId),
          isNotNull(transactions.categoryId),
          isNull(transactions.transferAccountId),
          isNull(transactions.parentId)
        )
      )
      .groupBy(transactions.payeeId, transactions.categoryId);
    const modeByPayee = new Map<number, number>();
    const usesByPayee = new Map<number, number>();
    const totalByPayee = new Map<number, number>();
    for (const row of usage) {
      if (row.payeeId == null || row.categoryId == null) continue;
      const n = Number(row.uses);
      totalByPayee.set(row.payeeId, (totalByPayee.get(row.payeeId) ?? 0) + n);
      if (n > (usesByPayee.get(row.payeeId) ?? 0)) {
        usesByPayee.set(row.payeeId, n);
        modeByPayee.set(row.payeeId, row.categoryId);
      }
    }
    for (const p of yPayees) {
      if (p.isTombstone || p.targetAccountId) continue;
      if (typeof p.name !== "string" || !p.name.trim()) continue;
      const localPayeeId = ctx.payeeDbIdMap.get(p.entityId);
      if (!localPayeeId) continue;
      let defaultCatId: number | null = null;
      const raw = p.autoFillCategoryId;
      if (typeof raw === "string" && raw && !SPECIAL_AUTO_FILL.has(raw)) {
        defaultCatId = ctx.categoryIdMap.get(raw) ?? null;
      }
      if (defaultCatId == null) {
        // History fallback only when the signal is strong: the modal
        // category needs at least 3 uses and an outright majority, so
        // one-off coincidences (e.g. opening-balance rows) don't mint
        // misleading defaults.
        const mode = modeByPayee.get(localPayeeId);
        const best = usesByPayee.get(localPayeeId) ?? 0;
        const total = totalByPayee.get(localPayeeId) ?? 0;
        if (mode != null && best >= 3 && best > total / 2) {
          defaultCatId = mode;
        }
      }
      if (defaultCatId != null) {
        db.update(payees)
          .set({ autoCategoryId: defaultCatId })
          .where(eq(payees.id, localPayeeId))
          .run();
      }
      // G-04: persist the entity-level autofill defaults so blank
      // rows for a history-less payee still propose memo + amount.
      // Stored in cents via the same wire-unit conversion as every
      // other amount; null when the backup carried no default.
      const autoMemoRaw = typeof p.autoFillMemo === "string" ? p.autoFillMemo.trim() : "";
      const autoAmountRaw = Number(p.autoFillAmount);
      const autoMemo = autoMemoRaw !== "" ? autoMemoRaw : null;
      const autoAmount =
        Number.isFinite(autoAmountRaw) && autoAmountRaw !== 0 ? ctx.convertAmount(autoAmountRaw) : null;
      if (autoMemo !== null || autoAmount !== null) {
        db.update(payees)
          .set({ autoMemo, autoAmount })
          .where(eq(payees.id, localPayeeId))
          .run();
      }
    }
  }
}

export async function importPayeeRenameConditions(
  db: Db,
  ynabData: unknown,
  ctx: Ynab4ImportContext
): Promise<void> {
  // Elements stay `any`: array shape is validated above, per-row wire
  // typing belongs to the phase files (kept under the explicit-`any`
  // carve-out) rather than this boundary.
  const yPayees: any[] = arrayField(ynabData, "payees");
  // 5c. Import YNAB4 payee rename conditions into rename_rules.
  //
  // Operator audit (`data/StringCondition.as`,
  // `data/StringOperator.as`, `com/ynab/enums/EnumBase.as`): exactly
  // four operators exist — Contains, Is, StartsWith, EndsWith
  // (serialized under the static property names, parsed
  // case-insensitively). All four map natively onto our rule engine:
  // `Is` becomes an exact rule; the three substring operators become
  // rules with the matching `operator` flavour (same
  // `normalizeRenameText` folding on both sides — a documented
  // superset of YNAB4's `toLocaleLowerCase`-only comparison, so
  // `AMZN*MKTP` matches operand `AMZN MKTP` here where stock YNAB4
  // would not). Only genuinely unknown operator strings land in
  // warnings. `locations` (plus top-level `payeeLocations`) have no
  // counterpart (no maps feature). `autoFillMemo`/`autoFillAmount`
  // persist on the payee row in 5b above, so blank rows for a
  // history-less payee still propose them. `targetAccountId`
  // transfer payees stay skipped by design (modeled via
  // transferAccountId), reported as one aggregated notice.
  {
    let transferPayeeCount = 0;
    let droppedLocationCount = arrayField(ynabData, "payeeLocations").filter((l: any) => !l?.isTombstone).length;
    const importedAt = new Date().toISOString();
    for (const p of yPayees) {
      if (p.isTombstone) continue;
      if (typeof p.name !== "string" || !p.name.trim()) continue;
      if (p.targetAccountId) {
        transferPayeeCount++;
        continue;
      }
      if (Array.isArray(p.locations)) {
        droppedLocationCount += p.locations.filter((l: any) => !l?.isTombstone).length;
      }
      const conditions = Array.isArray(p.renameConditions) ? p.renameConditions : [];
      for (const c of conditions) {
        if (c?.isTombstone) continue;
        const operator = typeof c?.operator === "string" ? c.operator.trim() : "";
        const operand = typeof c?.operand === "string" ? c.operand.trim() : "";
        if (!operator || !operand) {
          ctx.warnings.push(
            `Payee "${p.name.trim()}": skipped a rename condition with a missing operator or blank text (YNAB4 never matches those)`
          );
          continue;
        }
        const lowered = operator.toLowerCase();
        const ruleOperator =
          lowered === "is"
            ? "is"
            : lowered === "contains"
              ? "contains"
              : lowered === "startswith"
                ? "startsWith"
                : lowered === "endswith"
                  ? "endsWith"
                  : null;
        if (!ruleOperator) {
          ctx.warnings.push(
            `Payee "${p.name.trim()}": skipped rename condition with unknown operator "${operator}" (operand "${operand}"); expected one of Is, Contains, StartsWith, EndsWith`
          );
          continue;
        }
        if (isTransferPayee(operand)) {
          ctx.warnings.push(
            `Payee "${p.name.trim()}": skipped rename condition for transfer-like text "${operand}" (rename rules never apply to transfers)`
          );
          continue;
        }
        await db
          .insert(renameRules)
          .values({ sourcePattern: operand, targetPayee: p.name.trim(), operator: ruleOperator, createdAt: importedAt })
          .onConflictDoNothing();
      }
    }
    if (transferPayeeCount > 0) {
      ctx.warnings.push(
        `Skipped ${transferPayeeCount} transfer payee(s) (targetAccountId set); transfers are modeled via transferAccountId, not payee rows`
      );
    }
    if (droppedLocationCount > 0) {
      ctx.warnings.push(
        `Dropped ${droppedLocationCount} payee location(s) (YNAB4 map pins); there is no maps feature to hold them`
      );
    }
  }
}
