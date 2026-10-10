import type {
  Account,
  Assignment,
  BudgetData,
  Category,
  Payee,
  Recurring,
  RecurringSubTransaction,
  RenameRule,
  Transaction,
} from "./types.js";
import type {
  RenameSuggestResponse,
  RenameSuggestStatusResponse,
} from "./contracts.js";
import type { ReconcileState } from "./reconcile.js";
import { num } from "./format.js";

/**
 * Privacy (screenshot) mode: display-only disguises for amounts and names.
 *
 * Design notes:
 * - Amounts are multiplied by ONE random factor per budget, so arithmetic
 *   stays consistent (totals match rows, charts keep their shape). Scaled
 *   rows drift by pennies from scaled totals due to per-value rounding —
 *   acceptable for screenshots, never for real math.
 * - Names become deterministic, realistic-looking pseudonyms (payees
 *   from a fictional merchant pool, accounts from a fictional account
 *   pool) so the same entity looks the same on every screen and every
 *   reload — and screenshots read naturally.
 * - Category/group names are intentionally kept: they are the generic
 *   budget structure ("Groceries"), not personal data.
 * - Masked data must never be written back. The UI layer blocks all
 *   mutations while privacy mode is on.
 */

export const PRIVACY_FACTOR_MIN = 0.05;
export const PRIVACY_FACTOR_MAX = 20;

export function isPrivacyFactor(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= PRIVACY_FACTOR_MIN &&
    v <= PRIVACY_FACTOR_MAX
  );
}

/**
 * Scale integer cents by the disguise factor. Zero stays zero; non-zero
 * stays non-zero (clamped to ±1¢) so empty states and signs survive.
 */
export function scaleMaskedAmount(cents: number, factor: number): number {
  if (!Number.isFinite(cents) || cents === 0) return 0;
  const scaled = Math.round(cents * factor);
  if (scaled === 0) return cents < 0 ? -1 : 1;
  return scaled;
}

function scaleCentsString(s: string, factor: number): string {
  return String(scaleMaskedAmount(num(s), factor));
}

function scaleNullable(
  v: number | string | null | undefined,
  factor: number
): number | string | null | undefined {
  if (v == null) return v;
  if (typeof v === "number") return scaleMaskedAmount(v, factor);
  return scaleCentsString(v, factor);
}

/** Deterministic string hash (djb2) for stable fallback pseudonyms. */
function hashName(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Fictional merchant names for payee disguises. Deliberately generic —
 * no real brands. Assigned in budget order (see createPrivacyMask).
 */
export const PRIVACY_PAYEE_NAMES = [
  "Greenwood Market",
  "Bluebird Cafe",
  "Harbor Fuel",
  "Copper Kettle Diner",
  "Northgate Books",
  "Silverline Transit",
  "Maple Street Bakery",
  "Clearwater Utilities",
  "Foxglove Pharmacy",
  "Ember & Oak Grill",
  "Quickstop Mart",
  "Lakeshore Cinema",
  "Fernway Florist",
  "Ironhorse Hardware",
  "Moonbeam Laundry",
  "Cedar Point Dental",
  "Redwood Outfitters",
  "Starling Coffee",
  "Beacon Electronics",
  "Willow Creek Vet",
  "Golden Grain Grocer",
  "Night Owl Pizza",
  "Summit Fitness",
  "Paper Lantern Noodles",
  "Driftwood Shoes",
  "Honeybee Crafts",
  "Foxfire Gas",
  "Juniper Home Goods",
  "Cobalt Wireless",
  "Marigold Salon",
  "Stonebridge Deli",
  "Raincheck Auto Care",
  "Sunflower Nursery",
  "Old Mill Pub",
  "Cascade Bike Shop",
  "Velvet Bean Roasters",
  "Tidepool Aquarium",
  "Granite State Insurance",
  "Poppyseed Pantry",
  "Blackpine Motors",
  "Seaside Donuts",
  "Fox Hollow Inn",
  "Cinder & Smoke BBQ",
  "Larkspur Library",
  "Meadowlark Dairy",
  "Pinecone Stationery",
  "Riverbend Theater",
  "Sagebrush Spa",
  "Timberline Sports",
  "Wren House Goods",
  "Yellowfin Sushi",
  "Zinnia Gardens",
  "Alder Street Tacos",
  "Bramble Berry Farm",
  "Cloverleaf Cleaners",
  "Dogwood Donuts",
  "Elm Park Parking",
  "Frostline Plumbing",
  "Gables Guesthouse",
  "Hearthside Pizza",
  "Ivy Lane Boutique",
  "Jackrabbit Courier",
  "Kestrel Key Shop",
  "Lantern Light Power",
  "Moss & Stone Nursery",
  "Nettle Creek Cafe",
  "Osprey Optics",
  "Puddleduck Toys",
  "Quarry Road Supplies",
  "Ridgeline Rentals",
  "Saltbox Seafood",
  "Thistledown Tailor",
  "Umber Ultra Mart",
];

/** Fictional account names for account disguises. */
export const PRIVACY_ACCOUNT_NAMES = [
  "Everyday Chequing",
  "Daily Saver",
  "High-Interest Savings",
  "Emergency Fund",
  "Cash Wallet",
  "Travel Card",
  "Rewards Card",
  "Cashback Card",
  "Fuel Card",
  "Joint Chequing",
  "Holiday Fund",
  "Home Fund",
  "Car Fund",
  "Business Account",
  "Money Market",
  "Overdraft Line",
];

/**
 * Pick pool entry `index` (0-based), cycling with a numeric suffix past
 * the end of the pool so large budgets still get unique names.
 */
function poolName(pool: readonly string[], index: number): string {
  const base = pool[index % pool.length]!;
  const round = Math.floor(index / pool.length);
  return round === 0 ? base : `${base} ${round + 1}`;
}

export type PrivacyMask = {
  factor: number;
  scaleAmount: (cents: number) => number;
  /** Map a payee-ish display name to its pseudonym. Empty stays empty. */
  maskPayee: (name: string) => string;
  /** Map an account id to its pseudonym (pool order by id). */
  maskAccountName: (id: number) => string;
};

export type PrivacyMaskInput = Pick<
  BudgetData,
  "accounts" | "transactions" | "recurring" | "payees" | "renameRules"
>;

/**
 * Build the pseudonym mappings for one budget snapshot. Mappings derive
 * from sorted names/ids only, so they are stable across renders and
 * reloads for the same data + factor.
 */
export function createPrivacyMask(
  data: PrivacyMaskInput,
  factor: number
): PrivacyMask {
  const f = isPrivacyFactor(factor) ? factor : 1;
  const payeeNames = new Set<string>();
  for (const t of data.transactions) {
    if (t.payee) payeeNames.add(t.payee);
  }
  for (const r of data.recurring) {
    if (r.payee) payeeNames.add(r.payee);
  }
  for (const p of data.payees ?? []) {
    if (p.name) payeeNames.add(p.name);
  }
  for (const r of data.renameRules ?? []) {
    if (r.sourcePattern) payeeNames.add(r.sourcePattern);
    if (r.targetPayee) payeeNames.add(r.targetPayee);
  }
  const sorted = [...payeeNames].sort();
  const payeeIndex = new Map(sorted.map((name, i) => [name, i]));
  const maskPayee = (name: string): string => {
    if (!name) return name;
    const known = payeeIndex.get(name);
    if (known != null) return poolName(PRIVACY_PAYEE_NAMES, known);
    // Names outside the budget snapshot (rare): stable pool pick by
    // hash. May coincide with an assigned name; still a disguise.
    return PRIVACY_PAYEE_NAMES[hashName(name) % PRIVACY_PAYEE_NAMES.length]!;
  };
  const accountIds = data.accounts.map((a) => a.id).sort((a, b) => a - b);
  const accountIndex = new Map(accountIds.map((id, i) => [id, i]));
  const maskAccountName = (id: number): string => {
    const known = accountIndex.get(id);
    if (known != null) return poolName(PRIVACY_ACCOUNT_NAMES, known);
    return PRIVACY_ACCOUNT_NAMES[hashName(String(id)) % PRIVACY_ACCOUNT_NAMES.length]!;
  };
  return {
    factor: f,
    scaleAmount: (cents: number) => scaleMaskedAmount(cents, f),
    maskPayee,
    maskAccountName,
  };
}

function maskTransaction(t: Transaction, mask: PrivacyMask): Transaction {
  return {
    ...t,
    payee: mask.maskPayee(t.payee),
    memo: "",
    amount: scaleCentsString(t.amount, mask.factor),
  };
}

function maskRecurringSub(
  s: RecurringSubTransaction,
  mask: PrivacyMask
): RecurringSubTransaction {
  return {
    ...s,
    amount: scaleCentsString(s.amount, mask.factor),
    memo: "",
  };
}

function maskRecurring(
  r: Recurring & { subTransactions: RecurringSubTransaction[] },
  mask: PrivacyMask
): Recurring & { subTransactions: RecurringSubTransaction[] } {
  return {
    ...r,
    payee: mask.maskPayee(r.payee),
    memo: r.memo == null ? r.memo : "",
    amount: scaleCentsString(r.amount, mask.factor),
    subTransactions: r.subTransactions.map((s) => maskRecurringSub(s, mask)),
  };
}

function maskAccount(a: Account, mask: PrivacyMask): Account {
  return {
    ...a,
    name: mask.maskAccountName(a.id),
    balance: scaleCentsString(a.balance, mask.factor),
    lastReconciledBalance: scaleNullable(
      a.lastReconciledBalance,
      mask.factor
    ),
    notes: null,
  };
}

function maskCategory(c: Category, mask: PrivacyMask): Category {
  return {
    ...c,
    carryover: scaleCentsString(c.carryover, mask.factor),
    goalTarget:
      c.goalTarget == null
        ? null
        : scaleCentsString(c.goalTarget, mask.factor),
  };
}

function maskAssignment(a: Assignment, mask: PrivacyMask): Assignment {
  return { ...a, amount: scaleCentsString(a.amount, mask.factor) };
}

function maskRenameRule(r: RenameRule, mask: PrivacyMask): RenameRule {
  return {
    ...r,
    sourcePattern: mask.maskPayee(r.sourcePattern),
    targetPayee: mask.maskPayee(r.targetPayee),
  };
}

function maskPayeeRow(p: Payee, mask: PrivacyMask): Payee {
  return { ...p, name: mask.maskPayee(p.name) };
}

/**
 * Deep-copy a budget snapshot with amounts scaled and names replaced.
 * Ids, dates, statuses, flags, categories, and groups pass through
 * untouched so views, filters, and navigation keep working. The
 * precomputed budget index is dropped: the UI recomputes from the
 * masked rows instead.
 */
export function maskBudgetData(data: BudgetData, mask: PrivacyMask): BudgetData {
  return {
    ...data,
    accounts: data.accounts.map((a) => maskAccount(a, mask)),
    categories: data.categories.map((c) => maskCategory(c, mask)),
    assignments: data.assignments.map((a) => maskAssignment(a, mask)),
    transactions: data.transactions.map((t) => maskTransaction(t, mask)),
    recurring: data.recurring.map((r) => maskRecurring(r, mask)),
    budgetIndex: undefined,
    renameRules: data.renameRules?.map((r) => maskRenameRule(r, mask)),
    payees: data.payees?.map((p) => maskPayeeRow(p, mask)),
  };
}

/** Mask the uncovered-payee candidates of a suggest-status response. */
export function maskRenameSuggestStatus(
  status: RenameSuggestStatusResponse,
  mask: PrivacyMask
): RenameSuggestStatusResponse {
  return {
    ...status,
    candidates: status.candidates.map((c) => ({
      ...c,
      payee: mask.maskPayee(c.payee),
    })),
  };
}

/** Mask AI suggestions (patterns, targets, evidence memos, skipped sources). */
export function maskRenameSuggestResponse(
  res: RenameSuggestResponse,
  mask: PrivacyMask
): RenameSuggestResponse {
  return {
    ...res,
    suggestions: res.suggestions.map((s) => ({
      ...s,
      sourcePattern: mask.maskPayee(s.sourcePattern),
      targetPayee: mask.maskPayee(s.targetPayee),
      memos: s.memos?.map(() => ""),
    })),
    skipped: res.skipped.map((s) => ({
      ...s,
      source: mask.maskPayee(s.source),
    })),
  };
}

/** Mask the account name and balances of a reconcile-state response. */
export function maskReconcileState(
  state: ReconcileState,
  mask: PrivacyMask
): ReconcileState {
  return {
    ...state,
    accountName: mask.maskAccountName(state.accountId),
    workingBalance: mask.scaleAmount(state.workingBalance),
    unclearedTotal: mask.scaleAmount(state.unclearedTotal),
    lastReconciledBalance:
      state.lastReconciledBalance == null
        ? state.lastReconciledBalance
        : mask.scaleAmount(state.lastReconciledBalance),
  };
}
