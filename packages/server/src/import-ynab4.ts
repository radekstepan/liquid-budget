import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import AdmZip from "adm-zip";
import {
  classifyBoundaryTransfer,
  dollarsToCents,
  isTransferPayee,
  nextMonthKey,
  todayISO,
  TRANSACTION_DUPLICATE_FLAG,
  type ImportSkippedEntry,
  type ImportSummary,
  type TransactionFlagColor,
} from "@ynab/logic";
import { duplicateFingerprint } from "@ynab/logic";
import type { Db } from "./client.js";
import { withTransaction } from "./transaction.js";
import { accounts, assignments, categoryGroups, categories, payees, reconciliations, recurring, recurringSubTransactions, renameRules, transactions } from "./schema.js";
import { resetDatabase } from "./seed.js";
import { setSettings } from "./settings.js";
import { recomputeAccountBalances } from "./queries/diagnostics.js";
import { findOrCreatePayee } from "./queries/payees.js";

/**
 * Detect whether YNAB4 amounts are stored as milliunits (integer × 1000) or
 * decimal dollars (float). Stock YNAB4 backups encode amounts as milliunits
 * (e.g. -45000 for −$45.00), but exported or converted backups may use decimal
 * dollars (e.g. -45.00 or integer whole dollars like 45).
 *
 * Detection algorithm:
 * 1. If any non-zero amount has a fractional part (e.g., 45.25, 0.5) -> decimal dollars.
 * 2. Analyze all-integer amounts:
 *    - In decimal dollars, everyday purchases are small integers: 1 to 999 (e.g. $5, $15, $45, $120).
 *      In milliunits, these values would represent tiny fractions of a cent ($0.001 to $0.999).
 *    - If there are non-multiple-of-10 values < 1000 (e.g. 15, 25, 45, 12, 1, 2) or if more than
 *      5% of non-zero amounts are < 1000, it is decimal dollars.
 *    - If virtually all (>= 95%) non-zero amounts are >= 1000 (e.g. 1000, 3990, 12500, 45000, 500000),
 *      it is milliunits.
 */
export function detectMilliunitScale(ynabData: any): boolean {
  const amounts: number[] = [];

  const collect = (v: unknown) => {
    if (v == null) return;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n !== 0) amounts.push(n);
  };

  for (const t of ynabData.transactions || []) {
    if (t.isTombstone) continue;
    collect(t.amount);
    for (const st of t.subTransactions || []) {
      if (st.isTombstone) continue;
      collect(st.amount);
    }
  }
  for (const mb of ynabData.monthlyBudgets || []) {
    if (mb.isTombstone) continue;
    for (const msb of mb.monthlySubCategoryBudgets || []) {
      if (msb.isTombstone) continue;
      collect(msb.budgeted);
    }
  }
  for (const st of ynabData.scheduledTransactions || []) {
    if (st.isTombstone) continue;
    collect(st.amount);
    for (const sub of st.subTransactions || []) {
      if (sub.isTombstone) continue;
      collect(sub.amount);
    }
  }
  for (const r of ynabData.reconciliations || []) {
    if (r.isTombstone) continue;
    collect(r.statementBalance);
  }
  for (const acc of ynabData.accounts || []) {
    if (acc.isTombstone) continue;
    collect(acc.lastReconciledBalance);
  }

  if (amounts.length === 0) return false;

  // 1. If any amount has a fractional part → decimal dollars
  for (const a of amounts) {
    if (a % 1 !== 0) return false;
  }

  // 2. All amounts are integers. Analyze distribution of magnitudes.
  let smallCount = 0;
  let smallNonMultipleOf10Count = 0;

  for (const a of amounts) {
    const abs = Math.abs(a);
    if (abs < 1000) {
      smallCount++;
      if (abs % 10 !== 0) {
        smallNonMultipleOf10Count++;
      }
    }
  }

  // If there are values like 1, 2, 5, 12, 15, 45 (< 1000 and not multiples of 10),
  // in milliunits those would be 0.1¢ to 4.5¢, which are everyday dollar amounts in decimal budgets.
  if (smallNonMultipleOf10Count > 0) {
    return false;
  }

  // If more than 30% of amounts are < 1000 (sub-dollar in milliunits), it's decimal dollars.
  if (smallCount / amounts.length > 0.3) {
    return false;
  }

  // If all or virtually all amounts are >= 1000, it's milliunits.
  return true;
}

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
  ynabData: any;
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
 * YNAB4 data-version policy (see docs/ynab4-import-gaps.md G-01).
 *
 * Stock YNAB4 rejects budgets older than 2.6 and treats 4.2.0 as current.
 * Backups without `fileMetaData.budgetDataVersion` predate the 4.0
 * migration (or are legacy-XML conversions) and cannot be trusted to
 * parse, so the zip boundary rejects them instead of misparsing.
 */
export const MIN_SUPPORTED_BUDGET_DATA_VERSION: [number, number, number] = [2, 6, 0];
export const CURRENT_BUDGET_DATA_VERSION = "4.2.0";
const CURRENT_BUDGET_DATA_VERSION_TUPLE: [number, number, number] = [4, 2, 0];

/**
 * Parse a `budgetDataVersion` value (string like "4.2.0"/"4.2" or a
 * plain number like 4.2) into a [major, minor, patch] tuple.
 * Returns null when the value is missing or unparseable.
 */
export function parseBudgetDataVersion(value: unknown): [number, number, number] | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return parseBudgetDataVersion(String(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(".");
  if (parts.length < 1 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  while (nums.length < 3) nums.push(0);
  return [nums[0]!, nums[1]!, nums[2]!];
}

function compareVersionTuples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

function formatVersionTuple(t: [number, number, number]): string {
  return `${t[0]}.${t[1]}.${t[2]}`;
}

/**
 * Enforce the version gate: throw a descriptive error when
 * `fileMetaData.budgetDataVersion` is missing/unparseable or older
 * than 2.6. Returns the normalized version string on success.
 */
export function assertYnab4BudgetDataVersion(ynabData: any): string {
  const raw = ynabData?.fileMetaData?.budgetDataVersion;
  const parsed = parseBudgetDataVersion(raw);
  if (parsed == null) {
    throw new Error(
      "Could not determine YNAB4 budgetDataVersion (missing fileMetaData.budgetDataVersion); " +
        "refusing to import a backup that may predate YNAB4 2.6"
    );
  }
  if (compareVersionTuples(parsed, MIN_SUPPORTED_BUDGET_DATA_VERSION) < 0) {
    throw new Error(
      `Unsupported YNAB4 budgetDataVersion "${String(raw).trim()}"; minimum supported version is 2.6`
    );
  }
  return formatVersionTuple(parsed);
}

/**
 * Collect non-fatal version warnings for data that passed the gate:
 * a single notice when the version is older than the current 4.2.0.
 */
export function collectYnab4VersionWarnings(ynabData: any): string[] {
  const raw = ynabData?.fileMetaData?.budgetDataVersion;
  const parsed = parseBudgetDataVersion(raw);
  if (parsed == null) return [];
  if (compareVersionTuples(parsed, CURRENT_BUDGET_DATA_VERSION_TUPLE) < 0) {
    return [
      `YNAB4 budgetDataVersion "${String(raw).trim()}" is older than ${CURRENT_BUDGET_DATA_VERSION}; ` +
        "some newer fields may be missing after import",
    ];
  }
  return [];
}

function unescapeXml(str: string | null | undefined): string {
  if (str == null) return "";
  return String(str)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function parseYnab4SettingsXml(xmlStr?: string): Ynab4Settings {
  const settings: Ynab4Settings = {};
  if (!xmlStr) return settings;

  const matchTag = (tag: string) => {
    const match = xmlStr.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
    if (!match) return undefined;
    const raw = unescapeXml(match[1]);
    const trimmed = raw.trim();
    // G-02: a whitespace-only value is significant for separators
    // (e.g. cs_CZ uses a space group separator) — only trim when
    // something non-whitespace remains.
    return trimmed !== "" ? trimmed : raw;
  };

  settings.currencySymbol = matchTag("currencySymbol");
  settings.currencyISOSymbol = matchTag("currencyISOSymbol") || matchTag("currencyISO");
  settings.decimalSeparator = matchTag("decimalSeparator") || matchTag("currencyDecimalSeparator");
  settings.groupSeparator = matchTag("groupSeparator") || matchTag("currencyGroupSeparator");
  settings.dateFormat = matchTag("dateFormat") || matchTag("shortDateFormat");
  settings.budgetName = matchTag("budgetName") || matchTag("budgetTitle");

  return settings;
}

/**
 * Whitelist-parse the `.ynab4` JSON root's `budgetMetaData` (G-02).
 * Only known string fields survive; anything else (arrays, objects,
 * numbers) is dropped so a hostile backup can't smuggle junk into
 * the settings table.
 */
export function parseYnab4BudgetMetaData(raw: unknown): Ynab4BudgetMetaData {
  const meta: Ynab4BudgetMetaData = {};
  if (raw == null || typeof raw !== "object") return meta;
  const src = raw as Record<string, unknown>;
  for (const key of ["budgetType", "currencyISOSymbol", "currencyLocale", "dateLocale", "strictBudget"] as const) {
    const v = src[key];
    if (typeof v === "string" && v.trim() !== "") {
      meta[key] = v.trim();
    }
  }
  return meta;
}

/** YNAB4 flag color name → our enum. Unknown/missing values map to null. */
export function ynabFlagToColor(flag: unknown): TransactionFlagColor | null {
  if (typeof flag !== "string") return null;
  const normalized = flag.trim().toLowerCase();
  switch (normalized) {
    case "red":
      return "red";
    case "orange":
      return "orange";
    case "yellow":
      return "yellow";
    case "green":
      return "green";
    case "blue":
      return "blue";
    case "purple":
      return "purple";
    default:
      return null;
  }
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

function cleanLineageString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

/** Pull the persistable lineage fields off any YNAB4 tx/sub-tx object. */
export function extractYnab4TxLineage(src: any): Ynab4TxLineage {
  return {
    checkNumber: cleanLineageString(src?.checkNumber),
    fitid: cleanLineageString(src?.FITID),
    ynabId: cleanLineageString(src?.YNABID),
    importedPayee: cleanLineageString(src?.importedPayee),
    source: cleanLineageString(src?.source),
  };
}

/**
 * Stage 1: Extract and parse YNAB4 data from a .y4backup or .zip archive buffer.
 */
export function extractYnab4DataFromZip(buffer: Buffer | ArrayBuffer): ExtractedYnab4Data {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const zip = new AdmZip(buf);
  const zipEntries = zip.getEntries();

  let ynab4JsonStr = "";
  let settingsXml: string | undefined = undefined;

  for (const entry of zipEntries) {
    if (entry.entryName.endsWith(".ynab4")) {
      ynab4JsonStr = zip.readAsText(entry);
    } else if (entry.entryName.endsWith(".ybsettings")) {
      settingsXml = zip.readAsText(entry);
    }
  }

  if (!ynab4JsonStr) {
    throw new Error("Could not find .ynab4 data file inside the zip archive");
  }

  const ynabData = JSON.parse(ynab4JsonStr);
  // Version gate (G-01): reject backups that predate fileMetaData (4.0)
  // or the 2.6 floor before any import step can misparse them.
  assertYnab4BudgetDataVersion(ynabData);
  const warnings = [
    ...collectYnab4VersionWarnings(ynabData),
    ...collectYnab4PackageWarnings(zipEntries.map((e) => e.entryName)),
  ];
  const settings = settingsXml ? parseYnab4SettingsXml(settingsXml) : undefined;
  const budgetMetaData = parseYnab4BudgetMetaData(ynabData.budgetMetaData);
  return { ynabData, settingsXml, settings, budgetMetaData, warnings };
}

/**
 * Warn (never throw) when a backup archive carries multi-device sync
 * state alongside the main budget: stock YNAB4 packages hold a
 * `Budget.ymeta` pointer plus `devices/` diffs and `Snapshots/`, while
 * `.y4backup` exports zip the whole package. We import only the
 * `.ynab4` payload, so surface the skipped sync state explicitly.
 */
export function collectYnab4PackageWarnings(entryNames: string[]): string[] {
  const warnings: string[] = [];
  const normalized = entryNames.map((n) => n.replace(/\\/g, "/"));
  const hasDevices = normalized.some((n) => /(^|\/)devices(\/|$)/i.test(n));
  const hasSnapshots = normalized.some((n) => /(^|\/)snapshots(\/|$)/i.test(n));
  if (hasDevices) {
    warnings.push(
      'Backup archive contains multi-device sync state ("devices/" entries); only the main .ynab4 budget file was imported'
    );
  }
  if (hasSnapshots) {
    warnings.push(
      'Backup archive contains historic snapshots ("Snapshots/" entries); only the main .ynab4 budget file was imported'
    );
  }
  return warnings;
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
    const yTransactions = ynabData.transactions || [];
    const yScheduled = ynabData.scheduledTransactions || [];
    const yBudgets = ynabData.monthlyBudgets || [];

    // Payees mapping (payeeId -> name)
    const payeeMap = new Map<string, string>();
    // YNAB4 payee entityId -> local payees.id (BUG-16). The payees table is
    // populated so transactions can link via payeeId instead of carrying
    // duplicated text-only payees. Transfer payees (targetAccountId set) are
    // modeled via transferAccountId and never get a payees row.
    const payeeDbIdMap = new Map<string, number>();
    for (const p of yPayees) {
      if (!p.isTombstone) {
        payeeMap.set(p.entityId, p.name);
        if (p.targetAccountId) continue;
        if (typeof p.name !== "string" || !p.name.trim()) continue;
        const payeeRow = findOrCreatePayee(db, p.name, undefined, p.entityId);
        payeeDbIdMap.set(p.entityId, payeeRow.id);
        // G-04: YNAB4 `enabled === false` payees import as archived
        // (mirrors `accounts.archived`; written back as `enabled`).
        // Missing `enabled` means enabled (YNAB4 defaults it to true).
        if (p.enabled === false && !payeeRow.archived) {
          db.update(payees).set({ archived: true }).where(eq(payees.id, payeeRow.id)).run();
        }
      }
    }

    // 2. Insert Accounts and Reconciliations
    const accountIdMap = new Map<string, number>();
    const accOnBudgetMap = new Map<string, boolean>();
    const accKindMap = new Map<string, string>();
    const reconciliationIdMap = new Map<string, number>();
    const reconciliationDateMap = new Map<string, string>();
    const accountReconciliationIdMap = new Map<string, number>();
    const accountReconciliationDateMap = new Map<string, string>();
    let accountSort = 0;
    const nonTombstoneAccounts = yAccounts
      .filter((a: any) => !a.isTombstone)
      .sort((a: any, b: any) => (a.sortableIndex ?? 0) - (b.sortableIndex ?? 0));

    const yReconciliations = (ynabData.reconciliations || []).filter((r: any) => !r.isTombstone);
    // G-09: `reconciliations[]` is our own extension — stock YNAB4 never
    // writes this array (it persists only `AccountVO.lastReconciledDate` /
    // `lastReconciledBalance` plus per-register `cleared` flags). It is
    // non-empty only for backups produced by our own exporter (or hand
    // edits); stock files take the account-fields-only path below.
    const hasExplicitReconciliations = yReconciliations.length > 0;

    // G-03: `lastEnteredCheckNumber` has no column (check-number support
    // is not modeled) — counted once here so the drop is reported in
    // warnings, never silent. YNAB4 defaults the field to -1.
    let droppedCheckNumberCount = 0;
    for (const acc of nonTombstoneAccounts) {
      const lec = acc?.lastEnteredCheckNumber;
      if (lec !== undefined && lec !== null && lec !== "" && Number(lec) !== -1) {
        droppedCheckNumberCount++;
      }
    }
    if (droppedCheckNumberCount > 0) {
      warnings.push(
        `Dropped lastEnteredCheckNumber on ${droppedCheckNumberCount} account(s); check-number tracking is not modeled`
      );
    }

    for (const acc of nonTombstoneAccounts) {
      accOnBudgetMap.set(acc.entityId, !!acc.onBudget);
      const kind =
        acc.accountType === "CreditCard" || acc.accountType === "LineofCredit"
          ? "credit"
          : acc.onBudget
          ? "liquid"
          : "offbudget";
      accKindMap.set(acc.entityId, kind);

      const groupLabel = acc.onBudget
        ? kind === "credit"
          ? "Credit Cards"
          : "Budget Accounts"
        : "Off Budget";

      const isArchived = Boolean(acc.hidden || acc.closed || acc.isClosed);

      let recDate: string | null = null;
      let recBalance: number | null = null;

      if (hasExplicitReconciliations) {
        const accRecs = yReconciliations.filter((r: any) => r.accountId === acc.entityId);
        if (accRecs.length > 0) {
          const latestRec = accRecs[accRecs.length - 1]!;
          recDate = acc.lastReconciledDate || latestRec.statementDate || latestRec.reconciledAt || todayISO();
          recBalance =
            acc.lastReconciledBalance != null
              ? convertAmount(Number(acc.lastReconciledBalance))
              : convertAmount(latestRec.statementBalance);
        } else if (acc.lastReconciledDate != null) {
          recDate = acc.lastReconciledDate;
          recBalance = acc.lastReconciledBalance != null ? convertAmount(Number(acc.lastReconciledBalance)) : null;
        }
      } else {
        // G-09 stock path: no `reconciliations[]` array (stock YNAB4 never
        // writes one). Carry just the account-level fields YNAB4 actually
        // persists (`AccountVO.lastReconciledDate/Balance`); never
        // synthesize reconciliation rows, so imported history claims no
        // phantom statement precision. Per-row `cleared: "Reconciled"`
        // flags still map to status "r" below (with the date but no
        // reconciliationId).
        recDate = acc.lastReconciledDate ?? null;
        recBalance =
          acc.lastReconciledBalance != null ? convertAmount(Number(acc.lastReconciledBalance)) : null;
      }

      const [row] = await db
        .insert(accounts)
        .values({
          entityId: acc.entityId,
          name: acc.accountName,
          kind,
          groupLabel,
          balance: 0, // To be computed from transactions
          onBudget: !!acc.onBudget,
          sort: accountSort++,
          lastReconciledAt: recDate,
          lastReconciledBalance: recBalance,
          archived: isArchived,
          // G-03 (cheap): preserve the YNAB4 account note verbatim.
          notes: typeof acc.note === "string" ? acc.note : "",
          // G-03: preserve the verbatim YNAB4 account type; `kind`
          // above keeps driving app logic, the exporter prefers this
          // raw value when present.
          accountTypeRaw:
            typeof acc.accountType === "string" && acc.accountType.trim() !== ""
              ? acc.accountType
              : null,
        })
        .returning();

      accountIdMap.set(acc.entityId, row!.id);

      if (hasExplicitReconciliations) {
        const accRecs = yReconciliations.filter((r: any) => r.accountId === acc.entityId);
        for (const r of accRecs) {
          const rDate = r.reconciledAt || r.statementDate || recDate || todayISO();
          const sDate = r.statementDate || r.reconciledAt || recDate || todayISO();
          const sBal = convertAmount(r.statementBalance);
          const [rec] = await db
            .insert(reconciliations)
            .values({
              entityId: r.entityId,
              accountId: row!.id,
              reconciledAt: rDate,
              statementDate: sDate,
              statementBalance: sBal,
              adjustmentTransactionId: null,
            })
            .returning();
          if (rec) {
            reconciliationIdMap.set(r.entityId, rec.id);
            reconciliationDateMap.set(r.entityId, rDate);
            accountReconciliationIdMap.set(acc.entityId, rec.id);
            accountReconciliationDateMap.set(acc.entityId, rDate);
          }
        }
      }
      // G-09: no row synthesis for stock files (no `reconciliations[]`
      // array) — only the account-level `lastReconciledAt/Balance`
      // fields above. Rows below are created solely for explicit
      // (exporter-shaped) reconciliation rounds.
    }

    // 3. Insert Category Groups and Categories
    const categoryIdMap = new Map<string, number>();
    let groupSort = 0;

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
          sort: groupSort++,
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
          sc.overspendingHandling === "OverspendCarriedForward" ||
          sc.entityVersion?.overspendingHandling === "OverspendCarriedForward";
        const [cRow] = await db
          .insert(categories)
          .values({
            entityId: sc.entityId,
            groupId: gRow!.id,
            name: sc.name,
            sort: catSort++,
            carryover: 0,
            goalTarget: null,
            overspendCarriesOver: overspendCarriesOver || false,
          })
          .returning();

        categoryIdMap.set(sc.entityId, cRow!.id);
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
        sort: groupSort++,
        isCreditCardPayments: true,
      })
      .returning();

    const creditAccounts = await db.select().from(accounts).where(eq(accounts.kind, "credit"));
    let ccCatSort = 0;
    for (const acc of creditAccounts) {
      const accEntityId = Array.from(accountIdMap.entries()).find(([_, id]) => id === acc.id)?.[0];
      const matchingSc = exportedCcSubs.find(
        (sc: any) =>
          !sc.isTombstone &&
          ((accEntityId && sc.accountId === accEntityId) ||
            sc.name?.toLowerCase() === acc.name?.toLowerCase())
      );

      const overspendCarriesOver =
        matchingSc?.overspendingHandling === "OverspendCarriedForward" ||
        matchingSc?.entityVersion?.overspendingHandling === "OverspendCarriedForward" ||
        false;
      const initialCarryover =
        matchingSc?.carryover !== undefined
          ? convertAmount(Number(matchingSc.carryover))
          : matchingSc?.cachedBalance !== undefined
          ? convertAmount(Number(matchingSc.cachedBalance))
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
        categoryIdMap.set(matchingSc.entityId, cRow!.id);
      }
    }

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
        const catId = categoryIdMap.get(msb.categoryId);
        if (!catId) {
          if (typeof msb.note === "string" && msb.note.trim() !== "") droppedCategoryNoteCount++;
          continue;
        }
        const amt = convertAmount(msb.budgeted);
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
      warnings.push(
        `Dropped month-level budget notes on ${monthLevelNoteCount} month(s); only per-category notes are imported`
      );
    }
    if (droppedCategoryNoteCount > 0) {
      warnings.push(
        `Dropped per-category budget notes on ${droppedCategoryNoteCount} row(s) whose category was not imported`
      );
    }

    // 5. Insert Transactions
    // G-05: YNAB4 import-match workflow fields we deliberately do not
    // model (`matchedTransactions`, `parentTransactionIdIfMatched`,
    // `dateEnteredFromSchedule`, and `accepted`). Our match workflow
    // differs, so every row imports as accepted and the link fields are
    // dropped — counted here so the loss is reported in warnings,
    // never silent. (Export hardcodes `accepted: true` for the same
    // reason; see export-ynab4.ts.)
    {
      let unacceptedCount = 0;
      let matchedCount = 0;
      let scheduleLinkCount = 0;
      const countRow = (row: any) => {
        if (row?.accepted === false) unacceptedCount++;
        if (
          Array.isArray(row?.matchedTransactions) &&
          row.matchedTransactions.some((m: any) => !m?.isTombstone)
        ) {
          matchedCount++;
        }
        if (typeof row?.parentTransactionIdIfMatched === "string" && row.parentTransactionIdIfMatched.trim() !== "") {
          matchedCount++;
        }
        const entered = row?.dateEnteredFromSchedule;
        if ((typeof entered === "string" && entered.trim() !== "") || typeof entered === "number") {
          scheduleLinkCount++;
        }
      };
      for (const t of yTransactions) {
        if (t.isTombstone) continue;
        countRow(t);
        for (const st of t.subTransactions || []) {
          if (!st?.isTombstone) countRow(st);
        }
      }
      for (const st of yScheduled) {
        if (st?.isTombstone) continue;
        countRow(st);
        for (const sub of st.subTransactions || []) {
          if (!sub?.isTombstone) countRow(sub);
        }
      }
      if (unacceptedCount > 0) {
        warnings.push(
          `Dropped "accepted === false" match state on ${unacceptedCount} YNAB4 row(s); our match workflow differs, so all rows import as accepted`
        );
      }
      if (matchedCount > 0) {
        warnings.push(
          `Dropped YNAB4 import-match links (matchedTransactions/parentTransactionIdIfMatched) on ${matchedCount} row(s); our match workflow differs`
        );
      }
      if (scheduleLinkCount > 0) {
        warnings.push(
          `Dropped YNAB4 schedule-entry links (dateEnteredFromSchedule) on ${scheduleLinkCount} row(s); recurring history is not linked to schedules`
        );
      }
    }
    const accNameMap = new Map<number, string>();
    const allAccountsForMap = await db.select().from(accounts);
    for (const a of allAccountsForMap) accNameMap.set(a.id, a.name);

    // Fallback category for cross-budget-boundary transfer outflows with missing categories (BUG-03)
    let fallbackTransferCategoryId: number | null = null;
    async function getOrCreateFallbackTransferCategory(): Promise<number> {
      if (fallbackTransferCategoryId !== null) return fallbackTransferCategoryId;
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
            sort: groupSort++,
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
        fallbackTransferCategoryId = existingCat.id;
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
        fallbackTransferCategoryId = cRow!.id;
      }
      return fallbackTransferCategoryId;
    }

    // Build subTransactions and transactions lookup
    const subTxById = new Map<string, { parent: any; sub: any }>();
    const txById = new Map<string, any>();
    for (const t of yTransactions) {
      if (!t.isTombstone) {
        txById.set(t.entityId, t);
        for (const st of t.subTransactions || []) {
          if (!st.isTombstone) {
            subTxById.set(st.entityId, { parent: t, sub: st });
          }
        }
      }
    }

    const processedTransferIds = new Set<string>();
    let totalImportedTxCount = 0;
    // Fingerprints of already-encountered plain regular rows (used to flag
    // suspected duplicate entries within the backup). Split rows and
    // transfers are intentionally excluded.
    const plainFingerprints = new Set<string>();
    const skippedDuplicates: ImportSkippedEntry[] = [];

    for (const t of yTransactions) {
      if (t.isTombstone) continue;

      const accId = accountIdMap.get(t.accountId);
      if (!accId) continue;

      const hasSubs = Array.isArray(t.subTransactions) && t.subTransactions.length > 0;

      if (hasSubs) {
        // Split transaction parent
        // G-06: import every live leg verbatim, including 0-amount legs
        // (they are valid YNAB4 rows). Only a parent with literally no
        // non-tombstone children is skipped — there is nothing to
        // import. Zero-sum parents import with amount 0 (the DB no
        // longer forbids zero amounts; balance math is unaffected
        // because split parents are excluded from balance sums and
        // zero legs contribute 0).
        let payee = payeeMap.get(t.payeeId) || "";
        const parentPayeeId = (t.payeeId && payeeDbIdMap.get(t.payeeId)) || null;
        const liveSubs = (t.subTransactions || []).filter((st: any) => !st.isTombstone);

        if (liveSubs.length === 0) {
          skippedDuplicates.push({
            accountName: accNameMap.get(accId) || "",
            date: t.date,
            payee,
            memo: t.memo || "",
            amount: 0,
            reason: "Split transaction with no live children",
          });
          continue;
        }

        const isParentDeferred = t.categoryId === "Category/__DeferredIncome__";
        const isParentIncome = (t.categoryId === "Category/__ImmediateIncome__" || isParentDeferred) && (t.amount || 0) > 0;
        const parentIncomeMonth = isParentIncome
          ? (t.incomeMonth || (isParentDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
          : null;
        const isParentReconciled = t.cleared === "Reconciled" || Boolean(t.reconciliationId);
        const parentRecId = t.reconciliationId
          ? reconciliationIdMap.get(t.reconciliationId) ?? accountReconciliationIdMap.get(t.accountId) ?? null
          : isParentReconciled
          ? accountReconciliationIdMap.get(t.accountId) ?? null
          : null;
        const parentRecDate = t.reconciliationId
          ? reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
          : isParentReconciled
          ? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
          : null;
        // G-09: a YNAB4 `cleared: "Reconciled"` flag always maps to
        // status "r" (with the derived date, even when no explicit
        // reconciliation row exists to link — `reconciliationId` stays
        // null for stock files). The lock state is real source data;
        // only the statement row was phantom.
        const effectiveParentStatus = isParentReconciled
          ? "r"
          : t.cleared === "Uncleared" ? "u" : "c";

        const parentSplitAmount = liveSubs.reduce((sum: number, st: any) => sum + convertAmount(st.amount), 0);

        const parentLineage = extractYnab4TxLineage(t);
        const [insertedT] = await db
          .insert(transactions)
          .values({
            entityId: t.entityId,
            accountId: accId,
            categoryId: null,
            date: t.date,
            payee,
            payeeId: parentPayeeId,
            memo: t.memo || "",
            amount: parentSplitAmount,
            status: effectiveParentStatus,
            flagColor: ynabFlagToColor(t.flag),
            checkNumber: parentLineage.checkNumber,
            fitid: parentLineage.fitid,
            ynabId: parentLineage.ynabId,
            importedPayee: parentLineage.importedPayee,
            source: parentLineage.source,
            transferAccountId: null,
            parentId: null,
            isIncome: isParentIncome,
            incomeMonth: parentIncomeMonth,
            reconciledAt: effectiveParentStatus === "r" ? parentRecDate : null,
            reconciliationId: effectiveParentStatus === "r" ? parentRecId : null,
          })
          .returning();

        totalImportedTxCount++;

        if (insertedT) {
          let allChildrenReconciled = liveSubs.length > 0;

          for (const st of liveSubs) {
            const accIsOnBudget = accOnBudgetMap.get(t.accountId) ?? true;
            let subCatId = (accIsOnBudget && categoryIdMap.get(st.categoryId)) || null;
            let subPayee = "";
            let subPayeeId: number | null = null;
            let subTransferAccountId: number | null = null;

            if (st.payeeId && st.payeeId.startsWith("Payee/Transfer:")) {
              const targetId = st.payeeId.split(":")[1];
              const foundTarget = targetId ? accountIdMap.get(targetId) : null;
              if (foundTarget) {
                subTransferAccountId = foundTarget;
                subPayee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
              }
            } else if (st.targetAccountId) {
              const foundTarget = accountIdMap.get(st.targetAccountId);
              if (foundTarget) {
                subTransferAccountId = foundTarget;
                subPayee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
              }
            } else if (st.payeeId) {
              subPayee = payeeMap.get(st.payeeId) || payee;
              subPayeeId = payeeDbIdMap.get(st.payeeId) ?? parentPayeeId;
            } else {
              subPayee = payee;
              subPayeeId = parentPayeeId;
            }

            const childAmt = convertAmount(st.amount);
            let isChildIncome = false;
            let childIncomeMonth: string | null = null;

            if (subTransferAccountId != null) {
              const destAccEntity = st.targetAccountId || (st.payeeId?.startsWith("Payee/Transfer:") ? st.payeeId.split(":")[1] : "");
              const destIsOnBudget = destAccEntity ? (accOnBudgetMap.get(destAccEntity) ?? false) : (allAccountsForMap.find((a) => a.id === subTransferAccountId)?.onBudget ?? false);
              const isCrossBoundary = accIsOnBudget !== destIsOnBudget;
              const netOnBudgetDelta = (accIsOnBudget ? childAmt : 0) + (destIsOnBudget ? -childAmt : 0);
              if (isCrossBoundary && netOnBudgetDelta < 0 && subCatId === null) {
                subCatId = await getOrCreateFallbackTransferCategory();
              }
              const classification = classifyBoundaryTransfer({
                srcOnBudget: accIsOnBudget,
                destOnBudget: destIsOnBudget,
                amount: childAmt,
                categoryId: subCatId,
              });
              subCatId = classification.categoryId;
              isChildIncome = classification.isIncome;
            } else {
              const isChildDeferred = st.categoryId === "Category/__DeferredIncome__";
              const accKind = accKindMap.get(t.accountId) ?? "liquid";
              isChildIncome =
                accIsOnBudget &&
                accKind !== "credit" &&
                (st.categoryId === "Category/__ImmediateIncome__" ||
                  isChildDeferred ||
                  (subCatId === null && subTransferAccountId === null)) &&
                (st.amount || 0) > 0;
              childIncomeMonth = isChildIncome
                ? (st.incomeMonth || (isChildDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
                : null;
            }

            const isChildReconciled = isParentReconciled || st.cleared === "Reconciled" || Boolean(st.reconciliationId);
            const childRecId = st.reconciliationId
              ? reconciliationIdMap.get(st.reconciliationId) ?? parentRecId ?? accountReconciliationIdMap.get(t.accountId) ?? null
              : isChildReconciled
              ? parentRecId ?? accountReconciliationIdMap.get(t.accountId) ?? null
              : null;
            const childRecDate = st.reconciliationId
              ? reconciliationDateMap.get(st.reconciliationId) ?? st.reconciledAt ?? parentRecDate ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
              : isChildReconciled
              ? parentRecDate ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
              : null;
            const effectiveChildStatus = isChildReconciled
              ? "r"
              : (t.cleared === "Uncleared" || st.cleared === "Uncleared") ? "u" : "c";

            let effectiveChildDestStatus: "u" | "c" | "r" | null = null;
            let childDestRecId: number | null = null;
            let childDestRecDate: string | null = null;
            let childDestTxEntityId: string | null = null;
            if (subTransferAccountId != null) {
              const destPartner = st.transferTransactionId ? txById.get(st.transferTransactionId) : null;
              childDestTxEntityId = destPartner?.entityId ?? st.transferTransactionId ?? null;
              if (destPartner) {
                const destAccEntId = destPartner.accountId;
                const isDestReconciled = destPartner.cleared === "Reconciled" || Boolean(destPartner.reconciliationId);
                const destRecEntityId = destPartner.reconciliationId;
                childDestRecId = destRecEntityId
                  ? reconciliationIdMap.get(destRecEntityId) ?? accountReconciliationIdMap.get(destAccEntId) ?? null
                  : isDestReconciled
                  ? accountReconciliationIdMap.get(destAccEntId) ?? null
                  : null;
                childDestRecDate = destRecEntityId
                  ? reconciliationDateMap.get(destRecEntityId) ?? destPartner.reconciledAt ?? accountReconciliationDateMap.get(destAccEntId) ?? t.date ?? null
                  : isDestReconciled
                  ? accountReconciliationDateMap.get(destAccEntId) ?? t.date ?? null
                  : null;
                effectiveChildDestStatus = isDestReconciled
                  ? "r"
                  : destPartner.cleared === "Uncleared" ? "u" : "c";
              } else {
                effectiveChildDestStatus = effectiveChildStatus;
                childDestRecId = effectiveChildStatus === "r" ? childRecId : null;
                childDestRecDate = effectiveChildStatus === "r" ? childRecDate : null;
              }
            }

            if (effectiveChildStatus !== "r") {
              allChildrenReconciled = false;
            }

            const childLineage = extractYnab4TxLineage(st);
            await db.insert(transactions).values({
              entityId: st.entityId,
              transferEntityId: childDestTxEntityId,
              accountId: accId,
              categoryId: subCatId,
              date: t.date,
              payee: subPayee,
              payeeId: subPayeeId,
              memo: st.memo || "",
              amount: convertAmount(st.amount),
              status: effectiveChildStatus,
              transferStatus: effectiveChildDestStatus,
              flagColor: ynabFlagToColor(st.flag),
              checkNumber: childLineage.checkNumber,
              fitid: childLineage.fitid,
              ynabId: childLineage.ynabId,
              importedPayee: childLineage.importedPayee,
              source: childLineage.source,
              transferAccountId: subTransferAccountId,
              parentId: insertedT.id,
              isIncome: isChildIncome,
              incomeMonth: childIncomeMonth,
              reconciledAt: effectiveChildStatus === "r" ? childRecDate : null,
              reconciliationId: effectiveChildStatus === "r" ? childRecId : null,
              transferReconciledAt: effectiveChildDestStatus === "r" ? childDestRecDate : null,
              transferReconciliationId: effectiveChildDestStatus === "r" ? childDestRecId : null,
            });
            totalImportedTxCount++;
          }

          // If all children are reconciled and parent is not yet 'r', reconcile parent
          if (allChildrenReconciled && effectiveParentStatus !== "r" && parentRecId != null) {
            await db
              .update(transactions)
              .set({
                status: "r",
                reconciledAt: parentRecDate,
                reconciliationId: parentRecId,
              })
              .where(eq(transactions.id, insertedT.id));
          }
        }
      } else {
        // Non-split transaction
        // Check if this is the standalone side of a split transfer in YNAB4
        const linkedSub = t.transferTransactionId ? subTxById.get(t.transferTransactionId) : null;
        if (linkedSub && accountIdMap.has(linkedSub.parent.accountId)) {
          // This was the duplicate counterpart of a split subtransaction in YNAB4.
          // Since the subtransaction on the parent split now carries transferAccountId,
          // the transfer is already fully accounted for without needing this duplicate row.
          skippedDuplicates.push({
            accountName: accNameMap.get(accId) || "",
            date: t.date,
            payee: payeeMap.get(t.payeeId) || "",
            memo: t.memo || "",
            amount: convertAmount(t.amount),
            reason: "Duplicate counterpart of a split transfer",
          });
          continue;
        } else if (t.transferTransactionId) {
          // Top-level regular transfer pair
          if (processedTransferIds.has(t.entityId)) {
            // Already imported from counterpart
            skippedDuplicates.push({
              accountName: accNameMap.get(accId) || "",
              date: t.date,
              payee: payeeMap.get(t.payeeId) || "",
              memo: t.memo || "",
              amount: convertAmount(t.amount),
              reason: "Duplicate transfer counterpart",
            });
            continue;
          }

          const partner = txById.get(t.transferTransactionId);
          const partnerAccId = partner ? accountIdMap.get(partner.accountId) : undefined;
          processedTransferIds.add(t.entityId);
          if (partner) processedTransferIds.add(partner.entityId);

          if (partner && partnerAccId) {
            // Both sides of transfer pair have valid accounts in DB: import as single linked transfer
            let sourceAccEntityId = t.accountId;
            let destAccEntityId = partner.accountId;
            let rawAmount = t.amount || 0;
            let memo = t.memo || "";
            let cleared = t.cleared;
            let catEntityId = t.categoryId;

            // Normalize transfer orientation:
            // - Cross-budget-boundary (one on-budget, one off-budget):
            //   always use the on-budget account as the source so the amount sign
            //   is meaningful relative to the budget (negative = spending,
            //   positive = inflow to budget).
            // - Same-budget (both on or both off):
            //   use the negative-amount (outflow) side as the source.
            const tOnBudget = accOnBudgetMap.get(t.accountId);
            const pOnBudget = accOnBudgetMap.get(partner.accountId);
            const isCrossBoundary =
              tOnBudget !== undefined && pOnBudget !== undefined && tOnBudget !== pOnBudget;

            if (isCrossBoundary) {
              if (!tOnBudget && pOnBudget) {
                // Source is off-budget, partner is on-budget (liquidation/sale).
                // Flip to use the on-budget side as source with its sign.
                sourceAccEntityId = partner.accountId;
                destAccEntityId = t.accountId;
                rawAmount = partner.amount || 0;
                if (!memo && partner.memo) memo = partner.memo;
                cleared = partner.cleared;
                catEntityId = partner.categoryId || t.categoryId;
              }
              // If source is already on-budget, no flip needed.
            } else {
              // Same budget: normalize to negative-amount (outflow) side as source.
              if (rawAmount > 0 && (partner.amount || 0) < 0) {
                sourceAccEntityId = partner.accountId;
                destAccEntityId = t.accountId;
                rawAmount = partner.amount || 0;
                if (!memo && partner.memo) memo = partner.memo;
                cleared = partner.cleared;
                catEntityId = partner.categoryId || t.categoryId;
              }
            }

            // Pull category from partner if current side has none.
            if (partner.categoryId && !catEntityId) {
              catEntityId = partner.categoryId;
            }

            const sourceAccId = accountIdMap.get(sourceAccEntityId)!;
            const destAccId = accountIdMap.get(destAccEntityId)!;
            const payee = "Transfer : " + (accNameMap.get(destAccId) || "Unknown");

            const sourceIsOnBudget = accOnBudgetMap.get(sourceAccEntityId) ?? true;
            const destIsOnBudget = accOnBudgetMap.get(destAccEntityId) ?? true;
            const isCrossBoundaryTransfer = sourceIsOnBudget !== destIsOnBudget;
            const rawCents = convertAmount(rawAmount);
            if (rawCents === 0) {
              skippedDuplicates.push({
                accountName: accNameMap.get(sourceAccId) || "",
                date: t.date,
                payee,
                memo,
                amount: 0,
                reason: "Zero-amount transfer transaction",
              });
              continue;
            }
            const netOnBudget = (sourceIsOnBudget ? rawCents : 0) + (destIsOnBudget ? -rawCents : 0);
            const catId = (catEntityId && categoryIdMap.get(catEntityId)) || null;
            const isSpecialIncomeCat =
              catEntityId === "Category/__ImmediateIncome__" ||
              catEntityId === "Category/__DeferredIncome__";
            let effectiveCatId = isSpecialIncomeCat ? null : catId;
            if (isCrossBoundaryTransfer && netOnBudget < 0 && effectiveCatId === null) {
              effectiveCatId = await getOrCreateFallbackTransferCategory();
            }
            const classification = classifyBoundaryTransfer({
              srcOnBudget: sourceIsOnBudget,
              destOnBudget: destIsOnBudget,
              amount: rawCents,
              categoryId: effectiveCatId,
            });
            const finalTransferCatId = classification.categoryId;
            const isTransferIncome = classification.isIncome;

            const sourceYTx = sourceAccEntityId === t.accountId ? t : partner;
            const destYTx = destAccEntityId === t.accountId ? t : partner;

            const isSrcReconciled = sourceYTx?.cleared === "Reconciled" || Boolean(sourceYTx?.reconciliationId);
            const srcRecEntityId = sourceYTx?.reconciliationId;
            const srcRecId = srcRecEntityId
              ? reconciliationIdMap.get(srcRecEntityId) ?? accountReconciliationIdMap.get(sourceAccEntityId) ?? null
              : isSrcReconciled
              ? accountReconciliationIdMap.get(sourceAccEntityId) ?? null
              : null;
            const srcRecDate = srcRecEntityId
              ? reconciliationDateMap.get(srcRecEntityId) ?? sourceYTx?.reconciledAt ?? accountReconciliationDateMap.get(sourceAccEntityId) ?? t.date ?? null
              : isSrcReconciled
              ? accountReconciliationDateMap.get(sourceAccEntityId) ?? t.date ?? null
              : null;
            const effectiveSrcStatus = isSrcReconciled
              ? "r"
              : (sourceYTx?.cleared === "Uncleared" ? "u" : "c");

            const isDestReconciled = destYTx?.cleared === "Reconciled" || Boolean(destYTx?.reconciliationId);
            const destRecEntityId = destYTx?.reconciliationId;
            const destRecId = destRecEntityId
              ? reconciliationIdMap.get(destRecEntityId) ?? accountReconciliationIdMap.get(destAccEntityId) ?? null
              : isDestReconciled
              ? accountReconciliationIdMap.get(destAccEntityId) ?? null
              : null;
            const destRecDate = destRecEntityId
              ? reconciliationDateMap.get(destRecEntityId) ?? destYTx?.reconciledAt ?? accountReconciliationDateMap.get(destAccEntityId) ?? t.date ?? null
              : isDestReconciled
              ? accountReconciliationDateMap.get(destAccEntityId) ?? t.date ?? null
              : null;
            const effectiveDestStatus = isDestReconciled
              ? "r"
              : (destYTx?.cleared === "Uncleared" ? "u" : "c");

            const sourceLineage = extractYnab4TxLineage(sourceYTx);
            await db.insert(transactions).values({
              entityId: sourceYTx?.entityId ?? t.entityId,
              transferEntityId: destYTx?.entityId ?? (partner?.entityId || t.transferTransactionId || null),
              accountId: sourceAccId,
              categoryId: finalTransferCatId,
              date: t.date,
              payee,
              payeeId: null,
              memo,
              amount: rawCents,
              status: effectiveSrcStatus,
              transferStatus: effectiveDestStatus,
              flagColor: ynabFlagToColor(t.flag),
              checkNumber: sourceLineage.checkNumber,
              fitid: sourceLineage.fitid,
              ynabId: sourceLineage.ynabId,
              importedPayee: sourceLineage.importedPayee,
              source: sourceLineage.source,
              transferAccountId: destAccId,
              parentId: null,
              isIncome: isTransferIncome,
              reconciledAt: effectiveSrcStatus === "r" ? srcRecDate : null,
              reconciliationId: effectiveSrcStatus === "r" ? srcRecId : null,
              transferReconciledAt: effectiveDestStatus === "r" ? destRecDate : null,
              transferReconciliationId: effectiveDestStatus === "r" ? destRecId : null,
            });
            totalImportedTxCount++;
          } else {
            // Partner is missing or its account is not in accountIdMap (e.g. deleted/tombstoned account).
            // Fall back to importing the resolvable side as a regular transaction on accId.
            const fallbackAmt = convertAmount(t.amount);
            let memo = t.memo || (partner?.memo || "");
            let cleared = t.cleared;
            let catEntityId = t.categoryId || (partner?.categoryId || null);
            let payee = (t.payeeId ? payeeMap.get(t.payeeId) : "") || (partner?.payeeId ? payeeMap.get(partner.payeeId) || "" : "") || "";

            if (fallbackAmt === 0) {
              skippedDuplicates.push({
                accountName: accNameMap.get(accId) || "",
                date: t.date,
                payee,
                memo,
                amount: 0,
                reason: "Zero-amount fallback transfer transaction",
              });
              continue;
            }

            const fallbackPayeeId =
              (t.payeeId ? payeeDbIdMap.get(t.payeeId) : undefined) ??
              (partner?.payeeId ? payeeDbIdMap.get(partner.payeeId) : undefined) ??
              null;

            const accIsOnBudget = accOnBudgetMap.get(t.accountId) ?? true;
            let catId = (accIsOnBudget && catEntityId && categoryIdMap.get(catEntityId)) || null;
            const isTxDeferred = catEntityId === "Category/__DeferredIncome__";
            const isSpecialIncomeCat =
              catEntityId === "Category/__ImmediateIncome__" ||
              isTxDeferred;
            if (
              isSpecialIncomeCat ||
              catEntityId === "Category/__Split__"
            ) {
              catId = null;
            }

            const accKind = accKindMap.get(t.accountId) ?? "liquid";
            const isTxIncome =
              accIsOnBudget &&
              accKind !== "credit" &&
              (isSpecialIncomeCat || catId === null) &&
              (t.amount || 0) > 0;
            const txIncomeMonth = isTxIncome
              ? (t.incomeMonth || (isTxDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
              : null;

            const isTxReconciled = cleared === "Reconciled" || Boolean(t.reconciliationId);
            const txRecId = t.reconciliationId
              ? reconciliationIdMap.get(t.reconciliationId) ?? accountReconciliationIdMap.get(t.accountId) ?? null
              : isTxReconciled
              ? accountReconciliationIdMap.get(t.accountId) ?? null
              : null;
            const txRecDate = t.reconciliationId
              ? reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
              : isTxReconciled
              ? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
              : null;

            const fallbackLineage = extractYnab4TxLineage(t);
            await db.insert(transactions).values({
              entityId: t.entityId,
              accountId: accId,
              categoryId: catId,
              date: t.date,
              payee,
              payeeId: fallbackPayeeId,
              memo,
              amount: fallbackAmt,
              status:
                isTxReconciled
                  ? "r"
                  : cleared === "Uncleared"
                    ? "u"
                    : "c",
              flagColor: ynabFlagToColor(t.flag),
              checkNumber: fallbackLineage.checkNumber,
              fitid: fallbackLineage.fitid,
              ynabId: fallbackLineage.ynabId,
              importedPayee: fallbackLineage.importedPayee,
              source: fallbackLineage.source,
              transferAccountId: null,
              parentId: null,
              isIncome: isTxIncome,
              incomeMonth: txIncomeMonth,
              reconciledAt: isTxReconciled ? txRecDate : null,
              reconciliationId: isTxReconciled ? txRecId : null,
            });
            totalImportedTxCount++;
          }
        } else {
          // Plain transaction (or standalone transfer without transferTransactionId)
          const regularAmt = convertAmount(t.amount);
          let targetAccEntityId = t.targetAccountId || (t.payeeId && t.payeeId.startsWith("Payee/Transfer:") ? t.payeeId.split(":")[1] : null);
          let destAccId = targetAccEntityId ? accountIdMap.get(targetAccEntityId) || null : null;
          let payee = "";
          if (destAccId) {
            payee = "Transfer : " + (accNameMap.get(destAccId) || "Unknown");
          } else {
            payee = payeeMap.get(t.payeeId) || "";
          }

          if (regularAmt === 0) {
            skippedDuplicates.push({
              accountName: accNameMap.get(accId) || "",
              date: t.date,
              payee,
              memo: t.memo || "",
              amount: 0,
              reason: "Zero-amount transaction",
            });
            continue;
          }

          const plainPayeeId = destAccId ? null : (t.payeeId ? payeeDbIdMap.get(t.payeeId) ?? null : null);

          const accIsOnBudget = accOnBudgetMap.get(t.accountId) ?? true;
          let catId = (accIsOnBudget && categoryIdMap.get(t.categoryId)) || null;
          const isTxDeferred = t.categoryId === "Category/__DeferredIncome__";
          const isSpecialIncomeCat =
            t.categoryId === "Category/__ImmediateIncome__" ||
            isTxDeferred;
          if (
            isSpecialIncomeCat ||
            t.categoryId === "Category/__Split__"
          ) {
            catId = null;
          }

          const srcOnBudget = accOnBudgetMap.get(t.accountId) ?? true;
          const destOnBudget = destAccId ? (accOnBudgetMap.get(targetAccEntityId!) ?? false) : false;
          const isCrossBoundaryTx = destAccId !== null && srcOnBudget !== destOnBudget;
          if (destAccId !== null && !isCrossBoundaryTx) {
            catId = null;
          }
          const netOnBudgetTx = (srcOnBudget ? (t.amount || 0) : 0) + (destOnBudget ? -(t.amount || 0) : 0);
          if (isCrossBoundaryTx && netOnBudgetTx < 0 && catId === null) {
            catId = await getOrCreateFallbackTransferCategory();
          }
          const srcKind = accKindMap.get(t.accountId) ?? "liquid";
          const isTxIncome =
            (srcOnBudget && srcKind !== "credit" && (isSpecialIncomeCat || (catId === null && destAccId === null)) && (t.amount || 0) > 0) ||
            (isCrossBoundaryTx && (catId === null || isSpecialIncomeCat) && netOnBudgetTx > 0);
          const txIncomeMonth = isTxIncome
            ? (t.incomeMonth || (isTxDeferred && t.date ? nextMonthKey(t.date.slice(0, 7)) : null))
            : null;

          let flagColor: string | null = ynabFlagToColor(t.flag);

          // Track plain regular rows to detect duplicate entries within the backup.
          // All non-tombstone rows are imported (two identical transactions on the same
          // day are legitimate). Suspected unflagged, unreconciled duplicates are
          // flagged with TRANSACTION_DUPLICATE_FLAG for user review.
          if (destAccId === null) {
            const fp = duplicateFingerprint({
              accountId: accId,
              date: t.date,
              payee,
              memo: t.memo || "",
              amount: regularAmt,
            });
            if (plainFingerprints.has(fp)) {
              if (t.cleared !== "Reconciled" && flagColor === null) {
                flagColor = TRANSACTION_DUPLICATE_FLAG;
              }
            } else {
              plainFingerprints.add(fp);
            }
          }

          const isTxReconciled = t.cleared === "Reconciled" || Boolean(t.reconciliationId);
          const txRecId = t.reconciliationId
            ? reconciliationIdMap.get(t.reconciliationId) ?? accountReconciliationIdMap.get(t.accountId) ?? null
            : isTxReconciled
            ? accountReconciliationIdMap.get(t.accountId) ?? null
            : null;
          const txRecDate = t.reconciliationId
            ? reconciliationDateMap.get(t.reconciliationId) ?? t.reconciledAt ?? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
            : isTxReconciled
            ? accountReconciliationDateMap.get(t.accountId) ?? t.date ?? null
            : null;

          const plainLineage = extractYnab4TxLineage(t);
          await db.insert(transactions).values({
            entityId: t.entityId,
            accountId: accId,
            categoryId: catId,
            date: t.date,
            payee,
            payeeId: plainPayeeId,
            memo: t.memo || "",
            amount: regularAmt,
            status:
              isTxReconciled
                ? "r"
                : t.cleared === "Uncleared"
                  ? "u"
                  : "c",
            flagColor,
            checkNumber: plainLineage.checkNumber,
            fitid: plainLineage.fitid,
            ynabId: plainLineage.ynabId,
            importedPayee: plainLineage.importedPayee,
            source: plainLineage.source,
            transferAccountId: destAccId,
            parentId: null,
            isIncome: isTxIncome,
            incomeMonth: txIncomeMonth,
            reconciledAt: isTxReconciled ? txRecDate : null,
            reconciliationId: isTxReconciled ? txRecId : null,
          });
          totalImportedTxCount++;
        }
      }
    }

    // 5b. Carry over per-payee default categories (Payees Manager "Default
    // Category"). YNAB4 stores it as payee.autoFillCategoryId, which the
    // payee-creation pass above ignored, leaving every default empty.
    // Primary source is the YNAB4 auto-fill id resolved through the category
    // map; payees without a resolvable auto-fill fall back to the category
    // they use most often across regular (non-transfer, non-split-child)
    // transactions. Special income/split markers map to no default. Skipped
    // entirely when no payee rows were created (nothing to backfill).
    if (payeeDbIdMap.size > 0) {
      const SPECIAL_AUTO_FILL = new Set([
        "Category/__ImmediateIncome__",
        "Category/__DeferredIncome__",
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
        const localPayeeId = payeeDbIdMap.get(p.entityId);
        if (!localPayeeId) continue;
        let defaultCatId: number | null = null;
        const raw = p.autoFillCategoryId;
        if (typeof raw === "string" && raw && !SPECIAL_AUTO_FILL.has(raw)) {
          defaultCatId = categoryIdMap.get(raw) ?? null;
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
      }
    }

    // 5c. Import YNAB4 payee rename conditions into rename_rules (G-04).
    //
    // Operator audit (`data/StringCondition.as`,
    // `data/StringOperator.as`, `com/ynab/enums/EnumBase.as`): exactly
    // four operators exist — Contains, Is, StartsWith, EndsWith
    // (serialized under the static property names, parsed
    // case-insensitively). Only `Is` maps faithfully onto our rule
    // engine (an exact, case-insensitive source_pattern → target
    // payee). Prefix/substring operators have no equivalent in our
    // full-match `[N]`/`[X]` patterns, so those conditions land in
    // warnings instead of being silently dropped. `locations` (plus
    // top-level `payeeLocations`) have no counterpart (no maps
    // feature) and `autoFillMemo`/`autoFillAmount` have no
    // payee-autofill target — both deliberately dropped (counts in
    // warnings, details in the changeset). `targetAccountId` transfer
    // payees stay skipped by design (modeled via transferAccountId),
    // reported as one aggregated notice.
    {
      let transferPayeeCount = 0;
      let droppedLocationCount = (ynabData.payeeLocations || []).filter((l: any) => !l?.isTombstone).length;
      let droppedAutoFillCount = 0;
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
        const autoFillMemo = typeof p.autoFillMemo === "string" ? p.autoFillMemo.trim() : "";
        const autoFillAmount = Number(p.autoFillAmount ?? 0);
        if (autoFillMemo !== "" || (Number.isFinite(autoFillAmount) && autoFillAmount !== 0)) {
          droppedAutoFillCount++;
        }
        const conditions = Array.isArray(p.renameConditions) ? p.renameConditions : [];
        for (const c of conditions) {
          if (c?.isTombstone) continue;
          const operator = typeof c?.operator === "string" ? c.operator.trim() : "";
          const operand = typeof c?.operand === "string" ? c.operand.trim() : "";
          if (!operator || !operand) {
            warnings.push(
              `Payee "${p.name.trim()}": skipped a rename condition with a missing operator or blank text (YNAB4 never matches those)`
            );
            continue;
          }
          if (operator.toLowerCase() !== "is") {
            warnings.push(
              `Payee "${p.name.trim()}": skipped rename condition with operator "${operator}" (operand "${operand}"); only "Is" maps to an exact rename rule`
            );
            continue;
          }
          if (isTransferPayee(operand)) {
            warnings.push(
              `Payee "${p.name.trim()}": skipped rename condition for transfer-like text "${operand}" (rename rules never apply to transfers)`
            );
            continue;
          }
          await db
            .insert(renameRules)
            .values({ sourcePattern: operand, targetPayee: p.name.trim(), createdAt: importedAt })
            .onConflictDoNothing();
        }
      }
      if (transferPayeeCount > 0) {
        warnings.push(
          `Skipped ${transferPayeeCount} transfer payee(s) (targetAccountId set); transfers are modeled via transferAccountId, not payee rows`
        );
      }
      if (droppedLocationCount > 0) {
        warnings.push(
          `Dropped ${droppedLocationCount} payee location(s) (YNAB4 map pins); there is no maps feature to hold them`
        );
      }
      if (droppedAutoFillCount > 0) {
        warnings.push(
          `Dropped default memo/amount autofill on ${droppedAutoFillCount} payee(s); only default categories are imported`
        );
      }
    }

    // 6. Compute real balances of accounts
    await recomputeAccountBalances(db);

    // 6b. Initialize Credit Card Payment category carryover from card starting balance if present
    for (const acc of creditAccounts) {
      // Check if carryover was already set from exported CC Payment category
      const [existingCat] = await db
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.groupId, ccGroup!.id),
            eq(categories.linkedAccountId, acc.id)
          )
        )
        .limit(1);

      if (existingCat && Number(existingCat.carryover) !== 0) {
        continue;
      }

      // Check opening debt via back-calculation: initialBalance = currentBalance - lifetimeDelta
      const [currAcc] = await db.select().from(accounts).where(eq(accounts.id, acc.id));
      const currentBal = Number(currAcc?.balance ?? 0);

      const outRes = await db
        .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, acc.id),
            isNull(transactions.parentId)
          )
        );
      const inRes = await db
        .select({ sum: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.transferAccountId, acc.id),
            isNotNull(transactions.transferAccountId),
            isNull(transactions.parentId)
          )
        );
      const lifetimeDelta = Number(outRes[0]?.sum || 0) - Number(inRes[0]?.sum || 0);
      const initialBalance = currentBal - lifetimeDelta;

      let openingDebt = 0;
      if (initialBalance < 0) {
        openingDebt = initialBalance;
      } else {
        // Find explicit starting balance transaction: match standard and multi-language starting payees
        const [startingTx] = await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.accountId, acc.id),
              isNull(transactions.parentId),
              isNull(transactions.transferAccountId),
              or(
                sql`lower(${transactions.payee}) like '%starting balance%'`,
                sql`lower(${transactions.payee}) like '%opening balance%'`,
                sql`lower(${transactions.payee}) like '%initial balance%'`,
                sql`lower(${transactions.payee}) like '%solde initial%'`,
                sql`lower(${transactions.payee}) like '%anfangssaldo%'`,
                sql`lower(${transactions.payee}) like '%saldo inicial%'`,
                sql`lower(${transactions.payee}) like '%saldo iniziale%'`,
                sql`lower(${transactions.payee}) like '%startsaldo%'`,
                sql`lower(${transactions.payee}) like '%beginsaldo%'`,
                sql`lower(${transactions.payee}) like '%debt balance%'`,
                sql`lower(${transactions.payee}) like '%old debt%'`,
                sql`lower(${transactions.payee}) like '%opening debt%'`
              )
            )
          )
          .orderBy(asc(transactions.date), asc(transactions.id))
          .limit(1);

        if (startingTx && Number(startingTx.amount) < 0) {
          openingDebt = Number(startingTx.amount);
        }
      }

      if (openingDebt < 0) {
        await db
          .update(categories)
          .set({ carryover: openingDebt })
          .where(
            and(
              eq(categories.groupId, ccGroup!.id),
              eq(categories.linkedAccountId, acc.id)
            )
          );
      }
    }

    // 7. Insert Scheduled (Recurring) Transactions
    // G-08: unknown frequencies warn instead of silently becoming
    // monthly; single-child scheduled splits collapse to plain rows
    // with a warning. Both aggregate so one exotic backup can't flood
    // the summary.
    const unknownFrequencies = new Map<string, number>();
    let collapsedSingleChildSplits = 0;
    for (const st of yScheduled) {
      if (st.isTombstone) continue;

      const accId = accountIdMap.get(st.accountId);
      if (!accId) continue;

      let payee = payeeMap.get(st.payeeId) || "";
      let recurringPayeeId: number | null = (st.payeeId && payeeDbIdMap.get(st.payeeId)) || null;
      let transferAccountId = st.targetAccountId ? accountIdMap.get(st.targetAccountId) || null : null;

      if (st.payeeId && st.payeeId.startsWith("Payee/Transfer:")) {
        const targetId = st.payeeId.split(":")[1];
        const foundTarget = targetId ? accountIdMap.get(targetId) : null;
        if (foundTarget) {
          transferAccountId = foundTarget;
          payee = "Transfer : " + (accNameMap.get(foundTarget) || "Unknown");
          recurringPayeeId = null;
        }
      }
      if (transferAccountId === accId) {
        transferAccountId = null;
      }

      const accIsOnBudget = accOnBudgetMap.get(st.accountId) ?? true;
      let catId = (accIsOnBudget && categoryIdMap.get(st.categoryId)) || null;
      if (
        st.categoryId === "Category/__ImmediateIncome__" ||
        st.categoryId === "Category/__DeferredIncome__" ||
        st.categoryId === "Category/__Split__"
      ) {
        catId = null;
      }

      const rawSubs = (st.subTransactions || []).filter((sub: any) => !sub.isTombstone);
      const nonZeroSubs = rawSubs.filter((sub: any) => convertAmount(sub.amount) !== 0);
      const hasSubs = nonZeroSubs.length >= 2;

      let parentAmount = convertAmount(st.amount);
      if (hasSubs) {
        catId = null;
        transferAccountId = null;
        // Rebalance parent amount to match the sum of sub-transactions to guarantee split balance invariant
        parentAmount = nonZeroSubs.reduce((sum: number, sub: any) => sum + convertAmount(sub.amount), 0);
      } else if (nonZeroSubs.length === 1) {
        // A single child is not a valid split; collapse to a regular recurring transaction
        collapsedSingleChildSplits++;
        const single = nonZeroSubs[0]!;
        parentAmount = convertAmount(single.amount);
        catId = (accIsOnBudget && categoryIdMap.get(single.categoryId)) || null;
        if (
          single.categoryId === "Category/__ImmediateIncome__" ||
          single.categoryId === "Category/__DeferredIncome__" ||
          single.categoryId === "Category/__Split__"
        ) {
          catId = null;
        }
        if (single.targetAccountId) {
          transferAccountId = accountIdMap.get(single.targetAccountId) || null;
        } else if (single.payeeId && single.payeeId.startsWith("Payee/Transfer:")) {
          const tid = single.payeeId.split(":")[1];
          transferAccountId = tid ? accountIdMap.get(tid) || null : null;
        }
        if (transferAccountId === accId) {
          transferAccountId = null;
        }
      }

      if (parentAmount === 0) {
        skippedDuplicates.push({
          accountName: accNameMap.get(accId) || "",
          date: st.date,
          payee,
          memo: st.memo || "",
          amount: 0,
          reason: "Zero-amount scheduled transaction",
        });
        continue;
      }

      if (transferAccountId != null) {
        const destAccEntity = st.targetAccountId || (st.payeeId?.startsWith("Payee/Transfer:") ? st.payeeId.split(":")[1] : "");
        const destIsOnBudget = destAccEntity ? (accOnBudgetMap.get(destAccEntity) ?? false) : (allAccountsForMap.find((a) => a.id === transferAccountId)?.onBudget ?? false);
        const isCross = accIsOnBudget !== destIsOnBudget;
        const netOnBudget = (accIsOnBudget ? parentAmount : 0) + (destIsOnBudget ? -parentAmount : 0);
        if (isCross) {
          if (netOnBudget < 0 && catId === null) {
            catId = await getOrCreateFallbackTransferCategory();
          }
        } else {
          catId = null;
        }
      }

      let rawFreq = (st.frequency || "monthly").toLowerCase().replace(/[\s_-]+/g, "");
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
        unknownFrequencies.set(st.frequency ?? "", (unknownFrequencies.get(st.frequency ?? "") ?? 0) + 1);
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
        for (const sub of nonZeroSubs) {
          let subCatId = (accIsOnBudget && categoryIdMap.get(sub.categoryId)) || null;
          if (
            sub.categoryId === "Category/__ImmediateIncome__" ||
            sub.categoryId === "Category/__DeferredIncome__" ||
            sub.categoryId === "Category/__Split__"
          ) {
            subCatId = null;
          }

          let subTransferAccountId: number | null = sub.targetAccountId
            ? accountIdMap.get(sub.targetAccountId) || null
            : null;
          if (sub.payeeId && sub.payeeId.startsWith("Payee/Transfer:")) {
            const targetId = sub.payeeId.split(":")[1];
            const foundTarget = targetId ? accountIdMap.get(targetId) : null;
            if (foundTarget) {
              subTransferAccountId = foundTarget;
            }
          }
          if (subTransferAccountId === accId) {
            subTransferAccountId = null;
          }

          const childAmt = convertAmount(sub.amount);
          if (subTransferAccountId != null) {
            const destAccEntity = sub.targetAccountId || (sub.payeeId?.startsWith("Payee/Transfer:") ? sub.payeeId.split(":")[1] : "");
            const destIsOnBudget = destAccEntity ? (accOnBudgetMap.get(destAccEntity) ?? false) : (allAccountsForMap.find((a) => a.id === subTransferAccountId)?.onBudget ?? false);
            const isCross = accIsOnBudget !== destIsOnBudget;
            const netOnBudget = (accIsOnBudget ? childAmt : 0) + (destIsOnBudget ? -childAmt : 0);
            if (isCross) {
              if (netOnBudget < 0 && subCatId === null) {
                subCatId = await getOrCreateFallbackTransferCategory();
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
      }
    }
    for (const [raw, count] of unknownFrequencies) {
      warnings.push(
        `Unknown scheduled frequency "${raw}" on ${count} schedule(s); falling back to monthly`
      );
    }
    if (collapsedSingleChildSplits > 0) {
      warnings.push(
        `Collapsed ${collapsedSingleChildSplits} single-child scheduled split(s) to plain recurring rows (YNAB4 splits need 2+ children)`
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
      accounts: accountIdMap.size,
      categoryGroups: groupSort,
      categories: categoryIdMap.size,
      transactions: totalImportedTxCount,
      settings: hasSettings ? settings : undefined,
      duplicatesSkipped: skippedDuplicates,
      warnings,
    };
    return result;
  });
}

export { recomputeAccountBalances } from "./queries/diagnostics.js";

