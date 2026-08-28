import { getDefaultDb, resetAndSeedDatabase } from "@ynab/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/reset
 *
 * Wipes all budget data and immediately re-seeds with the demo dataset atomically.
 * Useful during development to get back to a clean slate.
 *
 * curl -X POST http://localhost:3000/api/reset
 */
export async function POST() {
  const isProd = process.env.NODE_ENV === "production";
  const isResetEnabled = process.env.RESET_ENABLED === "true";

  if (isProd && !isResetEnabled) {
    return Response.json(
      { ok: false, message: "Reset is disabled in production unless RESET_ENABLED=true." },
      { status: 403 }
    );
  }

  try {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
    return Response.json({ ok: true, message: "Database reset and re-seeded." });
  } catch (err) {
    console.error("[reset]", err);
    return Response.json(
      { ok: false, message: String(err) },
      { status: 500 }
    );
  }
}
