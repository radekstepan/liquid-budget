import { getDefaultDb, searchGlobal } from "@ynab/server";
import { apiErrorResponse } from "../errors";
import { SearchQuerySchema, formatZodError } from "../schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?query=&payee=&categoryId=&accountId=&scopeAccountId=&searchAll=&limit=&before=
 *
 * Ranked server-side search (P1 search-perf): pushes GlobalSearch matching
 * into SQLite (SELECT ... WHERE ... LIMIT, same rank-then-date order as the
 * client index) so large budgets fetch O(limit) rows instead of hydrating
 * the full transaction list. Read-only, so no loopback guard — same policy
 * as the other GET endpoints.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const parsed = SearchQuerySchema.safeParse({
    query: searchParams.get("query") ?? undefined,
    payee: searchParams.get("payee") ?? undefined,
    categoryId: searchParams.get("categoryId") ?? undefined,
    accountId: searchParams.get("accountId") ?? undefined,
    scopeAccountId: searchParams.get("scopeAccountId") ?? undefined,
    searchAll: searchParams.get("searchAll") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
    before: searchParams.get("before") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  try {
    const result = await searchGlobal(getDefaultDb(), {
      query: parsed.data.query,
      payee: parsed.data.payee,
      categoryId: parsed.data.categoryId,
      accountId: parsed.data.accountId,
      scopeAccountId: parsed.data.scopeAccountId,
      searchAll: parsed.data.searchAll,
      limit: parsed.data.limit,
      before: parsed.data.before,
    });
    return Response.json(result);
  } catch (e) {
    return apiErrorResponse(e);
  }
}
