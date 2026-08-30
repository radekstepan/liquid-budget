// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData, type BudgetData } from "@ynab/logic";

let capturedProps: { data: BudgetData; api: any } | null = null;

vi.mock("@ynab/ui", async () => {
  const actual = await vi.importActual<any>("@ynab/ui");
  return {
    ...actual,
    BudgetApp: (props: any) => {
      capturedProps = props;
      return <div data-testid="budget-app" />;
    },
  };
});

describe("BudgetAppShell (BUG-07)", () => {
  let initialBudget: BudgetData;

  beforeEach(() => {
    vi.restoreAllMocks();
    capturedProps = null;
    initialBudget = makeSeedBudgetData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG-07: optimistic updateAccount synchronizes onBudget: false when changing account kind to offbudget", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/accounts") && init?.method === "PATCH") {
        return new Promise<Response>(() => {}); // Keep in-flight to inspect optimistic state
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="budget" />);

    await waitFor(() => {
      expect(capturedProps).not.toBeNull();
    });

    const account1 = capturedProps!.data.accounts.find((a) => a.id === 1)!;
    expect(account1.kind).toBe("liquid");
    expect(account1.onBudget).toBe(true);

    // Call updateAccount to change kind to offbudget without explicitly passing onBudget
    await act(async () => {
      capturedProps!.api.updateAccount(1, {
        name: "TD Investments",
        kind: "offbudget",
      });
    });

    // In optimistic state:
    const updatedAccount1 = capturedProps!.data.accounts.find((a) => a.id === 1)!;
    expect(updatedAccount1.name).toBe("TD Investments");
    expect(updatedAccount1.kind).toBe("offbudget");
    expect(updatedAccount1.onBudget).toBe(false);
  });

  it("BUG-07: optimistic updateAccount synchronizes onBudget: true when changing offbudget account to liquid/credit", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(initialBudget), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/accounts") && init?.method === "PATCH") {
        return new Promise<Response>(() => {}); // Keep in-flight to inspect optimistic state
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="budget" />);

    await waitFor(() => {
      expect(capturedProps).not.toBeNull();
    });

    // Account 11 in seed is "Wealthsimple Trade" (kind: "offbudget", onBudget: false)
    const account11 = capturedProps!.data.accounts.find((a) => a.id === 11)!;
    expect(account11.kind).toBe("offbudget");
    expect(account11.onBudget).toBe(false);

    // Call updateAccount to change kind to liquid
    await act(async () => {
      capturedProps!.api.updateAccount(11, {
        name: "Wealthsimple Cash",
        kind: "liquid",
      });
    });

    // In optimistic state:
    const updatedAccount11 = capturedProps!.data.accounts.find((a) => a.id === 11)!;
    expect(updatedAccount11.name).toBe("Wealthsimple Cash");
    expect(updatedAccount11.kind).toBe("liquid");
    expect(updatedAccount11.onBudget).toBe(true);
  });
});
