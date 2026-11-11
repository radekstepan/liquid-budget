import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  makeSeedBudgetData,
  num,
  pickMergePrimary,
  type MergeableTransaction,
  type Transaction,
} from "@ynab/logic";
import { useRegisterState } from "../src/transactions/useRegisterState.js";

function toMergeable(t: Transaction): MergeableTransaction {
  return {
    ...t,
    transferAccountId: t.transferAccountId ?? null,
    amount: num(t.amount),
  };
}

/** Two plain rows the merge planner accepts (no splits/transfers/locks). */
function mergeablePair(data: ReturnType<typeof makeSeedBudgetData>): [Transaction, Transaction] {
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
  if (rows[0] == null || rows[1] == null) throw new Error("seed data has no mergeable pair");
  return [rows[0], rows[1]];
}

describe("useRegisterState.confirmMergePreview (P2 merge-dedupe)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("prefers the server merged id over the local recompute", async () => {
    const data = makeSeedBudgetData();
    const [a, b] = mergeablePair(data);
    const [local] = pickMergePrimary(toMergeable(a), toMergeable(b));
    // The server is authoritative: return the row the local rule would drop.
    const serverPick = local.id === a.id ? b.id : a.id;
    const onMergeTransactions = vi.fn(async () => ({
      mergedId: serverPick,
      deletedId: local.id,
    }));

    const { result } = renderHook(() =>
      useRegisterState({ data, accountFilter: null, onMergeTransactions })
    );
    await act(async () => {
      await result.current.confirmMergePreview([a.id, b.id], {});
    });

    expect(onMergeTransactions).toHaveBeenCalledWith([a.id, b.id], {});
    expect(result.current.selectedIds).toEqual(new Set([serverPick]));
    expect(result.current.mergePreviewIds).toBeNull();
  });

  it("falls back to the local recompute when the api resolves void", async () => {
    const data = makeSeedBudgetData();
    const [a, b] = mergeablePair(data);
    const [local] = pickMergePrimary(toMergeable(a), toMergeable(b));
    const onMergeTransactions = vi.fn(async () => undefined);

    const { result } = renderHook(() =>
      useRegisterState({ data, accountFilter: null, onMergeTransactions })
    );
    await act(async () => {
      await result.current.confirmMergePreview([a.id, b.id], {});
    });

    // Same survivor the pre-remediation code always selected.
    expect(result.current.selectedIds).toEqual(new Set([local.id]));
    expect(result.current.mergePreviewIds).toBeNull();
  });
});
