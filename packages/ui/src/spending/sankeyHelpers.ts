import { STILL_HELD_GROUP_LABEL } from "@ynab/logic";
import { SANKEY_AUTOFIT_SESSION_KEY } from "./sankeyConstants.js";

export function truncateName(name: string, max = 26): string {
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

// True when a right-column row is a still-held account row: every cell
// arriving at it routes through the Still-held pseudo-group. Held cells
// route ONLY through it — and a kept held row's group can never have
// merged away (the group value always covers its cells), so this is exact
// for kept rows. Callers exclude merged buckets first: a bucket is a
// generic render-only row even when every folded row was held.
export function isHeldTarget(
  incomingGroupIndices: readonly number[],
  groupNameOf: (groupIndex: number) => string | undefined
): boolean {
  return (
    incomingGroupIndices.length > 0 &&
    incomingGroupIndices.every((g) => groupNameOf(g) === STILL_HELD_GROUP_LABEL)
  );
}

export function sankeyAutoFitDone(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(SANKEY_AUTOFIT_SESSION_KEY) != null
    );
  } catch {
    return false;
  }
}

export function markSankeyAutoFitDone(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SANKEY_AUTOFIT_SESSION_KEY, "1");
  } catch {
    // Private browsing / unavailable storage: auto-fit degrades to once per mount.
  }
}
