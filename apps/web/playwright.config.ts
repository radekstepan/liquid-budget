// apps/web/playwright.config.ts
//
// Playwright config for the YNAB4-alternative web app. Mirrors the
// shape of packages/ui/playwright.config.ts in the sibling
// `therascript` repo (one config inside the app that runs the dev
// server, chromium-only project, CI-aware retries/workers/reporter).
//
// Notable adaptations for Next.js (vs. therascript's webpack):
//   - Port 3000, the Next.js default. Next.js 16 refuses to start a
//     second dev server in the same workspace, so we always reuse
//     whatever `next dev` the developer (or the Playwright VSCode
//     extension) already started. CI starts a fresh server because
//     reuseExistingServer flips off in CI.
//   - Healthcheck targets `/api/health` — it's a real route, returns
//     `{ ok: true }` once the API has compiled, and avoids the SPA-
//     shell race that the static `index.html` check in therascript
//     was designed around.
//   - E2E_TESTING=true is passed through so the app can later opt
//     into MSW-style mocking via a DefinePlugin-style env. Today
//     nothing reads it; it's the same seam therascript uses.
//
// DB: the running dev server is responsible for the DB it points at
// (apps/web/.env.local → ../../budget.db). Read-only specs work against
// any seeded state. Mutating specs rely on `tests/e2e/global-setup.ts`
// to POST /api/reset before the suite; that setup is gated on CI so a
// developer's locally-running dev server is never reset out from under
// them.
import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `E2E_TESTING=true yarn dev --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    // Locally we want the Playwright VSCode extension to reuse the
    // dev server the developer started in a terminal (via `yarn dev`),
    // so the extension's auto-spawn race doesn't drop the spec. CI
    // always wants a fresh server with a clean state.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
