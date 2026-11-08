/**
 * REPRO ONLY — AI rename-suggest failure modes with no clean contract.
 *
 * Our side (`packages/server/src/llm.ts`, `completeChatJson`):
 * - Timeout is signal-only (`llm.ts:165-193`): an `AbortController`
 *   asks the transport to stop, but nothing bounds the call's own
 *   wall-clock duration. A provider/transport that never settles (and
 *   ignores the abort signal) leaves the `await` pending forever — the
 *   request hangs instead of failing with the documented 504.
 * - Non-OK responses collapse to one generic message (`llm.ts:194-201`):
 *   `The AI service returned an error (HTTP <status>)...`. For 401/403
 *   — which almost always mean a bad key or a key without access — the
 *   user gets no actionable signal (contrast the 501 path, which tells
 *   the user exactly which env vars to set). Nothing is persisted on
 *   these paths (the suggest flow is pure), so only the message is
 *   pinned below.
 *
 * Verified GREEN (handled today, not pinned): cooperative-timeout 504,
 * empty-response 502, `json()`-rejection 502, 5xx/429 upstream 502,
 * unusable-AI-response 502 via `parseRenameSuggestions`, and
 * nothing-persisted on every suggest-path failure.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import { completeChatJson, type LlmFetch } from "../src/llm.js";
import { suggestRenameRules } from "../src/queries/rename-suggest.js";
import * as schema from "../src/schema.js";
import type { Db } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../src/migrations");

function openMigratedDb(): Db {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

const enabledEnv = { LLM_API_KEY: "test-key", LLM_MODEL: "test-model" } as NodeJS.ProcessEnv;

async function seedUncoveredPayee(db: Db): Promise<void> {
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: "Checking", kind: "liquid", groupLabel: "Budget Accounts", balance: 0, onBudget: true, sort: 0 })
    .returning();
  // `needsReview: true` marks freshly imported rows — only those are
  // suggestion candidates (reviewed history is excluded).
  await db.insert(schema.transactions).values({
    accountId: account!.id,
    date: "2026-09-01",
    payee: "WONKY 123",
    memo: "",
    amount: -100,
    status: "c",
    needsReview: true,
  });
}

function countPersisted(db: Db): Record<string, number> {
  const count = (table: string) =>
    (db.$client.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  return {
    rename_rules: count("rename_rules"),
    transactions: count("transactions"),
    payees: count("payees"),
  };
}

/**
 * The app's own wording: everything before the echoed provider body
 * (`"<base>: <body>."`). Assertions target this prefix so a verbose
 * provider body can't satisfy them by accident.
 */
function appWording(message: string): string {
  const i = message.indexOf(": ");
  return i === -1 ? message : message.slice(0, i);
}

describe("repro: AI rename-suggest failure modes", () => {
  it("a hanging provider does not hang the request forever", { timeout: 5000 }, async () => {
    // Transport that never settles and ignores the abort signal (stalled
    // socket / uncooperative proxy): the configured deadline must still
    // bound the call.
    const never: LlmFetch = () => new Promise(() => {});
    const start = Date.now();
    const err = await completeChatJson([{ role: "user", content: "hi" }], {
      env: enabledEnv,
      fetchImpl: never,
      timeoutMs: 50,
    }).then(
      () => null,
      (e) => e
    );
    // FAILS today: the await above never settles (this test dies at the
    // 5s vitest timeout) instead of failing fast with LlmError 504.
    expect(err).toMatchObject({ name: "LlmError", status: 504 });
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("an invalid API key (401) produces an actionable error and persists nothing", async () => {
    const db = openMigratedDb();
    await seedUncoveredPayee(db);
    const before = countPersisted(db);
    const invalidKey: LlmFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "Unauthorized",
    });
    const err = await suggestRenameRules(db, { env: enabledEnv, fetchImpl: invalidKey }).then(
      () => null,
      (e) => e
    );
    expect(err).toMatchObject({ name: "LlmError" });
    // FAILS today: the app wording is a generic upstream error
    // ("The AI service returned an error (HTTP 401)") that never names
    // the API key as the problem.
    expect(appWording(String((err as Error).message))).toMatch(/api key/i);
    expect(countPersisted(db)).toEqual(before);
  });

  it("a forbidden key (403) produces an actionable error and persists nothing", async () => {
    const db = openMigratedDb();
    await seedUncoveredPayee(db);
    const before = countPersisted(db);
    const forbidden: LlmFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => "Forbidden",
    });
    const err = await suggestRenameRules(db, { env: enabledEnv, fetchImpl: forbidden }).then(
      () => null,
      (e) => e
    );
    expect(err).toMatchObject({ name: "LlmError" });
    // FAILS today: same generic wording as 401 — no hint that the key
    // lacks access / quota.
    expect(appWording(String((err as Error).message))).toMatch(/api key|permission|quota|access/i);
    expect(countPersisted(db)).toEqual(before);
  });
});
