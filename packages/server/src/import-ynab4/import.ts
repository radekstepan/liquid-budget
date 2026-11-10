import { dollarsToCents, type ImportSummary } from "@ynab/logic";
import type { Db } from "../client.js";
import { withTransaction } from "../transaction.js";
import { resetDatabase } from "../seed.js";
import { setSettings } from "../settings.js";
import { detectMilliunitScale } from "./amounts.js";
import { assertYnab4BudgetDataVersion, collectYnab4VersionWarnings } from "./versions.js";
import { parseYnab4BudgetMetaData, parseYnab4SettingsXml } from "./settings-xml.js";
import { incomeSentinelOffset } from "./sentinels.js";
import type {
  ImportYnab4Options,
  Ynab4BudgetSettings,
  Ynab4ImportContext,
  Ynab4Settings,
} from "./types.js";
import { importAccounts } from "./phases/accounts.js";
import { recomputeBalancesAndCcCarryover } from "./phases/balances.js";
import { importBudgets } from "./phases/budgets.js";
import { importCategories } from "./phases/categories.js";
import { reportDroppedOfxMappings } from "./phases/ofx.js";
import {
  backfillPayeeDefaults,
  importPayeeRenameConditions,
  importPayees,
} from "./phases/payees.js";
import { importScheduled } from "./phases/scheduled.js";
import { importTransactions } from "./phases/transactions.js";
import { extractYnab4DataFromZip } from "./archive.js";

/**
 * Thin entry point for upload routes: archive bytes in, import summary out.
 * Owns zip extraction (incl. size caps) so routes stay to
 * `getDefaultDb() + importYnab4FromArchive() + Response`.
 */
export async function importYnab4FromArchive(db: Db, archive: Buffer | ArrayBuffer) {
  const { ynabData, settingsXml, warnings, budgetMetaData } = extractYnab4DataFromZip(archive);
  return importYnab4(db, ynabData, settingsXml, { warnings, budgetMetaData });
}

export async function importYnab4(
  db: Db,
  ynabData: any,
  settingsXmlOrObj?: string | Ynab4Settings,
  options?: ImportYnab4Options
) {
  return withTransaction(db, async () => {
    // Version gate (G-01): versioned data older than 2.6 is rejected
    // before the wipe, so a failed import never destroys the ledger.
    // A missing version is tolerated here for programmatic callers;
    // the zip boundary (extractYnab4DataFromZip) already rejects it.
    const rawVersion = ynabData?.fileMetaData?.budgetDataVersion;
    if (rawVersion !== undefined && rawVersion !== null) {
      assertYnab4BudgetDataVersion(ynabData);
    }
    // Archive-level warnings forwarded from extraction plus our own
    // version notice, deduplicated so the zip→import path never
    // reports the same notice twice.
    const seenWarnings = new Set<string>();
    const warnings = [...(options?.warnings ?? []), ...collectYnab4VersionWarnings(ynabData)].filter(
      (w) => {
        if (seenWarnings.has(w)) return false;
        seenWarnings.add(w);
        return true;
      }
    );

    // Detect amount scale: stock YNAB4 backups use milliunits (×1000),
    // but decimal-dollar conversions also exist. See BUG-01.
    const isMilliunit = detectMilliunitScale(ynabData);
    const convertAmount = (v: unknown): number =>
      isMilliunit
        ? Math.round(Number(v ?? 0) / 10)
        : dollarsToCents(v as string | number | null | undefined);

    // 1. Wipe current data
    await resetDatabase(db, true);

    const yAccounts = ynabData.accounts || [];
    const yPayees = ynabData.payees || [];
    const yMasterCategories = ynabData.masterCategories || [];
    const yScheduled = ynabData.scheduledTransactions || [];
    const yBudgets = ynabData.monthlyBudgets || [];

    const ctx: Ynab4ImportContext = {
      db,
      warnings,
      convertAmount,
      payeeMap: new Map<string, string>(),
      payeeDbIdMap: new Map<string, number>(),
      accountIdMap: new Map<string, number>(),
      accOnBudgetMap: new Map<string, boolean>(),
      accKindMap: new Map<string, string>(),
      reconciliationIdMap: new Map<string, number>(),
      reconciliationDateMap: new Map<string, string>(),
      accountReconciliationIdMap: new Map<string, number>(),
      accountReconciliationDateMap: new Map<string, string>(),
      confinedByCategoryEntityId: new Map<string, boolean>(),
      categoryIdMap: new Map<string, number>(),
      groupSort: 0,
      ccGroupId: null,
      accNameMap: new Map<number, string>(),
      allAccounts: [],
      fallbackTransferCategoryId: null,
      subTxById: new Map<string, { parent: any; sub: any }>(),
      txById: new Map<string, any>(),
      processedTransferIds: new Set<string>(),
      totalImportedTxCount: 0,
      legacyIncomeSentinelCount: 0,
      legacyIncomeSentinelKinds: new Set<string>(),
      splitRepairedCount: 0,
      plainFingerprints: new Set<string>(),
      skippedDuplicates: [],
      unknownFrequencies: new Map<string, number>(),
      collapsedSingleChildSplits: 0,
    };

    importPayees(db, yPayees, ctx);
    await importAccounts(db, yAccounts, ynabData.reconciliations || [], ctx);
    await importCategories(db, yMasterCategories, yBudgets, ctx);
    await importBudgets(db, yBudgets, ctx);
    await importTransactions(db, ynabData, ctx);
    await backfillPayeeDefaults(db, yPayees, ctx);
    await importPayeeRenameConditions(db, ynabData, ctx);
    reportDroppedOfxMappings(ynabData, ctx);
    await recomputeBalancesAndCcCarryover(db, ctx);
    await importScheduled(db, yScheduled, ctx);

    for (const [raw, count] of ctx.unknownFrequencies) {
      warnings.push(
        `Unknown scheduled frequency "${raw}" on ${count} schedule(s); falling back to monthly`
      );
    }
    if (ctx.collapsedSingleChildSplits > 0) {
      warnings.push(
        `Collapsed ${ctx.collapsedSingleChildSplits} single-child scheduled split(s) to plain recurring rows (YNAB4 splits need 2+ children)`
      );
    }
    if (ctx.splitRepairedCount > 0) {
      warnings.push(
        `Repaired ${ctx.splitRepairedCount} split transaction(s) whose legs did not sum to the parent amount; an auto-balance leg was added (YNAB4 renders these the same way)`
      );
    }
    if (ctx.legacyIncomeSentinelCount > 0) {
      const kinds = [...ctx.legacyIncomeSentinelKinds]
        .map((k) => `${k} → ${incomeSentinelOffset(k) ?? "unknown"}`)
        .join(", ");
      warnings.push(
        `Mapped ${ctx.legacyIncomeSentinelCount} transaction leg(s) with legacy YNAB4 income categories (${kinds}); treated as that offset's income and preserved verbatim for export`
      );
    }

    const xmlSettings =
      typeof settingsXmlOrObj === "string"
        ? parseYnab4SettingsXml(settingsXmlOrObj)
        : settingsXmlOrObj;
    // G-02: merge the `.ybsettings` half with the `.ynab4`
    // `budgetMetaData` half (explicit option wins, otherwise the
    // document root), then persist both so the exporter can write
    // them back. The document root wins on overlap
    // (`currencyISOSymbol` exists in both halves).
    const budgetMetaData =
      options?.budgetMetaData ?? parseYnab4BudgetMetaData(ynabData?.budgetMetaData);
    const settings: Ynab4BudgetSettings = { ...xmlSettings, ...budgetMetaData };
    // `resetDatabase` above wiped the settings table; rewrite it with
    // only the defined values so a partial document leaves no blanks.
    await setSettings(db, settings);
    // Preserve the historical summary shape: `settings` stays undefined
    // when the backup carried no settings at all.
    const hasSettings = Object.values(settings).some((v) => v !== undefined);

    const result: ImportSummary = {
      accounts: ctx.accountIdMap.size,
      categoryGroups: ctx.groupSort,
      categories: ctx.categoryIdMap.size,
      transactions: ctx.totalImportedTxCount,
      settings: hasSettings ? settings : undefined,
      duplicatesSkipped: ctx.skippedDuplicates,
      warnings,
    };
    return result;
  });
}
