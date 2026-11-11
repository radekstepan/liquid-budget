import type { RefObject, SetStateAction } from "react";
import type { BudgetData } from "@ynab/logic";
import type { ToastItem } from "@ynab/theme";

export type MutationMessages<T> = {
  success?: string;
  failure: string;
  notifyFailure?: boolean;
  onSuccess?: (result: T) => void;
};

export type MutationOptions = {
  onRollback?: () => void;
  skipReload?: boolean;
};

export type OptimisticMutationOptions<T> = {
  /** Optimistic preview applied synchronously before the request fires. */
  plan?: () => void;
  request: () => Promise<T>;
  messages: MutationMessages<T>;
  /** Local-state restore; the helper appends the silent confirming reload. */
  rollback?: () => void;
  /** Patch server-assigned ids into the optimistic rows (runs pre-toast). */
  mapResult?: (result: T) => void;
  skipReload?: boolean;
  /**
   * Resolve as soon as the POST lands and reload detached (reconcile):
   * implies skipReload for the inner runMutation.
   */
  deferredReload?: boolean;
};

export type OptimisticMutation = <T>(opts: OptimisticMutationOptions<T>) => Promise<T>;

export type RunMutation = <T>(
  action: () => Promise<T>,
  messages: MutationMessages<T>,
  options?: MutationOptions
) => Promise<T>;

export type ToastFn = (
  message: string,
  tone?: ToastItem["tone"],
  opts?: { action?: { label: string; run: () => void }; durationMs?: number }
) => ToastItem;

/**
 * Shell-owned primitives the API factories close over. Everything the
 * mutation methods need (state access, reload, mutation wrapper, sync
 * tracking, toasts) flows through here so the factories stay pure
 * functions of these deps.
 */
export type BudgetApiDeps = {
  dataRef: RefObject<BudgetData | null>;
  setData: (value: SetStateAction<BudgetData | null>) => void;
  reload: () => Promise<void>;
  runMutation: RunMutation;
  optimisticMutation: OptimisticMutation;
  withSync: <T>(fn: () => Promise<T>) => Promise<T>;
  addToast: ToastFn;
};
