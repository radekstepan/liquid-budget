// apps/web/tests/e2e/global-setup.ts
//
// Reset the DB to the seed state once before the suite runs.
//
// Why this is gated on CI:
//
//   apps/web/.env.local points the dev server at the repo-root budget.db.
//   `playwright.config.ts` reuses whatever dev server is already running
//   locally (see `reuseExistingServer`), so a developer who kicks off
//   `yarn e2e` from the VSCode extension or a terminal already has the
//   dev server up. Resetting the DB in that case would silently nuke
//   their working data.
//
//   In CI, Playwright always starts a fresh server (`reuseExistingServer`
//   flips off), so the only thing attached to that DB is the test run
//   itself. Resetting is safe and gives the suite a deterministic
//   baseline.
//
//   The matching CI toggle on the server side lives at
//   `playwright.config.ts:49`.
import { request } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default async function globalSetup() {
  if (!process.env.CI) {
    return;
  }

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
