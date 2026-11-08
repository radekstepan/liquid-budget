/**
 * Property tests for budget-boundary transfer classification
 * (`src/transfers.ts`).
 *
 * Each property runs over hundreds of generated inputs; a failure shrinks
 * to a minimal counterexample. See `arbitraries.ts` for the shared
 * generators.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { num } from "../../src/format.js";
import {
  TransactionError,
  classifyBoundaryTransfer,
  isCreditPayoffTransfer,
  isInternalTransfer,
  isOffBudgetTransfer,
  isTransferEligible,
  transferNetOnBudgetDelta,
  validateTransferEligibility,
  validateTransferPayeeConsistency,
  type BoundaryTransferClassification,
  type TransferEligibilityInput,
} from "../../src/transfers.js";
import type { Account } from "../../src/types.js";
import {
  centsArb,
  idArb,
  nonZeroCentsArb,
  plainPayeeArb,
  transactionArb,
  transferPayeeArb,
  tx,
} from "./arbitraries.js";

/* ---------------- account universes ---------------- */

function accountListArbWithKinds(kinds: Account["kind"][]): fc.Arbitrary<Account[]> {
  return fc.uniqueArray(idArb, { minLength: 0, maxLength: 3 }).chain((ids) =>
    fc
      .array(
        fc.tuple(
          fc.boolean(),
          fc.constantFrom(...kinds),
          fc.string({ minLength: 1, maxLength: 12 }),
        ),
        { minLength: ids.length, maxLength: ids.length },
      )
      .map((flags) =>
        ids.map((id, i): Account => {
          const [onBudget, kind, name] = flags[i]!;
          return { id, name, kind, groupLabel: "g", balance: "0", onBudget, sort: 0 };
        }),
      ),
  );
}

const accountListArb = accountListArbWithKinds(["liquid", "credit", "offbudget"]);
const nonCreditListArb = accountListArbWithKinds(["liquid", "offbudget"]);

type UniverseShape = "map" | "array" | "undefined";
const shapeArb: fc.Arbitrary<UniverseShape> = fc.constantFrom("map", "array", "undefined");

function asUniverse(
  list: Account[],
  shape: UniverseShape,
): Map<number, Account> | Account[] | undefined {
  if (shape === "undefined") return undefined;
  if (shape === "map") return new Map(list.map((a) => [a.id, a] as const));
  return list;
}

const mkAccount = (id: number, onBudget: boolean): Account => ({
  id,
  name: `a${id}`,
  kind: "liquid",
  groupLabel: "g",
  balance: "0",
  onBudget,
  sort: 0,
});

/** An account id guaranteed to differ from `id` (stays in the id range). */
const distinctFrom = (id: number): number => (id >= 1_000_000 ? id - 1 : id + 1);

/* ---------------- classifyBoundaryTransfer ---------------- */

describe("classifyBoundaryTransfer properties", () => {
  it("maps every same-boundary transfer to the fixed zero object", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.oneof(centsArb, fc.double()),
        fc.option(idArb, { nil: null }),
        fc.option(fc.string({ maxLength: 16 }), { nil: null }),
        fc.boolean(),
        (onBudget, amount, categoryId, incomeMonth, allowMissing) => {
          expect(
            classifyBoundaryTransfer({
              srcOnBudget: onBudget,
              destOnBudget: onBudget,
              amount,
              categoryId,
              incomeMonth,
              allowMissingOutflowCategory: allowMissing,
            }),
          ).toEqual({
            isBoundaryCrossing: false,
            netOnBudgetDelta: 0,
            categoryId: null,
            isIncome: false,
            incomeMonth: null,
          });
        },
      ),
    );
  });

  it("computes the crossing delta from the boundary formula and negates on swap", () => {
    fc.assert(
      fc.property(fc.boolean(), nonZeroCentsArb, idArb, (src, amount, categoryId) => {
        const dest = !src;
        const expected = (src ? amount : 0) + (dest ? -amount : 0);
        const out = classifyBoundaryTransfer({
          srcOnBudget: src,
          destOnBudget: dest,
          amount,
          categoryId,
        });
        expect(out.isBoundaryCrossing).toBe(true);
        expect(out.netOnBudgetDelta).toBe(expected);
        const swapped = classifyBoundaryTransfer({
          srcOnBudget: dest,
          destOnBudget: src,
          amount,
          categoryId,
        });
        expect(swapped.netOnBudgetDelta).toBe(-expected);
      }),
    );
  });

  it("follows the income/outflow/zero decision table on crossings", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        centsArb,
        fc.option(idArb, { nil: null }),
        fc.option(fc.string({ maxLength: 16 }), { nil: null }),
        fc.boolean(),
        (src, dest, amount, categoryId, incomeMonth, allowMissing) => {
          const params = {
            srcOnBudget: src,
            destOnBudget: dest,
            amount,
            categoryId,
            incomeMonth,
            allowMissingOutflowCategory: allowMissing,
          };
          const crossing = src !== dest;
          const delta = crossing ? (src ? amount : 0) + (dest ? -amount : 0) : 0;
          if (crossing && delta < 0 && categoryId == null && !allowMissing) {
            expect(() => classifyBoundaryTransfer(params)).toThrow(TransactionError);
            return;
          }
          const out = classifyBoundaryTransfer(params);
          expect(out.isBoundaryCrossing).toBe(crossing);
          expect(out.netOnBudgetDelta).toBe(delta);
          expect(out.isIncome).toBe(crossing && delta > 0 && categoryId == null);
          if (!crossing || delta === 0) {
            expect(out.categoryId).toBeNull();
            expect(out.incomeMonth).toBeNull();
          } else if (delta > 0 && categoryId == null) {
            expect(out.incomeMonth).toBe(incomeMonth ?? null);
          } else {
            expect(out.incomeMonth).toBeNull();
            expect(out.categoryId).toBe(categoryId ?? null);
          }
        },
      ),
    );
  });

  it("treats a zero-amount crossing as a category-less non-income move", () => {
    // Pinned explicitly: even a supplied category is dropped when delta is 0.
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(idArb, { nil: null }),
        fc.option(fc.string({ maxLength: 16 }), { nil: null }),
        (src, categoryId, incomeMonth) => {
          expect(
            classifyBoundaryTransfer({
              srcOnBudget: src,
              destOnBudget: !src,
              amount: 0,
              categoryId,
              incomeMonth,
            }),
          ).toEqual({
            isBoundaryCrossing: true,
            netOnBudgetDelta: 0,
            categoryId: null,
            isIncome: false,
            incomeMonth: null,
          });
        },
      ),
    );
  });

  it("requires a category for outflows unless explicitly allowed", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 1, max: 50_000_000 }),
        fc.boolean(),
        (src, magnitude, allowMissing) => {
          const params = {
            srcOnBudget: src,
            destOnBudget: !src,
            amount: src ? -magnitude : magnitude, // always a delta<0 outflow
            categoryId: null as number | null,
            allowMissingOutflowCategory: allowMissing,
          };
          if (!allowMissing) {
            let caught: unknown;
            try {
              classifyBoundaryTransfer(params);
            } catch (e) {
              caught = e;
            }
            expect(caught).toBeInstanceOf(TransactionError);
            expect((caught as TransactionError).status).toBe(400);
          } else {
            const out = classifyBoundaryTransfer(params);
            expect(out.isBoundaryCrossing).toBe(true);
            expect(out.netOnBudgetDelta).toBe(-magnitude);
            expect(out.isIncome).toBe(false);
          }
        },
      ),
    );
  });

  it("never throws on arbitrary doubles when outflow categories are optional", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.double({ noNaN: false, noDefaultInfinity: false }),
        fc.option(idArb, { nil: null }),
        fc.option(fc.string({ maxLength: 16 }), { nil: null }),
        (src, dest, amount, categoryId, incomeMonth) => {
          let out: BoundaryTransferClassification | undefined;
          expect(() => {
            out = classifyBoundaryTransfer({
              srcOnBudget: src,
              destOnBudget: dest,
              amount,
              categoryId,
              incomeMonth,
              allowMissingOutflowCategory: true,
            });
          }).not.toThrow();
          expect(out!.isBoundaryCrossing).toBe(src !== dest);
        },
      ),
    );
  });
});

/* ---------------- row classifiers ---------------- */

describe("transfer row classifier properties", () => {
  it("treats non-transfer rows as neutral", () => {
    fc.assert(
      fc.property(transactionArb, accountListArb, shapeArb, (base, list, shape) => {
        const t = { ...base, transferAccountId: null };
        const u = asUniverse(list, shape);
        expect(transferNetOnBudgetDelta(t, u)).toBe(0);
        expect(isInternalTransfer(t, u)).toBe(false);
        expect(isOffBudgetTransfer(t, u)).toBe(false);
        expect(isCreditPayoffTransfer(t, u)).toBe(false);
      }),
    );
  });

  it("classifies every transfer row as exactly one of internal / off-budget", () => {
    fc.assert(
      fc.property(idArb, idArb, centsArb, accountListArb, shapeArb, (a, b, cents, list, shape) => {
        const t = tx({ accountId: a, transferAccountId: b, amount: String(cents) });
        const u = asUniverse(list, shape);
        expect(isInternalTransfer(t, u)).not.toBe(isOffBudgetTransfer(t, u));
      }),
    );
  });

  it("defaults missing accounts to on-budget", () => {
    fc.assert(
      fc.property(idArb, idArb, centsArb, (a, b, cents) => {
        const t = tx({ accountId: a, transferAccountId: b, amount: String(cents) });
        const bothOn = b === a ? [mkAccount(a, true)] : [mkAccount(a, true), mkAccount(b, true)];
        expect(transferNetOnBudgetDelta(t, undefined)).toBe(
          transferNetOnBudgetDelta(t, bothOn),
        );
        expect(isInternalTransfer(t, undefined)).toBe(true);
        expect(isOffBudgetTransfer(t, undefined)).toBe(false);
      }),
    );
  });

  it("keeps transferNetOnBudgetDelta in agreement with classifyBoundaryTransfer", () => {
    fc.assert(
      fc.property(
        idArb,
        idArb,
        centsArb,
        accountListArb,
        shapeArb,
        idArb,
        (a, b, cents, list, shape, categoryId) => {
          const t = tx({ accountId: a, transferAccountId: b, amount: String(cents) });
          const u = asUniverse(list, shape);
          const side = (id: number): boolean =>
            list.find((x) => x.id === id)?.onBudget ?? true;
          const classified = classifyBoundaryTransfer({
            srcOnBudget: side(a),
            destOnBudget: side(b),
            amount: num(t.amount),
            categoryId,
          });
          expect(transferNetOnBudgetDelta(t, u)).toBe(classified.netOnBudgetDelta);
        },
      ),
    );
  });

  it("keeps credit-payoff transfers a subset of internal transfers", () => {
    fc.assert(
      fc.property(transactionArb, accountListArb, shapeArb, (t, list, shape) => {
        const u = asUniverse(list, shape);
        if (isCreditPayoffTransfer(t, u)) {
          expect(isInternalTransfer(t, u)).toBe(true);
        }
      }),
    );
  });

  it("never reports a payoff when no credit account exists", () => {
    fc.assert(
      fc.property(transactionArb, nonCreditListArb, shapeArb, (t, list, shape) => {
        expect(isCreditPayoffTransfer(t, asUniverse(list, shape))).toBe(false);
      }),
    );
  });
});

/* ---------------- eligibility ---------------- */

const eligibilityInputArb: fc.Arbitrary<TransferEligibilityInput> = fc.record({
  accountId: idArb,
  transferAccountId: fc.option(idArb, { nil: null }),
  categoryId: fc.option(idArb, { nil: null }),
  payee: fc.option(fc.oneof(transferPayeeArb, plainPayeeArb), { nil: null }),
  parentId: fc.option(idArb, { nil: null }),
  isSplitParent: fc.option(fc.boolean()),
  srcOnBudget: fc.option(fc.boolean(), { nil: null }),
  destOnBudget: fc.option(fc.boolean(), { nil: null }),
});

function throws(input: TransferEligibilityInput): boolean {
  try {
    validateTransferEligibility(input);
    return false;
  } catch {
    return true;
  }
}

describe("transfer eligibility properties", () => {
  it("keeps the boolean and throwing validators in agreement", () => {
    fc.assert(
      fc.property(eligibilityInputArb, (input) => {
        expect(isTransferEligible(input)).toBe(!throws(input));
      }),
    );
  });

  it("never allows self-transfers", () => {
    fc.assert(
      fc.property(eligibilityInputArb, (input) => {
        expect(
          isTransferEligible({ ...input, transferAccountId: input.accountId }),
        ).toBe(false);
      }),
    );
  });

  it("never allows a split parent to carry its own transfer leg", () => {
    fc.assert(
      fc.property(eligibilityInputArb, (input) => {
        expect(
          isTransferEligible({
            ...input,
            transferAccountId: distinctFrom(input.accountId),
            isSplitParent: true,
          }),
        ).toBe(false);
      }),
    );
  });

  it("never allows a same-boundary transfer to carry a category", () => {
    fc.assert(
      fc.property(eligibilityInputArb, fc.boolean(), (input, side) => {
        expect(
          isTransferEligible({
            ...input,
            transferAccountId: distinctFrom(input.accountId),
            isSplitParent: false,
            categoryId: input.categoryId ?? 7,
            srcOnBudget: side,
            destOnBudget: side,
          }),
        ).toBe(false);
      }),
    );
  });

  it("allows well-formed transfers under any boundary sides", () => {
    fc.assert(
      fc.property(
        eligibilityInputArb,
        fc.option(fc.boolean(), { nil: null }),
        fc.option(fc.boolean(), { nil: null }),
        (input, src, dest) => {
          expect(
            isTransferEligible({
              ...input,
              transferAccountId: distinctFrom(input.accountId),
              isSplitParent: false,
              categoryId: null,
              srcOnBudget: src,
              destOnBudget: dest,
            }),
          ).toBe(true);
        },
      ),
    );
  });

  it("rejects transfer payees with no transfer leg", () => {
    fc.assert(
      fc.property(eligibilityInputArb, transferPayeeArb, (input, payee) => {
        const row = { ...input, transferAccountId: null, payee };
        expect(() =>
          validateTransferPayeeConsistency(row.payee, row.transferAccountId),
        ).toThrow();
        expect(isTransferEligible(row)).toBe(false);
      }),
    );
  });

  it("never rejects a payee when a transfer leg is present", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), idArb, (payee, leg) => {
        expect(() => validateTransferPayeeConsistency(payee, leg)).not.toThrow();
      }),
    );
  });

  it("allows non-transfer rows with plain payees", () => {
    fc.assert(
      fc.property(
        eligibilityInputArb,
        fc.oneof(plainPayeeArb, fc.constant(null)),
        (input, payee) => {
          expect(
            isTransferEligible({ ...input, transferAccountId: null, payee }),
          ).toBe(true);
        },
      ),
    );
  });
});
