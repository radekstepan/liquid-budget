/**
 * optimistic.ts
 *
 * Pure optimistic-update state transitions for the budget shell.
 *
 * Every function here is pure: (previous state, intent) -> next state, with
 * account balance effects returned separately as per-account cent deltas so
 * callers can roll them back by inversion. The web shell keeps I/O
 * orchestration (fetch, temp-id generation, toasts, reloads); all state
 * math lives here so it is unit-testable and cannot drift from the
 * server-side rules it mirrors (split flattening, transfer boundary
 * classification, income inference).
 *
 * Amounts in `BudgetData` are decimal strings; delta maps and row builders
 * use integer cents via `num()`/`toFixed(2)`, matching the server.
 */
/**
 * Drift contract with the server (transactions/create, transactions/update,
 * transactions/splits, transactions/bulk-update): the income/boundary leaf
 * rules live in shared helpers (`classifyBoundaryTransfer`,
 * `inferUncategorizedInflowIncome` in transfers.ts) — this module calls
 * them instead of re-implementing the predicates. What stays mirrored by
 * hand: the update value-change preservation predicate (paired with
 * `transactionUpdateNeedsReload`/`skipReload`, which refetch whenever the
 * optimistic pass cannot fully recompute) and server-only concerns
 * (incomeCategoryRaw lineage clearing, payee-autofill history lookups).
 * Any server rule change to a shared helper propagates here via the
 * import; hand-mirrored branches need parallel updates plus parity tests
 * in tests/optimistic.test.ts.
 */
import { num } from "./format.js";
import { classifyBoundaryTransfer, inferUncategorizedInflowIncome } from "./transfers.js";
import {
  applyMergeOverrides,
  pickMergePrimary,
  resolveMergedTransaction,
  type MergeableTransaction,
  type MergedTransactionFields,
  type MergeOverrides,
} from "./merge.js";
import type {
  Account,
  Assignment,
  BudgetData,
  BulkUpdateTransactionPatch,
  ClearedStatus,
  Transaction,
  TransactionFlagColor,
  TransactionFlagState,
} from "./types.js";

/** Next state plus the per-account cent deltas that produced it. */
export type OptimisticPlan = {
  next: BudgetData;
  deltas: Map<number, number>;
};

export function applyAccountDeltas(
  accounts: Account[],
  deltas: Map<number, number>
): Account[] {
  if (deltas.size === 0) return accounts;
  return accounts.map((acc) => {
    const delta = deltas.get(acc.id);
    if (!delta) return acc;
    const current = num(acc.balance);
    return { ...acc, balance: String(current + Math.round(delta)) };
  });
}

/** Negate every entry of a delta map (rollback = apply the inversion). */
export function invertDeltas(deltas: Map<number, number>): Map<number, number> {
  const inverted = new Map<number, number>();
  for (const [accId, delta] of deltas.entries()) {
    inverted.set(accId, -delta);
  }
  return inverted;
}

export function applyOptimisticTransactionDeletion(
  prev: BudgetData,
  ids: number[]
): { nextData: BudgetData; deltas: Map<number, number> } {
  const idSet = new Set(ids);
  const deltas = new Map<number, number>();
  const removedIds = new Set(ids);
  const parentNewTotals = new Map<number, number>();
  const deletedParentIds = new Set<number>();
  const flattenedChildren = new Map<number, { payee?: string; flagColor?: TransactionFlagState }>();

  for (const tx of prev.transactions) {
    if (idSet.has(tx.id) && tx.parentId == null) {
      const children = prev.transactions.filter((x) => x.parentId === tx.id);
      if (children.length > 0) {
        deletedParentIds.add(tx.id);
        for (const c of children) {
          deltas.set(c.accountId, (deltas.get(c.accountId) ?? 0) - num(c.amount));
          if (c.transferAccountId != null) {
            deltas.set(c.transferAccountId, (deltas.get(c.transferAccountId) ?? 0) + num(c.amount));
          }
          removedIds.add(c.id);
        }
      } else {
        deltas.set(tx.accountId, (deltas.get(tx.accountId) ?? 0) - num(tx.amount));
        if (tx.transferAccountId != null) {
          deltas.set(tx.transferAccountId, (deltas.get(tx.transferAccountId) ?? 0) + num(tx.amount));
        }
      }
    }
  }

  const childrenByParent = new Map<number, typeof prev.transactions>();
  for (const tx of prev.transactions) {
    if (tx.parentId != null) {
      let list = childrenByParent.get(tx.parentId);
      if (!list) {
        list = [];
        childrenByParent.set(tx.parentId, list);
      }
      list.push(tx);
    }
  }

  for (const [parentId, allChildren] of childrenByParent.entries()) {
    if (deletedParentIds.has(parentId)) continue;
    const childrenToDelete = allChildren.filter((c) => idSet.has(c.id));
    if (childrenToDelete.length === 0) continue;

    for (const c of childrenToDelete) {
      deltas.set(c.accountId, (deltas.get(c.accountId) ?? 0) - num(c.amount));
      if (c.transferAccountId != null) {
        deltas.set(c.transferAccountId, (deltas.get(c.transferAccountId) ?? 0) + num(c.amount));
      }
      removedIds.add(c.id);
    }

    const remainingChildren = allChildren.filter((c) => !idSet.has(c.id));
    if (remainingChildren.length === 1) {
      const lastChild = remainingChildren[0]!;
      const parentTx = prev.transactions.find((t) => t.id === parentId);
      const childPayee =
        lastChild.payee && lastChild.payee.trim() !== ""
          ? lastChild.payee
          : (parentTx?.payee ?? "");
      const childFlagColor = lastChild.flagColor ?? (parentTx?.flagColor ?? null);
      flattenedChildren.set(lastChild.id, {
        payee: childPayee,
        flagColor: childFlagColor,
      });
      removedIds.add(parentId);
      parentNewTotals.delete(parentId);
    } else if (remainingChildren.length === 0) {
      removedIds.add(parentId);
      parentNewTotals.delete(parentId);
    } else {
      const newTotal = remainingChildren.reduce((sum, c) => sum + num(c.amount), 0);
      parentNewTotals.set(parentId, newTotal);
    }
  }

  const accounts = applyAccountDeltas(prev.accounts, deltas);
  let transactions = prev.transactions
    .filter(
      (x) =>
        !removedIds.has(x.id) &&
        (x.parentId == null || flattenedChildren.has(x.id) || !removedIds.has(x.parentId))
    )
    .map((x) => {
      const flat = flattenedChildren.get(x.id);
      if (flat) {
        return {
          ...x,
          parentId: null,
          payee: flat.payee || x.payee,
          flagColor: flat.flagColor !== undefined ? flat.flagColor : x.flagColor,
        };
      }
      return x;
    });
  if (parentNewTotals.size > 0) {
    transactions = transactions.map((x) => {
      const updatedTotal = parentNewTotals.get(x.id);
      return updatedTotal !== undefined ? { ...x, amount: updatedTotal.toFixed(2) } : x;
    });
  }
  return { nextData: { ...prev, accounts, transactions, budgetIndex: undefined }, deltas };
}

/**
 * Expand a set of transaction ids to every row an optimistic mutation may
 * touch: the rows themselves, their split parents, and all sibling rows
 * under those parents. Used to snapshot rollback state before mutating.
 */
export function collectSplitAffectedIds(
  transactions: Transaction[],
  ids: number[]
): Set<number> {
  const idSet = new Set(ids);
  const allAffectedIds = new Set<number>(ids);
  for (const tx of transactions) {
    if (idSet.has(tx.id) && tx.parentId != null) {
      allAffectedIds.add(tx.parentId);
    }
  }
  for (const tx of transactions) {
    if (tx.parentId != null && allAffectedIds.has(tx.parentId)) {
      allAffectedIds.add(tx.id);
    }
  }
  return allAffectedIds;
}

/** Deep-ish copy of the rows under `ids` for later rollback restore. */
export function snapshotTransactions(
  transactions: Transaction[],
  ids: Set<number>
): Transaction[] {
  return transactions.filter((tx) => ids.has(tx.id)).map((tx) => ({ ...tx }));
}

/**
 * Roll back an optimistic transaction mutation: reverse the recorded
 * account deltas, drop the optimistically written rows (and, by default,
 * their split children), and restore the pre-mutation snapshots.
 * Pass `includeChildren: false` when the affected set is exactly the rows
 * to drop (merge rollback).
 */
export function restoreTransactionRows(
  current: BudgetData,
  affectedIds: Set<number>,
  prevRows: Transaction[],
  appliedDeltas: Map<number, number>,
  opts?: { includeChildren?: boolean }
): BudgetData {
  const includeChildren = opts?.includeChildren ?? true;
  const accounts = applyAccountDeltas(current.accounts, invertDeltas(appliedDeltas));
  const otherTransactions = current.transactions.filter(
    (tx) =>
      !affectedIds.has(tx.id) &&
      (!includeChildren || tx.parentId == null || !affectedIds.has(tx.parentId))
  );
  return {
    ...current,
    accounts,
    transactions: [...otherTransactions, ...prevRows],
    budgetIndex: undefined,
  };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export type OptimisticAssignInput = {
  categoryId: number;
  month: string;
  amount: number;
};

/** Optimistically upsert one assignment row under a caller-supplied temp id. */
export function planOptimisticAssign(
  prev: BudgetData,
  input: OptimisticAssignInput,
  tempId: number
): BudgetData {
  const existing = prev.assignments.find(
    (a) => a.categoryId === input.categoryId && a.month === input.month
  );
  const assignments = existing
    ? prev.assignments.map((a) =>
        a.id === existing.id ? { ...a, amount: String(Math.round(input.amount)) } : a
      )
    : [
        ...prev.assignments,
        {
          id: tempId,
          categoryId: input.categoryId,
          month: input.month,
          amount: String(Math.round(input.amount)),
        },
      ];
  return { ...prev, assignments, budgetIndex: undefined };
}

/**
 * Map the temp id onto the server-returned assignment row after a
 * successful save. Deliberately leaves `budgetIndex` untouched (the
 * amounts already match; no recompute needed).
 */
export function mapOptimisticAssignId(
  prev: BudgetData,
  tempId: number,
  categoryId: number,
  month: string,
  real: Assignment
): BudgetData {
  return {
    ...prev,
    assignments: prev.assignments.map((a) =>
      a.id === tempId || (a.categoryId === categoryId && a.month === month)
        ? { ...a, id: real.id, amount: String(real.amount) }
        : a
    ),
  };
}

/** Roll back one optimistic assignment to its pre-mutation snapshot. */
export function rollbackOptimisticAssign(
  current: BudgetData,
  snapshot: Assignment | null,
  categoryId: number,
  month: string,
  tempId: number
): BudgetData {
  let assignments: Assignment[];
  if (snapshot) {
    assignments = current.assignments.map((a) =>
      a.id === snapshot.id || (a.categoryId === categoryId && a.month === month)
        ? snapshot
        : a
    );
  } else {
    assignments = current.assignments.filter(
      (a) =>
        !(a.id === tempId || (a.categoryId === categoryId && a.month === month))
    );
  }
  return { ...current, assignments, budgetIndex: undefined };
}

/** Optimistically upsert many assignment rows under sequential temp ids. */
export function planOptimisticBatchAssign(
  prev: BudgetData,
  items: OptimisticAssignInput[],
  tempIdBase: number
): BudgetData {
  let nextAssignments = [...prev.assignments];
  items.forEach((item, idx) => {
    const existing = nextAssignments.find(
      (a) => a.categoryId === item.categoryId && a.month === item.month
    );
    if (existing) {
      nextAssignments = nextAssignments.map((a) =>
        a.id === existing.id ? { ...a, amount: String(Math.round(item.amount)) } : a
      );
    } else {
      nextAssignments.push({
        id: tempIdBase - idx,
        categoryId: item.categoryId,
        month: item.month,
        amount: String(Math.round(item.amount)),
      });
    }
  });
  return { ...prev, assignments: nextAssignments, budgetIndex: undefined };
}

// ---------------------------------------------------------------------------
// Transaction insert
// ---------------------------------------------------------------------------

export type OptimisticSubInput = {
  categoryId?: number | null;
  amount: number;
  memo?: string;
  payee?: string;
  transferAccountId?: number | null;
  transferStatus?: ClearedStatus;
};

/**
 * Structural input for optimistic transaction writes. Mirrors the fields
 * the shell's save payloads carry (both the canonical
 * `TransactionSavePayload` union and the legacy inline shapes satisfy it)
 * without importing UI-layer types.
 */
export type OptimisticInsertInput = {
  accountId: number;
  categoryId?: number | null;
  date: string;
  payee: string;
  memo?: string;
  amount: number;
  status?: ClearedStatus;
  transferStatus?: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
  transferAccountId?: number | null;
  incomeMonth?: string | null;
  isIncome?: boolean;
  subTransactions?: OptimisticSubInput[];
};

/**
 * Build the optimistic rows for a new transaction (single, transfer, or
 * split with synthetic children) plus the account deltas they imply.
 * Category/income classification mirrors the server: boundary transfers
 * go through `classifyBoundaryTransfer`, uncategorized positive amounts
 * on on-budget liquid accounts default to income.
 */
export function planOptimisticInsert(
  prev: BudgetData,
  t: OptimisticInsertInput,
  tempId: number
): OptimisticPlan {
  const deltas = new Map<number, number>();
  if (t.subTransactions && t.subTransactions.length > 0) {
    for (const st of t.subTransactions) {
      deltas.set(t.accountId, (deltas.get(t.accountId) ?? 0) + st.amount);
      if (st.transferAccountId != null) {
        deltas.set(st.transferAccountId, (deltas.get(st.transferAccountId) ?? 0) - st.amount);
      }
    }
  } else {
    deltas.set(t.accountId, (deltas.get(t.accountId) ?? 0) + t.amount);
    if (t.transferAccountId != null) {
      deltas.set(t.transferAccountId, (deltas.get(t.transferAccountId) ?? 0) - t.amount);
    }
  }

  const srcAccount = prev.accounts.find((a) => a.id === t.accountId);
  const srcOnBudget = srcAccount?.onBudget ?? true;
  const srcKind = srcAccount?.kind ?? "liquid";
  let initialCatId = t.subTransactions?.length ? null : (t.categoryId ?? null);
  let initialIsIncome = false;
  let initialIncomeMonth: string | null = t.incomeMonth ?? null;

  if (t.transferAccountId != null) {
    const destAccount = prev.accounts.find((a) => a.id === t.transferAccountId);
    const destOnBudget = destAccount?.onBudget ?? true;
    const classification = classifyBoundaryTransfer({
      srcOnBudget,
      destOnBudget,
      amount: t.amount,
      categoryId: initialCatId,
      incomeMonth: initialIncomeMonth,
    });
    initialCatId = classification.categoryId;
    initialIsIncome = classification.isIncome;
    initialIncomeMonth = classification.incomeMonth;
  } else if (!t.subTransactions?.length) {
    if (!srcOnBudget || srcKind === "credit") {
      initialIsIncome = false;
      initialIncomeMonth = null;
    } else {
      // Shared leaf rule with the server (transactions/create).
      const inferred = inferUncategorizedInflowIncome({
        categoryId: initialCatId,
        amountCents: t.amount,
        explicitIsIncome:
          "isIncome" in t && t.isIncome !== undefined ? Boolean(t.isIncome) : undefined,
        incomeMonth: initialIncomeMonth,
      });
      initialIsIncome = inferred.isIncome;
      initialIncomeMonth = inferred.incomeMonth;
    }
  }

  const newTx: Transaction = {
    id: tempId,
    accountId: t.accountId,
    categoryId: initialCatId,
    date: t.date,
    payee: t.payee,
    memo: t.memo ?? "",
    amount: t.amount.toFixed(2),
    status: t.status ?? "u",
    flagColor: t.flagColor ?? null,
    transferAccountId: t.transferAccountId ?? null,
    parentId: null,
    isIncome: initialIsIncome,
    incomeMonth: initialIncomeMonth,
  };

  const newTransactions: Transaction[] = [newTx];

  if (t.subTransactions && t.subTransactions.length > 0) {
    let childIdx = 1;
    for (const st of t.subTransactions) {
      let childCategoryId = st.categoryId ?? null;
      let isIncome = false;

      if (st.transferAccountId != null) {
        const destAccount = prev.accounts.find((a) => a.id === st.transferAccountId);
        const destOnBudget = destAccount?.onBudget ?? true;
        const classification = classifyBoundaryTransfer({
          srcOnBudget,
          destOnBudget,
          amount: st.amount,
          categoryId: childCategoryId,
        });
        childCategoryId = classification.categoryId;
        isIncome = classification.isIncome;
      } else if (!srcOnBudget || srcAccount?.kind === "credit") {
        childCategoryId = null;
        isIncome = false;
      } else {
        // Shared leaf rule with the server (transactions/create split child).
        isIncome = inferUncategorizedInflowIncome({
          categoryId: childCategoryId,
          amountCents: st.amount,
        }).isIncome;
      }

      newTransactions.push({
        id: tempId - childIdx,
        accountId: t.accountId,
        categoryId: childCategoryId,
        date: t.date,
        payee: st.transferAccountId != null ? `Transfer : ${prev.accounts.find((a) => a.id === st.transferAccountId)?.name ?? "Unknown"}` : t.payee,
        memo: st.memo ?? "",
        amount: st.amount.toFixed(2),
        status: t.status ?? "u",
        flagColor: t.flagColor ?? null,
        transferAccountId: st.transferAccountId ?? null,
        parentId: tempId,
        isIncome,
      });
      childIdx++;
    }
  }
  const accounts = applyAccountDeltas(prev.accounts, deltas);
  return {
    next: {
      ...prev,
      accounts,
      transactions: [...newTransactions, ...prev.transactions],
      budgetIndex: undefined,
    },
    deltas,
  };
}

/**
 * The id-bearing subset of the server's transaction mutation result the
 * temp-id mapper reads. Structural (not the zod union) so `in`
 * narrowing can discriminate single vs split responses; both union
 * members satisfy it.
 */
export type OptimisticInsertResult =
  | { id: number }
  | { parent: { id: number }; children: { id: number }[] };

/**
 * Map optimistic temp ids onto server-returned real ids after a
 * successful insert. Single responses remap the parent row; split
 * responses remap the parent plus children positionally.
 */
export function mapOptimisticInsertIds(
  transactions: Transaction[],
  tempId: number,
  res: OptimisticInsertResult
): Transaction[] {
  if (res && "id" in res && typeof res.id === "number") {
    return transactions.map((tx) => (tx.id === tempId ? { ...tx, id: res.id } : tx));
  } else if (res && "parent" in res && "children" in res) {
    const childTempIds = new Map<number, number>();
    let ci = 1;
    for (const child of res.children) {
      childTempIds.set(tempId - ci, child.id);
      ci++;
    }
    return transactions.map((tx) => {
      if (tx.id === tempId) return { ...tx, id: res.parent.id };
      const realChildId = childTempIds.get(tx.id);
      if (realChildId != null) return { ...tx, id: realChildId };
      return tx;
    });
  }
  return transactions;
}

/** Roll back an optimistic insert: drop temp rows, reverse deltas. */
export function rollbackOptimisticInsert(
  current: BudgetData,
  createdTempIds: Set<number>,
  tempId: number,
  deltas: Map<number, number>
): BudgetData {
  const accounts = applyAccountDeltas(current.accounts, invertDeltas(deltas));
  const transactions = current.transactions.filter(
    (tx) => !createdTempIds.has(tx.id) && tx.parentId !== tempId
  );
  return { ...current, accounts, transactions, budgetIndex: undefined };
}

// ---------------------------------------------------------------------------
// Transaction update
// ---------------------------------------------------------------------------

export type OptimisticUpdateInput = {
  accountId?: number;
  categoryId?: number | null;
  date?: string;
  payee?: string;
  memo?: string;
  amount?: number;
  status?: ClearedStatus;
  transferStatus?: ClearedStatus;
  flagColor?: TransactionFlagColor | null;
  transferAccountId?: number | null;
  incomeMonth?: string | null;
  isIncome?: boolean;
  subTransactions?: OptimisticSubInput[];
};

/**
 * Build the optimistic state for editing one transaction. Deltas cover
 * account/amount/transfer/sub-transaction changes; category, income flag,
 * and income month are recomputed to mirror the server (boundary
 * classification for transfers, value-change preservation for liquid
 * on-budget accounts so unrelated edits don't flip uncategorized
 * inflows). Split members inherit date/status edits.
 *
 * `splitParentId` is the edited row's split parent when it belongs to a
 * split (the row's own id when it is a split parent), else null.
 */
export function planOptimisticUpdate(
  prev: BudgetData,
  id: number,
  t: OptimisticUpdateInput,
  splitParentId: number | null
): OptimisticPlan {
  const currentTarget = prev.transactions.find((x) => x.id === id);
  const isSplitParent = prev.transactions.some((x) => x.parentId === id);
  const deltas = new Map<number, number>();

  if (currentTarget) {
    if (t.subTransactions !== undefined) {
      const oldChildren = prev.transactions.filter((x) => x.parentId === id);
      for (const c of oldChildren) {
        deltas.set(c.accountId, (deltas.get(c.accountId) ?? 0) - num(c.amount));
        if (c.transferAccountId != null) {
          deltas.set(c.transferAccountId, (deltas.get(c.transferAccountId) ?? 0) + num(c.amount));
        }
      }
      for (const st of t.subTransactions) {
        deltas.set(currentTarget.accountId, (deltas.get(currentTarget.accountId) ?? 0) + st.amount);
        if (st.transferAccountId != null) {
          deltas.set(st.transferAccountId, (deltas.get(st.transferAccountId) ?? 0) - st.amount);
        }
      }
    } else if (!isSplitParent) {
      const oldAccountId = currentTarget.accountId;
      const oldAmount = num(currentTarget.amount);
      const newAccountId = t.accountId ?? currentTarget.accountId;
      const newAmount = t.amount !== undefined ? t.amount : oldAmount;
      const newTransferAccountId =
        "transferAccountId" in t ? (t.transferAccountId ?? null) : (currentTarget.transferAccountId ?? null);

      deltas.set(oldAccountId, (deltas.get(oldAccountId) ?? 0) - oldAmount);
      if (currentTarget.transferAccountId != null) {
        deltas.set(
          currentTarget.transferAccountId,
          (deltas.get(currentTarget.transferAccountId) ?? 0) + oldAmount
        );
      }
      deltas.set(newAccountId, (deltas.get(newAccountId) ?? 0) + newAmount);
      if (newTransferAccountId != null) {
        deltas.set(
          newTransferAccountId,
          (deltas.get(newTransferAccountId) ?? 0) - newAmount
        );
      }
    }
  }

  const accounts = applyAccountDeltas(prev.accounts, deltas);

  // Recompute categoryId, isIncome, and incomeMonth to mirror server-side logic
  let nextCategoryId: number | null | undefined = t.categoryId;
  let nextIsIncome: boolean | undefined;
  let nextIncomeMonth: string | null | undefined = t.incomeMonth;

  if (currentTarget) {
    const newAccountId = t.accountId ?? currentTarget.accountId;
    const newAmount = t.amount !== undefined ? t.amount : num(currentTarget.amount);
    const newTransferAccountId =
      "transferAccountId" in t ? (t.transferAccountId ?? null) : (currentTarget.transferAccountId ?? null);
    const srcAccount = prev.accounts.find((a) => a.id === newAccountId);
    const srcOnBudget = srcAccount?.onBudget ?? true;
    const srcKind = srcAccount?.kind ?? "liquid";

    if (newTransferAccountId != null) {
      const destAccount = prev.accounts.find((a) => a.id === newTransferAccountId);
      const rawCatId = "categoryId" in t ? (t.categoryId ?? null) : (currentTarget.categoryId ?? null);
      const rawIncMonth = "incomeMonth" in t ? (t.incomeMonth ?? null) : (currentTarget.incomeMonth ?? null);
      const classification = classifyBoundaryTransfer({
        srcOnBudget,
        destOnBudget: destAccount?.onBudget ?? true,
        amount: newAmount,
        categoryId: rawCatId,
        incomeMonth: rawIncMonth,
      });
      nextCategoryId = classification.categoryId;
      nextIsIncome = classification.isIncome;
      nextIncomeMonth = classification.incomeMonth;
    } else if (isSplitParent) {
      nextCategoryId = null;
      nextIsIncome = false;
      nextIncomeMonth = null;
    } else if (!srcOnBudget) {
      nextCategoryId = null;
      nextIsIncome = false;
      nextIncomeMonth = null;
    } else if (srcKind === "credit") {
      if ("categoryId" in t) {
        nextCategoryId = t.categoryId ?? null;
      } else {
        nextCategoryId = currentTarget.categoryId ?? null;
      }
      nextIsIncome = false;
      nextIncomeMonth = null;
    } else {
      // Liquid cash on-budget account: mirror the server's
      // value-change preservation so unrelated edits don't flip
      // uncategorized inflows to income optimistically.
      const finalCatId = "categoryId" in t ? (t.categoryId ?? null) : (currentTarget.categoryId ?? null);
      nextCategoryId = finalCatId;
      const isEligibleForIncome = finalCatId == null && newAmount > 0;
      const categoryChanged =
        "categoryId" in t && (t.categoryId ?? null) !== (currentTarget.categoryId ?? null);
      const amountChanged = t.amount !== undefined && t.amount !== num(currentTarget.amount);
      const accountChanged = t.accountId !== undefined && t.accountId !== currentTarget.accountId;
      const incomeExplicit = "isIncome" in t && t.isIncome !== undefined;
      const incomeMonthChanged =
        "incomeMonth" in t && (t.incomeMonth ?? null) !== (currentTarget.incomeMonth ?? null);
      if (categoryChanged || amountChanged || accountChanged || incomeExplicit || incomeMonthChanged) {
        // Shared leaf rule with the server (transactions/update): eligible
        // uncategorized inflows default to income unless explicitly
        // un-flagged. The income month keeps its patched/current value
        // here (only cleared below).
        const { isIncome } = inferUncategorizedInflowIncome({
          categoryId: finalCatId,
          amountCents: newAmount,
          explicitIsIncome: incomeExplicit ? Boolean(t.isIncome) : undefined,
        });
        nextIsIncome = isIncome;
        if (!isIncome) {
          nextIncomeMonth = null;
        } else if ("incomeMonth" in t) {
          nextIncomeMonth = t.incomeMonth ?? null;
        } else {
          nextIncomeMonth = currentTarget.incomeMonth ?? null;
        }
      } else if (!isEligibleForIncome && currentTarget.isIncome) {
        nextIsIncome = false;
        nextIncomeMonth = null;
      } else {
        nextIsIncome = currentTarget.isIncome ?? false;
        nextIncomeMonth = currentTarget.incomeMonth ?? null;
      }
    }
  }

  const transactions = prev.transactions.map((x) => {
    const isTarget = x.id === id;
    const isSplitMember =
      splitParentId != null && (x.id === splitParentId || x.parentId === splitParentId);

    if (!isTarget && !isSplitMember) return x;

    if (!isTarget && isSplitMember) {
      return {
        ...x,
        ...(t.date !== undefined ? { date: t.date } : {}),
        ...(t.status !== undefined ? { status: t.status } : {}),
      };
    }

    return {
      ...x,
      ...(t.accountId !== undefined ? { accountId: t.accountId } : {}),
      ...("transferAccountId" in t ? { transferAccountId: t.transferAccountId ?? null } : {}),
      ...(nextCategoryId !== undefined ? { categoryId: nextCategoryId } : {}),
      ...(t.date !== undefined ? { date: t.date } : {}),
      ...(t.payee !== undefined ? { payee: t.payee } : {}),
      ...(t.memo !== undefined ? { memo: t.memo } : {}),
      ...(t.amount !== undefined ? { amount: t.amount.toFixed(2) } : {}),
      ...(t.status !== undefined ? { status: t.status } : {}),
      ...("transferStatus" in t && t.transferStatus !== undefined ? { transferStatus: t.transferStatus } : {}),
      ...(t.flagColor !== undefined ? { flagColor: t.flagColor ?? null } : {}),
      ...(nextIsIncome !== undefined ? { isIncome: nextIsIncome } : {}),
      ...(nextIncomeMonth !== undefined ? { incomeMonth: nextIncomeMonth } : {}),
      // Mirror the server: any edit reviews the row. Required here
      // (not just on refetch) because status/flag/payee/memo-only
      // edits skip the reload below.
      needsReview: false,
    };
  });
  return { next: { ...prev, accounts, transactions, budgetIndex: undefined }, deltas };
}

/**
 * True when an update touches only cleared/flag state (no toast, but the
 * row still flips optimistically). Mirrors the shell's toast-suppression
 * predicate.
 */
export function isStatusOrFlagOnlyUpdate(t: OptimisticUpdateInput): boolean {
  return (
    (t.status !== undefined || ("transferStatus" in t && t.transferStatus !== undefined) || t.flagColor !== undefined) &&
    t.accountId === undefined &&
    !("categoryId" in t && t.categoryId !== undefined) &&
    !("transferAccountId" in t && t.transferAccountId !== undefined) &&
    t.date === undefined &&
    t.payee === undefined &&
    t.memo === undefined &&
    t.amount === undefined &&
    t.incomeMonth === undefined &&
    !("isIncome" in t && t.isIncome !== undefined) &&
    !("subTransactions" in t && t.subTransactions !== undefined)
  );
}

/**
 * True when an update changes data the optimistic pass cannot fully
 * recompute (totals, membership, identity), so the shell must refetch
 * after the mutation instead of trusting local state.
 */
export function transactionUpdateNeedsReload(t: OptimisticUpdateInput): boolean {
  return (
    t.amount !== undefined ||
    t.accountId !== undefined ||
    t.transferAccountId !== undefined ||
    t.subTransactions !== undefined ||
    t.date !== undefined ||
    t.categoryId !== undefined ||
    t.incomeMonth !== undefined ||
    t.payee !== undefined ||
    ("isIncome" in t && t.isIncome !== undefined)
  );
}

// ---------------------------------------------------------------------------
// Bulk update
// ---------------------------------------------------------------------------

/**
 * Build the optimistic state for a bulk patch over many rows. Deltas
 * cover account/amount changes (transfers move both legs); split members
 * inherit date/status edits. Unlike the single-row path this applies the
 * patch verbatim without income inference.
 */
export function planOptimisticBulkUpdate(
  prev: BudgetData,
  ids: number[],
  patch: BulkUpdateTransactionPatch
): OptimisticPlan {
  const idSet = new Set(ids);
  const affectedSplitParentIds = new Set<number>();
  for (const tx of prev.transactions) {
    if (idSet.has(tx.id)) {
      if (tx.parentId != null) affectedSplitParentIds.add(tx.parentId);
      else if (prev.transactions.some((c) => c.parentId === tx.id)) affectedSplitParentIds.add(tx.id);
    }
  }

  const deltas = new Map<number, number>();
  if (patch.accountId != null || patch.amount != null) {
    for (const tx of prev.transactions) {
      if (!idSet.has(tx.id)) continue;
      const isSplitParent = prev.transactions.some((c) => c.parentId === tx.id);
      const oldAccountId = tx.accountId;
      const oldAmount = num(tx.amount);
      const newAccountId = patch.accountId != null ? patch.accountId : oldAccountId;
      const newAmount = patch.amount != null ? patch.amount : oldAmount;

      if (tx.transferAccountId != null) {
        deltas.set(oldAccountId, (deltas.get(oldAccountId) ?? 0) - oldAmount);
        deltas.set(tx.transferAccountId, (deltas.get(tx.transferAccountId) ?? 0) + oldAmount);
        deltas.set(newAccountId, (deltas.get(newAccountId) ?? 0) + newAmount);
        deltas.set(tx.transferAccountId, (deltas.get(tx.transferAccountId) ?? 0) - newAmount);
      } else if (!isSplitParent) {
        if (newAccountId !== oldAccountId || newAmount !== oldAmount) {
          deltas.set(oldAccountId, (deltas.get(oldAccountId) ?? 0) - oldAmount);
          deltas.set(newAccountId, (deltas.get(newAccountId) ?? 0) + newAmount);
        }
      }
    }
  }

  const accounts = applyAccountDeltas(prev.accounts, deltas);

  const transactions = prev.transactions.map((x) => {
    if (!idSet.has(x.id)) {
      const isSplitMember =
        (x.parentId != null && affectedSplitParentIds.has(x.parentId)) ||
        affectedSplitParentIds.has(x.id);
      if (isSplitMember) {
        return {
          ...x,
          ...(patch.date !== undefined ? { date: patch.date } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        };
      }
      return x;
    }
    return {
      ...x,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
      ...(patch.flagColor !== undefined ? { flagColor: patch.flagColor } : {}),
      ...(patch.date !== undefined ? { date: patch.date } : {}),
      ...(patch.payee !== undefined ? { payee: patch.payee } : {}),
      ...(patch.memo !== undefined ? { memo: patch.memo ?? "" } : {}),
      ...(patch.amount !== undefined ? { amount: String(patch.amount) } : {}),
      ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
      ...(patch.incomeMonth !== undefined ? { incomeMonth: patch.incomeMonth } : {}),
    };
  });
  return { next: { ...prev, accounts, transactions, budgetIndex: undefined }, deltas };
}

/** True when a bulk patch touches only cleared state (no toast). */
export function isStatusOnlyBulkUpdate(patch: BulkUpdateTransactionPatch): boolean {
  return (
    patch.categoryId === undefined &&
    patch.payee === undefined &&
    patch.memo === undefined &&
    patch.date === undefined &&
    patch.amount === undefined &&
    patch.accountId === undefined &&
    patch.flagColor === undefined &&
    patch.incomeMonth === undefined
  );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export type PreparedOptimisticMerge = {
  primary: MergeableTransaction;
  secondary: MergeableTransaction;
  /** Snapshot rows for rollback restore (primary first). */
  prevRows: Transaction[];
  /** Snapshot of the primary row; the merged row spreads it. */
  primaryTx: Transaction;
  mergedFields: MergedTransactionFields;
};

function toMergeable(tx: Transaction): MergeableTransaction {
  return {
    ...tx,
    transferAccountId: tx.transferAccountId ?? null,
    amount: num(tx.amount),
  };
}

/**
 * Resolve the merged row for an optimistic merge (primary pick, field
 * resolution, user overrides). Throws when `prev` holds anything but
 * exactly the two selected rows — call before `setData` so the error
 * propagates synchronously to the caller.
 */
export function prepareOptimisticMerge(
  prev: BudgetData | null,
  ids: number[],
  overrides?: MergeOverrides
): PreparedOptimisticMerge {
  const pair = (prev?.transactions ?? []).filter((tx) => ids.includes(tx.id));
  if (pair.length !== 2 || pair[0] == null || pair[1] == null) {
    throw new Error("Select exactly two transactions to merge.");
  }
  const patch = overrides ?? {};
  const [primary, secondary] = pickMergePrimary(toMergeable(pair[0]), toMergeable(pair[1]));
  const primaryTx = primary.id === pair[0].id ? pair[0] : pair[1];
  const srcAcc = prev?.accounts.find((a) => a.id === primary.accountId);
  const destAcc =
    primary.transferAccountId != null
      ? prev?.accounts.find((a) => a.id === primary.transferAccountId)
      : null;
  const resolved = resolveMergedTransaction({
    primary,
    secondary,
    sourceAccount: { onBudget: srcAcc?.onBudget ?? true, kind: srcAcc?.kind ?? "liquid" },
    destAccount: destAcc ? { onBudget: destAcc.onBudget } : null,
  });
  const finalSrc =
    patch.accountId != null
      ? (prev?.accounts.find((a) => a.id === patch.accountId) ?? srcAcc)
      : srcAcc;
  const finalDestId =
    patch.transferAccountId !== undefined ? patch.transferAccountId : resolved.transferAccountId;
  const finalDest =
    finalDestId != null ? (prev?.accounts.find((a) => a.id === finalDestId) ?? null) : null;
  const mergedFields = applyMergeOverrides(resolved, patch, {
    sourceAccount: { onBudget: finalSrc?.onBudget ?? true, kind: finalSrc?.kind ?? "liquid" },
    destAccount: finalDest ? { onBudget: finalDest.onBudget } : null,
    destAccountName: finalDest?.name ?? null,
  });
  return { primary, secondary, prevRows: [{ ...pair[0] }, { ...pair[1] }], primaryTx, mergedFields };
}

/**
 * Apply a prepared merge to the latest state: reverse both legs, post
 * the merged leg, drop the pair, append the merged row.
 */
export function applyPreparedMerge(
  prev: BudgetData,
  prepared: PreparedOptimisticMerge
): OptimisticPlan {
  const { primary, secondary, primaryTx, mergedFields } = prepared;
  const deltas = new Map<number, number>();
  const reverse = (tx: Transaction) => {
    deltas.set(tx.accountId, (deltas.get(tx.accountId) ?? 0) - num(tx.amount));
    if (tx.transferAccountId != null) {
      deltas.set(tx.transferAccountId, (deltas.get(tx.transferAccountId) ?? 0) + num(tx.amount));
    }
  };
  const pairById = new Map(prev.transactions.map((tx) => [tx.id, tx]));
  reverse(pairById.get(primary.id) ?? toTransactionLike(primary));
  reverse(pairById.get(secondary.id) ?? toTransactionLike(secondary));
  deltas.set(
    mergedFields.accountId,
    (deltas.get(mergedFields.accountId) ?? 0) + mergedFields.amount
  );
  if (mergedFields.transferAccountId != null) {
    deltas.set(
      mergedFields.transferAccountId,
      (deltas.get(mergedFields.transferAccountId) ?? 0) - mergedFields.amount
    );
  }
  const accounts = applyAccountDeltas(prev.accounts, deltas);
  const mergedTx: Transaction = {
    ...primaryTx,
    accountId: mergedFields.accountId,
    categoryId: mergedFields.categoryId,
    transferAccountId: mergedFields.transferAccountId,
    date: mergedFields.date,
    payee: mergedFields.payee,
    memo: mergedFields.memo,
    amount: String(mergedFields.amount),
    status: mergedFields.status,
    transferStatus: mergedFields.transferStatus,
    flagColor: mergedFields.flagColor,
    isIncome: mergedFields.isIncome,
    incomeMonth: mergedFields.incomeMonth,
    needsReview: mergedFields.needsReview,
    entityId: mergedFields.entityId,
    transferEntityId: mergedFields.transferEntityId,
  };
  const transactions = prev.transactions
    .filter((tx) => tx.id !== primary.id && tx.id !== secondary.id)
    .concat([mergedTx]);
  return { next: { ...prev, accounts, transactions, budgetIndex: undefined }, deltas };
}

function toTransactionLike(m: MergeableTransaction): Transaction {
  return {
    id: m.id,
    accountId: m.accountId,
    transferAccountId: m.transferAccountId,
    categoryId: m.categoryId,
    date: m.date,
    payee: m.payee,
    memo: m.memo,
    amount: String(m.amount),
    status: m.status,
  };
}
