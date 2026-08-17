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
    reorderAccount: vi.fn(async (...args) => {
      calls.push({ method: "reorderAccount", args });
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
    expect(screen.getAllByText(/To Be Budgeted|Overbudgeted/i).length).toBeGreaterThan(0);
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

    fireEvent.change(screen.getByPlaceholderText("e.g. Superstore"), {
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
      amount: -550,
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
    fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
    const heading = screen.getByText(`Delete "${account?.name ?? ""}"?`);
    expect(heading).toBeInTheDocument();
    if (txCount > 0) {
      expect(screen.getByText(new RegExp(`This account has ${txCount} transaction`))).toBeInTheDocument();
    }
    expect(screen.getByText(/permanently remove/i)).toBeInTheDocument();

    // Step 2: cancel must NOT delete.
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(calls.some((c) => c.method === "deleteAccount")).toBe(false);

    // Re-open confirm and accept.
    fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });

    expect(calls.some((c) => c.method === "deleteAccount" && c.args[0] === 1)).toBe(true);
  });

  it("calls api.deleteTransaction from the edit transaction modal after confirmation", async () => {
    const { api, calls } = makeApi();
    const seed = makeSeedBudgetData();
    render(<BudgetApp data={seed} api={api} />);

    // Navigate to All Transactions
    fireEvent.click(screen.getByRole("button", { name: /^accounts/i }));

    // Click on the first transaction row in the register to open edit modal
    const tableRows = screen.getAllByRole("row");
    const firstRow = tableRows[1]!;
    fireEvent.click(firstRow);

    expect(screen.getByText("Edit Transaction")).toBeInTheDocument();

    // Step 1: Click Delete…
    fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
    expect(screen.getByText(/^Delete /)).toBeInTheDocument();

    // Step 2: Confirm deletion
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });

    const deleteCall = calls.find((c) => c.method === "deleteTransaction");
    expect(deleteCall).toBeDefined();
    expect(typeof deleteCall?.args[0]).toBe("number");
    expect(screen.queryByText("Edit Transaction")).not.toBeInTheDocument();
  });

  it("calls api.deleteTransaction when deleting a transfer transaction from edit modal", async () => {
    const { api, calls } = makeApi();
    const seed = makeSeedBudgetData();
    const transferTxn: Transaction = {
      id: 8888,
      accountId: 1,
      transferAccountId: 2,
      categoryId: null,
      date: "2026-06-29",
      payee: "Transfer: Unique Savings",
      memo: "Transfer test",
      amount: "-25000",
      status: "c",
    };
    const dataWithTransfer: BudgetData = {
      ...seed,
      transactions: [transferTxn, ...seed.transactions],
    };
    render(<BudgetApp data={dataWithTransfer} api={api} />);

    // Navigate to All Transactions
    fireEvent.click(screen.getByRole("button", { name: /^accounts/i }));

    // Find and click the transfer transaction row
    const transferCells = screen.getAllByText("Transfer: Unique Savings");
    const row = transferCells[0]!.closest("tr")!;
    fireEvent.click(row);

    expect(screen.getByText("Edit Transaction")).toBeInTheDocument();

    // Click Delete…
    fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
    expect(screen.getByText(/linked transfer/i)).toBeInTheDocument();

    // Confirm deletion
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });

    const deleteCall = calls.find((c) => c.method === "deleteTransaction");
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.args[0]).toBe(8888);
  });

  it("calls api.deleteTransaction when deleting a split transaction from edit modal", async () => {
    const { api, calls } = makeApi();
    const seed = makeSeedBudgetData();
    const splitParent: Transaction = {
      id: 9990,
      accountId: 1,
      categoryId: null,
      date: "2026-06-28",
      payee: "Split Grocery & Home",
      memo: "Split test",
      amount: "-15000",
      status: "c",
    };
    const splitChild1: Transaction = {
      id: 9991,
      parentId: 9990,
      accountId: 1,
      categoryId: 10,
      date: "2026-06-28",
      payee: "Split Grocery & Home",
      memo: "",
      amount: "-10000",
      status: "c",
    };
    const splitChild2: Transaction = {
      id: 9992,
      parentId: 9990,
      accountId: 1,
      categoryId: 11,
      date: "2026-06-28",
      payee: "Split Grocery & Home",
      memo: "",
      amount: "-5000",
      status: "c",
    };
    const dataWithSplit: BudgetData = {
      ...seed,
      transactions: [splitParent, splitChild1, splitChild2, ...seed.transactions],
    };
    render(<BudgetApp data={dataWithSplit} api={api} />);

    // Navigate to All Transactions
    fireEvent.click(screen.getByRole("button", { name: /^accounts/i }));

    const splitCells = screen.getAllByText("Split Grocery & Home");
    const row = splitCells[0]!.closest("tr")!;
    fireEvent.click(row);

    expect(screen.getByText("Edit Transaction")).toBeInTheDocument();

    // Click Delete…
    fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
    expect(screen.getByText(/split transaction/i)).toBeInTheDocument();
    expect(screen.getByText(/also delete all of its 2 sub-transactions/i)).toBeInTheDocument();

    // Confirm deletion
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });

    const deleteCall = calls.find((c) => c.method === "deleteTransaction");
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.args[0]).toBe(9990);
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

  it("calls api.updateAccount with archived: true when archiving an account", async () => {
    const { api, calls } = makeApi();
    const seed = makeSeedBudgetData();
    const account = seed.accounts.find((a) => a.id === 1);
    render(<BudgetApp data={seed} api={api} />);

    const editBtn = screen.getByRole("button", {
      name: `Edit account ${account?.name ?? ""}`,
    });
    fireEvent.click(editBtn);

    fireEvent.click(screen.getByRole("button", { name: /^archive$/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, archive it/i }));
    });

    expect(
      calls.some(
        (c) => c.method === "updateAccount" && c.args[0] === 1 && (c.args[1] as any)?.archived === true
      )
    ).toBe(true);
  });

  it("calls api.updateAccount with archived: false when unarchiving an account", async () => {
    const { api, calls } = makeApi();
    const seed = makeSeedBudgetData();
    const archivedAccount = { ...seed.accounts[0]!, id: 101, name: "Old TD", archived: true };
    const dataWithArchived: BudgetData = {
      ...seed,
      accounts: [...seed.accounts, archivedAccount],
    };
    render(<BudgetApp data={dataWithArchived} api={api} />);

    // Expand archived accounts section
    const archivedHead = screen.getByRole("button", { name: /archived accounts/i });
    fireEvent.click(archivedHead);

    const editBtn = screen.getByRole("button", {
      name: "Edit account Old TD",
    });
    fireEvent.click(editBtn);

    expect(screen.getByText(/edit account \(archived\)/i)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^unarchive$/i }));
    });

    expect(
      calls.some(
        (c) => c.method === "updateAccount" && c.args[0] === 101 && (c.args[1] as any)?.archived === false
      )
    ).toBe(true);
  });
});
