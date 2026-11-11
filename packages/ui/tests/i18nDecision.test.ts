import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, num } from "@ynab/logic";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_APP = path.resolve(here, "../src/BudgetApp.tsx");
const DECISION = path.resolve(here, "../../../docs/locale-decision.md");

describe("i18n single-locale decision", () => {
  it("BudgetApp carries no [i18n] marker — decision is recorded, not pending", () => {
    expect(readFileSync(BUDGET_APP, "utf8")).not.toContain("TODO(P2) [i18n]");
  });

  it("decision doc records single-locale en-US with fmt as the choke point", () => {
    const doc = readFileSync(DECISION, "utf8");
    expect(doc).toContain("single-locale");
    expect(doc).toContain("en-US");
    expect(doc).toContain("fmt");
    expect(doc).toContain("G-02");
  });

  it("display is en-US USD while input accepts either separator convention", () => {
    expect(fmt(123450)).toBe("$1,234.50");
    expect(fmt(-123450)).toBe("-$1,234.50");
    expect(num("1,234.56")).toBe(1235);
    expect(num("1.234,56")).toBe(1235);
  });
});
