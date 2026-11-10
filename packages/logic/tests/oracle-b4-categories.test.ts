/**
 * oracle-b4-categories.test.ts
 *
 * Oracle port: category/master-category domain mapped onto the fork's
 * BudgetData model (`packages/logic/src/types.ts`: CategoryGroup/Category),
 * `computeBudget`/`normalizeBudgetData` group handling, split detection,
 * income classification, rename-rule priority, and search category filters.
 *
 * Sources:
 * - ynab4-modern/packages/domain/src/Category.test.ts:28-54 (CategoryType
 *   getEnumByName exact/ci/cs/miss), :56-148 (defaults, trim, deleteable,
 *   sortableIndex trunc, note cleanup, VO round-trip, toString, ICategory).
 * - ynab4-modern/packages/domain/src/MasterCategory.test.ts:73-270
 *   (defaults, entityType, createFromVO arg order, hidden-master
 *   deleteable=false, "MasterCategory name cannot be empty", VO type
 *   fallback, ReadAggregateChildrenFromVO gate, populateVO).
 * - ynab4-modern/packages/domain/src/MasterCategoryList.test.ts:91-668
 *   (built-ins, name guard, sort/order, isSpecial/getNthNonSpecial, finders,
 *   add/remove/delete, hide/unhide, pre-YNAB-debt, bulk renames, full-name
 *   switch, hidden-name standardization).
 * - ynab4-modern/packages/domain/src/SubCategory.test.ts:71-259 (parent
 *   wiring, fullName/displayName/exportName, rename/re-parent refresh,
 *   null-name, isHidden, mangled hidden names + verbatim throws,
 *   equals/compareTo, populateFromVO/VO).
 * - ynab4-modern/packages/domain/src/entityLists.test.ts:106-431
 *   (SubCategoryList finders + null-query quirk, account partitioner,
 *   month manager incl Dec->Jan boundary).
 * - ynab4-modern/packages/domain/src/hiddenCategories.test.ts:35-268
 *   (descriptor, mangle round-trip + verbatim throws, grouping/sorting,
 *   unhide delegation).
 * - ynab4-modern/packages/domain/src/smallEntities.test.ts:41-269
 *   (IComparable/IEquatable/INote, SplitSubCategory.isSplit,
 *   InflowMonthOffset + getEnumByName, InflowSubCategory forced INFLOW +
 *   getInflowDisplayName incl Dec wrap + unknown->"", Uncategorized master,
 *   PreviousMonthChangedEvent, ExistingTransactionsAffectedByRule).
 *
 * Mapping notes (FORKs — deliberate non-ports):
 * - No CategoryType enum / `type` field: every fork category is
 *   outflow-like; income is uncategorised-positive. Type lookup maps to
 *   exact-only, case-folded category matching (`matchesFilter`).
 * - No name trimming, no note field, no sortableIndex truncation, no
 *   deleteable flag, no toString shape, no VO/store layer (SQLite
 *   persistence owns that — N/A from `packages/logic`).
 * - No built-in __Income__/__Internal__/__Hidden__/__PreYNABDebt__ masters
 *   and no backtick-mangled hidden names: hidden state is the single
 *   `CategoryGroup.isHidden` flag; hidden rows are NOT excluded from
 *   `computeBudget`. Pre-YNAB debt is replaced by the automatic CC buffer
 *   machine (`budget-engine.ts:31-45`).
 * - incomeMonth is an opaque "YYYY-MM" superset (not CurrentMonth/
 *   NextMonth singletons); December->January wrapping has no display-name
 *   counterpart here. Verbatim oracle error strings below are inline
 *   characterizations of the oracle wording, not prod-code throws.
 */
import { describe, expect, it } from "vitest";
import {
  computeBudget,
  getMonthsWithData,
  isIncomeTransaction,
  normalizeBudgetData,
} from "../src/budget-engine.js";
import { applyRenameRules } from "../src/rename-rules.js";
import {
  buildSearchCtx,
  matchesFilter,
} from "../src/searchQuery.js";
import { isSplitChild, isSplitParent } from "../src/split.js";
import { classifyBoundaryTransfer } from "../src/transfers.js";
import type {
  Account,
  BudgetData,
  Category,
  CategoryGroup,
  RenameRule,
  Transaction,
} from "../src/types.js";

function emptyData(): BudgetData {
  return {
    accounts: [],
    groups: [],
    categories: [],
    assignments: [],
    transactions: [],
    recurring: [],
  };
}

function makeGroup(overrides: Partial<CategoryGroup> = {}): CategoryGroup {
  return {
    id: 1,
    name: "Everyday",
    sort: 0,
    isCreditCardPayments: false,
    ...overrides,
  };
}

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 1,
    groupId: 1,
    name: "Groceries",
    sort: 0,
    carryover: "0",
    goalTarget: null,
    linkedAccountId: null,
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: "Checking",
    kind: "liquid",
    groupLabel: "Cash",
    balance: "0",
    onBudget: true,
    sort: 0,
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    accountId: 1,
    categoryId: 1,
    date: "2012-05-03",
    payee: "Store",
    memo: "",
    amount: "-100",
    status: "c",
    ...overrides,
  };
}

function dataWithEveryday(): BudgetData {
  return {
    ...emptyData(),
    accounts: [makeAccount()],
    groups: [makeGroup()],
    categories: [makeCategory()],
    transactions: [makeTx()],
  };
}

describe("Category shape (oracle: Category.test.ts)", () => {
  it("has fork defaults and no oracle-only keys (type/deleteable/note/sortableIndex)", () => {
    const c = makeCategory();
    expect(c.carryover).toBe("0");
    expect(c.goalTarget).toBeNull();
    expect(c.linkedAccountId).toBeNull();
    expect("type" in c).toBe(false);
    expect("deleteable" in c).toBe(false);
    expect("note" in c).toBe(false);
    expect("sortableIndex" in c).toBe(false);
  });

  it("FORK: names are preserved verbatim — no trim (server stores String(name))", () => {
    const data = dataWithEveryday();
    data.groups = [makeGroup({ name: "  Bills  " })];
    data.categories = [makeCategory({ name: "  Dining  " })];
    const result = computeBudget(data, "2012-05");
    expect(result.groups[0]!.group.name).toBe("  Bills  ");
    expect(result.groups[0]!.rows[0]!.category.name).toBe("  Dining  ");
  });

  it("OUTFLOW-default N/A: income is uncategorised-positive, not a type flag", () => {
    const accounts = [makeAccount()];
    expect(
      isIncomeTransaction(makeTx({ categoryId: null, amount: "5000" }), accounts),
    ).toBe(true);
    expect(
      isIncomeTransaction(makeTx({ categoryId: 1, amount: "5000" }), accounts),
    ).toBe(false);
  });

  it("sort is numeric (fractional sorts order between integers, no int truncation)", () => {
    const data = dataWithEveryday();
    data.groups = [
      makeGroup({ id: 1, name: "B", sort: 2 }),
      makeGroup({ id: 2, name: "A", sort: 0.5 }),
      makeGroup({ id: 3, name: "C", sort: 1 }),
    ];
    data.categories = [];
    const result = computeBudget(data, "2012-05");
    expect(result.groups.map((g) => g.group.name)).toEqual(["A", "C", "B"]);
  });

  it("round-trips through JSON with exact field names (VO layer N/A: SQLite owns it)", () => {
    const c = makeCategory({ id: 9, name: "Bills" });
    const back = JSON.parse(JSON.stringify(c)) as Category;
    expect(back).toEqual({
      id: 9,
      groupId: 1,
      name: "Bills",
      sort: 0,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: null,
    });
  });

  it("CategoryType.getEnumByName maps to exact-only, case-folded category matching", () => {
    const ctx = buildSearchCtx(dataWithEveryday());
    const tx = makeTx({ categoryId: 1 });
    expect(matchesFilter(tx, { kind: "category", value: "groceries", exact: true }, ctx)).toBe(true);
    expect(matchesFilter(tx, { kind: "category", value: "GROCERIES", exact: true }, ctx)).toBe(true);
    expect(matchesFilter(tx, { kind: "category", value: "rocer", exact: true }, ctx)).toBe(false);
    expect(matchesFilter(tx, { kind: "category", value: "rocer" }, ctx)).toBe(true);
    expect(matchesFilter(tx, { kind: "category", value: "Missing", exact: true }, ctx)).toBe(false);
  });
});

describe("MasterCategory -> group CRUD (oracle: MasterCategory.test.ts)", () => {
  it("groups default to non-CC, non-hidden", () => {
    const g = makeGroup();
    expect(g.isCreditCardPayments).toBe(false);
    expect(g.isHidden ?? false).toBe(false);
  });

  it("hidden groups keep their flag and still aggregate (single isHidden flag, no hidden master)", () => {
    const data = dataWithEveryday();
    data.groups = [makeGroup({ isHidden: true })];
    const norm = normalizeBudgetData(data);
    expect(norm.groups[0]!.isHidden).toBe(true);
    const result = computeBudget(data, "2012-05");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.rows).toHaveLength(1);
    expect(result.groups[0]!.outflow).toBe(-100);
  });

  it("FORK: no verbatim empty-name throw — empty group names render as-is", () => {
    const data = dataWithEveryday();
    data.groups = [makeGroup({ name: "" })];
    const result = computeBudget(data, "2012-05");
    expect(result.groups[0]!.group.name).toBe("");
  });

  it("store-VO N/A: BudgetData JSON round-trip preserves groups/categories", () => {
    const back = JSON.parse(JSON.stringify(dataWithEveryday())) as BudgetData;
    expect(back.groups).toHaveLength(1);
    expect(back.categories[0]).toMatchObject({ id: 1, groupId: 1, name: "Groceries" });
  });

  it("aggregate gate N/A: children always join by groupId; removal drops the row", () => {
    const data = dataWithEveryday();
    data.categories = [makeCategory({ id: 1 }), makeCategory({ id: 2, name: "Dining", sort: 1 })];
    data.transactions = [makeTx({ id: 1, categoryId: 1 }), makeTx({ id: 2, categoryId: 2 })];
    let result = computeBudget(data, "2012-05");
    expect(result.groups[0]!.rows.map((r) => r.category.name)).toEqual(["Groceries", "Dining"]);
    data.categories = data.categories.filter((c) => c.id !== 2);
    data.transactions = data.transactions.filter((t) => t.categoryId !== 2);
    result = computeBudget(data, "2012-05");
    expect(result.groups[0]!.rows.map((r) => r.category.name)).toEqual(["Groceries"]);
  });
});

describe("MasterCategoryList -> ordering/find/delete (oracle: MasterCategoryList.test.ts)", () => {
  it("FORK built-ins: no __Income__/__Internal__/__Hidden__ masters; CC group synthesised only for CC accounts", () => {
    expect(normalizeBudgetData(emptyData()).groups).toEqual([]);
    const withCC: BudgetData = {
      ...emptyData(),
      accounts: [makeAccount({ id: 7, name: "Visa", kind: "credit" })],
    };
    const norm = normalizeBudgetData(withCC);
    expect(norm.groups.map((g) => g.name)).toEqual(["Credit Card Payments"]);
    expect(norm.groups[0]!.isCreditCardPayments).toBe(true);
    const names = norm.groups.map((g) => g.name).join("|");
    expect(names).not.toContain("Pre-YNAB");
  });

  it("CC synthesis links one payment category per on-budget credit account", () => {
    const withCC: BudgetData = {
      ...emptyData(),
      accounts: [makeAccount({ id: 7, name: "Visa", kind: "credit" })],
    };
    const norm = normalizeBudgetData(withCC);
    const cat = norm.categories.find((c) => c.linkedAccountId === 7);
    expect(cat).toBeDefined();
    expect(cat!.name).toBe("Visa");
    expect(cat!.carryover).toBe("0");
    expect(cat!.groupId).toBe(norm.groups[0]!.id);
  });

  it("orders groups by sort, categories within a group by sort", () => {
    const data = dataWithEveryday();
    data.groups = [makeGroup({ id: 1, name: "B", sort: 2 }), makeGroup({ id: 2, name: "A", sort: 1 })];
    data.categories = [
      makeCategory({ id: 1, groupId: 2, name: "Second", sort: 1 }),
      makeCategory({ id: 2, groupId: 2, name: "First", sort: 0 }),
    ];
    const result = computeBudget(data, "2012-05");
    expect(result.groups.map((g) => g.group.name)).toEqual(["A", "B"]);
    expect(result.groups[0]!.rows.map((r) => r.category.name)).toEqual(["First", "Second"]);
  });

  it("finds by category name or master (group) name, case-insensitively", () => {
    const ctx = buildSearchCtx(dataWithEveryday());
    const tx = makeTx({ categoryId: 1 });
    expect(matchesFilter(tx, { kind: "category", value: "everyday", exact: true }, ctx)).toBe(true);
    expect(matchesFilter(tx, { kind: "category", value: "EVERYDAY" }, ctx)).toBe(true);
  });

  it("misses cleanly; unknown category ids read as uncategorised", () => {
    const ctx = buildSearchCtx(dataWithEveryday());
    const tx = makeTx({ categoryId: 999 });
    expect(matchesFilter(tx, { kind: "category", value: "Groceries", exact: true }, ctx)).toBe(false);
    expect(matchesFilter(tx, { kind: "category", value: "uncategorized", exact: true }, ctx)).toBe(true);
  });

  it("hide/unhide analogue: toggling isHidden never drops rows", () => {
    const data = dataWithEveryday();
    const before = computeBudget(data, "2012-05").groups[0]!.rows.length;
    data.groups = [makeGroup({ isHidden: true })];
    const hidden = computeBudget(data, "2012-05").groups[0]!.rows.length;
    data.groups = [makeGroup({ isHidden: false })];
    const restored = computeBudget(data, "2012-05").groups[0]!.rows.length;
    expect([before, hidden, restored]).toEqual([1, 1, 1]);
  });

  it("delete analogue: dropping a group removes its GroupRow (guard lives in server deleteCategoryGroup)", () => {
    const data = dataWithEveryday();
    expect(computeBudget(data, "2012-05").groups).toHaveLength(1);
    data.groups = [];
    data.categories = [];
    expect(computeBudget(data, "2012-05").groups).toHaveLength(0);
  });
});

describe("SubCategory -> wiring (oracle: SubCategory.test.ts)", () => {
  it("wires parent via groupId (full-name analogue: Group + Category pair)", () => {
    const ctx = buildSearchCtx(dataWithEveryday());
    expect(ctx.categoryById.get(1)).toEqual({ name: "Groceries", groupName: "Everyday" });
  });

  it("reflects renames on a fresh context (rename refresh)", () => {
    const data = dataWithEveryday();
    data.categories = [makeCategory({ name: "Dining Out" })];
    expect(buildSearchCtx(data).categoryById.get(1)).toEqual({
      name: "Dining Out",
      groupName: "Everyday",
    });
  });

  it("reflects re-parenting on a fresh context", () => {
    const data = dataWithEveryday();
    data.groups = [makeGroup({ id: 1, name: "Everyday" }), makeGroup({ id: 2, name: "Bills", sort: 1 })];
    data.categories = [makeCategory({ groupId: 2 })];
    expect(buildSearchCtx(data).categoryById.get(1)).toEqual({
      name: "Groceries",
      groupName: "Bills",
    });
  });

  it("null category reads as uncategorised with an empty master (null-name edge)", () => {
    const ctx = buildSearchCtx(dataWithEveryday());
    const tx = makeTx({ categoryId: null, transferAccountId: null });
    expect(matchesFilter(tx, { kind: "category", value: "uncategorized", exact: true }, ctx)).toBe(true);
    expect(matchesFilter(tx, { kind: "category", value: "Everyday", exact: true }, ctx)).toBe(false);
  });

  it("mangled hidden names N/A: backticks pass through verbatim; isHidden lives on the group", () => {
    const data = dataWithEveryday();
    data.categories = [makeCategory({ name: "Bills ` Groceries ` mc-1" })];
    const result = computeBudget(data, "2012-05");
    expect(result.groups[0]!.rows[0]!.category.name).toBe("Bills ` Groceries ` mc-1");
    expect("isHidden" in makeCategory()).toBe(false);
  });
});

describe("entityLists -> queries (oracle: entityLists.test.ts)", () => {
  it('null-query quirk N/A (SQLite store-list): null categoryId reads as "uncategorized"', () => {
    const ctx = buildSearchCtx(dataWithEveryday());
    expect(matchesFilter(makeTx({ categoryId: null }), { kind: "category", value: "uncategorized", exact: true }, ctx)).toBe(true);
  });

  it("attributes outflows by month across the Dec->Jan boundary", () => {
    const data = dataWithEveryday();
    data.transactions = [
      makeTx({ id: 1, date: "2012-12-15", amount: "-100" }),
      makeTx({ id: 2, date: "2013-01-10", amount: "-200" }),
    ];
    expect(computeBudget(data, "2012-12").groups[0]!.outflow).toBe(-100);
    expect(computeBudget(data, "2013-01").groups[0]!.outflow).toBe(-200);
  });

  it("live add/remove analogue: recompute reflects dataset edits (no observable store)", () => {
    const base = dataWithEveryday();
    expect(computeBudget(base, "2012-05").groups[0]!.outflow).toBe(-100);
    // The engine memoizes per BudgetData identity, so each edit is a fresh
    // object (mirroring immutable store updates), not an in-place mutation.
    const added: BudgetData = {
      ...base,
      transactions: [...base.transactions, makeTx({ id: 2, amount: "-50" })],
    };
    expect(computeBudget(added, "2012-05").groups[0]!.outflow).toBe(-150);
    const cleared: BudgetData = { ...base, transactions: [] };
    expect(computeBudget(cleared, "2012-05").groups[0]!.outflow).toBe(0);
  });

  it("getMonthsWithData lists unique sorted months including incomeMonth keys", () => {
    const data = dataWithEveryday();
    data.transactions = [
      makeTx({ id: 1, date: "2012-05-03", incomeMonth: "2012-06" }),
      makeTx({ id: 2, date: "2012-04-01" }),
    ];
    expect(getMonthsWithData(data)).toEqual(["2012-04", "2012-05", "2012-06"]);
  });
});

describe("hiddenCategories (oracle: hiddenCategories.test.ts)", () => {
  function mangle(oldMaster: string, sub: string, id: string | null): string {
    if (oldMaster.includes("`")) {
      throw new Error(
        "Can't mangle a masterCategory that already contains a ` in its name: " + oldMaster,
      );
    }
    if (sub.includes("`")) {
      throw new Error(
        "Can't mangle a subCategoryName that already contains a ` in its name: " + sub,
      );
    }
    if (id != null && id.includes("`")) {
      throw new Error(
        "Can't mangle a masterCategoryId that already contains a ` in its name: " + id,
      );
    }
    return id == null ? oldMaster + " ` " + sub : oldMaster + " ` " + sub + " ` " + id;
  }

  function parseMangled(mangled: string): { oldMaster: string; sub: string; id: string | null } {
    const parts = mangled.split(" ` ");
    if (parts.length === 2) return { oldMaster: parts[0]!, sub: parts[1]!, id: null };
    if (parts.length === 3) return { oldMaster: parts[0]!, sub: parts[1]!, id: parts[2]! };
    throw new Error(
      "Expected a mangled Subcategory of the form: 'OldMasterName ` SubName ', " +
        "optionally followed by ` OldMasterGUID. Instead received : " +
        mangled,
    );
  }

  it("descriptor N/A: hidden state is the group isHidden boolean", () => {
    expect(makeGroup({ isHidden: true }).isHidden).toBe(true);
    expect(makeGroup().isHidden ?? false).toBe(false);
  });

  it("inline mangle round-trips 3-part and legacy 2-part forms", () => {
    expect(mangle("Bills", "Groceries", "mc-1")).toBe("Bills ` Groceries ` mc-1");
    expect(parseMangled("Bills ` Groceries ` mc-1")).toEqual({
      oldMaster: "Bills",
      sub: "Groceries",
      id: "mc-1",
    });
    expect(parseMangled("Bills ` Groceries")).toEqual({
      oldMaster: "Bills",
      sub: "Groceries",
      id: null,
    });
  });

  it("inline: verbatim throws for backtick components", () => {
    expect(() => mangle("Bi`lls", "Groceries", "mc-1")).toThrow(
      "Can't mangle a masterCategory that already contains a ` in its name: Bi`lls",
    );
    expect(() => mangle("Bills", "Gro`ceries", "mc-1")).toThrow(
      "Can't mangle a subCategoryName that already contains a ` in its name: Gro`ceries",
    );
    expect(() => mangle("Bills", "Groceries", "mc`1")).toThrow(
      "Can't mangle a masterCategoryId that already contains a ` in its name: mc`1",
    );
  });

  it("inline: verbatim throw for malformed mangled names", () => {
    expect(() => parseMangled("Bills")).toThrow(
      "Expected a mangled Subcategory of the form: 'OldMasterName ` SubName ', " +
        "optionally followed by ` OldMasterGUID. Instead received : Bills",
    );
    expect(() => parseMangled("a ` b ` c ` d")).toThrow("Instead received : a ` b ` c ` d");
  });

  it("unhide delegation N/A (SQLite): clearing isHidden restores the model flag", () => {
    const data = dataWithEveryday();
    data.groups = [makeGroup({ isHidden: true })];
    expect(normalizeBudgetData(data).groups[0]!.isHidden).toBe(true);
    data.groups = [makeGroup({ isHidden: false })];
    expect(normalizeBudgetData(data).groups[0]!.isHidden).toBe(false);
  });
});

describe("smallEntities (oracle: smallEntities.test.ts)", () => {
  it("detects splits via parentId (SplitSubCategory.isSplit analogue)", () => {
    const parent = makeTx({ id: 1, parentId: null });
    const childA = makeTx({ id: 2, parentId: 1, categoryId: 1, amount: "-60" });
    const childB = makeTx({ id: 3, parentId: 1, categoryId: 1, amount: "-40" });
    const lone = makeTx({ id: 4, parentId: null });
    const all = [parent, childA, childB, lone];
    expect(isSplitChild(childA)).toBe(true);
    expect(isSplitChild(parent)).toBe(false);
    expect(isSplitParent(parent, all)).toBe(true);
    expect(isSplitParent(lone, all)).toBe(false);
    expect(isSplitParent(childA, all)).toBe(false);
  });

  it("incomeMonth superset: arbitrary YYYY-MM passes through boundary classification", () => {
    const inflow = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: false,
      amount: 100,
      categoryId: null,
      incomeMonth: "2031-05",
    });
    expect(inflow.isIncome).toBe(true);
    expect(inflow.incomeMonth).toBe("2031-05");
    const dec = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: false,
      amount: 100,
      categoryId: null,
      incomeMonth: "2012-12",
    });
    expect(dec.incomeMonth).toBe("2012-12");
    const internal = classifyBoundaryTransfer({
      srcOnBudget: true,
      destOnBudget: true,
      amount: 100,
      incomeMonth: "2012-12",
    });
    expect(internal.isBoundaryCrossing).toBe(false);
    expect(internal.incomeMonth).toBeNull();
  });

  it("forced-INFLOW/Dec-wrap display N/A: December income counts in December, unknown offsets collapse to null", () => {
    const accounts = [makeAccount()];
    expect(
      isIncomeTransaction(makeTx({ categoryId: null, amount: "5000", date: "2012-12-03" }), accounts),
    ).toBe(true);
    const data = dataWithEveryday();
    data.transactions = [makeTx({ categoryId: null, amount: "5000", incomeMonth: null })];
    expect(computeBudget(data, "2012-05").totalIncome).toBe(5000);
  });

  it("uncategorized master analogue: positive on-budget income only", () => {
    const accounts = [makeAccount(), makeAccount({ id: 2, name: "Off", kind: "liquid", onBudget: false })];
    const income = (over: Partial<Transaction>) => isIncomeTransaction(makeTx(over), accounts);
    expect(income({ categoryId: null, amount: "1" })).toBe(true);
    expect(income({ categoryId: null, amount: "0" })).toBe(false);
    expect(income({ categoryId: null, amount: "-1" })).toBe(false);
    expect(income({ categoryId: null, amount: "1", accountId: 2 })).toBe(false);
    expect(income({ categoryId: 1, amount: "1", accountId: 2 })).toBe(false);
  });

  it("rename rules: empty passthrough, exact case-insensitive match, trim", () => {
    expect(applyRenameRules([], "  BCF1  ")).toBe("  BCF1  ");
    const rules: RenameRule[] = [
      { id: 1, sourcePattern: "BCF1", targetPayee: "BC Ferries", createdAt: "2024-01-01" },
    ];
    expect(applyRenameRules(rules, "bcf1")).toBe("BC Ferries");
    expect(applyRenameRules(rules, "BCF2")).toBe("BCF2");
  });

  it("rename priority: exact beats newer patterns; newer patterns beat older ones", () => {
    const rules: RenameRule[] = [
      { id: 1, sourcePattern: "BCF[N]", targetPayee: "Old Pattern", createdAt: "2024-01-01" },
      { id: 2, sourcePattern: "BCF1", targetPayee: "Exact", createdAt: "2024-01-01" },
      { id: 3, sourcePattern: "BCF[N]", targetPayee: "New Pattern", createdAt: "2024-06-01" },
    ];
    expect(applyRenameRules(rules, "BCF1")).toBe("Exact");
    const patternsOnly = rules.filter((r) => r.id !== 2);
    expect(applyRenameRules(patternsOnly, "BCF12")).toBe("New Pattern");
  });
});
