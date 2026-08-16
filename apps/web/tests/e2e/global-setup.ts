// apps/web/tests/e2e/global-setup.ts
//
// Reset the DB to the seed state once before the suite runs.
//
// Why unconditionally:
//
//   apps/web/.env.local points the dev server at the repo-root budget.db.
//   The suite mutates that shared DB (accounts, categories, transactions,
//   recurrings, assignments) and import.spec.ts replaces it wholesale, so
//   leftover state between runs is the norm rather than the exception.
//   Starting from the demo seed makes every run — local or CI —
//   deterministic and keeps seed-assumption tests (e.g. reconcile.spec)
//   green on repeat runs. The dev DB is the demo dataset anyway; the
//   trade-off of re-seeding it is negligible next to the suite's own
//   writes.
//
//   (Historically this was gated on CI so a developer's locally-running
//   dev server was never reset out from under them — but that left local
//   runs starting from whatever the previous run left behind.)
import { request } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.post("/api/reset");
    if (!res.ok()) {
      throw new Error(`/api/reset failed: ${res.status()} ${await res.text()}`);
    }
  } finally {
    await ctx.dispose();
  }
}
