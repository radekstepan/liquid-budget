import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getDefaultDb,
  listAccounts,
  resetAndSeedDatabase,
} from "@ynab/server";
import { monthLabel, todayISO } from "@ynab/logic";
import { generateMetadata } from "../src/app/(app)/[[...slug]]/page";

vi.stubEnv("DATABASE_URL", ":memory:");

function params(slug?: string[]) {
  return { params: Promise.resolve({ slug }) };
}

describe("[[...slug]] generateMetadata", () => {
  beforeEach(async () => {
    await resetAndSeedDatabase(getDefaultDb());
  });

  it("titles a budget month deep-link", async () => {
    const meta = await generateMetadata(params(["budget", "2026-01"]));
    expect(meta.title).toBe("January 2026 Budget - Liquid");
  });

  it("defaults a month-less budget URL to today", async () => {
    const meta = await generateMetadata(params(["budget"]));
    expect(meta.title).toBe(
      `${monthLabel(todayISO().slice(0, 7))} Budget - Liquid`
    );
  });

  it("titles the reports view", async () => {
    const meta = await generateMetadata(params(["reports"]));
    expect(meta.title).toBe("Reports - Liquid");
  });

  it("titles an unfiltered register without an account", async () => {
    const meta = await generateMetadata(params(["transactions"]));
    expect(meta.title).toBe("All Transactions - Liquid");
  });

  it("titles a filtered register with the account name", async () => {
    const accounts = await listAccounts(getDefaultDb());
    const chequing = accounts.find((a) => a.name === "TD Unlimited Chequing");
    expect(chequing).toBeDefined();
    const meta = await generateMetadata(
      params(["transactions", String(chequing!.id)])
    );
    expect(meta.title).toBe("TD Unlimited Chequing Transactions - Liquid");
  });

  it("falls back to a view-level title for an unknown account id", async () => {
    const meta = await generateMetadata(params(["transactions", "999999"]));
    expect(meta.title).toBe("All Transactions - Liquid");
  });

  it("falls back to the budget view for an unknown path", async () => {
    const meta = await generateMetadata(params(["nope"]));
    expect(meta.title).toBe(
      `${monthLabel(todayISO().slice(0, 7))} Budget - Liquid`
    );
  });
});
