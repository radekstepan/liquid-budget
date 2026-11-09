/**
 * UI-safe error text extraction for `catch (err: unknown)` blocks.
 * Preserves the old `err?.message ? String(err.message) : String(err)`
 * convention without widening to `any`.
 */
export function errorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    const message = (e as { message?: unknown }).message;
    if (message) return String(message);
  }
  return String(e);
}
