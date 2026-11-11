import type { ImportSkippedEntry } from "@ynab/logic";
import type { Db } from "../client.js";
import type { accounts } from "../schema.js";

export interface Ynab4Settings {
  currencySymbol?: string;
  currencyISOSymbol?: string;
  decimalSeparator?: string;
  groupSeparator?: string;
  dateFormat?: string;
  budgetName?: string;
}

/**
 * Subset of the `.ynab4` JSON root's `budgetMetaData` we persist
 * (G-02). Mirrors YNAB4's `BudgetMetaDataVO` (`budgetType,
 * currencyISOSymbol, currencyLocale, dateLocale, strictBudget`).
 */
export interface Ynab4BudgetMetaData {
  budgetType?: string;
  currencyISOSymbol?: string;
  currencyLocale?: string;
  dateLocale?: string;
  strictBudget?: string;
}

/** Merged budget settings: `.ybsettings` XML + `.ynab4` budgetMetaData. */
export type Ynab4BudgetSettings = Ynab4Settings & Ynab4BudgetMetaData;

export interface ExtractedYnab4Data {
  /** Raw `.ynab4` document: untyped JSON, read only through `./guards.js`. */
  ynabData: unknown;
  settingsXml?: string;
  settings?: Ynab4Settings;
  /**
   * Whitelisted `budgetMetaData` from the `.ynab4` JSON root
   * (G-02). Forwarded to `importYnab4` via options alongside the
   * XML parse so both halves are persisted.
   */
  budgetMetaData?: Ynab4BudgetMetaData;
  /**
   * Non-fatal archive-level notices: an older (but supported)
   * budgetDataVersion, or multi-device `devices/`/`Snapshots/` entries
   * that were not imported. Forward to `importYnab4` via its options
   * so they surface in `ImportSummary.warnings`.
   */
  warnings: string[];
}

/**
 * Per-transaction OFX/check lineage carried by YNAB4 (G-05).
 * `checkNumber` lives on `BaseTransactionVO` (so split children have
 * it too); `FITID`/`YNABID`/`importedPayee`/`source` live on
 * `MatchableTransactionVO` (top-level rows only — split children
 * never carry them, but the extractor tolerates them anyway).
 */
export interface Ynab4TxLineage {
  checkNumber: string | null;
  fitid: string | null;
  ynabId: string | null;
  importedPayee: string | null;
  source: string | null;
}

export interface MangledHiddenName {
  oldMasterName: string;
  subName: string;
  oldMasterEntityId: string | null;
}

export interface ImportYnab4Options {
  /**
   * Archive-level warnings from `extractYnab4DataFromZip` (e.g.
   * `devices/`/`Snapshots/` entries). Merged into
   * `ImportSummary.warnings` alongside version notices.
   */
  warnings?: string[];
  /**
   * `budgetMetaData` parsed from the `.ynab4` JSON root (G-02).
   * Falls back to `ynabData.budgetMetaData` when omitted, so direct
   * programmatic callers that pass the raw document need no changes.
   */
  budgetMetaData?: Ynab4BudgetMetaData;
}

/**
 * Mutable state threaded through the import phases (`./phases/`).
 * Every map/counter the monolithic importer used to close over lives
 * here, so phases stay pure-looking stage functions while warning
 * order and id-map flow match the original exactly.
 */
export type Ynab4ImportContext = {
  db: Db;
  /** Aggregate warnings; phases push in pipeline order. */
  warnings: string[];
  /** Wire-unit (milliunit or decimal-dollar) to integer cents. */
  convertAmount: (v: unknown) => number;
  payeeMap: Map<string, string>;
  payeeDbIdMap: Map<string, number>;
  accountIdMap: Map<string, number>;
  accOnBudgetMap: Map<string, boolean>;
  accKindMap: Map<string, string>;
  reconciliationIdMap: Map<string, number>;
  reconciliationDateMap: Map<string, string>;
  accountReconciliationIdMap: Map<string, number>;
  accountReconciliationDateMap: Map<string, string>;
  confinedByCategoryEntityId: Map<string, boolean>;
  categoryIdMap: Map<string, number>;
  groupSort: number;
  ccGroupId: number | null;
  accNameMap: Map<number, string>;
  allAccounts: (typeof accounts.$inferSelect)[];
  fallbackTransferCategoryId: number | null;
  subTxById: Map<string, { parent: unknown; sub: unknown }>;
  txById: Map<string, unknown>;
  processedTransferIds: Set<string>;
  totalImportedTxCount: number;
  legacyIncomeSentinelCount: number;
  legacyIncomeSentinelKinds: Set<string>;
  splitRepairedCount: number;
  plainFingerprints: Set<string>;
  skippedDuplicates: ImportSkippedEntry[];
  unknownFrequencies: Map<string, number>;
  collapsedSingleChildSplits: number;
};
