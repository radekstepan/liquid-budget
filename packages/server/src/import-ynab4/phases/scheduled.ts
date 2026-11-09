import { repairSplitForImport } from "@ynab/logic";
import type { Db } from "../../client.js";
import { recurring, recurringSubTransactions } from "../../schema.js";
import { ynabFlagToColor } from "../lineage.js";
import type { Ynab4ImportContext } from "../types.js";
import { getOrCreateFallbackTransferCategory } from "./shared.js";

export async function importScheduled(
  db: Db,
  yScheduled: any[],
  ctx: Ynab4ImportContext
): Promise<void> {
  // 7. Insert Scheduled (Recurring) Transactions
  // G-08: unknown frequencies warn instead of silently becoming
  // monthly; single-child scheduled splits (exactly one live leg)
  // collapse to plain rows with a warning. Both aggregate so one
  // exotic backup can't flood the summary.
  // G-06: like register splits, every live leg imports verbatim —
  // including 0-amount legs. Only a parent with literally no live
  // children falls through to a plain row.
  for (const st of yScheduled) {
    if (st.isTombstone) continue;

    const accId = ctx.accountIdMap.get(st.accountId);
    if (!accId) continue;

    let payee = ctx.payeeMap.get(st.payeeId) || "";
    let recurringPayeeId: number | null = (st.payeeId && ctx.payeeDbIdMap.get(st.payeeId)) || null;
    let transferAccountId = st.targetAccountId ? ctx.accountIdMap.get(st.targetAccountId) || null : null;

    if (st.payeeId && st.payeeId.startsWith("Payee/Transfer:")) {
      const targetId = st.payeeId.split(":")[1];
      const foundTarget = targetId ? ctx.accountIdMap.get(targetId) : null;
      if (foundTarget) {
        transferAccountId = foundTarget;
        payee = "Transfer : " + (ctx.accNameMap.get(foundTarget) || "Unknown");
        recurringPayeeId = null;
      }
    }
    if (transferAccountId === accId) {
      transferAccountId = null;
    }

    const accIsOnBudget = ctx.accOnBudgetMap.get(st.accountId) ?? true;
    let catId = (accIsOnBudget && ctx.categoryIdMap.get(st.categoryId)) || null;
    if (
      st.categoryId === "Category/__ImmediateIncome__" ||
      st.categoryId === "Category/__DeferredIncome__" ||
      st.categoryId === "Category/__Split__"
    ) {
      catId = null;
    }

    const rawSubs = (st.subTransactions || []).filter((sub: any) => !sub.isTombstone);
    // G-06: import every live leg verbatim, including 0-amount legs
    // (they are valid YNAB4 rows) — mirroring register splits. The
    // split structure survives whenever 2+ live children exist; only
    // exactly one live child collapses to a plain recurring row.
    const hasSubs = rawSubs.length >= 2;

    let parentAmount = ctx.convertAmount(st.amount);
    // G-split: an unbalanced scheduled split keeps the file parent and
    // gains an auto-balance filler leg (the same repair register splits
    // use above) instead of silently rebasing the parent to the children
    // sum. The repair only counts once the row actually imports — a
    // zero-amount parent is still skipped below.
    let scheduledFiller: { amount: number; memo?: string | null } | null = null;
    if (hasSubs) {
      catId = null;
      transferAccountId = null;
      const repair = repairSplitForImport(
        parentAmount,
        rawSubs.map((sub: any) => ({ amount: ctx.convertAmount(sub.amount) }))
      );
      parentAmount = repair.parentAmount;
      if (repair.repaired) {
        scheduledFiller = repair.children[repair.children.length - 1]!;
      }
    } else if (rawSubs.length === 1) {
      // A single child is not a valid split; collapse to a regular recurring transaction
      ctx.collapsedSingleChildSplits++;
      const single = rawSubs[0]!;
      parentAmount = ctx.convertAmount(single.amount);
      catId = (accIsOnBudget && ctx.categoryIdMap.get(single.categoryId)) || null;
      if (
        single.categoryId === "Category/__ImmediateIncome__" ||
        single.categoryId === "Category/__DeferredIncome__" ||
        single.categoryId === "Category/__Split__"
      ) {
        catId = null;
      }
      if (single.targetAccountId) {
        transferAccountId = ctx.accountIdMap.get(single.targetAccountId) || null;
      } else if (single.payeeId && single.payeeId.startsWith("Payee/Transfer:")) {
        const tid = single.payeeId.split(":")[1];
        transferAccountId = tid ? ctx.accountIdMap.get(tid) || null : null;
      }
      if (transferAccountId === accId) {
        transferAccountId = null;
      }
    }

    if (parentAmount === 0) {
      ctx.skippedDuplicates.push({
        accountName: ctx.accNameMap.get(accId) || "",
        date: st.date,
        payee,
        memo: st.memo || "",
        amount: 0,
        reason: "Zero-amount scheduled transaction",
      });
      continue;
    }
    if (scheduledFiller) {
      ctx.splitRepairedCount++;
    }

    if (transferAccountId != null) {
      const destAccEntity = st.targetAccountId || (st.payeeId?.startsWith("Payee/Transfer:") ? st.payeeId.split(":")[1] : "");
      const destIsOnBudget = destAccEntity ? (ctx.accOnBudgetMap.get(destAccEntity) ?? false) : (ctx.allAccounts.find((a) => a.id === transferAccountId)?.onBudget ?? false);
      const isCross = accIsOnBudget !== destIsOnBudget;
      const netOnBudget = (accIsOnBudget ? parentAmount : 0) + (destIsOnBudget ? -parentAmount : 0);
      if (isCross) {
        if (netOnBudget < 0 && catId === null) {
          catId = await getOrCreateFallbackTransferCategory(db, ctx);
        }
      } else {
        catId = null;
      }
    }

    const rawFreq = (st.frequency || "monthly").toLowerCase().replace(/[\s_-]+/g, "");
    let frequency = rawFreq;
    if (rawFreq === "everyotherweek" || rawFreq === "biweekly") frequency = "biweekly";
    else if (rawFreq === "semimonthly" || rawFreq === "twiceamonth") frequency = "twiceamonth";
    else if (rawFreq === "everyothermonth" || rawFreq === "bimonthly") frequency = "everyothermonth";
    else if (rawFreq === "quarterly" || rawFreq === "every3months") frequency = "every3months";
    else if (rawFreq === "semiannually" || rawFreq === "twiceayear") frequency = "twiceayear";
    else if (rawFreq === "annually" || rawFreq === "yearly") frequency = "yearly";
    else if (rawFreq === "everyotheryear" || rawFreq === "every2years") frequency = "every2years";
    else if (rawFreq === "never" || rawFreq === "once") frequency = "never";
    const validFrequencies = [
      "daily",
      "weekly",
      "biweekly",
      "everyotherweek",
      "twiceamonth",
      "semimonthly",
      "every4weeks",
      "monthly",
      "everyothermonth",
      "bimonthly",
      "every3months",
      "quarterly",
      "every4months",
      "twiceayear",
      "semiannually",
      "yearly",
      "annually",
      "every2years",
      "everyotheryear",
      "once",
      "never",
    ];
    if (!validFrequencies.includes(frequency)) {
      ctx.unknownFrequencies.set(st.frequency ?? "", (ctx.unknownFrequencies.get(st.frequency ?? "") ?? 0) + 1);
      frequency = "monthly";
    }

    const active = st.active !== undefined ? Boolean(st.active) : true;
    const parsedAnchor =
      typeof st.anchorDay === "number" && !isNaN(st.anchorDay) && st.anchorDay >= 1 && st.anchorDay <= 31
        ? Math.floor(st.anchorDay)
        : st.date && /^\d{4}-\d{2}-\d{2}$/.test(st.date)
        ? parseInt(st.date.slice(8, 10), 10)
        : 1;
    const anchorDay = Math.min(31, Math.max(1, parsedAnchor));
    // G-08: YNAB4 `twiceAMonthStartDay` (`ScheduledTransactionVO`) —
    // the second leg of twice-a-month schedules. Stored whenever it
    // is a plausible day-of-month; YNAB4 defaults the int to 0 when
    // unset, which we normalize to null.
    const parsedSecondAnchor =
      typeof st.twiceAMonthStartDay === "number" &&
      !isNaN(st.twiceAMonthStartDay) &&
      st.twiceAMonthStartDay >= 1 &&
      st.twiceAMonthStartDay <= 31
        ? Math.floor(st.twiceAMonthStartDay)
        : null;

    const [insertedR] = await db
      .insert(recurring)
      .values({
        entityId: st.entityId,
        accountId: accId,
        categoryId: catId,
        payee,
        payeeId: recurringPayeeId,
        memo: st.memo || "",
        flagColor: ynabFlagToColor(st.flag),
        amount: parentAmount,
        frequency,
        nextDate: st.date,
        anchorDay,
        secondAnchorDay: parsedSecondAnchor,
        active,
        transferAccountId,
      })
      .returning();

    if (hasSubs && insertedR) {
      let sort = 0;
      for (const sub of rawSubs) {
        let subCatId = (accIsOnBudget && ctx.categoryIdMap.get(sub.categoryId)) || null;
        if (
          sub.categoryId === "Category/__ImmediateIncome__" ||
          sub.categoryId === "Category/__DeferredIncome__" ||
          sub.categoryId === "Category/__Split__"
        ) {
          subCatId = null;
        }

        let subTransferAccountId: number | null = sub.targetAccountId
          ? ctx.accountIdMap.get(sub.targetAccountId) || null
          : null;
        if (sub.payeeId && sub.payeeId.startsWith("Payee/Transfer:")) {
          const targetId = sub.payeeId.split(":")[1];
          const foundTarget = targetId ? ctx.accountIdMap.get(targetId) : null;
          if (foundTarget) {
            subTransferAccountId = foundTarget;
          }
        }
        if (subTransferAccountId === accId) {
          subTransferAccountId = null;
        }

        const childAmt = ctx.convertAmount(sub.amount);
        if (subTransferAccountId != null) {
          const destAccEntity = sub.targetAccountId || (sub.payeeId?.startsWith("Payee/Transfer:") ? sub.payeeId.split(":")[1] : "");
          const destIsOnBudget = destAccEntity ? (ctx.accOnBudgetMap.get(destAccEntity) ?? false) : (ctx.allAccounts.find((a) => a.id === subTransferAccountId)?.onBudget ?? false);
          const isCross = accIsOnBudget !== destIsOnBudget;
          const netOnBudget = (accIsOnBudget ? childAmt : 0) + (destIsOnBudget ? -childAmt : 0);
          if (isCross) {
            if (netOnBudget < 0 && subCatId === null) {
              subCatId = await getOrCreateFallbackTransferCategory(db, ctx);
            }
          } else {
            subCatId = null;
          }
        }

        await db.insert(recurringSubTransactions).values({
          entityId: sub.entityId,
          recurringId: insertedR.id,
          categoryId: subCatId,
          amount: childAmt,
          memo: sub.memo || "",
          sort: sort++,
          transferAccountId: subTransferAccountId,
        });
      }
      // G-split: append the repair filler leg (if any) YNAB4-style. It
      // is synthetic, so it never claims reconciled precision — scheduled
      // children carry no cleared state at all — and it opts out of
      // nothing here (scheduled rows have no reconciliation upgrade).
      if (scheduledFiller) {
        await db.insert(recurringSubTransactions).values({
          recurringId: insertedR.id,
          categoryId: null,
          amount: scheduledFiller.amount,
          memo: typeof scheduledFiller.memo === "string" ? scheduledFiller.memo : "",
          sort: sort++,
          transferAccountId: null,
        });
      }
    }
  }
}
