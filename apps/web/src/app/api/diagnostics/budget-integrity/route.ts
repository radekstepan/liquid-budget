import { checkStorageIntegrity, getDefaultDb, verifyBudgetIntegrity } from "@ynab/server";
import { optionalErrorMessage } from "../../errors";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  try {
    const db = getDefaultDb();
    let targetMonth: string | undefined;
    if (request?.url) {
      const url = new URL(request.url);
      targetMonth = url.searchParams.get("month") ?? undefined;
    }
    const report = await verifyBudgetIntegrity(db, targetMonth);
    const storage = await checkStorageIntegrity(db);
    return Response.json({
      ok: report.difference === 0 && storage.ok,
      ...report,
      storage,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: optionalErrorMessage(err) ?? "Failed to verify budget integrity" },
      { status: 500 }
    );
  }
}