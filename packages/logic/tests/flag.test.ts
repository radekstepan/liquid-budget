import { describe, expect, it } from "vitest";
import {
  TRANSACTION_DUPLICATE_FLAG,
  TRANSACTION_FLAG_COLORS,
  TRANSACTION_FLAG_HEX,
} from "../src/index.js";

describe("transaction flag palette", () => {
  it("exposes the six YNAB4 colors in canonical order", () => {
    expect(TRANSACTION_FLAG_COLORS).toEqual([
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
    ]);
  });

  it("maps every color to a hex swatch", () => {
    for (const c of TRANSACTION_FLAG_COLORS) {
      expect(TRANSACTION_FLAG_HEX[c]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps the internal duplicate marker separate from the user palette", () => {
    expect(TRANSACTION_DUPLICATE_FLAG).toBe("duplicate");
    expect(TRANSACTION_FLAG_COLORS).not.toContain(TRANSACTION_DUPLICATE_FLAG);
  });
});