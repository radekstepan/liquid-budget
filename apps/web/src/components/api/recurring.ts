import type { BudgetAppApi } from "@ynab/ui";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createRecurringApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "addRecurring" | "updateRecurring" | "deleteRecurring" | "postRecurring" | "bulkPostRecurring" | "bulkUpdateRecurring" | "bulkDeleteRecurring"> {
  const { dataRef, setData, runMutation, withSync, optimisticMutation } = deps;
  return {
  addRecurring: async (v) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/recurring", { method: "POST", body: JSON.stringify(v) });
        },
        { success: "Recurring transaction scheduled.", failure: "Failed to create recurring transaction." }
      )
    );
  },
  updateRecurring: async (id, v) => {
    const prevRecurring = dataRef.current?.recurring.find((r) => r.id === id);
    const prevRecurringSnapshot = prevRecurring
      ? {
          ...prevRecurring,
          subTransactions: prevRecurring.subTransactions?.map((st) => ({ ...st })),
        }
      : null;
    return optimisticMutation({
      plan: () => {
        setData((prev) => {
          if (!prev) return prev;
          const recurring = prev.recurring.map((r) => {
            if (r.id !== id) return r;
            const { subTransactions, amount, ...rest } = v;
            return {
              ...r,
              ...rest,
              amount: amount !== undefined ? amount.toFixed(2) : r.amount,
              subTransactions:
                subTransactions !== undefined
                  ? subTransactions.map((st, i) => ({
                      id: r.subTransactions?.[i]?.id ?? -(i + 1),
                      recurringId: id,
                      categoryId: st.categoryId,
                      transferAccountId: st.transferAccountId ?? null,
                      amount: st.amount.toFixed(2),
                      memo: st.memo ?? "",
                      sort: i,
                    }))
                  : r.subTransactions,
            };
          });
          return { ...prev, recurring, budgetIndex: undefined };
        });
      },
      request: async () => {
        return await jsonReq("/api/recurring", {
          method: "PATCH",
          body: JSON.stringify({ id, ...v }),
        });
      },
      messages: { success: "Recurring transaction updated.", failure: "Failed to update recurring transaction." },
      rollback: () => {
        if (prevRecurringSnapshot) {
          setData((current) => {
            if (!current) return current;
            return {
              ...current,
              recurring: current.recurring.map((r) =>
                r.id === id ? prevRecurringSnapshot : r
              ),
              budgetIndex: undefined,
            };
          });
        }
      },
    });
  },
  deleteRecurring: async (id) => {
    const prevRecurring = dataRef.current?.recurring.find((r) => r.id === id);
    const prevRecurringSnapshot = prevRecurring
      ? {
          ...prevRecurring,
          subTransactions: prevRecurring.subTransactions?.map((st) => ({ ...st })),
        }
      : null;
    return optimisticMutation({
      plan: () => {
        setData((prev) => {
          if (!prev) return prev;
          const recurring = prev.recurring.filter((r) => r.id !== id);
          return { ...prev, recurring, budgetIndex: undefined };
        });
      },
      request: async () => {
        return await jsonReq(`/api/recurring?id=${id}`, { method: "DELETE" });
      },
      messages: { success: "Recurring transaction deleted.", failure: "Failed to delete recurring transaction." },
      rollback: () => {
        if (prevRecurringSnapshot) {
          setData((current) => {
            if (!current) return current;
            if (current.recurring.some((r) => r.id === id)) return current;
            return {
              ...current,
              recurring: [...current.recurring, prevRecurringSnapshot],
              budgetIndex: undefined,
            };
          });
        }
      },
    });
  },
  postRecurring: async (id: number, date?: string) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/recurring", {
            method: "POST",
            body: JSON.stringify(date ? { action: "post", id, date } : { action: "post", id }),
          });
        },
        { success: "Scheduled transaction entered.", failure: "Failed to post recurring transaction." }
      )
    );
  },
  bulkPostRecurring: async (ids: number[], date?: string) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/recurring", {
            method: "POST",
            body: JSON.stringify({ action: "bulk-post", ids, date }),
          });
        },
        { success: `Entered ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to enter scheduled transactions." }
      )
    );
  },
  bulkUpdateRecurring: async (ids, patch) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/recurring", {
            method: "PATCH",
            body: JSON.stringify({ action: "bulk-update", ids, patch }),
          });
        },
        { success: `Updated ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to update scheduled transactions." }
      )
    );
  },
  bulkDeleteRecurring: async (ids: number[]) => {
    const idSet = new Set(ids);
    const prevRecurringSnapshots = (dataRef.current?.recurring ?? [])
      .filter((r) => idSet.has(r.id))
      .map((r) => ({
        ...r,
        subTransactions: r.subTransactions?.map((st) => ({ ...st })),
      }));
    return optimisticMutation({
      plan: () => {
        setData((prev) => {
          if (!prev) return prev;
          const recurring = prev.recurring.filter((r) => !idSet.has(r.id));
          return { ...prev, recurring, budgetIndex: undefined };
        });
      },
      request: async () => {
        return await jsonReq("/api/recurring", {
          method: "DELETE",
          body: JSON.stringify({ ids }),
        });
      },
      messages: { success: `Deleted ${ids.length} scheduled transaction${ids.length === 1 ? "" : "s"}.`, failure: "Failed to delete scheduled transactions." },
      rollback: () => {
        if (prevRecurringSnapshots.length > 0) {
          setData((current) => {
            if (!current) return current;
            const currentIds = new Set(current.recurring.map((r) => r.id));
            const toRestore = prevRecurringSnapshots.filter((r) => !currentIds.has(r.id));
            return {
              ...current,
              recurring: [...current.recurring, ...toRestore],
              budgetIndex: undefined,
            };
          });
        }
      },
    });
  },
  };
}
