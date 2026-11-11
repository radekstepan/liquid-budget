import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { makeSeedBudgetData, type BudgetData } from "@ynab/logic";
import { createTransactionsApi } from "../src/components/api/transactions";
import type { BudgetApiDeps, OptimisticMutation } from "../src/components/api/types";

function makeDeps(data: BudgetData): BudgetApiDeps {
  const dataRef = { current: data } as BudgetApiDeps["dataRef"];
  const setData: BudgetApiDeps["setData"] = (updater) => {
    const prev = dataRef.current;
    dataRef.current =
      typeof updater === "function"
        ? (updater as (p: BudgetData | null) => BudgetData | null)(prev)
        : updater;
  };
  const optimisticMutation: OptimisticMutation = async (opts) => {
    opts.plan?.();
    try {
      const res = await opts.request();
      opts.mapResult?.(res);
      return res;
    } catch (e) {
      opts.rollback?.();
      throw e;
    }
  };
  return {
    dataRef,
    setData,
    reload: vi.fn(async () => {}),
    runMutation: (async (action: () => Promise<unknown>) => action()) as BudgetApiDeps["runMutation"],
    optimisticMutation,
    withSync: async (fn) => fn(),
    addToast: vi.fn(() => ({ id: 1 }) as never),
  };
}

/** Two plain rows the optimistic merge planner accepts (no splits/transfers/locks). */
function mergeablePair(data: BudgetData): [number, number] {
  const parentIds = new Set(
    data.transactions.map((t) => t.parentId).filter((id) => id != null)
  );
  const rows = data.transactions.filter(
    (t) =>
      t.parentId == null &&
      !parentIds.has(t.id) &&
      t.status !== "r" &&
      t.transferStatus !== "r" &&
      t.transferAccountId == null
  );
  if (rows.length < 2 || rows[0] == null || rows[1] == null) {
    throw new Error("seed data has no mergeable pair");
  }
  return [rows[0].id, rows[1].id];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("mergeTransactions client (P2 merge-dedupe)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the server survivor/deleted ids for selection", async () => {
    const data = makeSeedBudgetData();
    const [a, b] = mergeablePair(data);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, merged: { id: b }, deletedId: a }))
    );

    const api = createTransactionsApi(makeDeps(data));
    await expect(api.mergeTransactions!([a, b])).resolves.toEqual({
      mergedId: b,
      deletedId: a,
    });
  });

  it("fails fast when the merge response drifts from the contract", async () => {
    const data = makeSeedBudgetData();
    const [a, b] = mergeablePair(data);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));

    const api = createTransactionsApi(makeDeps(data));
    await expect(api.mergeTransactions!([a, b])).rejects.toThrow(/Invalid merge response/);
  });
});
