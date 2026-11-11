import { describe, expect, it } from "vitest";
import {
  shouldUseServerSearch,
  SERVER_SEARCH_TXN_THRESHOLD,
} from "../src/search.js";
import {
  SearchQuerySchema,
  formatZodError,
  parseSearchResponse,
} from "../src/contracts.js";
import * as contracts from "../src/contracts.js";

describe("search contracts + server threshold", () => {
  it("re-exports the search contracts from the package root", () => {
    expect(contracts.SearchQuerySchema).toBe(SearchQuerySchema);
    expect(typeof contracts.parseSearchResponse).toBe("function");
  });

  it("SearchQuerySchema defaults an empty global query", () => {
    const parsed = SearchQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ query: "", searchAll: true });
    }
  });

  it("SearchQuerySchema reads query-string booleans and ids", () => {
    const parsed = SearchQuerySchema.safeParse({
      query: "whole",
      searchAll: "false",
      scopeAccountId: "12",
      categoryId: "34",
      limit: "10",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        query: "whole",
        searchAll: false,
        scopeAccountId: 12,
        categoryId: 34,
        limit: 10,
      });
    }
  });

  it("SearchQuerySchema rejects malformed limits and ids", () => {
    for (const query of [
      { limit: "0" },
      { limit: "101" },
      { limit: "abc" },
      { categoryId: "abc" },
      { categoryId: "-3" },
      { accountId: "1.5" },
      { before: "" },
    ]) {
      const parsed = SearchQuerySchema.safeParse(query);
      expect(parsed.success, `expected 400-shape for ${formatZodError(parsed.error!)}`).toBe(false);
    }
  });

  it("parseSearchResponse validates the envelope and rejects drift", () => {
    const valid = {
      payees: [{ name: "Whole Foods", txnCount: 3 }],
      categories: [{ id: 1, name: "Groceries", groupName: "Food", txnCount: 2 }],
      transactions: [
        {
          id: 7,
          accountId: 1,
          accountName: "Checking",
          payee: "Whole Foods",
          memo: "",
          categoryId: 1,
          categoryName: "Groceries",
          date: "2026-09-01",
          amount: -5000,
          rank: 0,
        },
      ],
      payeeOptions: [{ value: "Whole Foods", label: "Whole Foods (3)" }],
      nextCursor: null,
      hasMore: false,
    };
    expect(parseSearchResponse(valid).transactions).toHaveLength(1);
    expect(() => parseSearchResponse({ ...valid, transactions: [{ id: 1 }] })).toThrow();
    expect(() => parseSearchResponse(null)).toThrow();
  });

  it("shouldUseServerSearch flips at the documented threshold", () => {
    expect(SERVER_SEARCH_TXN_THRESHOLD).toBe(5000);
    expect(shouldUseServerSearch(SERVER_SEARCH_TXN_THRESHOLD - 1)).toBe(false);
    expect(shouldUseServerSearch(SERVER_SEARCH_TXN_THRESHOLD)).toBe(true);
  });
});
