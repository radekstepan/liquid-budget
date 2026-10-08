import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import type { CsvImportRow } from "@ynab/logic";
import { completeChatJson, getLlmConfig, isLlmRenameEnabled, LlmError, type LlmFetch } from "../src/llm.js";
import { importCsvTransactions } from "../src/import-csv.js";
import { findOrCreatePayee, updatePayee } from "../src/queries/payees.js";
import { reconcileAccount } from "../src/queries/reconcile.js";
import {
  acceptRenameSuggestions,
  getRenameSuggestStatus,
  suggestRenameRules,
} from "../src/queries/rename-suggest.js";
import { createRenameRule } from "../src/queries/rename-rules.js";
import {
  bulkUpdateTransactions,
  createTransaction,
  updateTransaction,
} from "../src/queries/transactions.js";
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

async function seedAccount(db: Db): Promise<number> {
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: "Checking", kind: "liquid", groupLabel: "Budget Accounts", balance: 0, onBudget: true, sort: 0 })
    .returning();
  return account!.id;
}

async function seedTransaction(
  db: Db,
  accountId: number,
  over: Partial<typeof schema.transactions.$inferInsert> & { payee: string }
): Promise<number> {
  const [inserted] = await db
    .insert(schema.transactions)
    .values({
      accountId,
      date: "2026-09-01",
      payee: over.payee,
      memo: "",
      amount: -100,
      status: "c",
      // Test rows stand in for freshly imported transactions.
      needsReview: true,
      ...over,
    })
    .returning();
  return inserted!.id;
}

const enabledEnv = { LLM_API_KEY: "test-key", LLM_MODEL: "test-model" } as NodeJS.ProcessEnv;

function stubFetch(params: {
  content?: unknown;
  ok?: boolean;
  status?: number;
  onCall?: (url: string, body: Record<string, unknown>) => void;
}): LlmFetch {
  return async (url, init) => {
    params.onCall?.(url, JSON.parse(init.body) as Record<string, unknown>);
    return {
      ok: params.ok ?? true,
      status: params.status ?? 200,
      json: async () => ({
        choices: [{ message: { content: params.content ?? "{}" } }],
      }),
      text: async () => "upstream failure",
    };
  };
}

describe("llm config", () => {
  it("is disabled unless both a key and a model are set", () => {
    expect(isLlmRenameEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isLlmRenameEnabled({ LLM_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isLlmRenameEnabled({ LLM_MODEL: "m" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isLlmRenameEnabled({ LLM_API_KEY: "  ", LLM_MODEL: "m" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isLlmRenameEnabled(enabledEnv)).toBe(true);
  });

  it("applies defaults and trims overrides", () => {
    expect(getLlmConfig({} as NodeJS.ProcessEnv)).toMatchObject({
      apiKey: "",
      model: "",
      baseUrl: "https://api.openai.com/v1",
      timeoutMs: 60_000,
      maxPayees: 200,
    });
    const custom = getLlmConfig({
      LLM_API_KEY: "  k  ",
      LLM_MODEL: "m",
      LLM_BASE_URL: "http://localhost:11434/v1/",
      LLM_TIMEOUT_MS: "5000",
      LLM_MAX_PAYEES: "10",
    } as NodeJS.ProcessEnv);
    expect(custom).toMatchObject({
      apiKey: "k",
      baseUrl: "http://localhost:11434/v1",
      timeoutMs: 5000,
      maxPayees: 10,
    });
    const invalid = getLlmConfig({ LLM_TIMEOUT_MS: "nope", LLM_MAX_PAYEES: "-3" } as NodeJS.ProcessEnv);
    expect(invalid.timeoutMs).toBe(60_000);
    expect(invalid.maxPayees).toBe(200);
  });
});

describe("completeChatJson", () => {
  it("posts a JSON-mode chat completion with the bearer key", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: LlmFetch = async (url, init) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization;
      seenBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }), text: async () => "" };
    };
    const res = await completeChatJson([{ role: "user", content: "hi" }], {
      env: enabledEnv,
      fetchImpl,
    });
    expect(res).toEqual({ content: '{"a":1}', model: "test-model" });
    expect(seenUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(seenAuth).toBe("Bearer test-key");
    expect(seenBody).toMatchObject({
      model: "test-model",
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("prefers the serving model id over the configured slug", async () => {
    const routed: LlmFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "some/free-model",
        choices: [{ message: { content: '{"a":1}' } }],
      }),
      text: async () => "",
    });
    const res = await completeChatJson([{ role: "user", content: "hi" }], {
      env: enabledEnv,
      fetchImpl: routed,
    });
    expect(res).toEqual({ content: '{"a":1}', model: "some/free-model" });
  });

  it("names the model and finish reason on empty responses", async () => {
    const empty: LlmFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "some/free-model",
        choices: [{ message: { content: "" }, finish_reason: "length" }],
      }),
      text: async () => "",
    });
    const err = await completeChatJson([{ role: "user", content: "hi" }], {
      env: enabledEnv,
      fetchImpl: empty,
    }).catch((e) => e);
    expect(err).toMatchObject({ name: "LlmError", status: 502 });
    expect(String(err.message)).toContain("some/free-model");
    expect(String(err.message)).toContain("length");
  });

  it("throws 501 when not configured and 502 on upstream failures", async () => {
    await expect(
      completeChatJson([{ role: "user", content: "hi" }], {
        env: {} as NodeJS.ProcessEnv,
        fetchImpl: stubFetch({}),
      })
    ).rejects.toMatchObject({ name: "LlmError", status: 501 });

    await expect(
      completeChatJson([{ role: "user", content: "hi" }], {
        env: enabledEnv,
        fetchImpl: stubFetch({ ok: false, status: 500 }),
      })
    ).rejects.toMatchObject({ name: "LlmError", status: 502 });

    const failing: LlmFetch = async () => {
      throw new Error("boom");
    };
    await expect(
      completeChatJson([{ role: "user", content: "hi" }], { env: enabledEnv, fetchImpl: failing })
    ).rejects.toMatchObject({ name: "LlmError", status: 502 });

    const empty: LlmFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => "",
    });
    await expect(
      completeChatJson([{ role: "user", content: "hi" }], { env: enabledEnv, fetchImpl: empty })
    ).rejects.toMatchObject({ name: "LlmError", status: 502 });
  });
});

describe("getRenameSuggestStatus", () => {
  it("reports enabled:false without env and still lists candidates", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "WONKY 123" });
    const status = getRenameSuggestStatus(db, {} as NodeJS.ProcessEnv);
    expect(status.enabled).toBe(false);
    expect(status.candidates.map((c) => c.payee)).toEqual(["WONKY 123"]);
  });

  it("only lists payees with no matching rule", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await createRenameRule(db, { sourcePattern: "BCF[N]", targetPayee: "BC Ferries" });
    await createRenameRule(db, { sourcePattern: "AMZN Mktp", targetPayee: "Amazon" });
    await seedTransaction(db, accountId, { payee: "BCF1" });
    await seedTransaction(db, accountId, { payee: "amzn   mktp" });
    await seedTransaction(db, accountId, { payee: "WONKY 123" });
    await seedTransaction(db, accountId, { payee: "wonky 123" });
    const otherId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "Transfer : Other", transferAccountId: otherId });
    const status = getRenameSuggestStatus(db, enabledEnv);
    expect(status.enabled).toBe(true);
    expect(status.candidates).toEqual([
      { payee: "WONKY 123", count: 2, transactionIds: expect.any(Array), memos: [] },
    ]);
    expect(status.totalUnique).toBe(1);
  });
});

describe("suggestRenameRules", () => {
  it("sends only uncovered payees and parses the reply", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await createRenameRule(db, { sourcePattern: "Covered", targetPayee: "Covered cafe" });
    await seedTransaction(db, accountId, { payee: "Covered" });
    await seedTransaction(db, accountId, { payee: "WONKY 123", memo: "downtown store" });

    let sentUserPrompt = "";
    const fetchImpl = stubFetch({
      content: JSON.stringify({ renames: [{ source: "WONKY 123", target: "Wonky" }] }),
      onCall: (_url, body) => {
        const messages = body.messages as { role: string; content: string }[];
        sentUserPrompt = messages.find((m) => m.role === "user")?.content ?? "";
      },
    });
    const res = await suggestRenameRules(db, { env: enabledEnv, fetchImpl });
    expect(sentUserPrompt).toContain("WONKY 123");
    expect(sentUserPrompt).toContain("downtown store");
    expect(sentUserPrompt).not.toContain("Covered");
    expect(res.suggestions).toEqual([
      { sourcePattern: "WONKY 123", targetPayee: "Wonky", count: 1 },
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.model).toBe("test-model");
    expect(res.candidates).toBe(1);
  });

  it("pages through candidates with offset/limit", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    for (let i = 0; i < 25; i++) {
      await seedTransaction(db, accountId, { payee: `Store ${String(i).padStart(2, "0")}` });
    }
    const seen: string[] = [];
    const fetchImpl = stubFetch({
      content: JSON.stringify({ renames: [] }),
      onCall: (_url, body) => {
        const messages = body.messages as { role: string; content: string }[];
        seen.push(messages.find((m) => m.role === "user")?.content ?? "");
      },
    });
    const first = await suggestRenameRules(db, {
      env: enabledEnv,
      fetchImpl,
      offset: 0,
      limit: 10,
    });
    expect(first.candidates).toBe(10);
    expect(seen[0]).toContain("Store 00");
    expect(seen[0]).toContain("Store 09");
    expect(seen[0]).not.toContain("Store 10");
    const third = await suggestRenameRules(db, {
      env: enabledEnv,
      fetchImpl,
      offset: 20,
      limit: 10,
    });
    expect(third.candidates).toBe(5);
    expect(seen[1]).toContain("Store 24");
    expect(seen[1]).not.toContain("Store 19");
  });

  it("returns empty without calling the LLM when the page is past the end", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "WONKY 123" });
    let calls = 0;
    const fetchImpl: LlmFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };
    const res = await suggestRenameRules(db, { env: enabledEnv, fetchImpl, offset: 10, limit: 10 });
    expect(res).toMatchObject({ suggestions: [], skipped: [], candidates: 0 });
    expect(calls).toBe(0);
  });

  it("throws 502 when the AI response is unusable", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "WONKY 123" });
    await expect(
      suggestRenameRules(db, {
        env: enabledEnv,
        fetchImpl: stubFetch({ content: "Here are some words, no JSON anywhere" }),
      })
    ).rejects.toMatchObject({ name: "LlmError", status: 502 });
    await expect(
      suggestRenameRules(db, {
        env: enabledEnv,
        fetchImpl: stubFetch({ content: JSON.stringify({ note: "no list here" }) }),
      })
    ).rejects.toMatchObject({ name: "LlmError", status: 502 });
  });

  it("throws 501 when the LLM is not configured", async () => {
    const db = openMigratedDb();
    await expect(
      suggestRenameRules(db, { env: {} as NodeJS.ProcessEnv, fetchImpl: stubFetch({}) })
    ).rejects.toMatchObject({ status: 501 });
  });

  it("returns empty without calling the LLM when nothing is uncovered", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await createRenameRule(db, { sourcePattern: "Covered", targetPayee: "Covered cafe" });
    await seedTransaction(db, accountId, { payee: "Covered" });
    let calls = 0;
    const fetchImpl: LlmFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };
    const res = await suggestRenameRules(db, { env: enabledEnv, fetchImpl });
    expect(res.suggestions).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("needsReview lifecycle", () => {
  const csvRow = (payee: string): CsvImportRow => ({
    rowNumber: 2,
    date: "2026-09-01",
    payee,
    memo: "",
    category: "",
    amountCents: -100,
    error: null,
  });

  it("flags CSV-imported rows but not manually created ones", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await importCsvTransactions(db, { accountId, rows: [csvRow("WONKY 123")] });
    await createTransaction(db, {
      accountId,
      date: "2026-09-02",
      payee: "Manual entry",
      amount: -200,
    });
    const rows = db.select().from(schema.transactions).all();
    expect(rows.find((r) => r.payee === "WONKY 123")?.needsReview).toBe(true);
    expect(rows.find((r) => r.payee === "Manual entry")?.needsReview).toBe(false);
  });

  it("imports land uncleared and approving via the C column clears review", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await importCsvTransactions(db, { accountId, rows: [csvRow("WONKY 123")] });
    const imported = db.select().from(schema.transactions).get();
    expect(imported).toMatchObject({ status: "u", needsReview: true });
    // Approving is a status flip to cleared, like scheduled transactions.
    await updateTransaction(db, imported!.id, { status: "c" });
    const approved = db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, imported!.id))
      .get();
    expect(approved).toMatchObject({ status: "c", needsReview: false });
  });

  it("clears the flag on any single or bulk user edit", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    const single = await seedTransaction(db, accountId, { payee: "WONKY 1" });
    const bulk = await seedTransaction(db, accountId, { payee: "WONKY 2" });
    await updateTransaction(db, single, { memo: "looked at it" });
    await bulkUpdateTransactions(db, [bulk], { memo: "looked at it" });
    const rows = db.select().from(schema.transactions).all();
    expect(rows.find((r) => r.id === single)?.needsReview).toBe(false);
    expect(rows.find((r) => r.id === bulk)?.needsReview).toBe(false);
  });

  it("clears the flag on payee-manager renames and reconciles", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    const payee = findOrCreatePayee(db, "WONKY 1");
    const renamed = await seedTransaction(db, accountId, { payee: "WONKY 1" });
    await updatePayee(db, payee.id, { name: "Wonky One" });
    expect(
      db.select().from(schema.transactions).where(eq(schema.transactions.id, renamed)).get()?.needsReview
    ).toBe(false);

    const reconciled = await seedTransaction(db, accountId, { payee: "WONKY 2" });
    await reconcileAccount(db, {
      accountId,
      // Both seeded rows are cleared for -100 each; matching the working
      // balance exactly avoids posting an adjustment transaction.
      statementBalance: -200,
      statementDate: "2026-09-30",
      adjustmentCategoryId: null,
    });
    expect(
      db.select().from(schema.transactions).where(eq(schema.transactions.id, reconciled)).get()
    ).toMatchObject({ status: "r", needsReview: false });
  });

  it("excludes reviewed history from suggestion candidates", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "WONKY OLD", needsReview: false });
    await seedTransaction(db, accountId, { payee: "WONKY NEW" });
    const status = getRenameSuggestStatus(db, enabledEnv);
    expect(status.candidates.map((c) => c.payee)).toEqual(["WONKY NEW"]);
    expect(status.totalUnique).toBe(1);
  });
});

describe("acceptRenameSuggestions", () => {
  it("learns rules through the standard learner (generalising families)", async () => {
    const db = openMigratedDb();
    const res = await acceptRenameSuggestions(
      db,
      [
        { sourcePattern: "BCF1", targetPayee: "BC Ferries" },
        { sourcePattern: "BCF2", targetPayee: "BC Ferries" },
      ]
    );
    expect(res.generalised).toBe(true);
    expect(res.rules.map((r) => [r.sourcePattern, r.targetPayee])).toEqual([
      ["BCF[N]", "BC Ferries"],
    ]);
    expect(res.applied).toEqual({ updated: 0, skippedLocked: 0 });
  });

  it("backfills stored transactions when asked", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    const id = await seedTransaction(db, accountId, { payee: "WONKY 123" });
    const res = await acceptRenameSuggestions(
      db,
      [{ sourcePattern: "WONKY 123", targetPayee: "Wonky" }],
      { applyToExisting: true }
    );
    expect(res.rules).toHaveLength(1);
    expect(res.applied).toEqual({ updated: 1, skippedLocked: 0 });
    const updated = db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
    expect(updated?.payee).toBe("Wonky");
    // An AI backfill is automatic, not a user review: the renamed row
    // keeps its imported (bold) flag.
    expect(updated?.needsReview).toBe(true);
  });

  it("leaves stored transactions alone without the apply flag", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    const id = await seedTransaction(db, accountId, { payee: "WONKY 123" });
    const res = await acceptRenameSuggestions(db, [
      { sourcePattern: "WONKY 123", targetPayee: "Wonky" },
    ]);
    expect(res.rules).toHaveLength(1);
    const untouched = db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
    expect(untouched?.payee).toBe("WONKY 123");
  });

  it("throws LlmError with a status the API error mapper understands", () => {
    const err = new LlmError("nope", 501);
    expect(err.status).toBe(501);
    expect(err.message).toBe("nope");
  });
});
