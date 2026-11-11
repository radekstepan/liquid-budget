import type { BudgetAppApi } from "@ynab/ui";
import type { BudgetApiDeps } from "./types";
import { createAssignmentsApi } from "./assignments";
import { createTransactionsApi } from "./transactions";
import { createRecurringApi } from "./recurring";
import { createCategoriesApi } from "./categories";
import { createAccountsApi } from "./accounts";
import { createReconcileApi } from "./reconcile";
import { createImportsApi } from "./imports";
import { createRenameApi } from "./rename";
import { createPayeesApi } from "./payees";
import { createSnapshotsApi } from "./snapshots";

/** Compose every domain factory into the full mutation API (minus `reload`, which the shell owns). */
export function createBudgetApi(deps: BudgetApiDeps): Omit<BudgetAppApi, "reload"> {
  return {
    ...createAssignmentsApi(deps),
    ...createTransactionsApi(deps),
    ...createRecurringApi(deps),
    ...createCategoriesApi(deps),
    ...createAccountsApi(deps),
    ...createReconcileApi(deps),
    ...createImportsApi(deps),
    ...createRenameApi(deps),
    ...createPayeesApi(deps),
    ...createSnapshotsApi(deps),
  };
}
export type { BudgetApiDeps, MutationMessages, MutationOptions, OptimisticMutation, OptimisticMutationOptions, RunMutation, ToastFn } from "./types";
export { jsonReq, type ApiRequestError } from "./client";
export { createOptimisticMutation, reportBudgetReloadFailure } from "./optimistic-mutation";
export { useToasts } from "./useToasts";
