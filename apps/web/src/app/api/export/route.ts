import { NextRequest } from "next/server";
import { getDefaultDb, exportYnab4Zip, exportBudgetCsv, exportBudgetJson, exportBudgetSqlite } from "@ynab/server";
import { optionalErrorMessage } from "../errors";
import { mutationGuardResponse } from "../guard";

export const dynamic = "force-dynamic";

// TODO(P2) [logging]: replace console-free error mapping below with logger abstraction +
// apiErrorResponse for consistent client envelopes.

export async function GET(req: NextRequest) {
  // Full-budget dump: sensitive read, same loopback bar as mutations.
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  // BudgetExport.body is string | Uint8Array<ArrayBufferLike>; copying the
  // binary case into a fresh Uint8Array<ArrayBuffer> satisfies BodyInit.
  const toResponseBody = (body: string | Uint8Array): BodyInit =>
    typeof body === "string" ? body : new Uint8Array(body);
  try {
    const format = req.nextUrl?.searchParams?.get("format")?.toLowerCase();
    const db = getDefaultDb();
    const today = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      const out = await exportBudgetJson(db, today);
      return new Response(toResponseBody(out.body), {
        headers: {
          "Content-Type": out.contentType,
          "Content-Disposition": `attachment; filename="${out.filename}"`,
        },
      });
    }

    if (format === "sqlite" || format === "db") {
      const out = await exportBudgetSqlite(db, today);
      return new Response(toResponseBody(out.body), {
        headers: {
          "Content-Type": out.contentType,
          "Content-Disposition": `attachment; filename="${out.filename}"`,
        },
      });
    }

    if (format === "csv") {
      const out = await exportBudgetCsv(db, today);
      return new Response(toResponseBody(out.body), {
        headers: {
          "Content-Type": out.contentType,
          "Content-Disposition": `attachment; filename="${out.filename}"`,
        },
      });
    }

    const buffer = await exportYnab4Zip(db);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="budget-${today}.y4backup"`,
      },
    });
  } catch (err) {
    return Response.json(
      { error: optionalErrorMessage(err) ?? "Failed to export data" },
      { status: 500 }
    );
  }
}
