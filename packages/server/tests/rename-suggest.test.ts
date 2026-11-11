import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "path";
import { fileURLToPath } from "url";
import type { CsvImportRow } from "@ynab/logic";
import { assertSecureLlmBaseUrl, completeChatJson, getLlmConfig, isLlmRenameEnabled, LlmError, type LlmFetch } from "../src/llm.js";
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
      includeMemos: false,
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

  it("opts memo evidence in only via LLM_INCLUDE_MEMOS", () => {
    expect(getLlmConfig({} as NodeJS.ProcessEnv).includeMemos).toBe(false);
    expect(getLlmConfig({ LLM_INCLUDE_MEMOS: "1" } as NodeJS.ProcessEnv).includeMemos).toBe(true);
    expect(getLlmConfig({ LLM_INCLUDE_MEMOS: "true" } as NodeJS.ProcessEnv).includeMemos).toBe(true);
    expect(getLlmConfig({ LLM_INCLUDE_MEMOS: "0" } as NodeJS.ProcessEnv).includeMemos).toBe(false);
  });
});

describe("assertSecureLlmBaseUrl", () => {
  it("allows https anywhere and http on loopback", () => {
    expect(assertSecureLlmBaseUrl("https://api.openai.com/v1")).toBe("api.openai.com");
    expect(assertSecureLlmBaseUrl("http://localhost:11434/v1")).toBe("localhost");
    expect(assertSecureLlmBaseUrl("http://127.0.0.1:11434/v1")).toBe("127.0.0.1");
    expect(assertSecureLlmBaseUrl("http://[::1]:11434/v1")).toBe("::1");
  });

  it("rejects plain http to non-loopback hosts and non-http schemes", () => {
    for (const baseUrl of [
      "http://example.com/v1",
      "http://192.168.1.10:11434/v1",
      "ftp://example.com/v1",
      "not a url",
      "",
    ]) {
      try {
        assertSecureLlmBaseUrl(baseUrl);
        expect.unreachable();
      } catch (e) {
        expect(e).toMatchObject({ name: "LlmError", status: 502 });
      }
    }
  });

  it("refuses the request before any fetch on insecure base URLs", async () => {
    let calls = 0;
    const fetchImpl: LlmFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };
    await expect(
      completeChatJson([{ role: "user", content: "hi" }], {
        env: { LLM_API_KEY: "k", LLM_MODEL: "m", LLM_BASE_URL: "http://example.com/v1" } as NodeJS.ProcessEnv,
        fetchImpl,
      })
    ).rejects.toMatchObject({ name: "LlmError", status: 502 });
    expect(calls).toBe(0);
  });

  it("lets loopback http through to fetch", async () => {
    let seenUrl = "";
    const fetchImpl: LlmFetch = async (url) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }),
        text: async () => "",
      };
    };
    const res = await completeChatJson([{ role: "user", content: "hi" }], {
      env: { LLM_API_KEY: "k", LLM_MODEL: "m", LLM_BASE_URL: "http://localhost:11434/v1" } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(res.content).toBe('{"a":1}');
    expect(seenUrl).toBe("http://localhost:11434/v1/chat/completions");
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
    // Whitespace is significant (YNAB4 parity): the triple-space variant is
    // NOT covered by "AMZN Mktp" and stays a candidate alongside WONKY 123.
    await seedTransaction(db, accountId, { payee: "amzn   mktp" });
    await seedTransaction(db, accountId, { payee: "WONKY 123" });
    await seedTransaction(db, accountId, { payee: "wonky 123" });
    const otherId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "Transfer : Other", transferAccountId: otherId });
    const status = getRenameSuggestStatus(db, enabledEnv);
    expect(status.enabled).toBe(true);
    expect(status.candidates).toEqual([
      { payee: "WONKY 123", count: 2, transactionIds: expect.any(Array), memos: [] },
      { payee: "amzn   mktp", count: 1, transactionIds: expect.any(Array), memos: [] },
    ]);
    expect(status.totalUnique).toBe(2);
  });
});

describe("suggestRenameRules", () => {
  it("sends payee names only — memos stay on the server by default", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await createRenameRule(db, { sourcePattern: "Covered", targetPayee: "Covered cafe" });
    await seedTransaction(db, accountId, { payee: "Covered" });
    await seedTransaction(db, accountId, { payee: "WONKY 123", memo: "downtown store acct 4821" });

    let sentUserPrompt = "";
    let sentBody = "";
    const fetchImpl = stubFetch({
      content: JSON.stringify({ renames: [{ source: "WONKY 123", target: "Wonky" }] }),
      onCall: (_url, body) => {
        sentBody = JSON.stringify(body);
        const messages = body.messages as { role: string; content: string }[];
        sentUserPrompt = messages.find((m) => m.role === "user")?.content ?? "";
      },
    });
    const res = await suggestRenameRules(db, { env: enabledEnv, fetchImpl });
    expect(sentUserPrompt).toContain("WONKY 123");
    expect(sentUserPrompt).not.toContain("downtown store");
    expect(sentUserPrompt).not.toContain("4821");
    expect(sentUserPrompt).not.toContain("Covered");
    // Allowlist: no ids, amounts, dates, or statuses on the wire.
    expect(sentBody).not.toContain("transactionIds");
    // Review evidence still rides the local candidate rows (never sent).
    expect(res.suggestions).toEqual([
      {
        sourcePattern: "WONKY 123",
        targetPayee: "Wonky",
        count: 1,
        memos: ["downtown store acct 4821"],
      },
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.model).toBe("test-model");
    expect(res.candidates).toBe(1);
  });

  it("attaches memo evidence only when LLM_INCLUDE_MEMOS opts in", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "WONKY 123", memo: "downtown store" });

    let sentUserPrompt = "";
    const fetchImpl = stubFetch({
      content: JSON.stringify({ renames: [{ source: "WONKY 123", target: "Wonky" }] }),
      onCall: (_url, body) => {
        const messages = (body as Record<string, unknown>).messages as { role: string; content: string }[];
        sentUserPrompt = messages.find((m) => m.role === "user")?.content ?? "";
      },
    });
    const env = { LLM_API_KEY: "k", LLM_MODEL: "m", LLM_INCLUDE_MEMOS: "1" } as NodeJS.ProcessEnv;
    const res = await suggestRenameRules(db, { env, fetchImpl });
    expect(sentUserPrompt).toContain("WONKY 123");
    expect(sentUserPrompt).toContain("downtown store");
    expect(res.suggestions).toEqual([
      { sourcePattern: "WONKY 123", targetPayee: "Wonky", count: 1, memos: ["downtown store"] },
    ]);
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

  it("audits success with model and candidate count, never key/payee/memo text", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "WONKY 123", memo: "downtown store acct 4821" });
    const entries: unknown[] = [];
    const res = await suggestRenameRules(db, {
      env: enabledEnv,
      fetchImpl: stubFetch({
        content: JSON.stringify({ renames: [{ source: "WONKY 123", target: "Wonky" }] }),
      }),
      onAudit: (entry) => entries.push(entry),
    });
    expect(res.candidates).toBe(1);
    expect(entries).toEqual([
      {
        host: "api.openai.com",
        requestedModel: "test-model",
        servedModel: "test-model",
        candidates: 1,
        ok: true,
      },
    ]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("test-key");
    expect(serialized).not.toContain("WONKY");
    expect(serialized).not.toContain("downtown");
    expect(serialized).not.toContain("4821");
  });

  it("audits the serving model id when a router resolves the slug", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "WONKY 123" });
    const routedEntries: { servedModel?: string; ok: boolean }[] = [];
    await suggestRenameRules(db, {
      env: enabledEnv,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "some/free-model",
          choices: [{ message: { content: JSON.stringify({ renames: [] }) } }],
        }),
        text: async () => "",
      }),
      onAudit: (entry) => routedEntries.push(entry),
    });
    expect(routedEntries).toEqual([
      expect.objectContaining({ servedModel: "some/free-model", ok: true }),
    ]);
  });

  it("audits failures without calling the audit twice and stays PII-free", async () => {
    const db = openMigratedDb();
    const accountId = await seedAccount(db);
    await seedTransaction(db, accountId, { payee: "WONKY 123", memo: "secret memo" });

    // Upstream failure: error detail is the scrubbed LlmError message.
    const upstreamEntries: unknown[] = [];
    await expect(
      suggestRenameRules(db, {
        env: enabledEnv,
        fetchImpl: stubFetch({ ok: false, status: 500 }),
        onAudit: (entry) => upstreamEntries.push(entry),
      })
    ).rejects.toMatchObject({ status: 502 });
    expect(upstreamEntries).toHaveLength(1);
    expect(upstreamEntries[0]).toMatchObject({ candidates: 1, ok: false });
    expect(JSON.stringify(upstreamEntries)).not.toContain("secret memo");

    // Unusable AI output echoes payees, so the audit records a fixed reason.
    const parseEntries: { error?: string }[] = [];
    await expect(
      suggestRenameRules(db, {
        env: enabledEnv,
        fetchImpl: stubFetch({ content: "WONKY 123 is great, no JSON here" }),
        onAudit: (entry) => parseEntries.push(entry),
      })
    ).rejects.toMatchObject({ status: 502 });
    expect(parseEntries).toEqual([
      expect.objectContaining({ ok: false, error: "unusable AI response" }),
    ]);
    expect(JSON.stringify(parseEntries)).not.toContain("WONKY");

    // Insecure base URL: blocked before fetch, audited once.
    let calls = 0;
    const countingFetch: LlmFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };
    const insecureEntries: unknown[] = [];
    await expect(
      suggestRenameRules(db, {
        env: { LLM_API_KEY: "k", LLM_MODEL: "m", LLM_BASE_URL: "http://example.com/v1" } as NodeJS.ProcessEnv,
        fetchImpl: countingFetch,
        onAudit: (entry) => insecureEntries.push(entry),
      })
    ).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(0);
    expect(insecureEntries).toHaveLength(1);
    expect(insecureEntries[0]).toMatchObject({ host: "example.com", ok: false });
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
