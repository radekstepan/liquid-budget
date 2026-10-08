import { describe, expect, it } from "vitest";
import type { RenameRule } from "../src/types.js";
import {
  buildRenameSuggestMessages,
  parseRenameSuggestions,
  selectRenameCandidates,
  type RenameCandidateRow,
} from "../src/rename-suggest.js";

const rule = (sourcePattern: string, targetPayee: string, id = 1): RenameRule => ({
  id,
  sourcePattern,
  targetPayee,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const row = (over: Partial<RenameCandidateRow> & { payee: string }): RenameCandidateRow => ({
  id: over.id ?? 1,
  payee: over.payee,
  memo: over.memo ?? null,
  status: over.status ?? "c",
  transferStatus: over.transferStatus ?? null,
  parentId: over.parentId ?? null,
  transferAccountId: over.transferAccountId ?? null,
  needsReview: over.needsReview === undefined ? true : over.needsReview,
});

describe("selectRenameCandidates", () => {
  it("skips payees already covered by an exact rule", () => {
    const rules = [rule("AMZN Mktp US*RT3ABCD12", "Amazon")];
    const rows = [
      row({ id: 1, payee: "AMZN Mktp US*RT3ABCD12" }),
      row({ id: 2, payee: "AMZN MKTP US RT3ABCD12" }),
      row({ id: 3, payee: "WHOLE FOODS #24" }),
    ];
    const { candidates, totalUnique, truncated } = selectRenameCandidates(rows, rules);
    expect(candidates.map((c) => c.payee)).toEqual(["WHOLE FOODS #24"]);
    expect(totalUnique).toBe(1);
    expect(truncated).toBe(false);
  });

  it("skips payees already covered by a pattern rule", () => {
    const rules = [rule("BCF[N]", "BC Ferries")];
    const rows = [
      row({ id: 1, payee: "BCF1" }),
      row({ id: 2, payee: "BCF22" }),
      row({ id: 3, payee: "STARBUCKS #12" }),
    ];
    const { candidates } = selectRenameCandidates(rows, rules);
    expect(candidates.map((c) => c.payee)).toEqual(["STARBUCKS #12"]);
  });

  it("skips payees already at a rule target (renamed or imported clean)", () => {
    const rules = [rule("AMZN Mktp US*RT3ABCD12", "Amazon")];
    const rows = [
      row({ id: 1, payee: "Amazon" }),
      row({ id: 2, payee: "AMAZON" }),
      row({ id: 3, payee: "WHOLE FOODS #24" }),
    ];
    const { candidates, totalUnique } = selectRenameCandidates(rows, rules);
    expect(candidates.map((c) => c.payee)).toEqual(["WHOLE FOODS #24"]);
    expect(totalUnique).toBe(1);
  });

  it("only considers freshly imported rows still needing review", () => {
    const rows = [
      row({ id: 1, payee: "Reviewed long ago", needsReview: false }),
      row({ id: 2, payee: "Manually entered", needsReview: null }),
      row({ id: 3, payee: "Just imported" }),
    ];
    const { candidates, totalUnique } = selectRenameCandidates(rows, []);
    expect(candidates.map((c) => c.payee)).toEqual(["Just imported"]);
    expect(totalUnique).toBe(1);
  });

  it("skips transfers, split children, reconciled rows, and empty payees", () => {
    const rows = [
      row({ id: 1, payee: "Transfer : Savings", transferAccountId: 2 }),
      row({ id: 2, payee: "Transfer : Checking" }),
      row({ id: 3, payee: "Split child", parentId: 9 }),
      row({ id: 4, payee: "Reconciled store", status: "r" }),
      row({ id: 5, payee: "Transfer leg locked", transferStatus: "r" }),
      row({ id: 6, payee: "   " }),
      row({ id: 7, payee: "WONKY PAYEE 123" }),
    ];
    const { candidates } = selectRenameCandidates(rows, []);
    expect(candidates.map((c) => c.payee)).toEqual(["WONKY PAYEE 123"]);
  });

  it("dedupes case-insensitively, counts, and sorts by frequency", () => {
    const rows = [
      row({ id: 1, payee: "amzn mktp" }),
      row({ id: 2, payee: "AMZN MKTP" }),
      row({ id: 3, payee: "AMZN-MKTP" }),
      row({ id: 4, payee: "Zebra cafe" }),
    ];
    const { candidates } = selectRenameCandidates(rows, []);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ payee: "amzn mktp", count: 3 });
    expect(candidates[0]!.transactionIds).toEqual([1, 2, 3]);
    expect(candidates[1]).toMatchObject({ payee: "Zebra cafe", count: 1 });
  });

  it("collects distinct non-empty memos per payee", () => {
    const rows = [
      row({ id: 1, payee: "WONKY 123", memo: "downtown store" }),
      row({ id: 2, payee: "wonky 123", memo: "  " }),
      row({ id: 3, payee: "WONKY 123", memo: "downtown store" }),
      row({ id: 4, payee: "WONKY 123", memo: "order #42" }),
      row({ id: 5, payee: "WONKY 123", memo: null }),
      row({ id: 6, payee: "MEMOLESS" }),
    ];
    const { candidates } = selectRenameCandidates(rows, []);
    expect(candidates.find((c) => c.payee === "WONKY 123")?.memos).toEqual([
      "downtown store",
      "order #42",
    ]);
    expect(candidates.find((c) => c.payee === "MEMOLESS")?.memos).toEqual([]);
  });

  it("caps memos per payee and truncates long ones", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ id: i + 1, payee: "WONKY 123", memo: `note ${i}` })
    );
    rows.push(row({ id: 6, payee: "LONG", memo: "x".repeat(500) }));
    const { candidates } = selectRenameCandidates(rows, []);
    expect(candidates.find((c) => c.payee === "WONKY 123")?.memos).toEqual([
      "note 0",
      "note 1",
      "note 2",
    ]);
    const long = candidates.find((c) => c.payee === "LONG")?.memos[0] ?? "";
    expect(long.length).toBeLessThanOrEqual(121);
    expect("x".repeat(500)).toContain(long.replace(/…$/, ""));
  });

  it("caps the payee list and reports truncation", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ id: i + 1, payee: `Store ${i}` })
    );
    const { candidates, totalUnique, truncated } = selectRenameCandidates(rows, [], {
      maxPayees: 2,
    });
    expect(candidates).toHaveLength(2);
    expect(totalUnique).toBe(5);
    expect(truncated).toBe(true);
  });
});

describe("buildRenameSuggestMessages", () => {
  it("lists every candidate and demands a total JSON mapping", () => {
    const messages = buildRenameSuggestMessages([
      { payee: "AMZN Mktp US*RT3ABCD12", count: 2, transactionIds: [1, 2], memos: [] },
      { payee: "WHOLE FOODS #24", count: 1, transactionIds: [3], memos: [] },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("JSON ONLY");
    expect(messages[0]!.content).toContain("Transfer :");
    const user = messages[1]!.content;
    expect(user).toContain('"AMZN Mktp US*RT3ABCD12" (2 transactions)');
    expect(user).toContain('"WHOLE FOODS #24"');
  });

  it("includes memos as disambiguation context when present", () => {
    const messages = buildRenameSuggestMessages([
      {
        payee: "WONKY 123",
        count: 2,
        transactionIds: [1, 2],
        memos: ["downtown store", "order #42"],
      },
      { payee: "PLAIN", count: 1, transactionIds: [3], memos: [] },
    ]);
    expect(messages[0]!.content).toContain("memo");
    const user = messages[1]!.content;
    expect(user).toContain("downtown store");
    expect(user).toContain("order #42");
    // The memo-less candidate gets no memo clause.
    expect(user).toMatch(/^2\. "PLAIN"$/m);
  });
});

describe("parseRenameSuggestions", () => {
  const candidates = [
    { payee: "AMZN Mktp US*RT3ABCD12", count: 2, transactionIds: [1, 2], memos: [] },
    { payee: "WHOLE FOODS #24", count: 1, transactionIds: [3], memos: [] },
    { payee: "BCF1", count: 1, transactionIds: [4], memos: [] },
  ];

  it("parses the renames object into suggestions", () => {
    const { suggestions, skipped } = parseRenameSuggestions(
      JSON.stringify({
        renames: [
          { source: "AMZN Mktp US*RT3ABCD12", target: "Amazon" },
          { source: "WHOLE FOODS #24", target: "Whole Foods" },
        ],
      }),
      candidates
    );
    expect(suggestions).toEqual([
      { sourcePattern: "AMZN Mktp US*RT3ABCD12", targetPayee: "Amazon", count: 2 },
      { sourcePattern: "WHOLE FOODS #24", targetPayee: "Whole Foods", count: 1 },
    ]);
    expect(skipped).toEqual([]);
  });

  it("accepts a bare array and markdown fences", () => {
    const { suggestions } = parseRenameSuggestions(
      '```json\n[{"source": "BCF1", "target": "BC Ferries"}]\n```',
      candidates
    );
    expect(suggestions).toEqual([
      { sourcePattern: "BCF1", targetPayee: "BC Ferries", count: 1 },
    ]);
  });

  it("skips hallucinations, no-ops, empties, and transfer targets", () => {
    const { suggestions, skipped } = parseRenameSuggestions(
      JSON.stringify({
        renames: [
          { source: "AMZN Mktp US*RT3ABCD12", target: "Amazon" },
          { source: "NETFLIX.COM", target: "Netflix" },
          { source: "WHOLE FOODS #24", target: "whole foods #24" },
          { source: "BCF1", target: "" },
          { source: "BCF1", target: "Transfer : Checking" },
        ],
      }),
      candidates
    );
    expect(suggestions).toEqual([
      { sourcePattern: "AMZN Mktp US*RT3ABCD12", targetPayee: "Amazon", count: 2 },
    ]);
    // Both BCF1 entries are reported: an invalid entry never claims the
    // source, so a later valid duplicate would still be accepted.
    expect(skipped.map((s) => s.source)).toEqual([
      "NETFLIX.COM",
      "WHOLE FOODS #24",
      "BCF1",
      "BCF1",
    ]);
  });

  it("extracts JSON wrapped in prose or fences with surrounding text", () => {
    const payload = JSON.stringify({
      renames: [{ source: "BCF1", target: "BC Ferries" }],
    });
    for (const raw of [
      `Here are the cleaned names:\n${payload}\nLet me know if you need more.`,
      `Sure!\n\`\`\`json\n${payload}\n\`\`\`\nDone.`,
      `[{"source": "BCF1", "target": "BC Ferries"}] is my answer (bare array).`,
    ]) {
      const { suggestions, skipped, error } = parseRenameSuggestions(raw, candidates);
      expect(error).toBeUndefined();
      expect(skipped).toEqual([]);
      expect(suggestions).toEqual([
        { sourcePattern: "BCF1", targetPayee: "BC Ferries", count: 1 },
      ]);
    }
  });

  it("carries candidate memos into suggestions as review evidence", () => {
    const withMemos = [
      {
        payee: "PAYPAL *4821",
        count: 2,
        transactionIds: [1, 2],
        memos: ["Spotify Premium", "order #42"],
      },
      { payee: "PLAIN", count: 1, transactionIds: [3], memos: [] },
    ];
    const { suggestions } = parseRenameSuggestions(
      JSON.stringify({
        renames: [
          { source: "PAYPAL *4821", target: "Spotify" },
          { source: "PLAIN", target: "Plain Shop" },
        ],
      }),
      withMemos
    );
    expect(suggestions).toEqual([
      {
        sourcePattern: "PAYPAL *4821",
        targetPayee: "Spotify",
        count: 2,
        memos: ["Spotify Premium", "order #42"],
      },
      { sourcePattern: "PLAIN", targetPayee: "Plain Shop", count: 1 },
    ]);
    expect("memos" in suggestions[1]!).toBe(false);
  });

  it("ignores braces inside strings when extracting embedded JSON", () => {
    const raw = `Note: use {"renames": [...]} format.\n${JSON.stringify({
      renames: [{ source: "BCF1", target: "BC Ferries (see {map})" }],
    })}`;
    const { suggestions, error } = parseRenameSuggestions(raw, candidates);
    expect(error).toBeUndefined();
    expect(suggestions).toEqual([
      { sourcePattern: "BCF1", targetPayee: "BC Ferries (see {map})", count: 1 },
    ]);
  });

  it("reports unusable responses as errors, not skips", () => {
    const garbage = parseRenameSuggestions("not json at all", candidates);
    expect(garbage.suggestions).toEqual([]);
    expect(garbage.skipped).toEqual([]);
    expect(garbage.error).toContain("not valid JSON");
    expect(garbage.error).toContain("not json at all");

    const missing = parseRenameSuggestions("{}", candidates);
    expect(missing.suggestions).toEqual([]);
    expect(missing.error).toContain("did not contain a renames list");

    // An empty renames list is a usable response: nothing to do, no error.
    const empty = parseRenameSuggestions('{"renames": []}', candidates);
    expect(empty.suggestions).toEqual([]);
    expect(empty.skipped).toEqual([]);
    expect(empty.error).toBeUndefined();
  });
});
