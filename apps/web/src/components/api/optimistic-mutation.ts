import type {
  MutationMessages,
  OptimisticMutation,
  OptimisticMutationOptions,
  ToastFn,
} from "./types";
import { logger } from "@/lib/logger";

/** Shell-owned primitives the optimistic helper closes over. */
export type OptimisticMutationShell = {
  reload: () => Promise<void>;
  runMutation: <T>(
    action: () => Promise<T>,
    messages: MutationMessages<T>,
    options?: { onRollback?: () => void; skipReload?: boolean }
  ) => Promise<T>;
  withSync: <T>(fn: () => Promise<T>) => Promise<T>;
  addToast: ToastFn;
};

/**
 * Shared toast for a stale budget read after a mutation already landed.
 * Single copy of the message pair previously duplicated between the
 * shell's runMutation and the reconcile deferred-reload path.
 */
export function reportBudgetReloadFailure(refreshErr: unknown, addToast: ToastFn): void {
  logger.error("Budget reload failed after successful mutation:", refreshErr);
  addToast("Saved changes, but failed to refresh latest budget data.", "warn");
}

/**
 * Single optimistic-mutation helper for the shell API factories.
 *
 * Centralizes the plan/request/rollback shape previously copied across
 * every factory: apply the optimistic `plan`, run the `request` under
 * `withSync` + `runMutation`, map server-assigned ids via `mapResult`,
 * and on failure run `rollback` followed by a silent confirming reload
 * so rolled-back state can't drift from the server.
 *
 * `deferredReload` covers the reconcile case: resolve as soon as the
 * POST lands (so the modal closes onto the already-updated register)
 * while the confirming reload runs detached with the standard
 * stale-read toast on failure.
 */
export function createOptimisticMutation(shell: OptimisticMutationShell): OptimisticMutation {
  const { reload, runMutation, withSync, addToast } = shell;
  return async <T>(opts: OptimisticMutationOptions<T>): Promise<T> => {
    opts.plan?.();
    const { rollback } = opts;
    const onRollback = rollback
      ? () => {
          rollback();
          reload().catch(() => {});
        }
      : undefined;
    if (opts.deferredReload) {
      const result = await withSync(() =>
        runMutation(
          async () => {
            const res = await opts.request();
            opts.mapResult?.(res);
            return res;
          },
          opts.messages,
          { onRollback, skipReload: true }
        )
      );
      reload().catch((refreshErr) => {
        reportBudgetReloadFailure(refreshErr, addToast);
      });
      return result;
    }
    return withSync(() =>
      runMutation(
        async () => {
          const res = await opts.request();
          opts.mapResult?.(res);
          return res;
        },
        opts.messages,
        { onRollback, skipReload: opts.skipReload }
      )
    );
  };
}
