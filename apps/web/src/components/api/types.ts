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
  withSync: <T>(fn: () => Promise<T>) => Promise<T>;
  addToast: ToastFn;
};
