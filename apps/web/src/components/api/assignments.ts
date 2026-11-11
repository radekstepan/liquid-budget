import type { BudgetAppApi } from "@ynab/ui";
import { mapOptimisticAssignId, planOptimisticAssign, planOptimisticBatchAssign, rollbackOptimisticAssign, parseAssignmentResponse } from "@ynab/logic";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createAssignmentsApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "assign" | "batchAssign"> {
  const { dataRef, setData, optimisticMutation } = deps;
  return {
  assign: async (categoryId, amount, month) => {
    const prevAssignment = dataRef.current?.assignments.find(
      (a) => a.categoryId === categoryId && a.month === month
    );
    const prevAssignmentSnapshot = prevAssignment ? { ...prevAssignment } : null;
    const tempId = -Date.now();
    await optimisticMutation({
      plan: () => {
        setData((prev) => {
          if (!prev) return prev;
          return planOptimisticAssign(prev, { categoryId, month, amount }, tempId);
        });
      },
      request: async () => {
        return parseAssignmentResponse(
          await jsonReq<unknown>("/api/assignments", {
            method: "PUT",
            body: JSON.stringify({ categoryId, month, amount }),
          })
        );
      },
      mapResult: (res) => {
        if (res && typeof res.id === "number") {
          setData((prev) => {
            if (!prev) return prev;
            return mapOptimisticAssignId(prev, tempId, categoryId, month, res);
          });
        }
      },
      messages: { failure: "Failed to save assignment. Please try again." },
      rollback: () => {
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
      },
      skipReload: true,
    });
  },
  batchAssign: async (assignments) => {
    if (!assignments.length) return;
    const prevAssignmentsSnapshot = dataRef.current ? [...dataRef.current.assignments] : [];
    const tempIdBase = -Date.now();
    await optimisticMutation({
      plan: () => {
        setData((prev) => {
          if (!prev) return prev;
          return planOptimisticBatchAssign(prev, assignments, tempIdBase);
        });
      },
      request: async () => {
        return await Promise.all(
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
      },
      messages: { failure: "Failed to save assignments. Please try again." },
      rollback: () => {
        setData((current) => {
          if (!current) return current;
          return { ...current, assignments: prevAssignmentsSnapshot, budgetIndex: undefined };
        });
      },
    });
  },
  };
}
