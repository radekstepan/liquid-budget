import type { BudgetAppApi } from "@ynab/ui";
import { parseRenameRuleResponse, parseRenameSuggestAcceptResponse, parseRenameSuggestResponse, parseRenameSuggestStatusResponse } from "@ynab/logic";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createRenameApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "addRenameRule" | "updateRenameRule" | "deleteRenameRule" | "applyRenameRule" | "getRenameSuggestStatus" | "suggestRenameRules" | "acceptRenameSuggestions"> {
  const { dataRef, setData, runMutation, withSync, optimisticMutation } = deps;
  return {
  addRenameRule: async (sourcePattern, targetPayee) => {
    // Rule CRUD touches no transactions, so the returned row is patched
    // into local state instead of reloading the whole budget.
    return withSync(() =>
      runMutation(
        async () => {
          const row = parseRenameRuleResponse(
            await jsonReq<unknown>("/api/rename-rules", {
              method: "POST",
              body: JSON.stringify({ sourcePattern, targetPayee }),
            })
          );
          setData((prev) =>
            prev
              ? { ...prev, renameRules: [...(prev.renameRules ?? []), row], budgetIndex: undefined }
              : prev
          );
        },
        { success: "Rename rule created.", failure: "Failed to save rename rule.", notifyFailure: false },
        { skipReload: true }
      )
    );
  },
  updateRenameRule: async (id, sourcePattern, targetPayee) => {
    return withSync(() =>
      runMutation(
        async () => {
          const row = parseRenameRuleResponse(
            await jsonReq<unknown>("/api/rename-rules", {
              method: "PATCH",
              body: JSON.stringify({ id, sourcePattern, targetPayee }),
            })
          );
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  renameRules: (prev.renameRules ?? []).map((r) => (r.id === id ? row : r)),
                  budgetIndex: undefined,
                }
              : prev
          );
        },
        { success: "Rename rule updated.", failure: "Failed to save rename rule.", notifyFailure: false },
        { skipReload: true }
      )
    );
  },
  deleteRenameRule: async (id) => {
    const prevRules = dataRef.current?.renameRules;
    return optimisticMutation({
      plan: () => {
        setData((prev) =>
          prev
            ? {
                ...prev,
                renameRules: (prev.renameRules ?? []).filter((r) => r.id !== id),
                budgetIndex: undefined,
              }
            : prev
        );
      },
      request: async () => {
        return await jsonReq(`/api/rename-rules?id=${id}`, { method: "DELETE" });
      },
      messages: { success: "Rename rule deleted.", failure: "Failed to delete rename rule.", notifyFailure: false },
      rollback: () => {
        if (prevRules) {
          setData((current) =>
            current ? { ...current, renameRules: prevRules, budgetIndex: undefined } : current
          );
        }
      },
      skipReload: true,
    });
  },
  applyRenameRule: async (id) => {
    return withSync(() =>
      runMutation(
        async () => {
          const res = await jsonReq<{ updated: number; skippedLocked: number }>(
            "/api/rename-rules/apply",
            {
              method: "POST",
              body: JSON.stringify({ id }),
            }
          );
          return { updated: res.updated, skippedLocked: res.skippedLocked };
        },
        { success: "Rename rule applied to existing transactions.", failure: "Failed to apply rename rule.", notifyFailure: false }
      )
    );
  },
  getRenameSuggestStatus: async () => {
    return parseRenameSuggestStatusResponse(await jsonReq<unknown>("/api/rename-rules/suggest"));
  },
  suggestRenameRules: async (offset: number, limit: number) => {
    return withSync(async () =>
      parseRenameSuggestResponse(
        await jsonReq<unknown>("/api/rename-rules/suggest", {
          method: "POST",
          body: JSON.stringify({ offset, limit }),
        })
      )
    );
  },
  acceptRenameSuggestions: async (suggestions, applyToExisting) => {
    const noun = suggestions.length === 1 ? "rule" : "rules";
    return withSync(() =>
      runMutation(
        async () => {
          const res = parseRenameSuggestAcceptResponse(
            await jsonReq<unknown>("/api/rename-rules/suggest", {
              method: "POST",
              body: JSON.stringify({ action: "accept", suggestions, applyToExisting }),
            })
          );
          return {
            updated: res.applied.updated,
            skippedLocked: res.applied.skippedLocked,
            generalised: res.generalised,
          };
        },
        {
          success: `Created ${suggestions.length} AI rename ${noun}.`,
          failure: "Failed to create AI rename rules.",
          notifyFailure: false,
        }
      )
    );
  },
  };
}
