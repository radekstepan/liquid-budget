/**
 * REPRO ONLY — CSV thousands-separator gap: NBSP grouping (not yet fixed;
 * do not promote).
 *
 * Diverges: `parseAmount` accepts space-grouped thousands (`1 000,50`) and
 * every Euro-format variant with plain spaces, but a non-breaking space
 * (U+00A0, what Excel/LibreOffice and many EU banks emit as the grouping
 * separator) falls through every pattern and errors as "Invalid amount".
 * Same visual amount parses or errors depending on which space byte the
 * bank emitted. BOM prefix, quoted commas/newlines, CRLF, blank lines and
 * absurd-magnitude amounts were verified handled (`parseCsv`: BOM strip
 * + quote/CRLF handling; blank-line skip; `parseAmount` MAX_SAFE_INTEGER
 * guard) — dropped, no test.
 *
 * Ours: packages/logic/src/csv-import.ts:391-410 (`parseAmount` grouping
 *   patterns match only the literal ASCII space) + :581-735
 *   (`parseCsvImport` surfaces the resulting "Invalid amount").
 */
import { describe, expect, it } from "vitest";
import { parseCsvImport } from "../src/csv-import.js";

function importOneLine(amountCell: string) {
  const csv = `Date,Payee,Amount\n2026-01-05,Boulanger,${amountCell}`;
  return parseCsvImport(csv);
}

describe("csv: non-breaking-space thousands separators parse like plain spaces", () => {
  it("French `1 000,50 €` with NBSP grouping parses to 100050 cents", () => {
    const result = importOneLine('"1\u00a0000,50 \u20ac"');
    // FAILS today: NBSP-grouped amount errors as "Invalid amount".
    expect(result.rows[0]?.error).toBeNull();
    expect(result.rows[0]?.amountCents).toBe(100050);
  });

  it("NBSP-grouped integer `10 000` parses to 1000000 cents", () => {
    const result = importOneLine('"10\u00a0000"');
    // FAILS today: NBSP-grouped amount errors as "Invalid amount".
    expect(result.rows[0]?.error).toBeNull();
    expect(result.rows[0]?.amountCents).toBe(1000000);
  });
});
