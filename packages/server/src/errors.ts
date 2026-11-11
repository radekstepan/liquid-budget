/**
 * Database constraint errors, translated at the source.
 *
 * Raw SQLite wire errors (`SQLITE_CONSTRAINT_UNIQUE`, ...) must never reach
 * the web layer: `withTransaction` and the handful of non-transactional
 * writes translate them here into domain errors with HTTP statuses, so
 * `apps/web/src/app/api/errors.ts` only ever sees domain errors.
 */

export class ConstraintError extends Error {
  readonly status: 400 | 409 | 422;
  constructor(message: string, status: 400 | 409 | 422 = 409) {
    super(message);
    this.name = "ConstraintError";
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Map a raw SQLite constraint failure to a `ConstraintError` with the same
 * message/status the API previously produced in the web layer. Anything
 * already carrying an HTTP status (domain errors) or not constraint-shaped
 * passes through untouched.
 */
export function translateConstraintError(err: unknown): unknown {
  const record = asRecord(err);
  if (typeof record?.status === "number") return err;
  const cause = asRecord(record?.cause);
  const code = record?.code ?? cause?.code;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || message.includes("UNIQUE constraint failed")) {
    return new ConstraintError("A record with these details already exists", 409);
  }
  if (
    code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
    message.includes("FOREIGN KEY constraint failed")
  ) {
    return new ConstraintError(
      "Referenced entity does not exist or foreign key constraint failed",
      400
    );
  }
  if (code === "SQLITE_CONSTRAINT_CHECK" || message.includes("CHECK constraint failed")) {
    return new ConstraintError("Constraint check failed", 422);
  }
  return err;
}
