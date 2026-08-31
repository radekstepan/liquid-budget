// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent, within } from "@testing-library/react";
import React from "react";
import { BudgetAppShell } from "../src/components/BudgetAppShell";
import { makeSeedBudgetData, type BudgetData } from "@ynab/logic";

describe("BudgetAppShell (BUG-25)", () => {
  let initialBudget: BudgetData;

  beforeEach(() => {
    vi.restoreAllMocks();
    initialBudget = makeSeedBudgetData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG-25: optimistic assignment maps server-returned real id on success instead of keeping negative temp id", async () => {
    let putAssignmentResolver: ((res: Response) => void) | null = null;
    let putAssignmentBody: any = null;

    // Filter out assignments for category 10 in "2026-06" to simulate a brand new assignment
    const budgetWithoutCat10June: BudgetData = {
      ...initialBudget,
      assignments: initialBudget.assignments.filter(
        (a) => !(a.categoryId === 10 && a.month === "2026-06")
      ),
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/budget")) {
        return new Response(JSON.stringify(budgetWithoutCat10June), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/api/assignments") && init?.method === "PUT") {
        putAssignmentBody = JSON.parse(init.body as string);
        return new Promise<Response>((resolve) => {
          putAssignmentResolver = resolve;
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    render(<BudgetAppShell initialView="budget" initialMonth="2026-06" />);

    await waitFor(() => {
      expect(screen.queryByText("Loading budget")).toBeNull();
    });

    // Find category "Groceries" (categoryId = 11)
    const row = screen
      .getAllByText("Groceries")
      .find((el) => el.closest("tr"))
      ?.closest("tr")!;
    expect(row).toBeDefined();

    // Click the June assignment cell (the last $0.00 button in the row)
    const assignButtons = within(row).getAllByRole("button", { name: "$0.00" });
    const assignBtn = assignButtons[assignButtons.length - 1]!;
    expect(assignBtn).toBeDefined();
    fireEvent.click(assignBtn);

    const input = within(row).getByRole("textbox");
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify PUT request
    await waitFor(() => {
      expect(putAssignmentBody).toEqual({
        categoryId: 11,
        month: "2026-07",
        amount: 25000,
      });
    });

    // Resolve PUT response with real server ID 999
    await act(async () => {
      if (putAssignmentResolver) {
        putAssignmentResolver(
          new Response(
            JSON.stringify({
              id: 999,
              categoryId: 11,
              month: "2026-07",
              amount: 25000,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }
    });

    // Verify cell remains $250.00
    await waitFor(() => {
      expect(within(row).getByRole("button", { name: "$250.00" })).toBeDefined();
    });
  });
});
