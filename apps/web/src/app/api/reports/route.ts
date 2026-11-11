import { getDefaultDb, getReportAggregates } from "@ynab/server";
import { apiErrorResponse } from "../errors";
import { ReportAggregatesQuerySchema, formatZodError } from "../schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports?startMonth=YYYY-MM&endMonth=YYYY-MM
 *
 * SQL-aggregated report group-bys (P1 sql-aggregation): O(months x categories)
 * SUM/GROUP BY rows so report screens need not hydrate the full transaction
 * list. Read-only, so no loopback guard — same policy as the other GETs.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const parsed = ReportAggregatesQuerySchema.safeParse({
    startMonth: searchParams.get("startMonth") ?? undefined,
    endMonth: searchParams.get("endMonth") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  try {
    const aggregates = await getReportAggregates(getDefaultDb(), parsed.data);
    return Response.json(aggregates);
  } catch (e) {
    return apiErrorResponse(e);
  }
}
