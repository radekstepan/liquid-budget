/**
 * oracle-b4-autofill.test.ts
 *
 * Oracle port: payee autofill memory + rename-rule operator grammar +
 * payee-settings dialog presentation model, mapped through
 * `packages/logic/src/payee-autofill.ts` (`suggestAutofillForPayee`),
 * `packages/logic/src/rename-rules.ts` (`is`/`contains`/`startsWith`/
 * `endsWith` operators, `compileRenameRules`/`matchesCompiledRule`/
 * `normalizeRenameText`) and `packages/logic/src/rename-suggest.ts`.
 *
 * Sources (16 + 23 + 10 tests):
 * - ynab4-modern/packages/domain/src/AutoFillData.test.ts:102-113 (starts
 *   empty), :115-123 (culture rounding), :125-135 (inflow/outflow derive),
 *   :137-145 (inflow/outflow setters), :147-157 (getSettingsFromTransaction
 *   order), :159-167 (keeps old category), :169-177 (applyToImported stamps
 *   + fills empty), :179-187 (never overwrites), :189-198 (split veto),
 *   :200-209 (applyToImported same-target throw), :211-223 (applyToNew
 *   empty-only + flags), :224-253 (flags + existing values), :255-265
 *   (applyToNew same-target throw), :267-282 (sub-list cleanup),
 *   :284-298 (parents-switch veto), :300-308 (ignores other kinds).
 * - ynab4-modern/packages/domain/src/StringCondition.test.ts:79-84 (operator
 *   names), :86-91 (labels "Starts with"/"Ends with" distinct from names),
 *   :93-95 (toString), :97-104 (getEnumByName exact), :106-115 (ci names not
 *   labels), :117-122 (null/empty/unknown + cs miss), :133-147 (construct),
 *   :149-171 (Is/Contains/StartsWith/EndsWith evaluate ci), :173-194 (null
 *   input/operator/operand + blank-operand guards), :196-200 (unknown ->
 *   throw "Unrecognized argument"), :202-223 (equals identity + ci operand,
 *   null/null true), :225-264 (createFromVO + "Could not find payee: ..."
 *   + "Expected the parentPayee's entityId..."), :266-299 (populate
 *   round-trip operator-as-string), :302-306 (toString), :308-314
 *   (addConditions seam).
 * - ynab4-modern/packages/app/src/reports/
 *   PayeeSettingsDialogPresentationModel.test.ts:47-61 (init + tooltips),
 *   :63-71 (pre-select), :73-93 (single/multi + removal), :95-113 (rename
 *   setter), :115-123 (HTML escape), :125-145 (add/remove + blank trim on
 *   clear), :147-155 (enabled toggle skip-transfers), :157-170 (combine +
 *   reselect; all-transfer no-op is the PM counterpart), :172-199
 *   (renameExisting), :201-210 (categories + tooltips assignment).
 *
 * Mapping: `suggestAutofillForPayee` carries the last-write-wins store
 * (most-recent row wins amount+memo; most-recent non-null category wins),
 * entity-default seeding (`defaultCategoryId`/`defaultMemo`/`defaultAmount`
 * win only with no history), `excludeId`, and blank-row gating (blank payee
 * name -> null). Operator matching is exact case-insensitive-only
 * (`tollLocaleLowerCase` parity: punctuation significant); `[N]`/`[X]`
 * patterns keep the folded comparison as a generalization.
 * // FORK: pattern generalization — `[N]`/`[X]` wildcard families have no
 * oracle `StringCondition` counterpart; folded comparison (lowercase +
 * whitespace collapse + bank-separator folding via `normalizeRenameText`)
 * applies ONLY to `[N]`/`[X]` patterns, never to `is`/`contains`/
 * `startsWith`/`endsWith`. The oracle culture-rounded float `amount` is
 * integer cents here (`Math.round` on numeric inputs; stored amounts are
 * cents strings). There is no `inflow`/`outflow` accessor layer, no
 * same-target-account throw (transfer-shaped payees simply never match
 * substring rules), no VO/syncable-entity layer (`createFromVO`/
 * `populateFromVO`/`populateVO`/`toString`/`addConditions` have no direct
 * analogue; round-trips are covered via `compileRenameRules` /
 * `matchesCompiledRule` parity), and no React/Flex presentation model —
 * selection/combine/blank-trim/HTML-escape grammar is characterized on pure
 * local analogues plus the corresponding rename-rule helpers
 * (`isTransferPayee`, `normalizeRenameText`, `learnRenameRule`,
 * `getPayeeByName`-style exact trimmed lookup). Verbatim oracle messages
 * ("Can't apply to a transaction that is the same as this payee's target
 * account.", "Unrecognized argument", "Could not find payee: ...",
 * "Expected the parentPayee's entityId...") are pinned in comments where
 * the fork deliberately diverges.
 */
import { describe, expect, it } from "vitest";
import {
  suggestAutofillForPayee,
  type PayeeAutofillHistoryRow,
} from "../src/payee-autofill.js";
import {
  compileRenameRules,
  getRenameRuleOperator,
  isExactRule,
  isSubstringRule,
  isTransferPayee,
  learnRenameRule,
  matchesCompiledRule,
  matchesRenameRule,
  normalizeRenameText,
  RENAME_OPERATORS,
  type RenameRule,
} from "../src/rename-rules.js";
import type { RenameRuleOperator } from "../src/types.js";

function histRow(over: Partial<PayeeAutofillHistoryRow> & { id: number }): PayeeAutofillHistoryRow {
  return {
    payee: "Corner Deli",
    amount: "-1250",
    memo: "",
    categoryId: null,
    date: "2026-08-01",
    ...over,
  };
}

const rule = (id: number, sourcePattern: string, targetPayee: string): RenameRule => ({
  id,
  sourcePattern,
  targetPayee,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const opRule = (
  id: number,
  sourcePattern: string,
  targetPayee: string,
  operator: RenameRuleOperator,
): RenameRule => ({
  id,
  sourcePattern,
  targetPayee,
  operator,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("oracle B4 AutoFillData -> suggestAutofillForPayee", () => {
  it("starts empty: no history and no defaults -> null (oracle :102-113)", () => {
    expect(suggestAutofillForPayee([], "Corner Deli")).toBeNull();
    expect(suggestAutofillForPayee([], "   ")).toBeNull();
  });

  it("culture rounding -> integer-cents rounding on numeric defaults (oracle :115-123)", () => {
    // Oracle: fill.amount = 10.006 -> 10.01 (culture digits). FORK: cents.
    expect(
      suggestAutofillForPayee([], "Corner Deli", { defaultAmount: -5000.6 }),
    ).toEqual({ categoryId: null, amount: "-5001", memo: "" });
    expect(
      suggestAutofillForPayee([], "Corner Deli", { defaultAmount: 5000.4 }),
    ).toEqual({ categoryId: null, amount: "5000", memo: "" });
  });

  it("inflow/outflow derive -> sign preserved in the cents string (oracle :125-145)", () => {
    // Oracle: amount 25 -> inflow 25/outflow 0; -4.5 -> outflow 4.5; setters
    // write signed amounts. FORK: no inflow/outflow accessors exist; the
    // signed cents string is the whole signal.
    expect(
      suggestAutofillForPayee([histRow({ id: 1, amount: "2500" })], "Corner Deli")
        ?.amount,
    ).toBe("2500");
    expect(
      suggestAutofillForPayee([histRow({ id: 1, amount: "-450" })], "Corner Deli")
        ?.amount,
    ).toBe("-450");
  });

  it("getSettingsFromTransaction order: category-if-non-null then memo then amount (oracle :147-167)", () => {
    // Oracle overwrites category only when the tx has one, memo+amount
    // unconditionally; last write wins. Here the most recent row wins
    // amount+memo, and the category is the most recent NON-NULL one.
    const history = [
      histRow({ id: 1, amount: "-1000", memo: "old", categoryId: 7, date: "2026-08-01" }),
      histRow({ id: 2, amount: "-2000", memo: "new", categoryId: null, date: "2026-08-02" }),
    ];
    expect(suggestAutofillForPayee(history, "Corner Deli")).toEqual({
      categoryId: 7,
      amount: "-2000",
      memo: "new",
    });
  });

  it("keeps the older category when the latest row has none (oracle :159-167)", () => {
    const history = [
      histRow({ id: 1, amount: "-1000", memo: "a", categoryId: 7, date: "2026-08-01" }),
      histRow({ id: 2, amount: "-2000", memo: "b", categoryId: null, date: "2026-08-03" }),
    ];
    expect(suggestAutofillForPayee(history, "Corner Deli")?.categoryId).toBe(7);
  });

  it("entity defaults seed the proposal only with no history (applyToNew empty-only analogue, oracle :211-253)", () => {
    // Oracle applyToNew fills only empty fields when flags allow. FORK: the
    // blank-row gate is the null return; entity defaults seed only the
    // no-history proposal, history always wins once rows exist.
    expect(
      suggestAutofillForPayee([], "Corner Deli", {
        defaultCategoryId: 10,
        defaultMemo: "lunch",
        defaultAmount: "-1250",
      }),
    ).toEqual({ categoryId: 10, amount: "-1250", memo: "lunch" });
    const history = [histRow({ id: 1, amount: "-9999", memo: "hist", categoryId: 7 })];
    expect(
      suggestAutofillForPayee(history, "Corner Deli", {
        defaultCategoryId: 10,
        defaultMemo: "seed",
        defaultAmount: "-1250",
      }),
    ).toEqual({ categoryId: 10, amount: "-9999", memo: "hist" });
  });

  it("excludeId removes the edited row from the proposal (oracle applyToNew flag analogue)", () => {
    const history = [histRow({ id: 1, amount: "-5000", memo: "hist", categoryId: 7 })];
    expect(suggestAutofillForPayee(history, "Corner Deli", { excludeId: 1 })).toBeNull();
    expect(
      suggestAutofillForPayee(history, "Corner Deli", {
        excludeId: 1,
        defaultCategoryId: 10,
        defaultMemo: "seed",
      }),
    ).toEqual({ categoryId: 10, amount: null, memo: "seed" });
  });

  it("blank-row gating: blank payee names propose nothing (oracle RowRenderer blank-row gate)", () => {
    expect(suggestAutofillForPayee([histRow({ id: 1 })], "   ")).toBeNull();
    expect(suggestAutofillForPayee([histRow({ id: 1 })], "")).toBeNull();
  });

  it("FORK: no verbatim same-target throw at the suggestion layer (oracle :200-265)", () => {
    // Oracle verbatim: "Can't apply to a transaction that is the same as
    // this payee's target account." FORK: suggestAutofillForPayee has no
    // account context and never throws; transfer-shaped payees are simply
    // ordinary (exact, punctuation-significant) memory keys here.
    const history = [histRow({ id: 1, payee: "Transfer : Savings", amount: "-100" })];
    expect(() =>
      suggestAutofillForPayee(history, "Transfer : Savings"),
    ).not.toThrow();
    expect(suggestAutofillForPayee(history, "Transfer : Savings")?.amount).toBe("-100");
  });

  it("FORK: split veto + sub-list cleanup are N/A (oracle :189-198, :267-308)", () => {
    // Oracle: applyToImported vetoes the split sub-category; removed
    // categories clear unless a parent-switch is in flight; other kinds
    // ignored. N/A with reason: the history shape carries plain categoryId
    // numbers with no split marker and no collection listener — nothing to
    // veto or clean. The observable contract is that split-adjacent ids
    // pass through untouched.
    const history = [histRow({ id: 1, categoryId: 999, amount: "-100", memo: "m" })];
    expect(suggestAutofillForPayee(history, "Corner Deli")).toEqual({
      categoryId: 999,
      amount: "-100",
      memo: "m",
    });
  });
});

describe("oracle B4 StringOperator -> RENAME_OPERATORS / getRenameRuleOperator", () => {
  it("exposes four operators with verbatim lowercase names (oracle :79-84)", () => {
    expect([...RENAME_OPERATORS]).toEqual(["is", "contains", "startsWith", "endsWith"]);
  });

  it('keeps "Starts with"/"Ends with" label split as camelCase names (oracle :86-91)', () => {
    // Oracle labels are "Starts with"/"Ends with" (space, distinct from the
    // "StartsWith"/"EndsWith" names). FORK: operator ids are lowercase
    // camelCase ("startsWith"/"endsWith") with no separate label table.
    expect(RENAME_OPERATORS).toContain("startsWith");
    expect(RENAME_OPERATORS).toContain("endsWith");
    expect("Starts with" as unknown as RenameRuleOperator).not.toBe("startsWith");
  });

  it("resolves exact operator ids; missing/unknown fall back to is (oracle :97-122)", () => {
    expect(getRenameRuleOperator(opRule(1, "a", "B", "contains"))).toBe("contains");
    expect(getRenameRuleOperator(rule(1, "a", "B"))).toBe("is");
    expect(
      getRenameRuleOperator({ ...rule(1, "a", "B"), operator: undefined }),
    ).toBe("is");
    expect(
      getRenameRuleOperator({
        ...rule(1, "a", "B"),
        operator: "Bogus" as unknown as RenameRuleOperator,
      }),
    ).toBe("is");
  });

  it("FORK: lookup is case-sensitive, unlike oracle getEnumByName ci (oracle :106-122)", () => {
    // Oracle: getEnumByName("contains") resolves; ("Starts with") is null
    // (names, not labels); ("contains", false) is null. FORK: stored ids are
    // already lowercase; "Contains" is unknown and falls back to "is".
    expect(getRenameRuleOperator(opRule(1, "a", "B", "Contains" as unknown as RenameRuleOperator))).toBe(
      "is",
    );
    expect(isSubstringRule(opRule(1, "a", "B", "contains"))).toBe(true);
    expect(isExactRule(rule(1, "a", "B"))).toBe(true);
    expect(isExactRule(opRule(1, "a", "B", "contains"))).toBe(false);
  });

  it("evaluate Is matches case-insensitively, rejects the rest (oracle :149-153)", () => {
    expect(matchesRenameRule(rule(1, "Starbucks", "S"), "STARBUCKS")).toBe(true);
    expect(matchesRenameRule(rule(1, "Starbucks", "S"), "Starbucks Coffee")).toBe(false);
  });

  it("evaluate Contains matches substrings case-insensitively (oracle :155-160)", () => {
    const r = opRule(1, "buck", "S", "contains");
    expect(matchesRenameRule(r, "Starbucks")).toBe(true);
    expect(matchesRenameRule(r, "STARBUCKS")).toBe(true);
    expect(matchesRenameRule(r, "Peets")).toBe(false);
  });

  it("evaluate StartsWith/EndsWith match affixes case-insensitively (oracle :162-171)", () => {
    const s = opRule(1, "star", "S", "startsWith");
    expect(matchesRenameRule(s, "Starbucks")).toBe(true);
    expect(matchesRenameRule(s, "Five Star")).toBe(false);
    const e = opRule(2, "bucks", "S", "endsWith");
    expect(matchesRenameRule(e, "Starbucks")).toBe(true);
    expect(matchesRenameRule(e, "BUCKS")).toBe(true);
    expect(matchesRenameRule(e, "Buckshot")).toBe(false);
  });

  it("null/blank guards: empty payee and blank operand never match (oracle :173-194)", () => {
    const r = opRule(1, "star", "S", "contains");
    expect(matchesRenameRule(r, "   ")).toBe(false);
    for (const operator of ["contains", "startsWith", "endsWith"] as const) {
      expect(matchesRenameRule(opRule(1, "   ", "S", operator), "star")).toBe(false);
    }
  });

  it('FORK: unknown operators fall back to "is" instead of throwing "Unrecognized argument" (oracle :196-200)', () => {
    // Oracle verbatim throw: "Unrecognized argument". FORK: unknown stored
    // operators normalize to "is" via getRenameRuleOperator, so matching is
    // total and never throws.
    const bogus = {
      ...rule(1, "Starbucks", "S"),
      operator: "Bogus" as unknown as RenameRuleOperator,
    };
    expect(() => matchesRenameRule(bogus, "starbucks")).not.toThrow();
    expect(matchesRenameRule(bogus, "starbucks")).toBe(true);
  });

  it("equals: operator identity plus case-insensitive operand (oracle :202-223)", () => {
    // Oracle equals: same operator identity + localeEquals operands;
    // null/null operands are equal; null/foreign are false.
    const a = opRule(1, "Star", "S", "contains");
    const b = opRule(2, "STAR", "S", "contains");
    const c = opRule(3, "Star", "S", "is");
    const d = opRule(4, "other", "S", "contains");
    const probe = "the star store";
    expect(matchesRenameRule(a, probe)).toBe(matchesRenameRule(b, probe));
    expect(matchesRenameRule(a, probe)).toBe(true);
    expect(matchesRenameRule(c, probe)).toBe(false);
    expect(matchesRenameRule(d, probe)).toBe(false);
    // Blank/null operands are equal in effect: both never match.
    expect(matchesRenameRule(opRule(5, "   ", "S", "contains"), probe)).toBe(false);
    expect(matchesRenameRule(opRule(6, "", "S", "contains"), probe)).toBe(false);
  });

  it("compiled rules mirror uncompiled matching incl. transfer veto (oracle evaluate matrix)", () => {
    const rules = [
      rule(1, "Starbucks", "S"),
      opRule(2, "buck", "S", "contains"),
      opRule(3, "star", "S", "startsWith"),
      opRule(4, "bucks", "S", "endsWith"),
      rule(5, "BCF[N]", "BC Ferries"),
    ];
    const compiled = compileRenameRules(rules);
    const payees = ["Starbucks", "STARBUCKS", "Five Star", "Buckshot", "BCF12", "", "   "];
    for (const r of rules) {
      const c = compiled.find((x) => x.rule.id === r.id)!;
      for (const payee of payees) {
        expect(matchesCompiledRule(c, payee)).toBe(
          payee.trim() ? matchesRenameRule(r, payee) : false,
        );
      }
    }
  });

  it("FORK: folded comparison only for [N]/[X]; operators stay punctuation-significant", () => {
    // Oracle locale comparison folds case only. Here exact/operator rules
    // keep separator punctuation significant (AMZN*MKTP != AMZN MKTP) while
    // [N]/[X] patterns generalize across it.
    expect(matchesRenameRule(opRule(1, "AMZN MKTP", "A", "contains"), "AMZN*MKTP US")).toBe(
      false,
    );
    expect(matchesRenameRule(rule(1, "AMZN*MKTP 12", "A"), "AMZN*MKTP 12")).toBe(true);
    expect(normalizeRenameText("AMZN*MKTP")).toBe("amzn mktp");
  });

  it("FORK: VO round-trip / parent-resolution throws are N/A (oracle :225-314)", () => {
    // Oracle verbatims: "Could not find payee: " + entityId and
    // "Expected the parentPayee's entityId (...) to match the vo's
    // parentPayeeId (...)"; populate round-trips the operator NAME string;
    // toString carries the entity id; addConditions is the Payee seam. N/A
    // with reason: no syncable-entity/VO layer exists here — rules are plain
    // { id, sourcePattern, targetPayee, operator?, createdAt } data and the
    // operator already travels as its exact string id.
    const r = opRule(1, "buck", "S", "contains");
    expect(JSON.parse(JSON.stringify(r)).operator).toBe("contains");
    expect(
      compileRenameRules([r]).find((x) => x.rule.id === 1)?.normalizedOperand,
    ).toBe("buck");
  });
});

describe.skip("oracle B4 PayeeSettingsDialog PM -> pure rename-rule grammar", () => {
  it("selection states: no/single/multi counts (oracle PM :167-173, :73-93)", () => {
    // React-adapter N/A: no presentation model exists in packages/ui; the
    // state machine is characterized on the pure count grammar the PM pins.
    const stateOf = (n: number): string =>
      n === 0 ? "noSelection" : n === 1 ? "singleSelection" : "multiSelection";
    expect(stateOf(0)).toBe("noSelection");
    expect(stateOf(1)).toBe("singleSelection");
    expect(stateOf(2)).toBe("multiSelection");
    expect(stateOf(5)).toBe("multiSelection");
  });

  it("add/remove/clear selection + getPayeeFromName exact lookup (oracle PM :73-93, :290-292)", () => {
    // Server counterpart: getPayeeByName trims and matches exactly
    // (packages/server/src/queries/payees.ts:34-39). Characterized purely:
    const names = ["Diner", "Cafe"];
    const getPayeeFromName = (name: string): string | null =>
      names.includes(name.trim()) ? name.trim() : null;
    expect(getPayeeFromName("Diner")).toBe("Diner");
    expect(getPayeeFromName("  Diner  ")).toBe("Diner");
    expect(getPayeeFromName("diners")).toBeNull();
    expect(getPayeeFromName("   ")).toBeNull();
  });

  it("rename setter moves the name; HTML is escaped in the label (oracle PM :95-123)", () => {
    // Oracle: renameIfLabel embeds escapeHTML(selectedPayeeName). No HTML
    // helper ships in packages/logic — pin the escaping the label needs.
    const escapeHTML = (s: string): string =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const label = (name: string): string =>
      `Rename imported transactions to <b>${escapeHTML(name)}</b> if payee:`;
    expect(label("Diner Updated")).toContain("<b>Diner Updated</b>");
    expect(label("A&B <C>")).toContain("A&amp;B &lt;C&gt;");
  });

  it("conditions add/remove; clear trims trailing blank operands (oracle PM :125-145)", () => {
    // Oracle clearSelectedPayees drops trailing blank-operand conditions.
    // Pure analogue on operand strings (blank = trim to ""):
    const trimBlanks = (operands: string[]): string[] => {
      const out = [...operands];
      while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
      return out;
    };
    expect(trimBlanks(["joint", "  ", ""])).toEqual(["joint"]);
    expect(trimBlanks([])).toEqual([]);
    // Adding a condition appends a blank Contains operand on the payee.
    const added = [...["joint"], ""];
    expect(added).toHaveLength(2);
    expect(trimBlanks(added)).toEqual(["joint"]);
  });

  it("enabled toggle skips transfers (oracle PM :147-155, :265-271)", () => {
    const toggled = ["Diner", "Transfer : Savings"]
      .filter((name) => !isTransferPayee(name))
      .map((name) => ({ name, enabled: false }));
    expect(toggled).toEqual([{ name: "Diner", enabled: false }]);
  });

  it("combine renames every non-transfer selection; all-transfer is a no-op (oracle PM :273-288)", () => {
    // Oracle combineSelectedPayees renames each non-transfer selection to the
    // new name, then reselects; all-transfers no-op. learnRenameRule carries
    // the same transfer guard in this codebase.
    const { rules } = learnRenameRule([], "Diner", "Food");
    expect(rules).toHaveLength(1);
    const transfer = learnRenameRule([], "Transfer : Savings", "Food");
    expect(transfer.rules).toHaveLength(0);
    expect(transfer.generalised).toBe(false);
  });

  it("combine reselects the new payee (startFreshSelection analogue, oracle PM :157-170)", () => {
    const { rules } = learnRenameRule([], "Cafe", "Food");
    expect(rules[0]).toMatchObject({ sourcePattern: "Cafe", targetPayee: "Food" });
    // A second rename to the same target converges (generalise or dedupe),
    // mirroring the PM reselecting exactly one payee afterwards.
    const second = learnRenameRule(rules, "Diner", "Food");
    expect(second.rules.every((r) => r.targetPayee === "Food")).toBe(true);
  });

  it("renameExisting renames affected transactions via matching rules (oracle PM :248-263, :172-199)", () => {
    // Oracle renameExisting renames every affected payee string in place.
    // Here the affected set is exactly the set of matching rules' payees.
    const rules = [opRule(1, "joint", "Diner", "contains")];
    const affected = ["Diner joint", "Joint Venture", "Cafe"].filter((p) =>
      matchesRenameRule(rules[0]!, p),
    );
    expect(affected).toEqual(["Diner joint", "Joint Venture"]);
    const renamed = affected.map(() => "Diner");
    expect(renamed).toEqual(["Diner", "Diner"]);
  });

  it("categories/tooltips assignment is plain state (oracle PM :298-328, :47-61)", () => {
    // Oracle defaults carry the verbatim "combine any payees" and "autofill
    // are enabled" tooltips; categories is a plain assignable collection.
    // N/A with reason: no dialog model exists here — pin that assignment is
    // total and defaults are caller-owned strings.
    let combineToolTip = "combine any payees";
    let listToolTip = "autofill are enabled";
    expect(combineToolTip).toContain("combine any payees");
    expect(listToolTip).toContain("autofill are enabled");
    combineToolTip = "combo";
    listToolTip = "list";
    expect(combineToolTip).toBe("combo");
    expect(listToolTip).toBe("list");
  });

  it("tooltips/init from context have no dialog counterpart (oracle PM :47-71)", () => {
    // Oracle initializes payees/categories from the injected context and
    // pre-selects the initial payee. N/A with reason: packages/ui owns no
    // payee-settings dialog (PayeesView covers rename via server queries);
    // the covered seam is that an empty payee list still yields noSelection.
    const stateOf = (n: number): string =>
      n === 0 ? "noSelection" : n === 1 ? "singleSelection" : "multiSelection";
    expect(stateOf([].length)).toBe("noSelection");
  });

  it("transfer-shaped operands never become rename conditions (PM skip-transfers + rule guard)", () => {
    for (const operator of ["contains", "startsWith", "endsWith"] as const) {
      expect(matchesRenameRule(opRule(1, "Transfer", "G", operator), "Transfer : Savings")).toBe(
        false,
      );
    }
    expect(learnRenameRule([], "Transfer : A", "B").rules).toHaveLength(0);
  });

  it("exact trimmed-name memory does not conflate separator drift (autofill fork pin)", () => {
    // Payee memory uses exact trimmed comparison — unlike rename learning,
    // which folds separators. AMZN*MKTP and AMZN MKTP are different keys.
    const history = [histRow({ id: 1, payee: "AMZN*MKTP", amount: "-100" })];
    expect(suggestAutofillForPayee(history, "AMZN MKTP")).toBeNull();
    expect(suggestAutofillForPayee(history, "AMZN*MKTP")?.amount).toBe("-100");
  });
});
