import type { BudgetAppApi } from "@ynab/ui";
import { mapOptimisticAssignId, planOptimisticAssign, planOptimisticBatchAssign, rollbackOptimisticAssign, parseAssignmentResponse } from "@ynab/logic";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createAssignmentsApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "assign" | "batchAssign"> {
  const { dataRef, setData, reload, runMutation, withSync } = deps;
  return {
  assign: async (categoryId, amount, month) => {
    const prevAssignment = dataRef.current?.assignments.find(
      (a) => a.categoryId === categoryId && a.month === month
    );
    const prevAssignmentSnapshot = prevAssignment ? { ...prevAssignment } : null;
    const tempId = -Date.now();
    setData((prev) => {
      if (!prev) return prev;
      return planOptimisticAssign(prev, { categoryId, month, amount }, tempId);
    });
    await withSync(() =>
      runMutation(
        async () => {
          const res = parseAssignmentResponse(
            await jsonReq<unknown>("/api/assignments", {
              method: "PUT",
              body: JSON.stringify({ categoryId, month, amount }),
            })
          );
          if (res && typeof res.id === "number") {
            setData((prev) => {
              if (!prev) return prev;
              return mapOptimisticAssignId(prev, tempId, categoryId, month, res);
            });
          }
          return res;
        },
        { failure: "Failed to save assignment. Please try again." },
        {
          onRollback: () => {
            setData((current) => {
              if (!current) return current;
              return rollbackOptimisticAssign(
                current,
                prevAssignmentSnapshot,
                categoryId,
                month,
                tempId
              );
            });
            reload().catch(() => {});
          },
          skipReload: true,
        }
      )
    );
  },
  batchAssign: async (assignments) => {
    if (!assignments.length) return;
    const prevAssignmentsSnapshot = dataRef.current ? [...dataRef.current.assignments] : [];
    const tempIdBase = -Date.now();
    setData((prev) => {
      if (!prev) return prev;
      return planOptimisticBatchAssign(prev, assignments, tempIdBase);
    });
    await withSync(() =>
      runMutation(
        async () => {
          const results = await Promise.all(
            assignments.map(async (item) =>
              parseAssignmentResponse(
                await jsonReq<unknown>("/api/assignments", {
                  method: "PUT",
                  body: JSON.stringify({
                    categoryId: item.categoryId,
                    month: item.month,
                    amount: item.amount,
                  }),
                })
              )
            )
          );
          return results;
        },
        { failure: "Failed to save assignments. Please try again." },
        {
          onRollback: () => {
            setData((current) => {
              if (!current) return current;
              return { ...current, assignments: prevAssignmentsSnapshot, budgetIndex: undefined };
            });
            reload().catch(() => {});
          },
        }
      )
    );
  },
  };
}
