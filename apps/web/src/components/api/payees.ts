import type { BudgetAppApi } from "@ynab/ui";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createPayeesApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "ensurePayee" | "renamePayee" | "setPayeeDefaultCategory" | "mergePayees" | "deletePayee"> {
  const { runMutation, withSync } = deps;
  return {
  ensurePayee: async (name) => {
    return withSync(() =>
      runMutation(
        async () => {
          const row = await jsonReq<{ id: number }>("/api/payees", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
          return row.id;
        },
        { failure: "Failed to save payee.", notifyFailure: false }
      )
    );
  },
  renamePayee: async (id, name) => {
    return withSync(() =>
      runMutation(
        async () => {
          await jsonReq("/api/payees", {
            method: "PATCH",
            body: JSON.stringify({ id, name }),
          });
        },
        { success: "Payee renamed.", failure: "Failed to rename payee.", notifyFailure: false }
      )
    );
  },
  setPayeeDefaultCategory: async (id, categoryId) => {
    return withSync(() =>
      runMutation(
        async () => {
          await jsonReq("/api/payees", {
            method: "PATCH",
            body: JSON.stringify({ id, autoCategoryId: categoryId }),
          });
        },
        {
          success: categoryId == null ? "Default category removed." : "Default category saved.",
          failure: "Failed to save default category.",
          notifyFailure: false,
        }
      )
    );
  },
  mergePayees: async (targetId, sourceIds) => {
    return withSync(() =>
      runMutation(
        async () => {
          await jsonReq("/api/payees?action=merge", {
            method: "POST",
            body: JSON.stringify({ targetId, sourceIds }),
          });
        },
        { success: "Payees merged.", failure: "Failed to merge payees.", notifyFailure: false }
      )
    );
  },
  deletePayee: async (id) => {
    return withSync(() =>
      runMutation(
        async () => {
          await jsonReq(`/api/payees?id=${id}`, { method: "DELETE" });
        },
        { success: "Payee deleted.", failure: "Failed to delete payee.", notifyFailure: false }
      )
    );
  },
  };
}
