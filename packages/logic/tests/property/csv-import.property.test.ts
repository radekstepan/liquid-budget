/**
 * Property tests for CSV importing (`src/csv-import.ts`).
 *
 * Strategy: generative round-trips (build valid CSV/dates/amounts, assert
 * exact parse), hostile fuzz (arbitrary strings never crash, outputs stay
 * well-shaped), decision-matrix pins (date-format votes, error taxonomy,
 * column precedence), and differentials (headerless/headered, swap, date
 * format overrides).
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  detectDateFormat,
  detectDateFormatDetailed,
  parseAmount,
  parseCsv,
  parseCsvImport,
  parseDate,
  swapPayeeMemo,
  type CsvImportRow,
  type DateFormatConvention,
} from "../../src/csv-import.js";
import { dollarsToCents } from "../../src/format.js";

/* ---------------- shared helpers ---------------- */

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Minimal correct CSV escaper: quote cells holding , " newline or CR. */
const escapeCell = (cell: string): string =>
  /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const ordinal = (d: number): string => {
  if (d % 100 >= 11 && d % 100 <= 13) return `${d}th`;
  switch (d % 10) {
    case 1:
      return `${d}st`;
    case 2:
      return `${d}nd`;
    case 3:
      return `${d}rd`;
    default:
      return `${d}th`;
  }
};

/** Independent Gregorian calendar oracle (month table + leap rule). */
const isLeapYear = (y: number): boolean =>
  y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const daysInMonth = (y: number, m: number): number =>
  m === 2 && isLeapYear(y) ? 29 : (DIM[m - 1] ?? 0);

/* ---------------- parseCsv ---------------- */

describe("parseCsv properties", () => {
  it("round-trips arbitrary cells", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.string({ maxLength: 30 }), {
            minLength: 1,
            maxLength: 4,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.constantFrom("\n", "\r\n", "\r"),
        fc.boolean(),
        (rows, eol, trailingNewline) => {
          let text = rows.map((r) => r.map(escapeCell).join(",")).join(eol);
          if (trailingNewline) text += eol;
          // A trailing [""] row has an empty serialization, so without a
          // trailing newline there is no content after the last break and
          // the row vanishes; with one it survives as [""].
          const last = rows[rows.length - 1]!;
          const expected =
            !trailingNewline && last.length === 1 && last[0] === ""
              ? rows.slice(0, -1)
              : rows;
          expect(parseCsv(text)).toEqual(expected);
        },
      ),
    );
  });

  it("throws only Unclosed-quote errors on hostile input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        let out: string[][] | undefined;
        let caught: unknown;
        try {
          out = parseCsv(text);
        } catch (e) {
          caught = e;
        }
        if (caught !== undefined) {
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toMatch(/Unclosed quote/);
        } else {
          expect(Array.isArray(out)).toBe(true);
          for (const row of out!) {
            expect(Array.isArray(row)).toBe(true);
            for (const cell of row) expect(typeof cell).toBe("string");
          }
        }
      }),
    );
  });

  it("always throws on an opener with no closer", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }).map((s) => s.replace(/"/g, "")),
        (content) => {
          expect(() => parseCsv(`"${content}`)).toThrow(/Unclosed quote/);
        },
      ),
    );
  });

  it("strips a leading BOM", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.string({ maxLength: 20 }), {
            minLength: 1,
            maxLength: 3,
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (rows) => {
          const text = rows.map((r) => r.map(escapeCell).join(",")).join("\n");
          if (text === "") return;
          expect(parseCsv(`\uFEFF${text}`)).toEqual(parseCsv(text));
        },
      ),
    );
  });
});

/* ---------------- parseDate ---------------- */

type YMD = { y: number; m: number; d: number; iso: string };

/** Valid calendar dates with years that round-trip 2-digit pivots exactly. */
const ymdArb: fc.Arbitrary<YMD> = fc
  .tuple(
    fc.integer({ min: 1970, max: 2069 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => ({ y, m, d, iso: `${y}-${pad2(m)}-${pad2(d)}` }));

type DateShape =
  | "iso"
  | "dmy4"
  | "dmy2"
  | "mdy4"
  | "mdy2"
  | "textMDY"
  | "textDMY"
  | "textYMD";

const monthNameArb = (m: number): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(
        SHORT_MONTHS[m - 1]!,
        LONG_MONTHS[m - 1]!,
        ...(m === 9 ? ["Sept"] : []),
      ),
      fc.constantFrom("title", "lower", "upper"),
      fc.boolean(),
    )
    .map(([name, casing, dot]) => {
      const cased =
        casing === "lower"
          ? name.toLowerCase()
          : casing === "upper"
            ? name.toUpperCase()
            : name;
      return dot ? `${cased}.` : cased;
    });

function renderDate(
  ymd: YMD,
  shape: DateShape,
  monthName: string,
  ordinalDay: boolean,
  padded: boolean,
  numericSep: string,
  textSep: string,
  year2: boolean,
): { text: string; convention: DateFormatConvention | "either" } {
  const { y, m, d } = ymd;
  const M = padded ? pad2(m) : String(m);
  const D = padded ? pad2(d) : String(d);
  const yyyy = String(y);
  const yy = yyyy.slice(2);
  switch (shape) {
    case "iso":
      return { text: `${yyyy}${numericSep}${M}${numericSep}${D}`, convention: "either" };
    case "dmy4":
      return { text: `${D}${numericSep}${M}${numericSep}${yyyy}`, convention: "dmy" };
    case "dmy2":
      return { text: `${D}${numericSep}${M}${numericSep}${yy}`, convention: "dmy" };
    case "mdy4":
      return { text: `${M}${numericSep}${D}${numericSep}${yyyy}`, convention: "mdy" };
    case "mdy2":
      return { text: `${M}${numericSep}${D}${numericSep}${yy}`, convention: "mdy" };
    case "textMDY": {
      const day = ordinalDay ? ordinal(d) : D;
      return {
        text: `${monthName}${textSep}${day}${textSep}${year2 ? yy : yyyy}`,
        convention: "either",
      };
    }
    case "textDMY": {
      const day = ordinalDay ? ordinal(d) : D;
      return {
        text: `${day}${textSep}${monthName}${textSep}${year2 ? yy : yyyy}`,
        convention: "either",
      };
    }
    case "textYMD": {
      const day = ordinalDay ? ordinal(d) : D;
      return {
        text: `${yyyy}${textSep}${monthName}${textSep}${day}`,
        convention: "either",
      };
    }
  }
}

describe("parseDate properties", () => {
  it("round-trips every supported shape", () => {
    const renderedArb = ymdArb.chain((ymd) =>
      fc
        .tuple(
          fc.constant(ymd),
          fc.constantFrom<DateShape>(
            "iso",
            "dmy4",
            "dmy2",
            "mdy4",
            "mdy2",
            "textMDY",
            "textDMY",
            "textYMD",
          ),
          monthNameArb(ymd.m),
          fc.constantFrom("-", "/", "."),
          fc.constantFrom(" ", ", ", "-", "/", ".", "  "),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
        )
        .map(
          ([
            date,
            shape,
            monthName,
            numericSep,
            textSep,
            ordinalDay,
            padded,
            year2,
          ]) => ({
            date,
            ...renderDate(
              date,
              shape,
              monthName,
              ordinalDay,
              padded,
              numericSep,
              textSep,
              year2,
            ),
          }),
        ),
    );
    fc.assert(
      fc.property(renderedArb, ({ date, text, convention }) => {
        if (convention === "either") {
          // ISO and text-month shapes ignore the convention.
          expect(parseDate(text, "dmy")).toBe(date.iso);
          expect(parseDate(text, "mdy")).toBe(date.iso);
        } else {
          expect(parseDate(text, convention)).toBe(date.iso);
        }
      }),
    );
  });

  it("validates calendar dates against the month table", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2200 }),
        fc.integer({ min: 0, max: 13 }),
        fc.integer({ min: 0, max: 32 }),
        fc.boolean(),
        (y, m, d, padded) => {
          const text = `${String(y).padStart(4, "0")}-${padded ? pad2(m) : m}-${padded ? pad2(d) : d}`;
          // Years below 100 fall into Date.UTC's 0-99 -> 1900+Y mapping,
          // so toISO's round-trip check rejects them (pinned quirk).
          const expected =
            y < 100 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)
              ? null
              : `${y}-${pad2(m)}-${pad2(d)}`;
          expect(parseDate(text, "dmy")).toBe(expected);
          expect(parseDate(text, "mdy")).toBe(expected);
        },
      ),
    );
  });

  it("pins the two-digit-year pivot", () => {
    expect(parseDate("15/06/69", "dmy")).toBe("2069-06-15");
    expect(parseDate("15/06/70", "dmy")).toBe("1970-06-15");
    expect(parseDate("06/15/00", "mdy")).toBe("2000-06-15");
    expect(parseDate("06/15/99", "mdy")).toBe("1999-06-15");
  });

  it("never throws and only emits real calendar dates", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.constantFrom("dmy", "mdy"),
        (input, convention) => {
          let out: string | null | undefined;
          expect(() => {
            out = parseDate(input, convention);
          }).not.toThrow();
          if (out == null) return;
          expect(out).toMatch(/^\d{1,4}-\d{2}-\d{2}$/);
          const [ys, ms, ds] = out.split("-").map(Number);
          expect(ys).toBeGreaterThanOrEqual(100);
          expect(ms).toBeGreaterThanOrEqual(1);
          expect(ms).toBeLessThanOrEqual(12);
          expect(ds).toBeGreaterThanOrEqual(1);
          expect(ds).toBeLessThanOrEqual(daysInMonth(ys!, ms!));
        },
      ),
    );
  });
});

/* ---------------- detectDateFormat ---------------- */

const numSepArb = fc.constantFrom("-", "/", ".");
const numYearArb = fc.constantFrom("2026", "26");

/** Numeric dates valid only as DMY (day > 12). */
const dmyOnlyArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 13, max: 28 }), fc.integer({ min: 1, max: 12 }), numSepArb, numYearArb)
  .map(([d, m, sep, y]) => `${d}${sep}${m}${sep}${y}`);

/** Numeric dates valid only as MDY (day > 12). */
const mdyOnlyArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 13, max: 28 }), numSepArb, numYearArb)
  .map(([m, d, sep, y]) => `${m}${sep}${d}${sep}${y}`);

/** Numeric dates valid under both conventions. */
const ambiguousDateArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 12 }), numSepArb)
  .map(([a, b, sep]) => `${a}${sep}${b}${sep}2026`);

const textMonthArb = fc.constantFrom(
  ...SHORT_MONTHS,
  ...LONG_MONTHS,
  ...SHORT_MONTHS.map((m) => m.toLowerCase()),
  ...SHORT_MONTHS.map((m) => m.toUpperCase()),
  "Sept",
  "SEPT",
);

/** Text dates voting MDY ("Aug 15, 2026"). */
const textMDYArb: fc.Arbitrary<string> = fc
  .tuple(textMonthArb, fc.integer({ min: 1, max: 28 }), numYearArb, fc.constantFrom(" ", ", "))
  .map(([mon, d, y, sep]) => `${mon}${sep}${d}, ${y}`);

/** Text dates voting DMY ("15 Aug 2026"). */
const textDMYArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 28 }), textMonthArb, numYearArb)
  .map(([d, mon, y]) => `${d} ${mon} ${y}`);

const isoDateArb: fc.Arbitrary<string> = ymdArb.map(({ iso }) => iso);

/** Grid with a header row plus date rows in column `dateIdx` (0 or 1). */
function gridWith(
  dates: string[],
  dateIdx: 0 | 1,
  header: string[] = ["Date", "Payee"],
): string[][] {
  return [
    header,
    ...dates.map((d) => (dateIdx === 0 ? [d, "Store"] : ["Store", d])),
  ];
}

describe("detectDateFormat properties", () => {
  it("elects DMY on unanimous DMY-only dates", () => {
    fc.assert(
      fc.property(
        fc.array(dmyOnlyArb, { minLength: 1, maxLength: 6 }),
        fc.constantFrom(0, 1),
        (dates, dateIdx) => {
          expect(
            detectDateFormatDetailed(gridWith(dates, dateIdx), dateIdx),
          ).toEqual({ convention: "dmy", dmyVotes: dates.length, mdyVotes: 0, ambiguous: false });
        },
      ),
    );
  });

  it("elects MDY on unanimous MDY-only dates", () => {
    fc.assert(
      fc.property(
        fc.array(mdyOnlyArb, { minLength: 1, maxLength: 6 }),
        fc.constantFrom(0, 1),
        (dates, dateIdx) => {
          expect(
            detectDateFormatDetailed(gridWith(dates, dateIdx), dateIdx),
          ).toEqual({ convention: "mdy", dmyVotes: 0, mdyVotes: dates.length, ambiguous: false });
        },
      ),
    );
  });

  it("defaults to DMY and flags ambiguity on all-ambiguous dates", () => {
    fc.assert(
      fc.property(
        fc.array(ambiguousDateArb, { minLength: 1, maxLength: 6 }),
        fc.constantFrom(0, 1),
        (dates, dateIdx) => {
          expect(
            detectDateFormatDetailed(gridWith(dates, dateIdx), dateIdx),
          ).toEqual({ convention: "dmy", dmyVotes: 0, mdyVotes: 0, ambiguous: true });
        },
      ),
    );
  });

  it("elects the majority on mixed votes", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom(0, 1),
        fc.array(dmyOnlyArb, { minLength: 4, maxLength: 4 }),
        fc.array(mdyOnlyArb, { minLength: 4, maxLength: 4 }),
        (dmyWins, dateIdx, dmyDates, mdyDates) => {
          const dates = dmyWins
            ? [...dmyDates, mdyDates[0]!]
            : [...mdyDates, dmyDates[0]!];
          // 4-1 either way: ties are impossible here.
          const expected = dmyWins
            ? { convention: "dmy", dmyVotes: 4, mdyVotes: 1, ambiguous: false }
            : { convention: "mdy", dmyVotes: 1, mdyVotes: 4, ambiguous: false };
          expect(
            detectDateFormatDetailed(gridWith(dates, dateIdx), dateIdx),
          ).toEqual(expected);
        },
      ),
    );
  });

  it("counts text votes and ignores ISO dates", () => {
    fc.assert(
      fc.property(
        fc.array(textMDYArb, { minLength: 2, maxLength: 2 }),
        textDMYArb,
        fc.array(isoDateArb, { minLength: 0, maxLength: 2 }),
        fc.constantFrom(0, 1),
        (mdyDates, dmyDate, isoDates, dateIdx) => {
          const dates = [...mdyDates, dmyDate, ...isoDates];
          expect(
            detectDateFormatDetailed(gridWith(dates, dateIdx), dateIdx),
          ).toEqual({ convention: "mdy", dmyVotes: 1, mdyVotes: 2, ambiguous: false });
        },
      ),
    );
  });

  it("breaks text ties toward DMY without flagging ambiguity", () => {
    fc.assert(
      fc.property(textMDYArb, textDMYArb, fc.constantFrom(0, 1), (mdyDate, dmyDate, dateIdx) => {
        expect(
          detectDateFormatDetailed(gridWith([mdyDate, dmyDate], dateIdx), dateIdx),
        ).toEqual({ convention: "dmy", dmyVotes: 1, mdyVotes: 1, ambiguous: false });
      }),
    );
  });

  it("defaults on empty or garbage cells", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("", "   ", "abc", "!!", "2026"), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.constantFrom(0, 1),
        (dates, dateIdx) => {
          expect(
            detectDateFormatDetailed(gridWith(dates, dateIdx), dateIdx),
          ).toEqual({ convention: "dmy", dmyVotes: 0, mdyVotes: 0, ambiguous: false });
        },
      ),
    );
  });

  it("skips rows at or before the header index", () => {
    fc.assert(
      fc.property(
        fc.array(mdyOnlyArb, { minLength: 2, maxLength: 2 }),
        fc.array(dmyOnlyArb, { minLength: 2, maxLength: 2 }),
        fc.constantFrom(0, 1),
        (decoys, real, dateIdx) => {
          const rows = gridWith([...decoys, ...real], dateIdx);
          // Header + 2 decoys skipped: only the real rows vote.
          const skipped = detectDateFormatDetailed(rows, dateIdx, 2);
          expect(skipped).toEqual(
            detectDateFormatDetailed(rows.slice(2), dateIdx, 0),
          );
          expect(skipped.convention).toBe("dmy");
          expect(skipped.mdyVotes).toBe(0);
        },
      ),
    );
  });

  it("counts only transaction-led rows in multi-section mode", () => {
    fc.assert(
      fc.property(
        fc.array(dmyOnlyArb, { minLength: 1, maxLength: 3 }),
        fc.array(mdyOnlyArb, { minLength: 1, maxLength: 3 }),
        (realDates, decoyDates) => {
          const rows: string[][] = [["Type", "Date"]];
          for (const d of realDates) rows.push(["Transaction", d]);
          for (const d of decoyDates) rows.push(["Transfer", d]);
          rows.push(["", ""]);
          rows.push(["Balance", decoyDates[0]!]);
          const multi = detectDateFormatDetailed(rows, 1, 0, true);
          // Keep the header at index 0 so both loops vote the same range.
          const filtered = [
            rows[0]!,
            ...rows.slice(1).filter(
              (r) =>
                r.every((c) => c.trim() === "") ||
                r[0]?.trim().toLowerCase() === "transaction",
            ),
          ];
          expect(multi).toEqual(detectDateFormatDetailed(filtered, 1, 0, false));
          expect(multi.convention).toBe("dmy");
          expect(multi.mdyVotes).toBe(0);
        },
      ),
    );
  });

  it("keeps the wrapper in agreement and never throws on hostile grids", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }), {
          maxLength: 5,
        }),
        fc.integer({ min: -1, max: 4 }),
        fc.integer({ min: -1, max: 3 }),
        fc.boolean(),
        (rows, dateIdx, headerIdx, multi) => {
          let detailed: ReturnType<typeof detectDateFormatDetailed> | undefined;
          let simple: string | undefined;
          expect(() => {
            detailed = detectDateFormatDetailed(rows, dateIdx, headerIdx, multi);
            simple = detectDateFormat(rows, dateIdx, headerIdx, multi);
          }).not.toThrow();
          expect(simple).toBe(detailed!.convention);
          expect(["dmy", "mdy"]).toContain(detailed!.convention);
          expect(Number.isInteger(detailed!.dmyVotes)).toBe(true);
          expect(Number.isInteger(detailed!.mdyVotes)).toBe(true);
          expect(detailed!.dmyVotes).toBeGreaterThanOrEqual(0);
          expect(detailed!.mdyVotes).toBeGreaterThanOrEqual(0);
          expect(typeof detailed!.ambiguous).toBe("boolean");
        },
      ),
    );
  });
});

/* ---------------- parseAmount ---------------- */

/** Cents-exact dollar values with a canonical decimal rendering. */
const moneyArb = fc
  .tuple(fc.integer({ min: -999_999_999, max: 999_999_999 }), fc.integer({ min: 0, max: 9 }))
  .map(([c, r]) => {
    const cents = r === 0 ? 0 : c; // 10% zeros
    const abs = Math.abs(cents);
    const intPart = String(Math.floor(abs / 100));
    const frac2 = String(abs % 100).padStart(2, "0");
    const frac = frac2 === "00" ? null : frac2.endsWith("0") ? frac2.slice(0, 1) : frac2;
    return { intPart, frac, canonical: Number(frac == null ? intPart : `${intPart}.${frac}`) };
  });

const groupEvery3 = (s: string, sep: string): string =>
  s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);

type CoreStyle =
  | "plain"
  | "enGroup"
  | "deGroup"
  | "spaceDot"
  | "spaceComma"
  | "commaDec"
  | "trailComma"
  | "leadDot"
  | "trailDot";

function renderCore(intPart: string, frac: string | null, style: CoreStyle): string {
  switch (style) {
    case "plain":
      return frac == null ? intPart : `${intPart}.${frac}`;
    case "enGroup":
      return frac == null ? groupEvery3(intPart, ",") : `${groupEvery3(intPart, ",")}.${frac}`;
    case "deGroup":
      return frac == null ? groupEvery3(intPart, ".") : `${groupEvery3(intPart, ".")},${frac}`;
    case "spaceDot":
      return frac == null ? groupEvery3(intPart, " ") : `${groupEvery3(intPart, " ")}.${frac}`;
    case "spaceComma":
      return frac == null ? groupEvery3(intPart, " ") : `${groupEvery3(intPart, " ")},${frac}`;
    case "commaDec":
      // 1-2 digit tails can never match grouping: always a decimal comma.
      return frac == null ? intPart : `${intPart},${frac}`;
    case "trailComma":
      return frac == null ? `${intPart},` : `${intPart}.${frac}`;
    case "leadDot":
      return frac != null && intPart === "0" ? `.${frac}` : `${intPart}${frac == null ? "" : `.${frac}`}`;
    case "trailDot":
      return frac == null ? `${intPart}.` : `${intPart}.${frac}`;
  }
}

type Wrap = {
  outerSign: "" | "-" | "+";
  parens: boolean;
  innerSign: "" | "-" | "+";
  curr: "none" | "pre" | "post" | "innerPre" | "innerPost";
  symbol: string;
  pad: number;
};

const wrapArb: fc.Arbitrary<Wrap> = fc
  .tuple(
    fc.constantFrom("", "-", "+"),
    fc.boolean(),
    fc.constantFrom("", "-", "+"),
    fc.constantFrom("none", "pre", "post", "innerPre", "innerPost"),
    fc.constantFrom("$", "€", "£", "¥"),
    fc.integer({ min: 0, max: 2 }),
  )
  .map(([outerSign, parens, innerSign, curr, symbol, pad]) => ({
    outerSign,
    parens,
    // A minus in both places is rejected; normalize to inner plus.
    innerSign: outerSign === "-" && innerSign === "-" ? "+" : innerSign,
    curr: (curr === "innerPre" || curr === "innerPost") && !parens ? "pre" : curr,
    symbol,
    pad,
  }));

function renderAmount(core: string, w: Wrap): string {
  const sp = " ".repeat(w.pad);
  const join = (parts: string[]): string => parts.filter((p) => p !== "").join(sp);
  const inner = join([
    w.innerSign,
    w.curr === "innerPre" ? w.symbol : "",
    core,
    w.curr === "innerPost" ? w.symbol : "",
  ]);
  const parened = w.parens ? `(${sp}${inner}${sp})` : inner;
  const outer = join([
    w.outerSign,
    w.curr === "pre" ? w.symbol : "",
    parened,
    w.curr === "post" ? w.symbol : "",
  ]);
  return `${sp}${outer}${sp}`;
}

describe("parseAmount properties", () => {
  it("round-trips every locale, sign, currency, and padding combo", () => {
    fc.assert(
      fc.property(
        moneyArb,
        fc.constantFrom<CoreStyle>(
          "plain",
          "enGroup",
          "deGroup",
          "spaceDot",
          "spaceComma",
          "commaDec",
          "trailComma",
          "leadDot",
          "trailDot",
        ),
        wrapArb,
        ({ intPart, frac, canonical }, style, wrap) => {
          const text = renderAmount(renderCore(intPart, frac, style), wrap);
          // Plus signs are no-ops; each minus and the parens flip once.
          const sign =
            (wrap.parens ? -1 : 1) *
            (wrap.outerSign === "-" || wrap.innerSign === "-" ? -1 : 1);
          const raw = sign * canonical;
          expect(parseAmount(text)).toBe(raw === 0 ? 0 : raw);
        },
      ),
    );
  });

  it("rejects malformed strings", () => {
    const digits = fc.integer({ min: 0, max: 9999 }).map(String);
    const d2 = fc.integer({ min: 10, max: 99 }).map(String);
    const d3 = fc.integer({ min: 100, max: 999 }).map(String);
    const rejectArb = fc.oneof(
      // Two or more currency symbols anywhere.
      fc
        .tuple(
          fc.constantFrom("$", "€", "£", "¥"),
          digits,
          fc.constantFrom("$", "€", "£", "¥"),
        )
        .map(([a, d, b]) => `${a}${d}${b}`),
      // Unbalanced or empty parentheses.
      fc
        .tuple(digits, fc.constantFrom("open", "close", "double", "empty"))
        .map(([d, kind]) =>
          kind === "open"
            ? `(${d}`
            : kind === "close"
              ? `${d})`
              : kind === "double"
                ? `((${d}))`
                : "()",
        ),
      // Embedded junk between digits.
      fc
        .tuple(digits, fc.constantFrom("$", "-", "+", "€", "a", "Z", "_"), digits)
        .map(([a, j, b]) => `${a}${j}${b}`),
      // Multi-separator groupings with a bad group.
      fc
        .tuple(d2, d2, d3)
        .map(([a, b, c]) => `${a},${b},${c}`),
      fc
        .tuple(d2, d2, d3)
        .map(([a, b, c]) => `${a}.${b}.${c}`),
      // Lone marks and words.
      fc.constantFrom(".", ",", "", "   ", "-", "+", "$", "(", ")", "( )", "abc", "NaN", "Infinity", "1e5"),
    );
    fc.assert(
      fc.property(rejectArb, (input) => {
        expect(parseAmount(input)).toBeNull();
      }),
    );
  });

  it("rejects non-strings", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(123),
          fc.constant(0),
          fc.constant(-1.5),
          fc.constant(NaN),
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(true),
          fc.constant({}),
          fc.constant([]),
        ),
        (input) => {
          expect(parseAmount(input as unknown as string)).toBeNull();
        },
      ),
    );
  });

  it("nulls out unsafe-magnitude integers", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.integer({ min: 1, max: 9 }),
            fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 15, maxLength: 40 }),
          )
          .map(([head, tail]) => String(head) + tail.join("")),
        (digits) => {
          // ≥16 digits, leading non-zero: ×100 always exceeds MAX_SAFE_INTEGER.
          expect(parseAmount(digits)).toBeNull();
        },
      ),
    );
  });

  it("keeps short integers exact", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 13 }).map((n) => "9".repeat(n)),
        (digits) => {
          expect(parseAmount(digits)).toBe(Number(digits));
        },
      ),
    );
  });

  it("pins grouping-vs-decimal precedence", () => {
    const cases: [string, number | null][] = [
      ["1,235", 1235],
      ["1.235", 1235],
      ["123,456", 123456],
      ["1,2345", 1.2345],
      ["12,34", 12.34],
      ["1 234", 1234],
      [".5", 0.5],
      ["5.", 5],
      ["5,", 5],
      ["NaN", null],
      ["Infinity", null],
      ["", null],
      ["   ", null],
    ];
    for (const [input, expected] of cases) {
      expect(parseAmount(input)).toBe(expected);
    }
  });

  it("never throws and only emits finite numbers on hostile input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (input) => {
        let out: number | null | undefined;
        expect(() => {
          out = parseAmount(input);
        }).not.toThrow();
        if (out != null) {
          expect(typeof out).toBe("number");
          expect(Number.isFinite(out)).toBe(true);
        }
      }),
    );
  });
});

/* ---------------- parseCsvImport ---------------- */

type BankRow = {
  iso: string;
  payee: string;
  memo: string;
  category: string;
  outCents: number;
  inCents: number;
  amtCents: number;
  useOut: boolean;
  grouped: boolean;
};

const cleanPayeeArb = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim() !== "");

const signedCentsArb = (): fc.Arbitrary<number> =>
  fc
    .tuple(fc.integer({ min: 1, max: 50_000_000 }), fc.boolean())
    .map(([m, neg]) => (neg ? -m : m));

const bankRowArb = (payeeArb: fc.Arbitrary<string>): fc.Arbitrary<BankRow> =>
  fc
    .tuple(
      ymdArb,
      payeeArb,
      fc.string({ maxLength: 24 }),
      fc.string({ maxLength: 24 }),
      fc.integer({ min: 1, max: 50_000_000 }),
      fc.integer({ min: 1, max: 50_000_000 }),
      fc
        .tuple(fc.integer({ min: 1, max: 50_000_000 }), fc.boolean())
        .map(([m, neg]) => (neg ? -m : m)),
      fc.boolean(),
      fc.boolean(),
    )
    .map(([ymd, payee, memo, category, outCents, inCents, amtCents, useOut, grouped]) => ({
      iso: ymd.iso,
      payee,
      memo,
      category,
      outCents,
      inCents,
      amtCents,
      useOut,
      grouped,
    }));

const renderDollars = (cents: number, grouped: boolean): string => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const intPart = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${grouped ? groupEvery3(intPart, ",") : intPart}.${frac}`;
};

type LayoutExpect = { payee: string; memo: string; category: string; dollars: number };

type Layout = {
  header: string[];
  cells: (r: BankRow) => string[];
  expected: (r: BankRow) => LayoutExpect;
};

const LAYOUTS: Layout[] = [
  {
    header: ["Date", "Payee", "Amount"],
    cells: (r) => [r.iso, r.payee, renderDollars(r.amtCents, r.grouped)],
    expected: (r) => ({
      payee: r.payee.trim(),
      memo: "",
      category: "",
      dollars: r.amtCents / 100,
    }),
  },
  {
    header: ["Date", "Payee", "Memo", "Category", "Outflow", "Inflow"],
    cells: (r) => [
      r.iso,
      r.payee,
      r.memo,
      r.category,
      r.useOut ? renderDollars(r.outCents, r.grouped) : "",
      r.useOut ? "" : renderDollars(r.inCents, r.grouped),
    ],
    expected: (r) => ({
      payee: r.payee.trim(),
      memo: r.memo.trim(),
      category: r.category.trim(),
      dollars: (r.useOut ? -r.outCents : r.inCents) / 100,
    }),
  },
  {
    header: ["Transaction Date", "Description", "Amount"],
    cells: (r) => [r.iso, r.payee, renderDollars(r.amtCents, r.grouped)],
    expected: (r) => ({
      payee: r.payee.trim(),
      memo: "",
      category: "",
      dollars: r.amtCents / 100,
    }),
  },
  {
    header: ["DATE", "MERCHANT", "CATEGORY", "NOTE", "DEBIT", "CREDIT"],
    cells: (r) => [
      r.iso,
      r.payee,
      r.category,
      r.memo,
      r.useOut ? renderDollars(r.outCents, r.grouped) : "",
      r.useOut ? "" : renderDollars(r.inCents, r.grouped),
    ],
    expected: (r) => ({
      payee: r.payee.trim(),
      memo: r.memo.trim(),
      category: r.category.trim(),
      dollars: (r.useOut ? -r.outCents : r.inCents) / 100,
    }),
  },
];

const bankCsvArb = (payeeArb: fc.Arbitrary<string>) =>
  fc
    .tuple(
      fc.constantFrom(...LAYOUTS),
      fc.array(bankRowArb(payeeArb), { minLength: 1, maxLength: 4 }),
      fc.boolean(),
    )
    .map(([layout, rows, trailing]) => {
      let text = [layout.header, ...rows.map((r) => layout.cells(r))]
        .map((cells) => cells.map(escapeCell).join(","))
        .join("\n");
      if (trailing) text += "\n";
      return { layout, rows, text };
    });

/** Mirror of updatePayeeError: recompute Missing-payee around swapped payee. */
function mirrorPayeeError(oldError: string | null, newPayee: string): string | null {
  const parts = oldError
    ? oldError.split("; ").filter((p) => p !== "Missing payee" && p.trim() !== "")
    : [];
  if (!newPayee.trim()) parts.push("Missing payee");
  return parts.length > 0 ? parts.join("; ") : null;
}

describe("parseCsvImport properties", () => {
  it("round-trips clean bank CSVs", () => {
    fc.assert(
      fc.property(bankCsvArb(cleanPayeeArb), ({ layout, rows, text }) => {
        const result = parseCsvImport(text);
        expect(result.headerError).toBeNull();
        expect(result.rows.length).toBe(rows.length);
        expect(result.detectedDateFormat).toBe("dmy");
        expect(result.dateAmbiguous).toBe(false);
        rows.forEach((r, i) => {
          const row = result.rows[i]!;
          const exp = layout.expected(r);
          expect(row.rowNumber).toBe(i + 2);
          expect(row.date).toBe(r.iso);
          expect(row.payee).toBe(exp.payee);
          expect(row.memo).toBe(exp.memo);
          expect(row.category).toBe(exp.category);
          expect(row.amountCents).toBe(dollarsToCents(exp.dollars));
          expect(row.error).toBeNull();
        });
      }),
    );
  });

  it("reports row faults with exact taxonomy", () => {
    fc.assert(
      fc.property(
        bankRowArb(cleanPayeeArb),
        fc
          .tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean())
          .filter(([d, a, p]) => d || a || p),
        (base, [badDate, badAmount, emptyPayee, useZero]) => {
          const cells = [
            badDate ? "not-a-date" : base.iso,
            emptyPayee ? "" : base.payee,
            badAmount ? (useZero ? "0.00" : "abc") : renderDollars(base.amtCents, false),
          ];
          const text = [["Date", "Payee", "Amount"], cells]
            .map((r) => r.map(escapeCell).join(","))
            .join("\n");
          const result = parseCsvImport(text);
          expect(result.headerError).toBeNull();
          expect(result.rows.length).toBe(1);
          const row = result.rows[0]!;
          const parts: string[] = [];
          if (badDate) parts.push("Invalid date");
          if (badAmount) parts.push(useZero ? "Amount is zero" : "Invalid amount");
          if (emptyPayee) parts.push("Missing payee");
          expect(row.error).toBe(parts.join("; "));
          expect(row.date).toBe(badDate ? null : base.iso);
          expect(row.amountCents).toBe(
            badAmount ? (useZero ? 0 : null) : dollarsToCents(base.amtCents / 100),
          );
          expect(row.payee).toBe(emptyPayee ? "" : base.payee.trim());
        },
      ),
    );
  });

  it("applies outflow/inflow/amount precedence with sign forcing", () => {
    const header = ["Date", "Payee", "Outflow", "Inflow", "Amount"];
    fc.assert(
      fc.property(
        ymdArb,
        cleanPayeeArb,
        fc.constantFrom("out", "in", "amt", "allZero", "zeroFallthrough"),
        fc.boolean(),
        signedCentsArb(),
        signedCentsArb(),
        signedCentsArb(),
        (ymd, payee, mode, blankIsSpaces, outV, inV, amtV) => {
          const blank = blankIsSpaces ? "   " : "";
          const cells = [ymd.iso, payee, "", "", ""];
          let expectedDollars: number;
          let expectedError: string | null = null;
          if (mode === "out") {
            cells[2] = renderDollars(outV, false);
            cells[3] = renderDollars(inV, false);
            cells[4] = renderDollars(amtV, false);
            expectedDollars = -Math.abs(outV) / 100;
          } else if (mode === "in") {
            cells[2] = blank;
            cells[3] = renderDollars(inV, false);
            cells[4] = renderDollars(amtV, false);
            expectedDollars = Math.abs(inV) / 100;
          } else if (mode === "amt") {
            cells[2] = blank;
            cells[3] = blank;
            cells[4] = renderDollars(amtV, false);
            expectedDollars = amtV / 100;
          } else if (mode === "allZero") {
            cells[2] = "0";
            cells[3] = "0";
            cells[4] = "0";
            expectedDollars = 0;
            expectedError = "Amount is zero";
          } else {
            cells[2] = "0";
            cells[3] = renderDollars(inV, false);
            cells[4] = renderDollars(amtV, false);
            expectedDollars = Math.abs(inV) / 100;
          }
          const text = [header, cells].map((r) => r.map(escapeCell).join(",")).join("\n");
          const result = parseCsvImport(text);
          expect(result.headerError).toBeNull();
          expect(result.rows.length).toBe(1);
          const row = result.rows[0]!;
          expect(row.amountCents).toBe(dollarsToCents(expectedDollars));
          expect(row.error).toBe(expectedError);
        },
      ),
    );
  });

  it("swaps payee/memo with exact error recomputation", () => {
    fc.assert(
      fc.property(
        bankCsvArb(fc.string({ maxLength: 24 })),
        ({ text }) => {
          const base = parseCsvImport(text);
          const swapped = parseCsvImport(text, { swap: true });
          expect(swapped.headerError).toBe(base.headerError);
          expect(swapped.rows.length).toBe(base.rows.length);
          expect(swapped.detectedDateFormat).toBe(base.detectedDateFormat);
          expect(swapped.dateAmbiguous).toBe(base.dateAmbiguous);
          base.rows.forEach((b, i) => {
            const s = swapped.rows[i]!;
            expect(s.payee).toBe(b.memo);
            expect(s.memo).toBe(b.payee);
            expect(s.rowNumber).toBe(b.rowNumber);
            expect(s.date).toBe(b.date);
            expect(s.category).toBe(b.category);
            expect(s.amountCents).toBe(b.amountCents);
            expect(s.error).toBe(mirrorPayeeError(b.error, b.memo));
          });
          // Falsy swap is a no-op.
          expect(parseCsvImport(text, { swap: false })).toEqual(base);
          expect(parseCsvImport(text, {})).toEqual(base);
        },
      ),
    );
  });

  it("reports missing columns in date/payee/amount precedence", () => {
    const cases: [string[], string][] = [
      [["Amount"], "Could not find a Date column"],
      [["Date"], "Could not find a Payee column"],
      [["Payee"], "Could not find a Date column"],
      [["Amount", "Payee"], "Could not find a Date column"],
      [["Date", "Amount"], "Could not find a Payee column"],
      [["Date", "Payee"], "Could not find an Outflow, Inflow, or Amount column"],
    ];
    for (const [header, message] of cases) {
      expect(parseCsvImport(header.map(escapeCell).join(","))).toEqual({
        headerError: message,
        rows: [],
        detectedDateFormat: "dmy",
        dateAmbiguous: false,
      });
    }
  });

  it("recognizes header keyword variants", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Date", "DATE", "Transaction Date", "date-posted", " Settlement_Date "),
        fc.constantFrom("Payee", "Merchant Name", "VENDOR", "Description", "Details", "memo", "Note"),
        fc.constantFrom("single", "outin"),
        fc.constantFrom("lower", "upper", "title", "asis"),
        fc.boolean(),
        (dateH, payeeH, amountKind, casing, pad) => {
          const vary = (h: string): string => {
            const cased =
              casing === "lower"
                ? h.toLowerCase()
                : casing === "upper"
                  ? h.toUpperCase()
                  : casing === "title"
                    ? h.replace(/\b\w/g, (c) => c.toUpperCase())
                    : h;
            return pad ? `  ${cased}  ` : cased;
          };
          const header =
            amountKind === "single"
              ? [vary(dateH), vary(payeeH), vary("Amount")]
              : [vary(dateH), vary(payeeH), vary("Withdrawal"), vary("Deposit")];
          const data =
            amountKind === "single"
              ? ["2026-01-05", "Store", "10.00"]
              : ["2026-01-05", "Store", "10.00", ""];
          const text = [header, data].map((r) => r.map(escapeCell).join(",")).join("\n");
          const result = parseCsvImport(text);
          expect(result.headerError).toBeNull();
          expect(result.rows.length).toBe(1);
          const row = result.rows[0]!;
          expect(row.rowNumber).toBe(2);
          expect(row.date).toBe("2026-01-05");
          expect(row.payee).toBe("Store");
          expect(row.amountCents).toBe(amountKind === "single" ? 1000 : -1000);
          expect(row.error).toBeNull();
        },
      ),
    );
  });

  it("pins early-return shapes", () => {
    expect(parseCsvImport("")).toStrictEqual({ headerError: "The file is empty", rows: [] });
    expect(parseCsvImport("  \n \r\n ")).toStrictEqual({
      headerError: "The file is empty",
      rows: [],
    });
    const bad = parseCsvImport('"abc');
    expect(bad.rows).toEqual([]);
    expect(bad.headerError).toMatch(/Unclosed quote/);
    expect(bad.detectedDateFormat).toBeUndefined();
    expect(bad.dateAmbiguous).toBeUndefined();
  });

  it("lets an explicit date format override detection", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 13, max: 28 }),
        fc.integer({ min: 1, max: 12 }),
        fc.boolean(),
        (isDmy, day, month, sameDir) => {
          const text = isDmy ? `${day}/${month}/2026` : `${month}/${day}/2026`;
          const iso = `2026-${pad2(month)}-${pad2(day)}`;
          const opt = sameDir === isDmy ? "dmy" : "mdy";
          const csv = [["Date", "Payee", "Amount"], [text, "Store", "10.00"]]
            .map((r) => r.map(escapeCell).join(","))
            .join("\n");
          const result = parseCsvImport(csv, { dateFormat: opt });
          expect(result.headerError).toBeNull();
          expect(result.detectedDateFormat).toBe(opt);
          expect(result.dateAmbiguous).toBe(false);
          expect(result.rows.length).toBe(1);
          const row = result.rows[0]!;
          if (sameDir) {
            expect(row.date).toBe(iso);
            expect(row.error).toBeNull();
          } else {
            // Reinterpreted under the wrong convention: month > 12.
            expect(row.date).toBeNull();
            expect(row.error).toBe("Invalid date");
          }
        },
      ),
    );
  });

  it("treats auto and omitted date format identically", () => {
    fc.assert(
      fc.property(bankCsvArb(cleanPayeeArb), ({ text }) => {
        const base = parseCsvImport(text);
        expect(parseCsvImport(text, { dateFormat: "auto" })).toEqual(base);
        expect(parseCsvImport(text, {})).toEqual(base);
      }),
    );
  });

  it("never throws on hostile text and options", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.oneof(
          fc.constant(undefined),
          fc.constant({}),
          fc.record({
            swap: fc.option(fc.boolean(), { nil: undefined }),
            dateFormat: fc.option(fc.constantFrom("auto", "dmy", "mdy"), {
              nil: undefined,
            }),
          }),
        ),
        (text, opts) => {
          let result: ReturnType<typeof parseCsvImport> | undefined;
          expect(() => {
            result = parseCsvImport(text, opts);
          }).not.toThrow();
          const r = result!;
          expect(typeof r.headerError === "string" || r.headerError === null).toBe(true);
          expect(Array.isArray(r.rows)).toBe(true);
          if (r.headerError === null) {
            expect(["dmy", "mdy"]).toContain(r.detectedDateFormat);
            expect(typeof r.dateAmbiguous).toBe("boolean");
          }
          for (const row of r.rows) {
            expect(typeof row.rowNumber).toBe("number");
            expect(typeof row.payee).toBe("string");
            expect(typeof row.memo).toBe("string");
            expect(typeof row.category).toBe("string");
            expect(typeof row.error === "string" || row.error === null).toBe(true);
            expect(typeof row.amountCents === "number" || row.amountCents === null).toBe(true);
            expect(typeof row.date === "string" || row.date === null).toBe(true);
          }
        },
      ),
    );
  });
});

describe("headerless import properties", () => {
  /** "P"-prefixed payees never parse as dates (no month starts with P). */
  const safePayeeArb = fc.string({ maxLength: 20 }).map((s) => `P${s}`);

  /** Fixed words: never amounts, dates, or header keywords. */
  const MEMO_WORDS = ["groceries", "rent", "TAXI", "uber trip", "Food", "Travel"];
  const memoWordArb = fc.constantFrom(...MEMO_WORDS, "");

  type Triple = [number, number, number]; // positions of date, payee, amount
  const TRIPLES: Triple[] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];

  it("maps headerless triple columns positionally across orders", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRIPLES),
        fc.array(
          fc.tuple(ymdArb, safePayeeArb, signedCentsArb()),
          { minLength: 1, maxLength: 3 },
        ),
        fc.boolean(),
        ([dPos, pPos, aPos], data, trailing) => {
          let text = data
            .map(([ymd, payee, cents]) => {
              const cells = ["", "", ""];
              cells[dPos] = ymd.iso;
              cells[pPos] = payee;
              cells[aPos] = renderDollars(cents, false);
              return cells.map(escapeCell).join(",");
            })
            .join("\n");
          if (trailing) text += "\n";
          const result = parseCsvImport(text);
          expect(result.headerError).toBeNull();
          expect(result.rows.length).toBe(data.length);
          expect(result.detectedDateFormat).toBe("dmy");
          expect(result.dateAmbiguous).toBe(false);
          data.forEach(([ymd, payee, cents], i) => {
            const row = result.rows[i]!;
            expect(row.rowNumber).toBe(i + 1);
            expect(row.date).toBe(ymd.iso);
            expect(row.payee).toBe(payee.trim());
            expect(row.amountCents).toBe(dollarsToCents(cents / 100));
            expect(row.error).toBeNull();
          });
        },
      ),
    );
  });

  it("detects memo vs outflow-inflow pairs in 4-column files", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("memo", "outin"),
        fc.boolean(),
        fc.array(
          fc.tuple(ymdArb, safePayeeArb, memoWordArb, signedCentsArb()),
          { minLength: 1, maxLength: 3 },
        ),
        (variant, dateSecond, data) => {
          const rows = data.map(([ymd, payee, memo, v1], i) => {
            const tail =
              variant === "memo"
                ? [memo, renderDollars(v1, false)]
                : i === 0
                  ? [renderDollars(Math.abs(v1), false), ""]
                  : v1 > 0
                    ? [renderDollars(v1, false), ""]
                    : ["", renderDollars(Math.abs(v1), false)];
            return dateSecond ? [payee, ymd.iso, ...tail] : [ymd.iso, payee, ...tail];
          });
          const text = rows.map((r) => r.map(escapeCell).join(",")).join("\n");
          const result = parseCsvImport(text);
          expect(result.headerError).toBeNull();
          expect(result.rows.length).toBe(data.length);
          data.forEach(([ymd, payee, memo, v1], i) => {
            const row = result.rows[i]!;
            expect(row.rowNumber).toBe(i + 1);
            expect(row.date).toBe(ymd.iso);
            expect(row.payee).toBe(payee.trim());
            expect(row.error).toBeNull();
            if (variant === "memo") {
              expect(row.memo).toBe(memo.trim());
              expect(row.amountCents).toBe(dollarsToCents(v1 / 100));
            } else {
              const outFilled = i === 0 || v1 > 0;
              expect(row.amountCents).toBe(
                dollarsToCents((outFilled ? -Math.abs(v1) : Math.abs(v1)) / 100),
              );
            }
          });
        },
      ),
    );
  });

  it("rejects files without an amount column", () => {
    // The fallback analyzes the first data row as a header, so the error
    // names the Date column even though dates exist (pinned wart).
    const expected = {
      headerError: "Could not find a Date column",
      rows: [],
      detectedDateFormat: "dmy",
      dateAmbiguous: false,
    };
    expect(parseCsvImport("2026-01-05,Store\n2026-01-06,Shop")).toEqual(expected);
    expect(parseCsvImport("2026-01-05\n2026-01-06")).toEqual(expected);
  });

  it("assigns headerless columns without overlap", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("overlap", "control6", "control5"),
        fc.array(ymdArb, { minLength: 1, maxLength: 3 }),
        (layout, dates) => {
          const rows = dates.map((ymd, i) => {
            const outFirst = i % 2 === 0;
            const out = outFirst ? "50.00" : "";
            const inf = outFirst ? "" : "60.00";
            if (layout === "overlap") return [ymd.iso, `PStore${i}`, MEMO_WORDS[i % MEMO_WORDS.length]!, out, inf];
            if (layout === "control6")
              return [ymd.iso, `PStore${i}`, MEMO_WORDS[i % MEMO_WORDS.length]!, `Cat${i}`, out, inf];
            return [ymd.iso, `PStore${i}`, MEMO_WORDS[i % MEMO_WORDS.length]!, `Cat${i}`, i % 2 === 0 ? "-70.00" : "80.00"];
          });
          const text = rows.map((r) => r.map(escapeCell).join(",")).join("\n");
          const result = parseCsvImport(text);
          expect(result.headerError).toBeNull();
          expect(result.rows.length).toBe(dates.length);
          result.rows.forEach((row, i) => {
            expect(row.error).toBeNull();
            if (layout === "overlap") {
              // No category column exists: the field must stay empty.
              expect(row.category).toBe("");
              expect(row.amountCents).toBe(i % 2 === 0 ? -5000 : 6000);
            } else if (layout === "control6") {
              expect(row.category).toBe(`Cat${i}`);
              expect(row.amountCents).toBe(i % 2 === 0 ? -5000 : 6000);
            } else {
              expect(row.category).toBe(`Cat${i}`);
              expect(row.amountCents).toBe(i % 2 === 0 ? -7000 : 8000);
            }
          });
        },
      ),
    );
  });
});

describe("multi-section import properties", () => {
  it("parses only transaction-led rows", () => {
    fc.assert(
      fc.property(
        fc.array(dmyOnlyArb, { minLength: 1, maxLength: 3 }),
        fc.array(mdyOnlyArb, { minLength: 1, maxLength: 2 }),
        fc.constantFrom("Transfer", "Balance", "Opening Balance", " transfer "),
        fc.boolean(),
        (realDates, decoyDates, decoyType, trailingEmpty) => {
          const items: { type: string; date: string; keep: boolean }[] = [];
          const n = Math.max(realDates.length, decoyDates.length);
          for (let k = 0; k < n; k++) {
            if (k < realDates.length)
              items.push({ type: "Transaction", date: realDates[k]!, keep: true });
            if (k < decoyDates.length)
              items.push({ type: decoyType, date: decoyDates[k]!, keep: false });
          }
          if (trailingEmpty) items.push({ type: "", date: "", keep: false });
          const lines = [["Type", "Date", "Payee", "Amount"]];
          const keptLines: number[] = [];
          items.forEach((it, idx) => {
            lines.push([it.type, it.date, it.keep ? "Store" : "Decoy", it.keep ? "10.00" : "99.99"]);
            if (it.keep) keptLines.push(idx + 2);
          });
          const text = lines.map((r) => r.map(escapeCell).join(",")).join("\n");
          const result = parseCsvImport(text);
          expect(result.headerError).toBeNull();
          expect(result.rows.length).toBe(realDates.length);
          // Decoys are excluded from date detection too.
          expect(result.detectedDateFormat).toBe("dmy");
          expect(result.dateAmbiguous).toBe(false);
          result.rows.forEach((row, i) => {
            expect(row.rowNumber).toBe(keptLines[i]);
            expect(row.payee).toBe("Store");
            expect(row.amountCents).toBe(1000);
            expect(row.error).toBeNull();
            const [d, m, y] = realDates[i]!.split(/[-/.]/);
            const yyyy = y!.length === 2 ? `20${y}` : y!;
            expect(row.date).toBe(`${yyyy}-${pad2(Number(m))}-${pad2(Number(d))}`);
          });
        },
      ),
    );
  });
});

describe("swapPayeeMemo properties", () => {
  const mkRow = (over: Partial<CsvImportRow>): CsvImportRow => ({
    rowNumber: 1,
    date: "2026-01-01",
    payee: "Payee",
    memo: "Memo",
    category: "",
    amountCents: 100,
    error: null,
    ...over,
  });

  it("returns the same reference when swap is falsy", () => {
    fc.assert(
      fc.property(fc.constantFrom(false, undefined), (swap) => {
        const rows = [mkRow({}), mkRow({ payee: "", error: "Missing payee" })];
        expect(swapPayeeMemo(rows, swap)).toBe(rows);
        if (swap === undefined) expect(swapPayeeMemo(rows)).toBe(rows);
      }),
    );
  });

  it("swaps fields and recomputes only the payee error", () => {
    const cases: [CsvImportRow, CsvImportRow][] = [
      [
        mkRow({ payee: "", memo: "memo", error: "Missing payee" }),
        mkRow({ payee: "memo", memo: "", error: null }),
      ],
      [
        mkRow({ payee: "pay", memo: "", error: null }),
        mkRow({ payee: "", memo: "pay", error: "Missing payee" }),
      ],
      [
        mkRow({ payee: "pay", memo: "memo", error: "Invalid date" }),
        mkRow({ payee: "memo", memo: "pay", error: "Invalid date" }),
      ],
      [
        mkRow({ payee: "", memo: "", error: "Invalid date; Missing payee" }),
        mkRow({ payee: "", memo: "", error: "Invalid date; Missing payee" }),
      ],
      [
        mkRow({ payee: "pay", memo: "", error: "Invalid amount" }),
        mkRow({ payee: "", memo: "pay", error: "Invalid amount; Missing payee" }),
      ],
    ];
    for (const [input, expected] of cases) {
      const out = swapPayeeMemo([input], true);
      expect(out).toEqual([expected]);
      expect(out[0]).not.toBe(input);
    }
  });

  it("is an involution on parser rows", () => {
    fc.assert(
      fc.property(bankCsvArb(fc.string({ maxLength: 24 })), ({ text }) => {
        const rows = parseCsvImport(text).rows;
        expect(swapPayeeMemo(swapPayeeMemo(rows, true), true)).toEqual(rows);
      }),
    );
  });
});
