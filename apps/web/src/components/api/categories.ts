import type { BudgetAppApi } from "@ynab/ui";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createCategoriesApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "saveCategory" | "deleteCategory" | "reorderCategory" | "reorderGroup" | "saveGroup" | "deleteGroup"> {
  const { dataRef, setData, runMutation, withSync, optimisticMutation } = deps;
  return {
  saveCategory: async (groupId, categoryId, v) => {
    const prevCategory = categoryId
      ? dataRef.current?.categories.find((c) => c.id === categoryId)
      : null;
    const prevCategorySnapshot = prevCategory ? { ...prevCategory } : null;
    const targetGroupId = v.groupId ?? (groupId != null ? groupId : undefined);
    return optimisticMutation({
      plan: () => {
        if (categoryId) {
          setData((prev) => {
            if (!prev) return prev;
            const categories = prev.categories.map((c) =>
              c.id === categoryId
                ? {
                    ...c,
                    groupId: targetGroupId ?? c.groupId,
                    name: v.name,
                    goalTarget: v.goalTarget != null ? v.goalTarget.toFixed(2) : null,
                    carryover: v.carryover != null ? v.carryover.toFixed(2) : c.carryover,
                    overspendCarriesOver: v.overspendCarriesOver ?? c.overspendCarriesOver,
                  }
                : c
            );
            return { ...prev, categories, budgetIndex: undefined };
          });
        }
      },
      request: async () => {
        if (categoryId) {
          return await jsonReq("/api/categories", {
            method: "PATCH",
            body: JSON.stringify({
              id: categoryId,
              groupId: v.groupId,
              name: v.name,
              goalTarget: v.goalTarget,
              carryover: v.carryover,
              overspendCarriesOver: v.overspendCarriesOver,
            }),
          });
        } else {
          return await jsonReq("/api/categories", {
            method: "POST",
            body: JSON.stringify({
              groupId: targetGroupId ?? groupId,
              name: v.name,
              goalTarget: v.goalTarget,
              carryover: v.carryover,
              overspendCarriesOver: v.overspendCarriesOver,
            }),
          });
        }
      },
      messages: { success: categoryId ? "Category updated." : "Category created.", failure: "Failed to save category." },
      rollback: () => {
        if (prevCategorySnapshot && categoryId) {
          setData((current) => {
            if (!current) return current;
            return {
              ...current,
              categories: current.categories.map((c) =>
                c.id === categoryId ? prevCategorySnapshot : c
              ),
              budgetIndex: undefined,
            };
          });
        }
      },
    });
  },
  deleteCategory: async (id, opts) => {
    const prevCategory = dataRef.current?.categories.find((c) => c.id === id);
    const prevCategorySnapshot = prevCategory ? { ...prevCategory } : null;
    return optimisticMutation({
      plan: () => {
        setData((prev) => {
          if (!prev) return prev;
          const categories = prev.categories.filter((c) => c.id !== id);
          return { ...prev, categories, budgetIndex: undefined };
        });
      },
      request: async () => {
        const url = opts?.moveToCategoryId
          ? `/api/categories?id=${id}&moveToCategoryId=${opts.moveToCategoryId}`
          : `/api/categories?id=${id}`;
        return await jsonReq(url, { method: "DELETE" });
      },
      messages: { success: "Category deleted.", failure: "Failed to delete category." },
      rollback: () => {
        if (prevCategorySnapshot) {
          setData((current) => {
            if (!current) return current;
            if (current.categories.some((c) => c.id === id)) return current;
            return {
              ...current,
              categories: [...current.categories, prevCategorySnapshot],
              budgetIndex: undefined,
            };
          });
        }
      },
    });
  },
  reorderCategory: async (id, sort) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/categories", {
            method: "PATCH",
            body: JSON.stringify({ id, sort }),
          });
        },
        { failure: "Failed to reorder category." }
      )
    );
  },
  reorderGroup: async (id, sort) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq("/api/categories", {
            method: "PATCH",
            body: JSON.stringify({ id, type: "group", sort }),
          });
        },
        { failure: "Failed to reorder category group." }
      )
    );
  },
  saveGroup: async (groupId, name) => {
    return withSync(() =>
      runMutation(
        async () => {
          if (groupId) {
            return await jsonReq("/api/categories", {
              method: "PATCH",
              body: JSON.stringify({ id: groupId, type: "group", name }),
            });
          } else {
            return await jsonReq("/api/categories", {
              method: "POST",
              body: JSON.stringify({ type: "group", name }),
            });
          }
        },
        { success: groupId ? "Category group updated." : "Category group created.", failure: "Failed to save category group." }
      )
    );
  },
  deleteGroup: async (id) => {
    return withSync(() =>
      runMutation(
        async () => {
          return await jsonReq(`/api/categories?type=group&id=${id}`, { method: "DELETE" });
        },
        { success: "Category group deleted.", failure: "Failed to delete category group." }
      )
    );
  },
  };
}
