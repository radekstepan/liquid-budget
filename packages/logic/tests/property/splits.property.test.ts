/**
 * Property tests for split validation, import repair, and the split
 * row-graph helpers (`src/split.ts`).
 *
 * Each property runs over hundreds of generated inputs; a failure shrinks
 * to a minimal counterexample. See `arbitraries.ts` for the shared
 * generators.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { num } from "../../src/format.js";
import {
  SPLIT_IMPORT_FILLER_MEMO,
  assertSplitsBalanced,
  getSplitChildren,
  getSplitParent,
  isSplitChild,
  isSplitParent,
  repairSplitForImport,
  splitChildrenTotal,
  type SplitChildLike,
} from "../../src/split.js";
import type { Transaction } from "../../src/types.js";
import { centsArb, idArb, nonZeroCentsArb, tx } from "./arbitraries.js";

/* ---------------- balanced-split generator ---------------- */

const categorizedChildArb: fc.Arbitrary<SplitChildLike> = fc.record({
  categoryId: idArb,
  transferAccountId: fc.constant(null),
  amount: nonZeroCentsArb,
});

const transferLegChildArb: fc.Arbitrary<SplitChildLike> = fc.record({
  categoryId: fc.constant(null),
  transferAccountId: idArb,
  amount: nonZeroCentsArb,
});

/** Positive inflow leg: no category needed by `assertSplitsBalanced`. */
const inflowLegChildArb: fc.Arbitrary<SplitChildLike> = fc.record({
  categoryId: fc.constant(null),
  transferAccountId: fc.constant(null),
  amount: fc.integer({ min: 1, max: 50_000_000 }),
});

const validChildArb = fc.oneof(
  categorizedChildArb,
  transferLegChildArb,
  inflowLegChildArb,
);

/** 2+ valid legs whose signed sum is the (non-zero) parent amount. */
const balancedSplitArb = fc
  .array(validChildArb, { minLength: 2, maxLength: 6 })
  .map((legs) => {
    const children = legs.map((c) => ({ ...c }));
    let sum = children.reduce((s, c) => s + c.amount, 0);
    if (sum === 0) {
      const first = children[0]!;
      const bump = first.amount > 0 ? 1 : -1;
      first.amount += bump;
      sum += bump;
    }
    return { parentAmount: sum, children };
  });

/* ---------------- assertSplitsBalanced ---------------- */

describe("assertSplitsBalanced properties", () => {
  it("accepts constructed balanced splits", () => {
    fc.assert(
      fc.property(balancedSplitArb, ({ parentAmount, children }) => {
        expect(() => assertSplitsBalanced(parentAmount, children)).not.toThrow();
      }),
    );
  });

  it("rejects children that do not sum to the parent", () => {
    fc.assert(
      fc.property(
        balancedSplitArb,
        fc.integer({ min: 1, max: 500 }),
        fc.boolean(),
        ({ parentAmount, children }, magnitude, negative) => {
          const delta = negative ? -magnitude : magnitude;
          const bumped =
            parentAmount + delta === 0 ? delta + (delta > 0 ? 1 : -1) : delta;
          expect(() =>
            assertSplitsBalanced(parentAmount + bumped, children),
          ).toThrow(/do not sum/);
        },
      ),
    );
  });

  it("requires at least two children", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1 }).chain((n) =>
          fc.array(categorizedChildArb, { minLength: n, maxLength: n }),
        ),
        (children) => {
          const sum = children.reduce((s, c) => s + c.amount, 0);
          expect(() =>
            assertSplitsBalanced(sum === 0 ? 7 : sum, children),
          ).toThrow(/at least two/);
        },
      ),
    );
  });

  it("rejects a zero parent", () => {
    fc.assert(
      fc.property(balancedSplitArb, ({ children }) => {
        expect(() => assertSplitsBalanced(0, children)).toThrow(/zero/);
      }),
    );
  });

  it("rejects a zero child", () => {
    fc.assert(
      fc.property(balancedSplitArb, fc.integer({ min: 0, max: 6 }), idArb, ({ parentAmount, children }, at, categoryId) => {
        const childrenWithZero = [...children];
        childrenWithZero.splice(at % (children.length + 1), 0, { categoryId, amount: 0 });
        expect(() => assertSplitsBalanced(parentAmount, childrenWithZero)).toThrow(
          /zero/,
        );
      }),
    );
  });

  it("rejects non-positive legs that lack a category and transfer leg", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000_000 }),
        nonZeroCentsArb,
        idArb,
        (magnitude, other, categoryId) => {
          const uncategorized = { amount: -magnitude };
          const sibling = { categoryId, amount: other };
          let parent = uncategorized.amount + sibling.amount;
          if (parent === 0) {
            sibling.amount += sibling.amount > 0 ? 1 : -1;
            parent = uncategorized.amount + sibling.amount;
          }
          expect(() =>
            assertSplitsBalanced(parent, [uncategorized, sibling]),
          ).toThrow(/category or transfer/);
        },
      ),
    );
  });

  it("accepts positive inflow legs without a category", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000_000 }),
        nonZeroCentsArb,
        idArb,
        (magnitude, other, categoryId) => {
          const inflow = { amount: magnitude };
          const sibling = { categoryId, amount: other };
          let parent = inflow.amount + sibling.amount;
          if (parent === 0) {
            sibling.amount += sibling.amount > 0 ? 1 : -1;
            parent = inflow.amount + sibling.amount;
          }
          expect(() => assertSplitsBalanced(parent, [inflow, sibling])).not.toThrow();
        },
      ),
    );
  });

  it("routes hostile amounts through the error factory", () => {
    // Number() itself throws on objects shadowing toString/valueOf with a
    // non-function (reachable from parsed JSON, e.g. {"toString": ""}) —
    // that must surface as the factory error, never a raw TypeError.
    class SentinelError extends Error {}
    fc.assert(
      fc.property(
        hostileAmountArb,
        fc.array(jsonChildArb, { minLength: 2, maxLength: 4 }),
        (parentAmount, children) => {
          let caught: unknown;
          try {
            assertSplitsBalanced(
              parentAmount as unknown as number,
              children as unknown as SplitChildLike[],
              (message) => new SentinelError(message),
            );
          } catch (e) {
            caught = e;
          }
          if (caught !== undefined) {
            expect(caught).toBeInstanceOf(SentinelError);
          }
        },
      ),
    );
  });

  it("rejects non-finite and unsafe amounts", () => {
    const hostile = fc.constantFrom(
      NaN,
      Infinity,
      -Infinity,
      2 ** 60,
      -(2 ** 60),
      1e21,
      -1e21,
    );
    fc.assert(
      fc.property(
        hostile,
        categorizedChildArb,
        categorizedChildArb,
        (bad, first, second) => {
          expect(() => assertSplitsBalanced(bad, [first, second])).toThrow();
          expect(() =>
            assertSplitsBalanced(100, [first, { ...second, amount: bad }]),
          ).toThrow();
        },
      ),
    );
  });
});

describe("hostile coercion regression (pinned)", () => {
  // Minimal counterexample found by the repair never-throw property:
  // Number({"toString": ""}) throws "Cannot convert object to primitive
  // value" instead of returning NaN.
  it('handles {"toString": ""} amounts per each function\'s contract', () => {
    class SentinelError extends Error {}
    const poison = { toString: "" };
    expect(() =>
      repairSplitForImport(poison as unknown as number, []),
    ).not.toThrow();
    expect(() =>
      assertSplitsBalanced(
        poison as unknown as number,
        [
          { categoryId: 1, amount: 60 },
          { categoryId: 2, amount: 40 },
        ],
        (message) => new SentinelError(message),
      ),
    ).toThrow(SentinelError);
  });
});

/* ---------------- repairSplitForImport ---------------- */

const integerRepairInputArb = fc.tuple(
  fc.integer({ min: -50_000_000, max: 50_000_000 }),
  fc.array(fc.integer({ min: -50_000_000, max: 50_000_000 }), { maxLength: 5 }),
);

/**
 * Objects whose Number()/String() coercion throws outright (a non-function
 * shadowing `toString`/`valueOf`) — reachable from parsed JSON such as
 * `{"toString": ""}`. Mixed into the hostile generators so the never-throw
 * and factory-routing contracts are exercised on every run, not by luck.
 */
const uncoercibleArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({ toString: fc.constantFrom("", 0, null, true) }),
  fc.record({ valueOf: fc.constantFrom("", 0, null, true) }),
);

const hostileAmountArb = fc.oneof(fc.jsonValue(), uncoercibleArb);

const jsonChildArb = fc.record({
  amount: hostileAmountArb,
  categoryId: fc.option(fc.jsonValue(), { nil: null }),
  transferAccountId: fc.option(fc.jsonValue(), { nil: null }),
  memo: fc.option(fc.jsonValue(), { nil: null }),
});

describe("repairSplitForImport properties", () => {
  it("never throws and never mutates on hostile JSON input", () => {
    fc.assert(
      fc.property(
        hostileAmountArb,
        fc.array(jsonChildArb, { maxLength: 5 }),
        (parentAmount, children) => {
          const before = JSON.stringify([parentAmount, children]);
          let out: ReturnType<typeof repairSplitForImport> | undefined;
          expect(() => {
            out = repairSplitForImport(
              parentAmount as unknown as number,
              children as unknown as SplitChildLike[],
            );
          }).not.toThrow();
          expect(JSON.stringify([parentAmount, children])).toBe(before);
          expect(Number.isInteger(out!.parentAmount)).toBe(true);
          for (const c of out!.children) {
            expect(Number.isInteger(c.amount)).toBe(true);
            expect(children.includes(c as unknown as (typeof children)[number])).toBe(
              false,
            );
          }
        },
      ),
    );
  });

  it("returns legs that sum to the parent whenever legs exist", () => {
    fc.assert(
      fc.property(integerRepairInputArb, ([parent, legs]) => {
        const out = repairSplitForImport(
          parent,
          legs.map((amount) => ({ amount })),
        );
        if (legs.length === 0) {
          expect(out.kind).toBe("empty");
          expect(out.children).toEqual([]);
          return;
        }
        expect(out.children.reduce((s, c) => s + c.amount, 0)).toBe(out.parentAmount);
      }),
    );
  });

  it("follows the balanced/single/filler/empty decision table", () => {
    fc.assert(
      fc.property(integerRepairInputArb, ([parent, legs]) => {
        const out = repairSplitForImport(
          parent,
          legs.map((amount) => ({ amount })),
        );
        const sum = legs.reduce((s, a) => s + a, 0);
        const difference = parent - sum;
        expect(out.difference).toBe(difference);
        expect(out.repaired).toBe(out.kind === "filler-added");
        if (legs.length === 0) {
          expect(out.kind).toBe("empty");
        } else if (difference === 0) {
          expect(out.kind).toBe("balanced");
          expect(out.parentAmount).toBe(parent);
        } else if (legs.length === 1) {
          expect(out.kind).toBe("single-child-kept");
          expect(out.parentAmount).toBe(sum);
        } else {
          expect(out.kind).toBe("filler-added");
          expect(out.parentAmount).toBe(parent);
        }
      }),
    );
  });

  it("stamps the filler leg with the difference and memo, preserving legs", () => {
    fc.assert(
      fc.property(integerRepairInputArb, fc.string({ maxLength: 40 }), ([parent, legs], memo) => {
        const out = repairSplitForImport(
          parent,
          legs.map((amount) => ({ amount })),
          memo,
        );
        if (out.kind !== "filler-added") return;
        expect(out.children.length).toBe(legs.length + 1);
        expect(out.children.slice(0, legs.length).map((c) => c.amount)).toEqual(legs);
        const filler = out.children[out.children.length - 1]!;
        expect(filler.amount).toBe(out.difference);
        expect(filler.memo).toBe(memo);
      }),
    );
  });

  it("uses the distinctive default filler memo", () => {
    fc.assert(
      fc.property(integerRepairInputArb, ([parent, legs]) => {
        const out = repairSplitForImport(
          parent,
          legs.map((amount) => ({ amount })),
        );
        if (out.kind !== "filler-added") return;
        const filler = out.children[out.children.length - 1]!;
        expect(filler.memo).toBe(SPLIT_IMPORT_FILLER_MEMO);
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(integerRepairInputArb, ([parent, legs]) => {
        const once = repairSplitForImport(
          parent,
          legs.map((amount) => ({ amount })),
        );
        const twice = repairSplitForImport(once.parentAmount, once.children);
        if (once.children.length === 0) {
          expect(twice.kind).toBe("empty");
        } else {
          expect(twice.kind).toBe("balanced");
          expect(twice.parentAmount).toBe(once.parentAmount);
        }
      }),
    );
  });

  it("produces validator-clean splits exactly when balanced or positive-filler", () => {
    // A filler leg carries no category, so a repaired split passes the
    // write-path validator only when the filler is a positive inflow leg
    // (or no filler was needed) and the parent is non-zero.
    fc.assert(
      fc.property(
        fc.integer({ min: -50_000_000, max: 50_000_000 }),
        fc.array(categorizedChildArb, { minLength: 2, maxLength: 4 }),
        (parent, legs) => {
          const out = repairSplitForImport(parent, legs);
          const expectPass =
            out.parentAmount !== 0 &&
            (out.kind === "balanced" || out.difference > 0);
          let passed = true;
          try {
            assertSplitsBalanced(out.parentAmount, out.children);
          } catch {
            passed = false;
          }
          expect(passed).toBe(expectPass);
        },
      ),
    );
  });
});

/* ---------------- split row-graph helpers ---------------- */

const forestArb: fc.Arbitrary<{
  all: Transaction[];
  parents: Transaction[];
  kidsByParent: Map<number, Transaction[]>;
  noise: Transaction[];
}> = fc.integer({ min: 1, max: 4 }).chain((parentCount) =>
  fc
    .tuple(
      fc.array(fc.integer({ min: 0, max: 3 }), {
        minLength: parentCount,
        maxLength: parentCount,
      }),
      fc.integer({ min: 0, max: 3 }),
    )
    .chain(([kidsPerParent, noiseCount]) => {
      const kidTotal = kidsPerParent.reduce((a, b) => a + b, 0);
      const total = parentCount + kidTotal + noiseCount;
      return fc
        .tuple(
          fc.uniqueArray(idArb, { minLength: total, maxLength: total }),
          fc.array(centsArb, { minLength: total, maxLength: total }),
          fc.array(fc.double({ noNaN: true }), {
            minLength: total,
            maxLength: total,
          }),
        )
        .map(([ids, amounts, keys]) => {
          const parents: Transaction[] = [];
          const kidsByParent = new Map<number, Transaction[]>();
          const noise: Transaction[] = [];
          let cursor = 0;
          for (let p = 0; p < parentCount; p++) {
            const parent = tx({
              id: ids[cursor]!,
              accountId: 1,
              amount: String(amounts[cursor]!),
            });
            cursor++;
            parents.push(parent);
            const kids: Transaction[] = [];
            for (let k = 0; k < kidsPerParent[p]!; k++) {
              kids.push(
                tx({
                  id: ids[cursor]!,
                  accountId: 1,
                  amount: String(amounts[cursor]!),
                  parentId: parent.id,
                }),
              );
              cursor++;
            }
            kidsByParent.set(parent.id, kids);
          }
          for (let n = 0; n < noiseCount; n++) {
            noise.push(
              tx({
                id: ids[cursor]!,
                accountId: 1,
                amount: String(amounts[cursor]!),
              }),
            );
            cursor++;
          }
          const all = [...parents, ...[...kidsByParent.values()].flat(), ...noise]
            .map((row, i) => ({ row, key: keys[i]! }))
            .sort((a, b) => a.key - b.key)
            .map(({ row }) => row);
          return { all, parents, kidsByParent, noise };
        });
    }),
);

describe("split row-graph properties", () => {
  it("keeps children lookup, totals, and predicates mutually consistent", () => {
    fc.assert(
      fc.property(forestArb, ({ all, parents, kidsByParent, noise }) => {
        for (const parent of parents) {
          const expected = all.filter((t) => t.parentId === parent.id);
          expect(getSplitChildren(all, parent.id)).toEqual(expected);
          expect(splitChildrenTotal(all, parent.id)).toBe(
            expected.reduce((s, c) => s + num(c.amount), 0),
          );
          expect(isSplitParent(parent, all)).toBe(expected.length > 0);
          expect(isSplitChild(parent)).toBe(false);
          for (const kid of kidsByParent.get(parent.id)!) {
            expect(isSplitChild(kid)).toBe(true);
            expect(getSplitParent(all, kid)?.id).toBe(parent.id);
          }
        }
        for (const row of noise) {
          expect(isSplitChild(row)).toBe(false);
          expect(isSplitParent(row, all)).toBe(false);
          expect(getSplitParent(all, row)).toBeUndefined();
          expect(getSplitChildren(all, row.id)).toEqual([]);
        }
        // Orphaned children resolve to undefined and are never parents.
        const orphan = tx({ id: 2_000_001, accountId: 1, amount: "5", parentId: 1_999_999 });
        expect(isSplitChild(orphan)).toBe(true);
        expect(isSplitParent(orphan, all)).toBe(false);
        expect(getSplitParent(all, orphan)).toBeUndefined();
        // No nesting: a row with a parentId is never itself a parent,
        // even when another row references it.
        const someKid = [...kidsByParent.values()].flat()[0];
        if (someKid) {
          const nested = tx({ id: 2_000_003, accountId: 1, amount: "7", parentId: someKid.id });
          expect(isSplitParent(someKid, [...all, nested])).toBe(false);
          expect(getSplitChildren([...all, nested], someKid.id)).toEqual([nested]);
        }
      }),
    );
  });
});
