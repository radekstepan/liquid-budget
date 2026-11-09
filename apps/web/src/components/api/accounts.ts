import type { BudgetAppApi } from "@ynab/ui";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createAccountsApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "addAccount" | "deleteAccount" | "updateAccount" | "reorderAccount"> {
  const { dataRef, setData, reload, runMutation, withSync, addToast } = deps;
  const api: Pick<BudgetAppApi, "addAccount" | "deleteAccount" | "updateAccount" | "reorderAccount"> = {
  addAccount: async (v) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/accounts", { method: "POST", body: JSON.stringify(v) });
        },
        { success: "Account created.", failure: "Failed to create account." }
      )
    );
  },
  deleteAccount: async (id) => {
    const prevAccount = dataRef.current?.accounts.find((a) => a.id === id);
    const prevAccountSnapshot = prevAccount ? { ...prevAccount } : null;
    setData((prev) => {
      if (!prev) return prev;
      const accounts = prev.accounts.filter((a) => a.id !== id);
      return { ...prev, accounts, budgetIndex: undefined };
    });
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq(`/api/accounts?id=${id}`, { method: "DELETE" });
        },
        { success: "Account deleted.", failure: "Failed to delete account." },
        {
          onRollback: () => {
            if (prevAccountSnapshot) {
              setData((current) => {
                if (!current) return current;
                if (current.accounts.some((a) => a.id === id)) return current;
                return {
                  ...current,
                  accounts: [...current.accounts, prevAccountSnapshot],
                  budgetIndex: undefined,
                };
              });
            }
            reload().catch(() => {});
          },
        }
      )
    );
  },
  updateAccount: async (id, patch, opts?: { undo?: boolean }) => {
    const prevAccount = dataRef.current?.accounts.find((a) => a.id === id);
    const prevAccountSnapshot = prevAccount ? { ...prevAccount } : null;
    const rollback = () => {
      if (prevAccountSnapshot) {
        setData((current) => {
          if (!current) return current;
          return {
            ...current,
            accounts: current.accounts.map((a) =>
              a.id === id ? prevAccountSnapshot : a
            ),
            budgetIndex: undefined,
          };
        });
      }
      reload().catch(() => {});
    };
    const sendPatch = (p: typeof patch) => {
      setData((prev) => {
        if (!prev) return prev;
        const accounts = prev.accounts.map((a) => {
          if (a.id !== id) return a;
          const nextKind = p.kind !== undefined ? p.kind : a.kind;
          const nextOnBudget =
            p.onBudget !== undefined
              ? p.onBudget
              : p.kind !== undefined
                ? p.kind !== "offbudget"
                : a.onBudget;
          return {
            ...a,
            ...p,
            kind: nextKind,
            onBudget: nextOnBudget,
          };
        });
        return { ...prev, accounts, budgetIndex: undefined };
      });
      return withSync(() =>
        runMutation(
          async () => {
            return await jsonReq("/api/accounts", {
              method: "PATCH",
              body: JSON.stringify({ id, ...p }),
            });
          },
          // Close/reopen toasts are raised manually below so they can
          // carry an Undo action; other patches use the default toast.
          p.archived !== undefined && opts?.undo !== false
            ? { success: undefined, failure: "Failed to update account." }
            : {
                success:
                  p.archived === true
                    ? "Account closed."
                    : p.archived === false
                      ? "Account reopened."
                      : "Account updated.",
                failure: "Failed to update account.",
              },
          { onRollback: rollback }
        )
      );
    };
    const result = await sendPatch(patch);
    void result;
    if (patch.archived !== undefined && opts?.undo !== false) {
      const undoArchived = !patch.archived;
      addToast(patch.archived ? "Account closed." : "Account reopened.", "ok", {
        durationMs: 8000,
        action: {
          label: "Undo",
          run: () => {
            void api.updateAccount(id, { archived: undoArchived }, { undo: false });
          },
        },
      });
    }
    return;
  },
  reorderAccount: async (id, sort) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/accounts", {
            method: "PATCH",
            body: JSON.stringify({ id, sort }),
          });
        },
        { failure: "Failed to reorder account." }
      )
    );
  },
  };
  return api;
}