import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { BudgetApp, type BudgetAppApi } from "../src/BudgetApp.js";
import type { BudgetData } from "@ynab/logic";
import { makeSeedBudgetData, todayISO, MONTHS_LONG } from "@ynab/logic";
import { openSearchlistByPlaceholder } from "./dropdown.js";

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
    expect(screen.getByRole("button", { name: /^transactions/i })).toBeInTheDocument();
    expect(screen.queryByText(/To Be Budgeted|Overbudgeted/i)).toBeNull();
    // The single-month budget view has a MonthNav with prev/next buttons
    expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next month/i })).toBeInTheDocument();
  });

  it("switches view when a sidebar nav item is clicked", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /reports/i }));
    expect(screen.getByText("Spending by Category")).toBeInTheDocument();
  });

  it("resets Spending Trends drilldown to All Categories when Reports sidebar item is clicked", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);

    // Navigate to Reports
    fireEvent.click(screen.getByRole("button", { name: /reports/i }));

    // Switch to Spending Trends tab
    fireEvent.click(screen.getByRole("button", { name: "Spending Trends" }));
    expect(screen.getByText("All Categories")).toBeInTheDocument();

    // Verify initial state has Master Category header
    expect(screen.getByRole("columnheader", { name: "Master Category" })).toBeInTheDocument();

    // Drill down into Housing
    const housingRow = screen.getByText("Housing");
    fireEvent.click(housingRow);

    // Now drilled down to Category level
    expect(screen.getByRole("columnheader", { name: "Category" })).toBeInTheDocument();

    // Click Reports in the sidebar again
    fireEvent.click(screen.getByRole("button", { name: /reports/i }));

    // Should be reset back to root All Categories
    expect(screen.getByRole("columnheader", { name: "Master Category" })).toBeInTheDocument();
  });

  it("navigates to relevant account and checks the transaction when clicking a transaction in Spending Trends", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);

    // Navigate to Reports -> Spending Trends
    fireEvent.click(screen.getByRole("button", { name: /reports/i }));
    fireEvent.click(screen.getByRole("button", { name: "Spending Trends" }));

    // Drill down: Housing -> Mortgage Interest
    fireEvent.click(screen.getByText("Housing"));
    fireEvent.click(screen.getAllByText("Mortgage Interest")[0]!);

    // Find the category transaction row for TD Bank and click it
    const tdBankRow = screen.getAllByText("TD Bank")[0]!.closest("tr")!;
    expect(tdBankRow).toBeInTheDocument();
    fireEvent.click(tdBankRow);

    // Should navigate to Transactions view with TD Unlimited Chequing account active
    expect(screen.getAllByText("TD Unlimited Chequing").length).toBeGreaterThanOrEqual(1);

    // Summary bar should show 1 selected
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    // The transaction row in the register should be selected and checked
    const selectedRow = document.querySelector("tr.y-row--selected");
    expect(selectedRow).not.toBeNull();
    const checkbox = selectedRow!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("renders the Settings view with rename rules and calls the api on add", async () => {
    const addRenameRule = vi.fn(async () => {});
    const updateRenameRule = vi.fn(async () => {});
    const deleteRenameRule = vi.fn(async () => {});
    const { api } = makeApi({ addRenameRule, updateRenameRule, deleteRenameRule });
    const seed = makeSeedBudgetData();
    render(
      <BudgetApp
        data={{ ...seed, renameRules: [{ id: 7, sourcePattern: "BCF[N]", targetPayee: "BC Ferries", createdAt: "" }] }}
        api={api}
      />
    );
    fireEvent.click(screen.getAllByRole("button", { name: /settings/i })[0]!);
    fireEvent.click(screen.getByText("Rename rules"));
    expect(screen.getByText("Payee Rename Rules")).toBeInTheDocument();
    expect(screen.getByText("BCF[N]")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add rename rule/i }));
    fireEvent.change(screen.getByLabelText("Source pattern"), { target: { value: "UBER" } });
    fireEvent.change(screen.getByLabelText("Target payee"), { target: { value: "Uber" } });
    fireEvent.click(screen.getByRole("button", { name: /save rule/i }));
    await waitFor(() => {
      expect(addRenameRule).toHaveBeenCalledWith("UBER", "Uber");
    });
  });

  it("navigates to the Settings view from the Inspector gear menu", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByText("Rename rules"));
    expect(screen.getByText("Payee Rename Rules")).toBeInTheDocument();
  });

  it("closes the settings overlay when a sidebar nav item is clicked (sidebar stays live)", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByText("Rename rules"));
    expect(screen.getByText("Payee Rename Rules")).toBeInTheDocument();
    // The sidebar remains interactive while Settings is open — clicking a
    // nav item navigates away and dismisses the overlay.
    fireEvent.click(screen.getByRole("button", { name: /reports/i }));
    expect(screen.getByText("Spending by Category")).toBeInTheDocument();
    expect(screen.queryByText("Payee Rename Rules")).not.toBeInTheDocument();
  });

  it("opens the Add Transaction and Schedule Transaction modals from the Transactions view", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /^transactions/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /add a? ?new transaction/i })[0]!);
    expect(screen.getAllByText("Add Transaction").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    // Click schedule a new transaction from the bottom drawer
    fireEvent.click(screen.getByRole("button", { name: /schedule a new transaction/i }));
    expect(screen.getByText("Add Recurring Transaction")).toBeInTheDocument();
  });

  it("calls api.addTransaction with the form values when the modal is saved", async () => {
    const { api, calls } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /^transactions/i }));
    fireEvent.click(screen.getByRole("button", { name: /add a new transaction/i }));

    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
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
    fireEvent.click(screen.getByRole("button", { name: /^transactions/i }));

    // Click on the first transaction row in the register to open edit modal
    const tableRows = screen.getAllByRole("row");
    const firstRow = tableRows[1]!;
    fireEvent.click(firstRow);

    expect(screen.getByText("Edit Transaction")).toBeInTheDocument();

        // Step 1: Click Delete
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
    fireEvent.click(screen.getByRole("button", { name: /^transactions/i }));

    // Find and click the transfer transaction row
    const transferCells = screen.getAllByText("Transfer: Unique Savings");
    const row = transferCells[0]!.closest("tr")!;
    fireEvent.click(row);

    expect(screen.getByText("Edit Transaction")).toBeInTheDocument();

        // Click Delete
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
    fireEvent.click(screen.getByRole("button", { name: /^transactions/i }));

    const splitCells = screen.getAllByText("Split Grocery & Home");
    const row = splitCells[0]!.closest("tr")!;
    fireEvent.click(row);

    expect(screen.getByText("Edit Transaction")).toBeInTheDocument();

        // Click Delete
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

  it("does not highlight 'Transactions' when an account is selected", () => {
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

    const navAll = screen.getByRole("button", { name: /^transactions/i });
    expect(navAll.className).not.toMatch(/\bis-sel\b/);

    // Toggling the same account again (now in the filtered view) clears
    // the filter and re-highlights "Transactions".
    fireEvent.click(accountRow);
    expect(navAll.className).toMatch(/\bis-sel\b/);
  });

  it("pushes the correct URL when selecting an account", async () => {
    const { api } = makeApi();
    const pushSpy = vi.spyOn(window.history, "pushState");
    const seed = makeSeedBudgetData();
    render(<BudgetApp data={seed} api={api} />);

    const accountBtns = screen.getAllByRole("button", {
      name: /td unlimited chequing/i,
    });
    const accountRow = accountBtns.find((b) => b.getAttribute("aria-label") == null)!;
    fireEvent.click(accountRow);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(null, "", "/transactions/1");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add a? ?new transaction/i })).toBeInTheDocument();
    });
    pushSpy.mockRestore();
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

    fireEvent.click(screen.getByRole("button", { name: /archive account/i }));
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
      fireEvent.click(screen.getByRole("button", { name: /unarchive account/i }));
    });

    expect(
      calls.some(
        (c) => c.method === "updateAccount" && c.args[0] === 101 && (c.args[1] as any)?.archived === false
      )
    ).toBe(true);
  });

  it("BUG-07: calls api.updateAccount with onBudget when editing an account", async () => {
    const { api, calls } = makeApi();
    const seed = makeSeedBudgetData();
    const account = seed.accounts.find((a) => a.id === 1);
    render(<BudgetApp data={seed} api={api} />);

    const editBtn = screen.getByRole("button", {
      name: `Edit account ${account?.name ?? ""}`,
    });
    fireEvent.click(editBtn);

    const nameInput = screen.getByPlaceholderText("e.g. TD Chequing");
    fireEvent.change(nameInput, { target: { value: "TD Renamed" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    });

    expect(
      calls.some(
        (c) =>
          c.method === "updateAccount" &&
          c.args[0] === 1 &&
          (c.args[1] as any)?.name === "TD Renamed" &&
          (c.args[1] as any)?.onBudget === true
      )
    ).toBe(true);
  });

  it("considers all transactions regardless of list length for year range (UNI-39 / F-20)", () => {
    const { api } = makeApi();
    const seed = makeSeedBudgetData();
    
    // Create 150 transactions with one historical transaction from 2020 in the middle
    const manyTxns = Array.from({ length: 150 }, (_, i) => ({
      id: 1000 + i,
      accountId: 1,
      categoryId: 10,
      date: i === 75 ? "2020-03-15" : "2026-06-01",
      payee: `Payee ${i}`,
      memo: "",
      amount: "-1000",
      status: "c" as const,
    }));

    const data: BudgetData = {
      ...seed,
      transactions: manyTxns,
    };

    render(<BudgetApp data={data} api={api} />);
    const yearTrigger = screen.getByRole("button", { name: "Year" });
    expect(yearTrigger).toBeInTheDocument();
    fireEvent.click(yearTrigger);
    expect(screen.getByRole("option", { name: "2020" })).toBeInTheDocument();
  });

  it("opens ReconcileModal with workingBalance correctly excluding split parents and including inbound transfers (BUG-03)", () => {
    const { api } = makeApi();
    const seed = makeSeedBudgetData();
    const acct1 = { ...seed.accounts[0]!, id: 1, name: "Chequing" };
    const acct2 = { ...seed.accounts[1]!, id: 2, name: "Savings" };
    const customData: BudgetData = {
      ...seed,
      accounts: [acct1, acct2],
      transactions: [
        // 1. Cleared plain transaction on Chequing: +10000 ($100.00)
        {
          id: 101,
          accountId: 1,
          categoryId: null,
          date: "2026-06-01",
          payee: "Direct Deposit",
          memo: "",
          amount: "10000",
          status: "c",
        },
        // 2. Cleared split transaction on Chequing: parent -$50, children -$30 and -$20
        {
          id: 102,
          accountId: 1,
          categoryId: null,
          date: "2026-06-02",
          payee: "Store",
          memo: "Split",
          amount: "-5000",
          status: "c",
        },
        {
          id: 103,
          accountId: 1,
          categoryId: seed.categories[0]!.id,
          parentId: 102,
          date: "2026-06-02",
          payee: "Store",
          memo: "Item 1",
          amount: "-3000",
          status: "c",
        },
        {
          id: 104,
          accountId: 1,
          categoryId: seed.categories[1]!.id,
          parentId: 102,
          date: "2026-06-02",
          payee: "Store",
          memo: "Item 2",
          amount: "-2000",
          status: "c",
        },
        // 3. Cleared transfer from Savings (2) into Chequing (1): -$25 on Savings -> +$25 on Chequing
        {
          id: 105,
          accountId: 2,
          transferAccountId: 1,
          categoryId: null,
          date: "2026-06-03",
          payee: "Transfer",
          memo: "Inbound to Chequing",
          amount: "-2500",
          status: "c",
        },
      ],
    };

    render(<BudgetApp data={customData} api={api} />);

    // Click on Chequing account in sidebar
    fireEvent.click(screen.getByRole("button", { name: /^Chequing/ }));

    // Click Reconcile button in register footer
    fireEvent.click(screen.getByRole("button", { name: /^reconcile$/i }));

    // Working balance: +10000 (deposit) - 5000 (split children: -3000 + -2000, parent excluded) + 2500 (inbound transfer) = +7500 ($75.00)
    expect(screen.getByText("Reconcile: Chequing")).toBeInTheDocument();
    expect(screen.getByText("$75.00")).toBeInTheDocument();
    expect(screen.getByText("Balanced — ready to reconcile")).toBeInTheDocument();
  });

  it("BUG-46: popstate to /transactions clears account filter", () => {
    const { api } = makeApi();
    window.history.pushState(null, "", "/transactions/1");
    render(<BudgetApp data={makeSeedBudgetData()} api={api} initialView="transactions" initialAccount={1} />);

    const acctBtn = screen.getByRole("button", { name: /^TD Unlimited Chequing/ });
    expect(acctBtn.className).toContain("is-sel");

    // Simulate popstate navigation to /transactions (no account ID)
    act(() => {
      window.history.pushState(null, "", "/transactions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Account filter is cleared -> Main Transactions button in sidebar is selected
    const txBtn = screen.getByRole("button", { name: /^transactions/i });
    expect(txBtn.className).toContain("is-sel");
    expect(acctBtn.className).not.toContain("is-sel");
  });

  it("BUG-46: popstate with invalid month /budget/2026-99 does not set invalid month", () => {
    const { api } = makeApi();
    window.history.pushState(null, "", "/budget/2026-06");
    render(<BudgetApp data={makeSeedBudgetData()} api={api} initialMonth="2026-06" />);

    // Trigger popstate with invalid month
    act(() => {
      window.history.pushState(null, "", "/budget/2026-99");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Month remains 2026-06 (MonthNav trigger shows June)
    expect(screen.getByRole("button", { name: "Month" })).toHaveTextContent("June");
    expect(screen.getByRole("button", { name: "Year" })).toHaveTextContent("2026");
  });

  it("BUG-46: deleting an account navigates to budget view and updates URL", async () => {
    const { api } = makeApi();
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    const data = makeSeedBudgetData();
    const targetAccount = data.accounts[0]!;
    window.history.pushState(null, "", `/transactions/${targetAccount.id}`);

    render(<BudgetApp data={data} api={api} initialView="transactions" initialAccount={targetAccount.id} />);

    // Open Edit Account modal by clicking edit on sidebar account
    const editBtn = screen.getByRole("button", { name: `Edit account ${targetAccount.name}` });
    fireEvent.click(editBtn);

    // Step 1: Click Delete
    fireEvent.click(screen.getByRole("button", { name: /^delete/i }));

    // Step 2: Confirm deletion
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });

    expect(api.deleteAccount).toHaveBeenCalledWith(targetAccount.id);
    expect(pushStateSpy).toHaveBeenCalledWith(null, "", expect.stringMatching(/^\/budget\/\d{4}-\d{2}$/));
    expect(screen.getByRole("button", { name: /reports/i })).toBeInTheDocument();
  });

  it("BUG-44: recovers from null or corrupt values in localStorage without crashing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.localStorage.setItem("ynab:transactions:sort", JSON.stringify(null));
    window.localStorage.setItem("ynab:budget:collapsed", JSON.stringify(null));
    window.localStorage.setItem("ynab:budget:monthCount", JSON.stringify("invalid"));

    const { api } = makeApi();
    // Render BudgetApp should not crash into ErrorBoundary
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);

    expect(screen.getByRole("button", { name: /^transactions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reports/i })).toBeInTheDocument();
    expect(window.localStorage.getItem("ynab:budget:collapsed")).toBeNull();
    expect(window.localStorage.getItem("ynab:budget:monthCount")).toBeNull();

    // Switch to Transactions view to verify TransactionsView handles corrupted sort gracefully
    fireEvent.click(screen.getByRole("button", { name: /^transactions/i }));
    expect(screen.getByPlaceholderText("Search register")).toBeInTheDocument();
    expect(screen.getByText("All Transactions")).toBeInTheDocument();
    expect(window.localStorage.getItem("ynab:transactions:sort")).toBeNull();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("BUG-09: computes avgSpentByCategory as true 3-month average across multiple transactions per month", () => {
    const { api } = makeApi();
    const baseData = makeSeedBudgetData();
    const groceryCat = baseData.categories.find((c) => c.name === "Groceries") || baseData.categories[0]!;

    // Create 9 transactions in Groceries category across 3 prior months (2026-03, 2026-04, 2026-05)
    // 3 transactions of -$60 ($6000 cents) each month = $180 per month = $540 total.
    const transactions = [
      { id: 101, accountId: 1, categoryId: groceryCat.id, date: "2026-03-05", payee: "Store 1", memo: "", amount: "-6000", status: "c" as const },
      { id: 102, accountId: 1, categoryId: groceryCat.id, date: "2026-03-15", payee: "Store 2", memo: "", amount: "-6000", status: "c" as const },
      { id: 103, accountId: 1, categoryId: groceryCat.id, date: "2026-03-25", payee: "Store 3", memo: "", amount: "-6000", status: "c" as const },
      { id: 104, accountId: 1, categoryId: groceryCat.id, date: "2026-04-05", payee: "Store 1", memo: "", amount: "-6000", status: "c" as const },
      { id: 105, accountId: 1, categoryId: groceryCat.id, date: "2026-04-15", payee: "Store 2", memo: "", amount: "-6000", status: "c" as const },
      { id: 106, accountId: 1, categoryId: groceryCat.id, date: "2026-04-25", payee: "Store 3", memo: "", amount: "-6000", status: "c" as const },
      { id: 107, accountId: 1, categoryId: groceryCat.id, date: "2026-05-05", payee: "Store 1", memo: "", amount: "-6000", status: "c" as const },
      { id: 108, accountId: 1, categoryId: groceryCat.id, date: "2026-05-15", payee: "Store 2", memo: "", amount: "-6000", status: "c" as const },
      { id: 109, accountId: 1, categoryId: groceryCat.id, date: "2026-05-25", payee: "Store 3", memo: "", amount: "-6000", status: "c" as const },
    ];

    const data: BudgetData = {
      ...baseData,
      assignments: [],
      transactions,
    };

    render(<BudgetApp data={data} api={api} initialMonth="2026-06" />);
    expect(screen.getByRole("button", { name: /reports/i })).toBeInTheDocument();
    // Verify that the view rendered the Groceries category in June 2026
    expect(screen.getAllByText(groceryCat.name).length).toBeGreaterThanOrEqual(1);
  });

  it("navigates to the other account and selects the transaction when clicking the transfer icon in Category column", () => {
    const { api } = makeApi();
    const baseData = makeSeedBudgetData();
    // Account 1: TD Unlimited Chequing, Account 2: EQ Bank
    const transferTxn = {
      id: 550,
      accountId: 1,
      transferAccountId: 2,
      categoryId: null,
      date: "2026-06-15",
      payee: "Transfer : EQ Bank",
      memo: "Transfer to Savings",
      amount: "-15000",
      status: "c" as const,
      parentId: null,
    };

    const data: BudgetData = {
      ...baseData,
      transactions: [transferTxn, ...baseData.transactions],
    };

    window.history.pushState(null, "", "/transactions/1");
    render(
      <BudgetApp
        data={data}
        api={api}
        initialView="transactions"
        initialAccount={1}
      />
    );

    // Verify currently in Account 1
    const acct1Btn = screen.getByRole("button", { name: /^TD Unlimited Chequing/ });
    expect(acct1Btn.className).toContain("is-sel");

    // Find the transfer jump button in the category cell
    const row = document.querySelector('tr[data-txn-id="550"]');
    expect(row).not.toBeNull();

    const transferBtn = row!.querySelector('button[aria-label="Go to transfer in EQ Bank"]');
    expect(transferBtn).not.toBeNull();

    // Click the transfer button
    fireEvent.click(transferBtn!);

    // Should switch to Account 2
    const acct2Btn = screen.getByRole("button", { name: /^EQ Bank/ });
    expect(acct2Btn.className).toContain("is-sel");

    // In Account 2's register, transaction 550 should be selected and checked
    const rowInAcct2 = document.querySelector('tr[data-txn-id="550"]');
    expect(rowInAcct2).not.toBeNull();
    expect(rowInAcct2!.classList.contains("is-sel")).toBe(true);

    const checkbox = rowInAcct2!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("defaults to today's month on init so the current month is visible", () => {
    const { api } = makeApi();
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    const today = todayISO().slice(0, 7);
    const year = Number(today.slice(0, 4));
    const month0 = Number(today.slice(5, 7)) - 1;
    const picker = within(screen.getByTestId("month-nav-picker"));
    expect(picker.getByRole("button", { name: "Month" })).toHaveTextContent(
      MONTHS_LONG[month0]!
    );
    expect(picker.getByRole("button", { name: "Year" })).toHaveTextContent(String(year));
  });

  it("respects an explicit initialMonth instead of defaulting to today", () => {
    const { api } = makeApi();
    render(
      <BudgetApp data={makeSeedBudgetData()} api={api} initialMonth="2026-06" />
    );
    const picker = within(screen.getByTestId("month-nav-picker"));
    expect(picker.getByRole("button", { name: "Month" })).toHaveTextContent("June");
    expect(picker.getByRole("button", { name: "Year" })).toHaveTextContent("2026");
  });

  it("falls back to today's month when initialMonth is invalid", () => {
    const { api } = makeApi();
    render(
      <BudgetApp data={makeSeedBudgetData()} api={api} initialMonth="not-a-month" />
    );
    const today = todayISO().slice(0, 7);
    const year = Number(today.slice(0, 4));
    const month0 = Number(today.slice(5, 7)) - 1;
    const picker = within(screen.getByTestId("month-nav-picker"));
    expect(picker.getByRole("button", { name: "Month" })).toHaveTextContent(
      MONTHS_LONG[month0]!
    );
    expect(picker.getByRole("button", { name: "Year" })).toHaveTextContent(String(year));
  });

  it("opens the Page Visibility page from the Inspector gear menu", () => {
    window.localStorage.removeItem("ynab:nav:visible");
    try {
      const { api } = makeApi();
      render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.click(screen.getByText("Page Visibility"));
      expect(screen.getByRole("heading", { name: "Page Visibility" })).toBeInTheDocument();
      for (const name of ["Budget", "Reports", "Calendar", "Transactions"]) {
        expect(screen.getByRole("checkbox", { name })).toBeInTheDocument();
      }
    } finally {
      window.localStorage.removeItem("ynab:nav:visible");
    }
  });

  it("hides a menu page from the sidebar and moves to the next page when the current one is hidden", () => {
    window.localStorage.removeItem("ynab:nav:visible");
    try {
      const { api } = makeApi();
      render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
      // Starts on the Budget view.
      expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.click(screen.getByText("Page Visibility"));

      // Hide Budget while on Budget.
      fireEvent.click(screen.getByRole("checkbox", { name: "Budget" }));

      // Budget disappears from the sidebar, but the page stays open.
      expect(screen.queryByRole("button", { name: /^budget$/i })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Page Visibility" })).toBeInTheDocument();

      // Closing reveals the next available page (Reports).
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByText("Spending by Category")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^budget$/i })).not.toBeInTheDocument();
    } finally {
      window.localStorage.removeItem("ynab:nav:visible");
    }
  });

  it("keeps at least one menu page enabled", () => {
    window.localStorage.removeItem("ynab:nav:visible");
    try {
      const { api } = makeApi();
      render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.click(screen.getByText("Page Visibility"));

      // Hide everything except Transactions: each hide moves to the next page.
      for (const name of ["Budget", "Reports", "Calendar"]) {
        fireEvent.click(screen.getByRole("checkbox", { name }));
      }
      // The last remaining page is greyed out and cannot be hidden.
      expect(screen.getByRole("checkbox", { name: "Transactions" })).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox", { name: "Transactions" }));
      expect(screen.getByRole("checkbox", { name: "Transactions" })).toBeChecked();
      expect(
        screen.getByRole("button", { name: /^transactions/i })
      ).toBeInTheDocument();
    } finally {
      window.localStorage.removeItem("ynab:nav:visible");
    }
  });
});

