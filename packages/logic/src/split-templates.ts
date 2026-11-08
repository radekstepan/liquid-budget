/**
 * Split templates: named, reusable recipes for splitting a transaction.
 *
 * A template holds N legs, each with a share of the parent total in basis
 * points (8500 = 85%). Applying a template to a parent total yields
 * balanced sub-transaction amounts: every leg is rounded to the cent,
 * and any penny remainder goes to the largest leg (ties keep the first,
 * matching YNAB4 `RegisterGrid.distributeAmountsToSubTransactions`) so
 * the children always sum to the parent exactly (the invariant
 * `assertSplitsBalanced` enforces).
 *
 * All functions are pure — no DB access, no side-effects.
 */

import type { SplitTemplate, SplitTemplateLeg } from "./types.js";

/** Leg shares sum to this (100% in basis points). */
export const TEMPLATE_TOTAL_BPS = 10000;

export type AppliedTemplateLeg = {
  categoryId: number | null;
  transferAccountId: number | null;
  /** Signed amount in cents. Sums to the parent total across all legs. */
  amount: number;
  payee?: string;
  memo?: string;
};

/**
 * A split template leg as written in code configuration. Unlike the
 * resolved `SplitTemplateLeg`, the transfer destination is named by
 * account *name* (database ids are not stable across budgets) and a
 * category leg may omit its category ("choose when applying").
 */
export type SplitTemplatePresetLeg = {
  kind: "category" | "transfer";
  categoryId?: number | null;
  transferAccountName?: string;
  shareBps: number;
  payee?: string;
  memo?: string;
};

export type SplitTemplatePreset = {
  name: string;
  legs: SplitTemplatePresetLeg[];
};

/**
 * Split templates as code configuration. Edit this list to rename a
 * template, change shares, or add new cost-share recipes — no settings
 * UI, no database rows. `transferAccountName` must match an account name
 * in the budget exactly; legs whose account cannot be resolved apply as
 * unassigned so the editor, not a crash, surfaces the problem.
 */
export const SPLIT_TEMPLATE_PRESETS: SplitTemplatePreset[] = [
  {
    name: "Susie 85/15",
    legs: [
      { kind: "category", shareBps: 8500 },
      { kind: "transfer", transferAccountName: "Susie", shareBps: 1500 },
    ],
  },
];

export type NamedAccount = {
  id: number;
  name: string;
};

/**
 * Resolve code-configured presets against a budget's accounts into
 * `SplitTemplate` rows (stable 1-based ids in preset order). Pure —
 * no DB access.
 */
export function resolveSplitTemplatePresets(
  presets: SplitTemplatePreset[],
  accounts: NamedAccount[]
): SplitTemplate[] {
  const byName = new Map(accounts.map((a) => [a.name, a.id]));
  return presets.map((p, i) => ({
    id: i + 1,
    name: p.name,
    legs: p.legs.map((l) => ({
      kind: l.kind,
      categoryId: l.categoryId ?? null,
      transferAccountId:
        l.kind === "transfer" && l.transferAccountName != null
          ? (byName.get(l.transferAccountName) ?? null)
          : null,
      shareBps: l.shareBps,
      ...(l.payee !== undefined ? { payee: l.payee } : {}),
      ...(l.memo !== undefined ? { memo: l.memo } : {}),
    })),
  }));
}

/**
 * Validate a template draft. Returns null when valid, otherwise a
 * human-readable error for the settings form / API error response.
 */
export function validateSplitTemplate(
  name: string,
  legs: SplitTemplateLeg[]
): string | null {
  if (!name.trim()) return "Template name is required";
  if (legs.length < 2) return "Template must have at least two legs";
  let sum = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    if (!Number.isInteger(leg.shareBps) || leg.shareBps <= 0) {
      return `Leg ${i + 1} must have a positive share`;
    }
    sum += leg.shareBps;
    const hasTransfer = leg.transferAccountId != null;
    // A category leg may leave its category unset ("choose when applying");
    // only a transfer target on a category leg is a conflict.
    if (leg.kind === "category" && hasTransfer) {
      return `Leg ${i + 1} must not have a transfer account`;
    }
    if (leg.kind === "transfer" && !hasTransfer) {
      return `Leg ${i + 1} must have a transfer account`;
    }
    if (leg.kind !== "category" && leg.kind !== "transfer") {
      return `Leg ${i + 1} has an unknown kind`;
    }
  }
  if (sum !== TEMPLATE_TOTAL_BPS) {
    return `Leg shares must add up to 100% (currently ${(sum / 100).toFixed(2)}%)`;
  }
  return null;
}

/**
 * Apply a template's legs to a signed parent total (cents). Returns one
 * amount per leg, in order; the signed amounts sum to `totalCents`
 * exactly. Every leg is rounded to the cent and any penny remainder
 * goes to the largest leg (ties keep the first, matching YNAB4
 * `RegisterGrid.distributeAmountsToSubTransactions`). Throws on an
 * invalid template or a zero total.
 */
export function applySplitTemplate(
  totalCents: number,
  legs: SplitTemplateLeg[]
): AppliedTemplateLeg[] {
  if (!Number.isInteger(totalCents) || totalCents === 0) {
    throw new Error("Amount must be a valid non-zero number");
  }
  const error = validateSplitTemplate("template", legs);
  if (error) throw new Error(error);
  const sign = Math.sign(totalCents);
  const magnitude = Math.abs(totalCents);
  const magnitudes = legs.map((leg) =>
    Math.round((magnitude * leg.shareBps) / TEMPLATE_TOTAL_BPS)
  );
  const leftover = magnitude - magnitudes.reduce((s, a) => s + a, 0);
  if (leftover !== 0) {
    let largest = 0;
    for (let i = 1; i < magnitudes.length; i++) {
      if (Math.abs(magnitudes[i]!) > Math.abs(magnitudes[largest]!)) {
        largest = i;
      }
    }
    magnitudes[largest]! += leftover;
  }
  const out: AppliedTemplateLeg[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const amount = magnitudes[i]!;
    out.push({
      // A set boundary category on a transfer leg passes through; the
      // server nulls it for same-boundary transfers during classification.
      categoryId: leg.categoryId,
      transferAccountId: leg.kind === "transfer" ? leg.transferAccountId : null,
      amount: sign * amount,
      ...(leg.payee !== undefined ? { payee: leg.payee } : {}),
      ...(leg.memo !== undefined ? { memo: leg.memo } : {}),
    });
  }
  return out;
}


