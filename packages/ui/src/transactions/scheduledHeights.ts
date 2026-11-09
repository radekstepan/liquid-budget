// Resizable scheduled-drawer heights, remembered per account.

export const SCHEDULED_HEIGHT_STORAGE_KEY = "ynab:transactions:scheduledHeight";
export const MIN_SCHEDULED_HEIGHT = 120;
const MAX_SCHEDULED_HEIGHT = 720;

export function isScheduledHeights(v: unknown): v is Record<string, number> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every(
      (x) =>
        typeof x === "number" &&
        Number.isFinite(x) &&
        x >= MIN_SCHEDULED_HEIGHT &&
        x <= MAX_SCHEDULED_HEIGHT
    )
  );
}

export const clampScheduledHeight = (h: number) =>
  Math.min(MAX_SCHEDULED_HEIGHT, Math.max(MIN_SCHEDULED_HEIGHT, Math.round(h)));
