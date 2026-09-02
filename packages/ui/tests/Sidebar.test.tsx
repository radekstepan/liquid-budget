import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "../src/Sidebar.js";
import type { Account } from "@ynab/logic";

const accounts: Account[] = [
  { id: 1, name: "Cash", kind: "liquid", groupLabel: "Liquid", balance: "32000", onBudget: true, sort: 0 },
  { id: 2, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "165808", onBudget: true, sort: 1 },
  { id: 3, name: "Chase", kind: "credit", groupLabel: "Credit Cards", balance: "-82347", onBudget: true, sort: 2 },
  { id: 4, name: "Retirement", kind: "offbudget", groupLabel: "Retirement", balance: "5800000", onBudget: false, sort: 3 },
];

describe("Sidebar", () => {
  it("renders all 4 top nav buttons", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /budget/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reports/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /calendar/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /projections/i })).toBeInTheDocument();
  });

  it("calls setView when a nav button is clicked", () => {
    const setView = vi.fn();
    render(
      <Sidebar
        view="budget"
        setView={setView}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /reports/i }));
    expect(setView).toHaveBeenCalledWith("reports");
  });

  it("calls onAddAccount when the Add Account button is clicked", () => {
    const onAddAccount = vi.fn();
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={onAddAccount}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /add account/i }));
    expect(onAddAccount).toHaveBeenCalledTimes(1);
  });

  it("renders Add Account button centered and not stretched full width", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    const btn = screen.getByRole("button", { name: /add account/i });
    expect(btn.parentElement).toHaveClass("flex");
    expect(btn.parentElement).toHaveClass("justify-center");
    expect(btn.className).not.toContain("w-[calc(100%-1rem)]");
  });

  it("calls onSelectAccount with the account id", () => {
    const onSelectAccount = vi.fn();
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={onSelectAccount}
        onAddAccount={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /cash/i }));
    expect(onSelectAccount).toHaveBeenCalledWith(1);
  });

  it("marks the matching account row with is-sel when selectedAccountId matches and view is transactions", () => {
    render(
      <Sidebar
        view="transactions"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={2}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /cash/i })).not.toHaveClass(/is-sel/);
    expect(screen.getByRole("button", { name: /checking/i })).toHaveClass(/is-sel/);
  });

  it("does not mark any account row as selected when view is not transactions", () => {
    render(
      <Sidebar
        view="projections"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={2}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /checking/i })).not.toHaveClass(/is-sel/);
    expect(screen.getByRole("button", { name: /projections/i })).toHaveClass(/is-sel/);
  });

  it("does not render per-account delete or reconcile buttons", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: /delete account cash/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reconcile account cash/i })).not.toBeInTheDocument();
  });

  it("does not highlight the 'Transactions' nav when an account is selected", () => {
    render(
      <Sidebar
        view="transactions"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={1}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    const navAll = screen.getByRole("button", { name: /transactions/i });
    expect(navAll.className).not.toMatch(/\bis-sel\b/);
    expect(screen.getByRole("button", { name: /cash/i })).toHaveClass(/is-sel/);
  });

  it("highlights the 'Transactions' nav when view=transactions and no account is selected", () => {
    render(
      <Sidebar
        view="transactions"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    const navAll = screen.getByRole("button", { name: /transactions/i });
    expect(navAll.className).toMatch(/\bis-sel\b/);
  });

  it("calls onReorderAccount on account drag and drop", () => {
    const onReorderAccount = vi.fn();
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        onReorderAccount={onReorderAccount}
      />
    );

    const cashRow = screen.getByText("Cash").closest("[draggable='true']");
    const checkingRow = screen.getByText("Checking").closest("[draggable='true']");
    expect(cashRow).not.toBeNull();
    expect(checkingRow).not.toBeNull();

    const dataTransfer = { effectAllowed: "", dropEffect: "" };

    fireEvent.dragStart(cashRow!, { dataTransfer });
    fireEvent.dragOver(checkingRow!, { dataTransfer });
    expect(checkingRow!.classList.contains("is-drop-target")).toBe(true);
    fireEvent.drop(checkingRow!, { dataTransfer });

    expect(onReorderAccount).toHaveBeenCalled();
  });

  it("resets sidebar width on double clicking the resize handle", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    const handle = screen.getByLabelText("Resize sidebar");
    expect(handle).toBeInTheDocument();
    fireEvent.doubleClick(handle);
  });

  it("renders Archived Accounts section when archived accounts exist", () => {
    const mixedAccounts: Account[] = [
      ...accounts,
      { id: 99, name: "Old Bank", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 4, archived: true },
    ];
    const onSelectAccount = vi.fn();
    render(
      <Sidebar
        view="transactions"
        setView={() => {}}
        accounts={mixedAccounts}
        selectedAccountId={null}
        onSelectAccount={onSelectAccount}
        onAddAccount={() => {}}
      />
    );

    // Header is rendered
    const archivedGroupHead = screen.getByRole("button", { name: /archived accounts/i });
    expect(archivedGroupHead).toBeInTheDocument();

    // By default it is collapsed, so Old Bank is not visible yet
    expect(screen.queryByRole("button", { name: /^Old Bank / })).not.toBeInTheDocument();

    // Expand the group
    fireEvent.click(archivedGroupHead);
    const oldBankRow = screen.getByRole("button", { name: /^Old Bank / });
    expect(oldBankRow).toBeInTheDocument();

    // Selecting it fires onSelectAccount
    fireEvent.click(oldBankRow);
    expect(onSelectAccount).toHaveBeenCalledWith(99);
  });

  it("renders edit pencil for accounts and triggers onEditAccount when clicked", () => {
    const onEditAccount = vi.fn();
    const onSelectAccount = vi.fn();
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={onSelectAccount}
        onAddAccount={() => {}}
        onEditAccount={onEditAccount}
      />
    );

    const editCashBtn = screen.getByRole("button", { name: "Edit account Cash" });
    expect(editCashBtn).toBeInTheDocument();

    fireEvent.click(editCashBtn);
    expect(onEditAccount).toHaveBeenCalledWith(1);
    expect(onSelectAccount).not.toHaveBeenCalled();
  });

  it("orders custom groups dynamically placing budget groups first (UNI-24)", () => {
    const customAccounts: Account[] = [
      { id: 10, name: "Brokerage", kind: "offbudget", groupLabel: "Investments", balance: "50000", onBudget: false, sort: 0 },
      { id: 11, name: "Daily Checking", kind: "liquid", groupLabel: "Everyday Accounts", balance: "10000", onBudget: true, sort: 1 },
      { id: 12, name: "Savings", kind: "liquid", groupLabel: "Emergency", balance: "20000", onBudget: true, sort: 2 },
    ];

    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={customAccounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );

    const groupButtons = screen.getAllByRole("button").filter((b) =>
      b.className.includes("y-side-head")
    );
    const groupTexts = groupButtons.map((b) => b.textContent);
    // Everyday Accounts and Emergency (budget accounts) should come before Investments (off-budget)
    expect(groupTexts[0]).toContain("Everyday Accounts");
    expect(groupTexts[1]).toContain("Emergency");
    expect(groupTexts[2]).toContain("Investments");
  });

  it("renders a numeric badge on the Transactions button when dueBadgeCount > 0 and on individual accounts", () => {
    const { rerender } = render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        dueBadgeCount={3}
        dueByAccount={{ 1: 2, 2: 1 }}
      />
    );

    const totalBadge = screen.getByText("3");
    expect(totalBadge).toBeInTheDocument();
    expect(totalBadge).toHaveClass("y-badge");

    const cashBadge = screen.getByText("2");
    expect(cashBadge).toBeInTheDocument();

    rerender(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        dueBadgeCount={0}
      />
    );

    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });
});

