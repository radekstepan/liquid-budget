import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guard: clickable icon/chrome controls must show the pointer (hand) cursor
// on hover. These classes back the settings-overlay close button
// (`y-icon-btn` in BudgetApp) and the other icon/action buttons across the
// app; a missing `cursor: pointer` leaves the default arrow on hover.
const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(here, "../../theme/src/index.css"), "utf8");

// Selectors that must carry `cursor: pointer` in their base rule block.
const POINTER_SELECTORS = [
  ".y-icon-btn",
  ".y-side-edit-btn",
  ".y-group-add-btn",
  ".y-cat-edit-btn",
  ".y-side-head",
  ".y-month-qb-scope-clear",
];

function ruleBlock(selector: string): string | null {
  const idx = css.indexOf(`${selector} {`);
  if (idx === -1) return null;
  const end = css.indexOf("}", idx);
  if (end === -1) return null;
  return css.slice(idx, end);
}

describe("pointer cursor on clickable controls", () => {
  for (const selector of POINTER_SELECTORS) {
    it(`${selector} shows the hand cursor`, () => {
      const block = ruleBlock(selector);
      expect(block, `${selector} rule missing from theme CSS`).not.toBeNull();
      expect(block, `${selector} must set cursor: pointer`).toMatch(/cursor:\s*pointer/);
    });
  }

  it("disabled icon buttons fall back to the default cursor", () => {
    const block = ruleBlock(".y-icon-btn:disabled");
    expect(block, ".y-icon-btn:disabled rule missing from theme CSS").not.toBeNull();
    expect(block, ".y-icon-btn:disabled must not keep the pointer").toMatch(/cursor:\s*default/);
  });
});
