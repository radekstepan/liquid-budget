import {
  AccountError,
  CategoryError,
  ConstraintError,
  PayeeError,
  RecurringError,
  RenameRuleError,
  TransactionError,
} from "@ynab/server";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Human-readable message from an `Error` or an error-shaped object. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const record = asRecord(e);
  return typeof record?.message === "string" ? record.message : String(e ?? "");
}

/** Like `errorMessage`, but preserves the absent-vs-empty distinction. */
export function optionalErrorMessage(e: unknown): string | undefined {
  if (e instanceof Error) return e.message;
  const record = asRecord(e);
  return typeof record?.message === "string" ? record.message : undefined;
}

/** Numeric `status` carried by domain/API errors, when present. */
export function errorStatus(e: unknown): number | undefined {
  const record = asRecord(e);
  return typeof record?.status === "number" ? record.status : undefined;
}

export function apiErrorResponse(e: unknown): Response {
  // SQLite wire errors never reach this layer: packages/server translates
  // SQLITE_CONSTRAINT_* at the source (withTransaction + the handful of
  // non-transactional writes) into ConstraintError/domain errors. The status
  // branch below renders them; anything without a status is a 500.
  if (
    e instanceof AccountError ||
    e instanceof CategoryError ||
    e instanceof ConstraintError ||
    e instanceof PayeeError ||
    e instanceof RecurringError ||
    e instanceof RenameRuleError ||
    e instanceof TransactionError
  ) {
    return Response.json({ error: e.message }, { status: e.status });
  }

  const msg = e instanceof Error ? e.message : String(e ?? "");

  const status = errorStatus(e);
  if (status !== undefined && status >= 400 && status < 600) {
    return Response.json({ error: msg || "Request failed" }, { status });
  }

  // Unknown errors: return a generic message so raw sqlite/stack/PII details
  // never leak to the client. Log server-side via @/lib/logger
  // (createScopedLogger + toLogDetails) instead.
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
