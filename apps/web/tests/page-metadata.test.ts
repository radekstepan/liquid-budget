import { describe, expect, it, vi } from "vitest";
import { monthLabel, todayISO } from "@ynab/logic";

// Lock in the layering fix: slug-page metadata must never open SQLite.
// The mock throws on import — if generateMetadata (or its import graph)
// touches @ynab/server again, this file fails to load.
vi.mock("@ynab/server", () => {
  throw new Error("@ynab/server must not be imported for page metadata");
});

import { generateMetadata } from "../src/app/(app)/[[...slug]]/page";

function params(slug?: string[]) {
  return { params: Promise.resolve({ slug }) };
}

describe("slug page generateMetadata (P1 layering)", () => {
  it("titles the bare budget URL with the current month, no DB", async () => {
    const meta = await generateMetadata(params(undefined));
    expect(meta.title).toMatch(/Budget - Liquid$/);
  });

  it("titles a month-scoped budget URL", async () => {
    const meta = await generateMetadata(params(["budget", "2026-05"]));
    expect(meta.title).toBe("May 2026 Budget - Liquid");
  });

  it("defaults a month-less budget slug to today", async () => {
    const meta = await generateMetadata(params(["budget"]));
    expect(meta.title).toBe(`${monthLabel(todayISO().slice(0, 7))} Budget - Liquid`);
  });

  it("uses the generic transactions title without resolving the account", async () => {
    const meta = await generateMetadata(params(["transactions", "999999"]));
    expect(meta.title).toBe("All Transactions - Liquid");
  });

  it("titles an unfiltered register generically", async () => {
    const meta = await generateMetadata(params(["transactions"]));
    expect(meta.title).toBe("All Transactions - Liquid");
  });

  it("falls back to the budget view for an unknown path", async () => {
    const meta = await generateMetadata(params(["nope"]));
    expect(meta.title).toBe(`${monthLabel(todayISO().slice(0, 7))} Budget - Liquid`);
  });

  it("titles the reports view", async () => {
    const meta = await generateMetadata(params(["reports"]));
    expect(meta.title).toBe("Reports - Liquid");
  });
});
