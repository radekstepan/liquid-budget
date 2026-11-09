"use client";

import { useCallback, useMemo, useState } from "react";
import type { BudgetData } from "@ynab/logic";
import { createPrivacyMask, isPrivacyFactor, maskBudgetData } from "@ynab/logic";
import { useLocalStorage } from "./useLocalStorage.js";
import { guardApiForPrivacy, randomPrivacyFactor } from "./privacyApi.js";
import type { BudgetAppApi } from "./BudgetAppApi.js";

export const PRIVACY_STORAGE_KEY = "ynab:privacy";

export type PrivacySettings = {
  enabled: boolean;
  /** Disguise factor; 0 means "none drawn yet". */
  factor: number;
};

export function isPrivacySettings(v: unknown): v is PrivacySettings {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.enabled === "boolean" &&
    (o.factor === 0 || isPrivacyFactor(o.factor))
  );
}

/**
 * Privacy (screenshot) mode: disguise factors persist in local storage;
 * returns the masked data snapshot plus a guarded api that blocks all
 * mutations (masked data must never be written back) and reports the
 * block via `privacyNotice`. With the mode off, inputs pass through
 * untouched.
 */
export function usePrivacyBudget(rawData: BudgetData, rawApi: BudgetAppApi) {
  // Privacy (screenshot) mode: every `data`/`api` use below sees the
  // masked snapshot and the guarded api, so all views, modals, search,
  // titles, and tooltips are disguised with no per-screen changes.
  // Masked data must never be written back: the guard blocks all
  // mutations while the mode is on.
  const [privacy, setPrivacy] = useLocalStorage<PrivacySettings>(
    PRIVACY_STORAGE_KEY,
    { enabled: false, factor: 0 },
    isPrivacySettings
  );
  const [privacyNotice, setPrivacyNotice] = useState(false);
  const privacyMask = useMemo(
    () =>
      privacy.enabled && isPrivacyFactor(privacy.factor)
        ? createPrivacyMask(rawData, privacy.factor)
        : null,
    [privacy, rawData]
  );
  const data = useMemo(
    () => (privacyMask ? maskBudgetData(rawData, privacyMask) : rawData),
    [rawData, privacyMask]
  );
  const api = useMemo(
    () =>
      privacyMask
        ? guardApiForPrivacy(rawApi, privacyMask, () => setPrivacyNotice(true))
        : rawApi,
    [rawApi, privacyMask]
  );
  const enablePrivacy = useCallback(() => {
    setPrivacy((p) => ({
      enabled: true,
      factor: isPrivacyFactor(p.factor) ? p.factor : randomPrivacyFactor(),
    }));
  }, [setPrivacy]);
  const disablePrivacy = useCallback(() => {
    setPrivacy((p) => ({ ...p, enabled: false }));
    setPrivacyNotice(false);
  }, [setPrivacy]);
  const regeneratePrivacyFactor = useCallback(() => {
    setPrivacy((p) => ({ ...p, factor: randomPrivacyFactor() }));
  }, [setPrivacy]);

  return {
    data,
    api,
    privacy,
    privacyMask,
    privacyNotice,
    setPrivacyNotice,
    enablePrivacy,
    disablePrivacy,
    regeneratePrivacyFactor,
  };
}
