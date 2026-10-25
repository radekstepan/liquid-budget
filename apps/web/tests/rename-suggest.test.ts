import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  autoPostDueRecurringTransactions,
  createRenameRule,
  getDefaultDb,
  resetAndSeedDatabase,
  transactions,
} from "@ynab/server";
import { GET, POST } from "../src/app/api/rename-rules/suggest/route";

vi.stubEnv("DATABASE_URL", ":memory:");

describe("Rename suggest API routes", () => {
  beforeEach(async () => {
    const db = getDefaultDb();
    await resetAndSeedDatabase(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv("DATABASE_URL", ":memory:");
  });

  async function seedWonky(db: ReturnType<typeof getDefaultDb>, payee: string, memo = "") {
    // Direct insert mirroring a CSV import row: flagged as needing
    // review, bypassing import-time rename/duplicate handling so the
    // stored payee stays exactly as given.
    const accounts = await db.query.accounts.findMany();
    await db.insert(transactions).values({
      accountId: accounts[0]!.id,
      date: "2026-09-01",
      payee,
      memo,
      amount: -100,
      status: "c",
      needsReview: true,
    });
  }

  it("GET reports disabled without LLM env but still lists candidates", async () => {
    const db = getDefaultDb();
    await seedWonky(db, "WONKY SMOKE 123");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(Array.isArray(body.candidates)).toBe(true);
    // Only the flagged import stands in: seeded history needs no review.
    expect(body.totalUnique).toBe(1);
    expect(body.candidates.some((c: any) => c.payee === "WONKY SMOKE 123")).toBe(true);
  });

  it("POST suggest returns 501 when the LLM is not configured", async () => {
    const req = new NextRequest("http://localhost:3000/api/rename-rules/suggest", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("POST suggest returns 502 when the AI response is unusable", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_MODEL", "test-model");
    const db = getDefaultDb();
    await seedWonky(db, "WONKY SMOKE 777");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "not json at all" } }],
        }),
        text: async () => "",
      }))
    );
    const req = new NextRequest("http://localhost:3000/api/rename-rules/suggest", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("not valid JSON");
  });

  it("POST suggest sends only uncovered payees to the LLM", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_MODEL", "test-model");
    vi.stubEnv("LLM_MAX_PAYEES", "1000");
    const db = getDefaultDb();
    await createRenameRule(db, { sourcePattern: "COVERED SMOKE 1", targetPayee: "Covered" });
    await seedWonky(db, "COVERED SMOKE 1");
    await seedWonky(db, "WONKY SMOKE 999", "downtown store");

    let sentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        sentBody = init.body;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    renames: [{ source: "WONKY SMOKE 999", target: "Wonky Smoke" }],
                  }),
                },
              },
            ],
          }),
          text: async () => "",
        };
      })
    );

    const req = new NextRequest("http://localhost:3000/api/rename-rules/suggest", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toEqual([
      {
        sourcePattern: "WONKY SMOKE 999",
        targetPayee: "Wonky Smoke",
        count: 1,
        memos: ["downtown store"],
      },
    ]);
    // The covered payee never leaves the server; the uncovered one does,
    // with its memo as disambiguation context.
    expect(sentBody).toContain("WONKY SMOKE 999");
    expect(sentBody).toContain("downtown store");
    expect(sentBody).not.toContain("COVERED SMOKE 1");
  });

  it("POST suggest pages through candidates with offset/limit", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_MODEL", "test-model");
    const db = getDefaultDb();
    await seedWonky(db, "AAA WONKY");
    await seedWonky(db, "ZZZ WONKY");

    let sentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        sentBody = init.body;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    renames: [{ source: "ZZZ WONKY", target: "Zed Wonky" }],
                  }),
                },
              },
            ],
          }),
          text: async () => "",
        };
      })
    );

    const req = new NextRequest("http://localhost:3000/api/rename-rules/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset: 1, limit: 10 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.suggestions).toEqual([
      { sourcePattern: "ZZZ WONKY", targetPayee: "Zed Wonky", count: 1 },
    ]);
    expect(sentBody).toContain("ZZZ WONKY");
    expect(sentBody).not.toContain("AAA WONKY");
  });

  it("POST suggest rejects invalid batch bodies", async () => {
    const badJson = new NextRequest("http://localhost:3000/api/rename-rules/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    expect((await POST(badJson)).status).toBe(400);

    const badOffset = new NextRequest("http://localhost:3000/api/rename-rules/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset: -1 }),
    });
    const res = await POST(badOffset);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("offset");
  });

  it("POST ?action=accept creates rules and backfills when asked", async () => {
    const db = getDefaultDb();
    await seedWonky(db, "WONKY SMOKE 456");
    const req = new NextRequest("http://localhost:3000/api/rename-rules/suggest?action=accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        suggestions: [{ sourcePattern: "WONKY SMOKE 456", targetPayee: "Wonky Smoke" }],
        applyToExisting: true,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules.some((r: any) => r.targetPayee === "Wonky Smoke")).toBe(true);
    expect(body.applied.updated).toBe(1);

    // The accepted payee is now covered, so it drops out of candidates.
    const status = await GET();
    const statusBody = await status.json();
    expect(
      statusBody.candidates.some((c: any) => c.payee === "WONKY SMOKE 456")
    ).toBe(false);
    // The backfilled row keeps its imported flag (stays bold) yet is not
    // re-suggested: it already sits at the rule's target name.
    expect(
      statusBody.candidates.some((c: any) => c.payee === "Wonky Smoke")
    ).toBe(false);
    expect(statusBody.totalUnique).toBe(0);
  });

  it("GET status grows when auto-post materializes overdue scheduled rows", async () => {
    // Posted scheduled rows enter needsReview (like imports), so they join
    // the rename-candidate pool. The app auto-posts on every page load, so
    // the e2e "Suggest with AI" count includes ambient scheduled payees on
    // top of freshly imported ones — never assert it as import-only.
    // Deterministic via an explicit as-of date (not the wall clock).
    const db = getDefaultDb();
    await seedWonky(db, "WONKY SMOKE A");
    await seedWonky(db, "WONKY SMOKE B");
    await seedWonky(db, "WONKY SMOKE C");
    expect((await (await GET()).json()).totalUnique).toBe(3);

    await autoPostDueRecurringTransactions(db, "2026-10-25");
    const after = await (await GET()).json();
    // Six distinct scheduled payees are due by 2026-10-25: the transfer
    // template and the future yearly one stay out of the pool.
    expect(after.totalUnique).toBe(9);
    for (const p of [
      "TD Bank",
      "Mountain's Edge MSP",
      "Telus",
      "Fido",
      "Fortis BC",
      "SAP Concur",
    ]) {
      expect(after.candidates.some((c: any) => c.payee === p)).toBe(true);
    }
  });

  it("POST ?action=accept validates its body and rejects unknown actions", async () => {
    const bad = new NextRequest("http://localhost:3000/api/rename-rules/suggest?action=accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestions: [] }),
    });
    expect((await POST(bad)).status).toBe(400);

    const unknown = new NextRequest("http://localhost:3000/api/rename-rules/suggest?action=nope", {
      method: "POST",
    });
    expect((await POST(unknown)).status).toBe(400);
  });
});
