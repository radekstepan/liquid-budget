import {
  AccountError,
  CategoryError,
  PayeeError,
  RecurringError,
  RenameRuleError,
  TransactionError,
} from "@ynab/server";

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
  const code = (e as any)?.code || (e as any)?.cause?.code;

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

  if (typeof e === "object" && e !== null && "status" in e && typeof (e as any).status === "number") {
    const status = (e as any).status;
    if (status >= 400 && status < 600) {
      return Response.json({ error: msg || "Request failed" }, { status });
    }
  }

  return Response.json({ error: msg || "Internal server error" }, { status: 500 });
}
