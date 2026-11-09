import {
  AccountError,
  CategoryError,
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

function errorCode(e: unknown): unknown {
  const record = asRecord(e);
  if (!record) return undefined;
  const cause = asRecord(record.cause);
  return record.code || cause?.code;
}

export function apiErrorResponse(e: unknown): Response {
  if (
    e instanceof AccountError ||
    e instanceof CategoryError ||
    e instanceof PayeeError ||
    e instanceof RecurringError ||
    e instanceof RenameRuleError ||
    e instanceof TransactionError
  ) {
    return Response.json({ error: e.message }, { status: e.status });
  }

  const msg = e instanceof Error ? e.message : String(e ?? "");
  const code = errorCode(e);

  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY" || msg.includes("FOREIGN KEY constraint failed")) {
    return Response.json(
      { error: "Referenced entity does not exist or foreign key constraint failed" },
      { status: 400 }
    );
  }

  if (code === "SQLITE_CONSTRAINT_UNIQUE" || msg.includes("UNIQUE constraint failed")) {
    return Response.json(
      { error: "A record with these details already exists" },
      { status: 409 }
    );
  }

  if (code === "SQLITE_CONSTRAINT_CHECK" || msg.includes("CHECK constraint failed")) {
    return Response.json(
      { error: "Constraint check failed" },
      { status: 422 }
    );
  }

  const status = errorStatus(e);
  if (status !== undefined && status >= 400 && status < 600) {
    return Response.json({ error: msg || "Request failed" }, { status });
  }

  return Response.json({ error: msg || "Internal server error" }, { status: 500 });
}
