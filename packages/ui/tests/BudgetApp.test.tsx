import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { BudgetApp, type BudgetAppApi } from "../src/BudgetApp.js";
import type { BudgetData } from "@ynab/logic";
import { makeSeedBudgetData } from "@ynab/logic";

function makeApi(overrides: Partial<BudgetAppApi> = {}): {
  api: BudgetAppApi;
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const api: BudgetAppApi = {
    reload: vi.fn(async () => {}),
    assign: vi.fn(async (...args) => {
      calls.push({ method: "assign", args });
    }),
    addTransaction: vi.fn(async (...args) => {
      calls.push({ method: "addTransaction", args });
    }),
    updateTransaction: vi.fn(async (...args) => {
      calls.push({ method: "updateTransaction", args });
    }),
    deleteTransaction: vi.fn(async (...args) => {
      calls.push({ method: "deleteTransaction", args });
    }),
    addRecurring: vi.fn(async (...args) => {
      calls.push({ method: "addRecurring", args });
    }),
    updateRecurring: vi.fn(async (...args) => {
      calls.push({ method: "updateRecurring", args });
    }),
    deleteRecurring: vi.fn(async (...args) => {
      calls.push({ method: "deleteRecurring", args });
    }),
    postRecurring: vi.fn(async (...args) => {
      calls.push({ method: "postRecurring", args });
    }),
    saveCategory: vi.fn(async (...args) => {
      calls.push({ method: "saveCategory", args });
    }),
    deleteCategory: vi.fn(async (...args) => {
      calls.push({ method: "deleteCategory", args });
    }),
    saveGroup: vi.fn(async (...args) => {
      calls.push({ method: "saveGroup", args });
    }),
    deleteGroup: vi.fn(async (...args) => {
      calls.push({ method: "deleteGroup", args });
    }),
    addAccount: vi.fn(async (...args) => {
      calls.push({ method: "addAccount", args });
    }),
    deleteAccount: vi.fn(async (...args) => {
      calls.push({ method: "deleteAccount", args });
    }),
    updateAccount: vi.fn(async (...args) => {
      calls.push({ method: "updateAccount", args });
    }),
    resetDemo: vi.fn(async (...args) => {
      calls.push({ method: "resetDemo", args });
    }),
    reorderCategory: vi.fn(async (...args) => {
      calls.push({ method: "reorderCategory", args });
    }),
    reorderGroup: vi.fn(async (...args) => {
      calls.push({ method: "reorderGroup", args });
    }),
    ...overrides,
  };
  return { api, calls };
}

describe("BudgetApp", () => {
  it("renders Sidebar, Inspector, and the default Budget view", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    expect(screen.getByRole("button", { name: /^accounts/i })).toBeInTheDocument();
    expect(screen.getAllByText("To Be Budgeted").length).toBeGreaterThan(0);
    // The single-month budget view has a MonthNav with prev/next buttons
    expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next month/i })).toBeInTheDocument();
  });

  it("switches view when a sidebar nav item is clicked", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /recurring/i }));
    expect(
      screen.getByRole("button", { name: /add recurring/i })
    ).toBeInTheDocument();
  });

  it("opens the Add Transaction modal when triggered from the Transactions view", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /^accounts/i }));
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));
    expect(screen.getAllByText("Add Transaction").length).toBeGreaterThan(0);
  });

  it("calls api.addTransaction with the form values when the modal is saved", async () => {
    const { api, calls } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /^accounts/i }));
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));

    fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
      target: { value: "Coffee" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "-5.50" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    });

    expect(calls.some((c) => c.method === "addTransaction")).toBe(true);
    const call = calls.find((c) => c.method === "addTransaction");
    expect(call?.args[0]).toMatchObject({
      payee: "Coffee",
      amount: -5.5,
    });
  });

  it("opens the Add Account modal from the Sidebar", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /add account/i }));
    expect(screen.getAllByText("Add Account").length).toBeGreaterThan(0);
  });

  it("calls api.deleteAccount from the edit modal after the two-step confirm", async () => {
    const { api, calls } = makeApi();
    const seed = makeSeedBudgetData();
    const account = seed.accounts.find((a) => a.id === 1);
    const txCount = account
      ? seed.transactions.filter((t) => t.accountId === account.id).length
      : 0;
    render(<BudgetApp data={seed} api={api} />);

    // Open the edit modal via the row's edit button (no longer a trash button).
    const editBtn = screen.getByRole("button", {
      name: `Edit account ${account?.name ?? ""}`,
    });
    fireEvent.click(editBtn);

    expect(screen.getByText("Edit Account")).toBeInTheDocument();

    // Step 1: enter the confirm panel.
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    const heading = screen.getByText(`Delete "${account?.name ?? ""}"?`);
    expect(heading).toBeInTheDocument();
    if (txCount > 0) {
      expect(screen.getByText(txCount.toString())).toBeInTheDocument();
    }
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();

    // Step 2: cancel must NOT delete.
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(calls.some((c) => c.method === "deleteAccount")).toBe(false);

    // Re-open confirm and accept.
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });

    expect(calls.some((c) => c.method === "deleteAccount" && c.args[0] === 1)).toBe(true);
  });

  it("does not highlight 'Accounts' when an account is selected", () => {
    const { api } = makeApi();
    const seed = makeSeedBudgetData();
    render(<BudgetApp data={seed} api={api} />);

    // Select the first account row, which navigates the app to the
    // transactions view with an accountFilter set.
    const accountBtns = screen.getAllByRole("button", { name: /td unlimited chequing/i });
    const accountRow = accountBtns.find(
      (b) => b.getAttribute("aria-label") == null
    )!;
    fireEvent.click(accountRow);

    const navAll = screen.getByRole("button", { name: /^accounts/i });
    expect(navAll.className).not.toMatch(/\bis-sel\b/);

    // Toggling the same account again (now in the filtered view) clears
    // the filter and re-highlights "Accounts".
    fireEvent.click(accountRow);
    expect(navAll.className).toMatch(/\bis-sel\b/);
  });

  it("calls api.resetDemo when the menu item is clicked", async () => {
    const { api, calls } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByText("Reset demo data"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, reset it/i }));
    });
    expect(calls.some((c) => c.method === "resetDemo")).toBe(true);
  });
});
