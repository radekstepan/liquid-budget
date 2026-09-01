import AdmZip from "adm-zip";
import { asc } from "drizzle-orm";
import { computeBudget, getMonthsWithData, todayISO } from "@ynab/logic";
import type { Db } from "./client.js";
import { accounts, assignments, categoryGroups, categories, payees, reconciliations, recurring, recurringSubTransactions, transactions } from "./schema.js";
import { getBudgetData } from "./queries/budget.js";

const FLAG_NAMES: Record<string, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
};

function flagToName(flag: string | null | undefined): string | null {
  if (!flag) return null;
  return FLAG_NAMES[flag.toLowerCase()] ?? null;
}

function escapeXml(str: string | null | undefined): string {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function statusToCleared(status: string | null | undefined): string {
  switch (status) {
    case "r":
      return "Reconciled";
    case "u":
      return "Uncleared";
    case "c":
    default:
      return "Cleared";
  }
}

function formatFrequency(freq: string | null | undefined): string {
  if (!freq) return "Monthly";
  const f = freq.toLowerCase().replace(/[\s_-]+/g, "");
  switch (f) {
    case "never":
    case "once":
      return "Never";
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "biweekly":
    case "everyotherweek":
      return "EveryOtherWeek";
    case "twiceamonth":
    case "semimonthly":
      return "TwiceAMonth";
    case "every4weeks":
      return "Every4Weeks";
    case "monthly":
      return "Monthly";
    case "everyothermonth":
    case "bimonthly":
      return "EveryOtherMonth";
    case "every3months":
    case "quarterly":
      return "Every3Months";
    case "every4months":
      return "Every4Months";
    case "twiceayear":
    case "semiannually":
      return "TwiceAYear";
    case "yearly":
    case "annually":
      return "Yearly";
    case "every2years":
    case "everyotheryear":
      return "Every2Years";
    default:
      return "Monthly";
  }
}

export interface ExportYnab4Options {
  budgetName?: string;
  currencySymbol?: string;
  currencyISOSymbol?: string;
  decimalSeparator?: string;
  groupSeparator?: string;
  dateFormat?: string;
}

export async function exportYnab4(
  db: Db,
  options?: ExportYnab4Options
): Promise<{ ynabData: any; settingsXml: string }> {
  const [
    allAccounts,
    allGroups,
    allCategories,
    allAssignments,
    allTransactions,
    allRecurring,
    allRecurringSubs,
    allReconciliations,
    allPayees,
    budgetData,
  ] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.sort), asc(accounts.id)),
    db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort), asc(categoryGroups.id)),
    db.select().from(categories).orderBy(asc(categories.sort), asc(categories.id)),
    db.select().from(assignments),
    db.select().from(transactions).orderBy(asc(transactions.date), asc(transactions.id)),
    db.select().from(recurring).orderBy(asc(recurring.nextDate), asc(recurring.id)),
    db.select().from(recurringSubTransactions).orderBy(asc(recurringSubTransactions.sort), asc(recurringSubTransactions.id)),
    db.select().from(reconciliations).orderBy(asc(reconciliations.id)),
    db.select().from(payees),
    getBudgetData(db),
  ]);

  const allMonths = getMonthsWithData(budgetData);
  const currentMonth = todayISO().slice(0, 7);
  const targetMonth = allMonths.length > 0
    ? (allMonths.includes(currentMonth) ? currentMonth : allMonths[allMonths.length - 1]!)
    : currentMonth;

  const budgetResult = computeBudget(budgetData, targetMonth);
  const availableByCatId = new Map<number, number>();
  for (const g of budgetResult.groups) {
    for (const r of g.rows) {
      availableByCatId.set(r.category.id, r.available);
    }
  }

  const categoryMap = new Map<number, typeof allCategories[number]>();
  for (const c of allCategories) {
    categoryMap.set(c.id, c);
  }

  const getAccountEntityId = (accountId: number | null | undefined): string => {
    if (accountId == null) return "";
    const acc = allAccounts.find((a) => a.id === accountId);
    return acc?.entityId || `acc-${accountId}`;
  };

  const getCategoryEntityId = (categoryId: number | null | undefined): string | null => {
    if (categoryId == null) return null;
    const cat = categoryMap.get(categoryId);
    return cat?.entityId || `sc-${categoryId}`;
  };

  const getReconciliationEntityId = (recId: number | null | undefined): string | null => {
    if (recId == null) return null;
    const rec = allReconciliations.find((r) => r.id === recId);
    return rec?.entityId || `rec-${recId}`;
  };

  const getTransactionEntityId = (txId: number | null | undefined): string | null => {
    if (txId == null) return null;
    const t = allTransactions.find((tx) => tx.id === txId);
    return t?.entityId || `tx-${txId}`;
  };

  // 1. Budget Metadata
  const budgetMetaData = {
    currencyLocale: "en_US",
    dateLocale: "en_US",
    strictBudget: "TRUE",
    budgetType: "Personal",
    entityId: "budget-metadata",
    entityType: "budgetMetaData",
    currencyISOSymbol: options?.currencyISOSymbol ?? "USD",
  };

  // 2. Accounts
  const yAccounts = allAccounts.map((a) => {
    let accountType = "Checking";
    if (a.kind === "credit") {
      accountType = "CreditCard";
    } else if (a.kind === "offbudget") {
      accountType = "InvestmentAccount";
    }

    return {
      entityId: a.entityId || `acc-${a.id}`,
      accountName: a.name,
      accountType,
      onBudget: Boolean(a.onBudget),
      sortableIndex: (a.sort ?? 0) * 1000,
      lastReconciledDate: a.lastReconciledAt || null,
      lastReconciledBalance: a.lastReconciledBalance != null ? Math.round(a.lastReconciledBalance * 10) : null,
      hidden: Boolean(a.archived),
      isClosed: Boolean(a.archived),
      isTombstone: false,
      entityType: "account",
      entityVersion: `acc-v-${a.id}`,
    };
  });

  // 3. Payees
  const payeeMap = new Map<string, { entityId: string; name: string; targetAccountId?: string; entityType: string; enabled: boolean }>();

  // Add transfer payees for every account
  for (const a of allAccounts) {
    const accEntityId = a.entityId || `acc-${a.id}`;
    const transferEntityId = `Payee/Transfer:${accEntityId}`;
    payeeMap.set(transferEntityId, {
      entityId: transferEntityId,
      name: `Transfer : ${a.name}`,
      targetAccountId: accEntityId,
      entityType: "payee",
      enabled: true,
    });
  }

  const getOrCreatePayeeId = (name: string | null | undefined): string | undefined => {
    if (!name || !name.trim()) return undefined;
    const trimmed = name.trim();
    if (trimmed.startsWith("Transfer : ")) {
      // Transfer payee matching account name
      const targetAccName = trimmed.replace("Transfer : ", "").trim();
      const matchAcc = allAccounts.find((a) => a.name.toLowerCase() === targetAccName.toLowerCase());
      if (matchAcc) {
        const accEntId = matchAcc.entityId || `acc-${matchAcc.id}`;
        return `Payee/Transfer:${accEntId}`;
      }
    }
    const matchPayee = allPayees.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    const entityId = matchPayee?.entityId || `payee-${trimmed.toLowerCase()}`;
    if (!payeeMap.has(entityId)) {
      payeeMap.set(entityId, {
        entityId,
        name: trimmed,
        entityType: "payee",
        enabled: true,
      });
    }
    return entityId;
  };

  // 4. Master Categories & Subcategories
  const categoriesByGroup = new Map<number, (typeof allCategories[number])[]>();
  for (const c of allCategories) {
    const list = categoriesByGroup.get(c.groupId) ?? [];
    list.push(c);
    categoriesByGroup.set(c.groupId, list);
  }

  const yMasterCategories = allGroups.map((g) => {
    const groupCats = categoriesByGroup.get(g.id) ?? [];
    const isHidden = Boolean(g.isHidden || g.name.toLowerCase() === "hidden categories");
    const entityId = isHidden
      ? "MasterCategory/__Hidden__"
      : g.isCreditCardPayments
      ? "MasterCategory/CreditCardPayments"
      : (g.entityId || `mc-${g.id}`);
    return {
      entityId,
      name: g.name,
      type: "OUTFLOW",
      sortableIndex: (g.sort ?? 0) * 1000,
      isCreditCardPayments: Boolean(g.isCreditCardPayments),
      entityType: "masterCategory",
      entityVersion: `mc-v-${g.id}`,
      subCategories: groupCats.map((c) => {
        const linkedAccEntityId = c.linkedAccountId ? getAccountEntityId(c.linkedAccountId) : undefined;
        return {
          entityId: c.entityId || `sc-${c.id}`,
          masterCategoryId: entityId,
          name: c.name,
          sortableIndex: (c.sort ?? 0) * 1000,
          type: "OUTFLOW",
          overspendingHandling: c.overspendCarriesOver ? "OverspendCarriedForward" : "Confined",
          cachedBalance: Math.round((availableByCatId.get(c.id) ?? c.carryover ?? 0) * 10),
          carryover: Math.round((c.carryover ?? 0) * 10),
          accountId: linkedAccEntityId,
          entityType: "subCategory",
          entityVersion: `sc-v-${c.id}`,
        };
      }),
    };
  });

  // Also include standard Income master category
  yMasterCategories.push({
    entityId: "MasterCategory/__Income__",
    name: "Income",
    type: "INFLOW",
    sortableIndex: 999999,
    isCreditCardPayments: false,
    entityType: "masterCategory",
    entityVersion: "mc-income",
    subCategories: [],
  });

  // 5. Monthly Budgets & Assignments
  const assignmentsByMonth = new Map<string, (typeof allAssignments[number])[]>();
  for (const a of allAssignments) {
    const monthKey = a.month;
    const list = assignmentsByMonth.get(monthKey) ?? [];
    list.push(a);
    assignmentsByMonth.set(monthKey, list);
  }

  const yMonthlyBudgets = Array.from(assignmentsByMonth.entries()).map(([month, assigns]) => {
    return {
      entityId: `MB/${month}`,
      month: `${month}-01`,
      entityType: "monthlyBudget",
      entityVersion: `mb-v-${month}`,
      monthlySubCategoryBudgets: assigns.map((a) => {
        const cat = categoryMap.get(a.categoryId);
        const catEntityId = cat?.entityId || `sc-${a.categoryId}`;
        return {
          entityId: `MCB/${month}/${catEntityId}`,
          parentMonthlyBudgetId: `MB/${month}`,
          categoryId: catEntityId,
          budgeted: Math.round(a.amount * 10),
          overspendingHandling: cat?.overspendCarriesOver ? "OverspendCarriedForward" : "Confined",
          entityType: "monthlyCategoryBudget",
          entityVersion: `mcb-v-${month}-${a.categoryId}`,
        };
      }),
    };
  });

  // 6. Transactions
  const childrenByParent = new Map<number, (typeof allTransactions[number])[]>();
  const parentTransactions: (typeof allTransactions[number])[] = [];

  for (const t of allTransactions) {
    if (t.parentId != null) {
      const list = childrenByParent.get(t.parentId) ?? [];
      list.push(t);
      childrenByParent.set(t.parentId, list);
    } else {
      parentTransactions.push(t);
    }
  }

  const yTransactions: any[] = [];

  for (const t of parentTransactions) {
    const children = childrenByParent.get(t.id);

    if (children && children.length > 0) {
      // Split Transaction
      const parentTxEntityId = t.entityId || `tx-${t.id}`;
      const parentAccEntityId = getAccountEntityId(t.accountId);
      const parentRecId = getReconciliationEntityId(t.reconciliationId);
      const payeeId = getOrCreatePayeeId(t.payee);
      const isParentDeferred = t.incomeMonth && t.date ? t.incomeMonth > t.date.slice(0, 7) : false;
      const parentCatId = t.isIncome
        ? isParentDeferred
          ? "Category/__DeferredIncome__"
          : "Category/__ImmediateIncome__"
        : "Category/__Split__";

      const subTransactions = children.map((ch) => {
        const childTxEntityId = ch.entityId || `st-${ch.id}`;
        let subTargetAccId: string | undefined = undefined;
        let subTransferPayeeId: string | undefined = undefined;
        let subTransferTxId: string | undefined = undefined;
        let subCatId: string | null = null;

        if (ch.categoryId != null) {
          subCatId = getCategoryEntityId(ch.categoryId);
        } else if (ch.isIncome) {
          const isChildDeferred = ch.incomeMonth && t.date ? ch.incomeMonth > t.date.slice(0, 7) : false;
          subCatId = isChildDeferred ? "Category/__DeferredIncome__" : "Category/__ImmediateIncome__";
        }

        if (ch.transferAccountId != null) {
          const destAccEntityId = getAccountEntityId(ch.transferAccountId);
          const counterpartTxEntityId = ch.transferEntityId || `tx-split-transfer-${ch.id}-dest`;

          subTargetAccId = destAccEntityId;
          subTransferPayeeId = `Payee/Transfer:${destAccEntityId}`;
          subTransferTxId = counterpartTxEntityId;

          const destClearedStatus = ch.transferStatus ?? ch.status ?? t.status;
          const destRecId = getReconciliationEntityId(
            ch.transferReconciliationId || ch.reconciliationId || t.transferReconciliationId || t.reconciliationId
          );
          const destRecDate = ch.transferReconciledAt || ch.reconciledAt || t.transferReconciledAt || t.reconciledAt || null;

          // Generate counterpart on destination account
          yTransactions.push({
            entityId: counterpartTxEntityId,
            accountId: destAccEntityId,
            targetAccountId: parentAccEntityId,
            date: t.date,
            amount: Math.round(-ch.amount * 10),
            cleared: statusToCleared(destClearedStatus),
            flag: flagToName(ch.flagColor),
            memo: ch.memo || "",
            payeeId: `Payee/Transfer:${parentAccEntityId}`,
            transferTransactionId: childTxEntityId,
            categoryId: null,
            reconciliationId: destRecId,
            reconciledAt: destRecDate,
            accepted: true,
            entityType: "transaction",
            entityVersion: `tx-v-${ch.id}-dest`,
          });
        }

        const childPayeeId = ch.payee ? getOrCreatePayeeId(ch.payee) : undefined;
        const childRecId = getReconciliationEntityId(ch.reconciliationId || t.reconciliationId);

        return {
          entityId: childTxEntityId,
          parentTransactionId: parentTxEntityId,
          amount: Math.round(ch.amount * 10),
          memo: ch.memo || "",
          categoryId: subCatId,
          targetAccountId: subTargetAccId,
          payeeId: subTransferPayeeId || childPayeeId || payeeId,
          transferTransactionId: subTransferTxId,
          flag: flagToName(ch.flagColor),
          reconciliationId: childRecId,
          reconciledAt: ch.reconciledAt || t.reconciledAt || null,
          entityType: "subTransaction",
          entityVersion: `st-v-${ch.id}`,
          incomeMonth: ch.incomeMonth || null,
        };
      });

      yTransactions.push({
        entityId: parentTxEntityId,
        accountId: parentAccEntityId,
        date: t.date,
        amount: Math.round(t.amount * 10),
        cleared: statusToCleared(t.status),
        flag: flagToName(t.flagColor),
        memo: t.memo || "",
        payeeId,
        categoryId: parentCatId,
        subTransactions,
        reconciliationId: parentRecId,
        reconciledAt: t.reconciledAt || null,
        accepted: true,
        entityType: "transaction",
        entityVersion: `tx-v-${t.id}`,
        incomeMonth: t.incomeMonth || null,
      });
    } else if (t.transferAccountId != null) {
      // Transfer Pair
      const sourceAcc = allAccounts.find((a) => a.id === t.accountId);
      const destAcc = allAccounts.find((a) => a.id === t.transferAccountId);
      const sourceAccEntityId = getAccountEntityId(t.accountId);
      const destAccEntityId = getAccountEntityId(t.transferAccountId);
      const srcTxEntityId = t.entityId || `tx-${t.id}-src`;
      const destTxEntityId = t.transferEntityId || `tx-${t.id}-dest`;

      let transferCatId: string | null = null;
      if (t.categoryId != null) {
        transferCatId = getCategoryEntityId(t.categoryId);
      } else if (t.isIncome) {
        const isTxDeferred = t.incomeMonth && t.date ? t.incomeMonth > t.date.slice(0, 7) : false;
        transferCatId = isTxDeferred ? "Category/__DeferredIncome__" : "Category/__ImmediateIncome__";
      }

      // For cross-boundary transfers, assign the category to the on-budget leg
      const srcCatId = sourceAcc?.onBudget ? transferCatId : (!destAcc?.onBudget ? transferCatId : null);
      const destCatId = destAcc?.onBudget && !sourceAcc?.onBudget ? transferCatId : null;
      const recId = getReconciliationEntityId(t.reconciliationId);
      const destRecId = getReconciliationEntityId(t.transferReconciliationId);

      // Source transaction
      yTransactions.push({
        entityId: srcTxEntityId,
        accountId: sourceAccEntityId,
        targetAccountId: destAccEntityId,
        date: t.date,
        amount: Math.round(t.amount * 10),
        cleared: statusToCleared(t.status),
        flag: flagToName(t.flagColor),
        memo: t.memo || "",
        payeeId: `Payee/Transfer:${destAccEntityId}`,
        transferTransactionId: destTxEntityId,
        categoryId: srcCatId,
        reconciliationId: recId,
        reconciledAt: t.reconciledAt || null,
        accepted: true,
        entityType: "transaction",
        entityVersion: `tx-v-${t.id}-src`,
        incomeMonth: t.incomeMonth || null,
      });

      // Destination counterpart transaction
      yTransactions.push({
        entityId: destTxEntityId,
        accountId: destAccEntityId,
        targetAccountId: sourceAccEntityId,
        date: t.date,
        amount: Math.round(-t.amount * 10),
        cleared: statusToCleared(t.transferStatus ?? t.status),
        flag: flagToName(t.flagColor),
        memo: t.memo || "",
        payeeId: `Payee/Transfer:${sourceAccEntityId}`,
        transferTransactionId: srcTxEntityId,
        categoryId: destCatId,
        reconciliationId: destRecId,
        reconciledAt: t.transferReconciledAt || null,
        accepted: true,
        entityType: "transaction",
        entityVersion: `tx-v-${t.id}-dest`,
        incomeMonth: t.incomeMonth || null,
      });
    } else {
      // Standard regular transaction
      const payeeId = getOrCreatePayeeId(t.payee);
      const isTxDeferred = t.incomeMonth && t.date ? t.incomeMonth > t.date.slice(0, 7) : false;
      const catId = t.isIncome
        ? isTxDeferred
          ? "Category/__DeferredIncome__"
          : "Category/__ImmediateIncome__"
        : t.categoryId != null
        ? getCategoryEntityId(t.categoryId)
        : null;
      const recId = getReconciliationEntityId(t.reconciliationId);
      const accEntityId = getAccountEntityId(t.accountId);
      const txEntityId = t.entityId || `tx-${t.id}`;

      yTransactions.push({
        entityId: txEntityId,
        accountId: accEntityId,
        date: t.date,
        amount: Math.round(t.amount * 10),
        cleared: statusToCleared(t.status),
        flag: flagToName(t.flagColor),
        memo: t.memo || "",
        payeeId,
        categoryId: catId,
        reconciliationId: recId,
        reconciledAt: t.reconciledAt || null,
        accepted: true,
        entityType: "transaction",
        entityVersion: `tx-v-${t.id}`,
        incomeMonth: t.incomeMonth || null,
      });
    }
  }

  // 7. Scheduled Transactions
  const subsByRecurringId = new Map<number, (typeof allRecurringSubs[number])[]>();
  for (const s of allRecurringSubs) {
    const list = subsByRecurringId.get(s.recurringId) ?? [];
    list.push(s);
    subsByRecurringId.set(s.recurringId, list);
  }

  const yScheduledTransactions = allRecurring.map((r) => {
    const subs = subsByRecurringId.get(r.id) ?? [];
    const hasSubs = subs.length > 0;
    const schedEntityId = r.entityId || `sched-${r.id}`;
    const schedAccEntityId = getAccountEntityId(r.accountId);
    const schedTargetAccEntityId = r.transferAccountId != null ? getAccountEntityId(r.transferAccountId) : undefined;
    const schedCatEntityId = r.categoryId != null ? getCategoryEntityId(r.categoryId) : null;

    let catId: string | null = null;
    let targetAccId: string | undefined = undefined;
    let payeeId: string | undefined = undefined;

    if (hasSubs) {
      catId = "Category/__Split__";
      payeeId = schedTargetAccEntityId
        ? `Payee/Transfer:${schedTargetAccEntityId}`
        : getOrCreatePayeeId(r.payee);
    } else if (schedTargetAccEntityId) {
      targetAccId = schedTargetAccEntityId;
      payeeId = `Payee/Transfer:${schedTargetAccEntityId}`;
      catId = null;
    } else {
      catId = schedCatEntityId;
      payeeId = getOrCreatePayeeId(r.payee);
    }

    const subTransactions = hasSubs
      ? subs.map((s) => {
          const subTargetAccEntityId = s.transferAccountId != null ? getAccountEntityId(s.transferAccountId) : undefined;
          const subCatEntityId = s.categoryId != null ? getCategoryEntityId(s.categoryId) : null;

          return {
            entityId: s.entityId || `st-sched-${s.id}`,
            parentTransactionId: schedEntityId,
            amount: Math.round(s.amount * 10),
            memo: s.memo || "",
            categoryId:
              subTargetAccEntityId != null
                ? null
                : subCatEntityId != null
                ? subCatEntityId
                : s.amount > 0
                ? "Category/__ImmediateIncome__"
                : null,
            targetAccountId: subTargetAccEntityId,
            payeeId: subTargetAccEntityId != null ? `Payee/Transfer:${subTargetAccEntityId}` : undefined,
            entityType: "subTransaction",
            entityVersion: `st-sched-v-${s.id}`,
          };
        })
      : [];

    return {
      entityId: schedEntityId,
      accountId: schedAccEntityId,
      date: r.nextDate,
      amount: Math.round(r.amount * 10),
      frequency: formatFrequency(r.frequency),
      payeeId,
      targetAccountId: targetAccId,
      categoryId: catId,
      memo: r.memo || "",
      flag: flagToName(r.flagColor),
      cleared: "Uncleared",
      accepted: true,
      isTombstone: false,
      active: Boolean(r.active),
      anchorDay: r.anchorDay ?? null,
      entityType: "scheduledTransaction",
      entityVersion: `sched-v-${r.id}`,
      subTransactions,
    };
  });

  const yReconciliations = allReconciliations.map((r) => {
    const recAccEntityId = getAccountEntityId(r.accountId);
    const adjTxEntityId = r.adjustmentTransactionId ? getTransactionEntityId(r.adjustmentTransactionId) : null;

    return {
      entityId: r.entityId || `rec-${r.id}`,
      accountId: recAccEntityId,
      reconciledAt: r.reconciledAt,
      statementDate: r.statementDate,
      statementBalance: Math.round(r.statementBalance * 10),
      adjustmentTransactionId: adjTxEntityId,
      entityType: "reconciliation",
      entityVersion: `rec-v-${r.id}`,
    };
  });

  const ynabData = {
    budgetMetaData,
    accounts: yAccounts,
    payees: Array.from(payeeMap.values()),
    masterCategories: yMasterCategories,
    monthlyBudgets: yMonthlyBudgets,
    transactions: yTransactions,
    scheduledTransactions: yScheduledTransactions,
    reconciliations: yReconciliations,
  };

  const budgetName = options?.budgetName ?? "Budget";
  const currencySymbol = options?.currencySymbol ?? "$";
  const currencyISOSymbol = options?.currencyISOSymbol ?? "USD";
  const decimalSeparator = options?.decimalSeparator ?? ".";
  const groupSeparator = options?.groupSeparator ?? ",";
  const dateFormat = options?.dateFormat ?? "YYYY-MM-DD";

  const settingsXml = `<?xml version="1.0" encoding="utf-8"?>
<com.ynab.dataAccess.settings.MachineBudgetSettingsVO>
  <currencySymbol>${escapeXml(currencySymbol)}</currencySymbol>
  <currencyISOSymbol>${escapeXml(currencyISOSymbol)}</currencyISOSymbol>
  <decimalSeparator>${escapeXml(decimalSeparator)}</decimalSeparator>
  <groupSeparator>${escapeXml(groupSeparator)}</groupSeparator>
  <dateFormat>${escapeXml(dateFormat)}</dateFormat>
  <budgetName>${escapeXml(budgetName)}</budgetName>
</com.ynab.dataAccess.settings.MachineBudgetSettingsVO>
`;

  return { ynabData, settingsXml };
}

export async function exportYnab4Zip(
  db: Db,
  options?: ExportYnab4Options
): Promise<Buffer> {
  const { ynabData, settingsXml } = await exportYnab4(db, options);
  const zip = new AdmZip();

  const jsonStr = JSON.stringify(ynabData, null, 2);
  const dataFileName = "Budget.ynab4";
  const settingsFileName = "budgetSettings.ybsettings";

  zip.addFile(dataFileName, Buffer.from(jsonStr, "utf-8"));
  zip.addFile(settingsFileName, Buffer.from(settingsXml, "utf-8"));

  return zip.toBuffer();
}
