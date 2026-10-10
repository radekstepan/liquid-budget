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
  it("renders all 2 top nav buttons", () => {
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
  });

  it("hides nav items disabled via visibleViews", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        visibleViews={{
          budget: true,
          reports: true,
          transactions: false,
        }}
      />
    );
    expect(screen.getByRole("button", { name: /^budget$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reports$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^transactions/i })).not.toBeInTheDocument();
  });

  it("shows every nav item when visibleViews is omitted", () => {
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
    expect(screen.getByRole("button", { name: /^budget$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reports$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^transactions/i })).toBeInTheDocument();
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
        view="reports"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={2}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /checking/i })).not.toHaveClass(/is-sel/);
    expect(screen.getByRole("button", { name: /^reports$/i })).toHaveClass(/is-sel/);
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

  it("renders Closed Accounts section when closed accounts exist", () => {
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
    const archivedGroupHead = screen.getByRole("button", { name: /closed accounts/i });
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

  it("renders the new-count badge on individual accounts but not on the Transactions button", () => {
    const { rerender } = render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        newByAccount={{ 1: 2, 2: 1 }}
      />
    );

    const cashBadge = screen.getByText("2");
    expect(cashBadge).toBeInTheDocument();
    expect(cashBadge).toHaveClass("y-badge");

    // The overall Transactions row carries no count label.
    const txBtn = screen.getByRole("button", { name: /^transactions/i });
    expect(txBtn.querySelector(".y-badge")).toBeNull();

    rerender(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        newByAccount={{}}
      />
    );

    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("renders the new-count badge right of the account name with an aligning column on every row", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        newByAccount={{ 1: 2 }}
      />
    );

    const cashBtn = screen.getByRole("button", { name: /cash/i });
    const cashCols = cashBtn.querySelectorAll(".y-side-newcol");
    expect(cashCols).toHaveLength(1);
    // Badge follows the name and precedes the amount in DOM order.
    const name = cashBtn.querySelector(".truncate")!;
    const amt = cashBtn.querySelector(".y-side-amt")!;
    expect(name.compareDocumentPosition(cashCols[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cashCols[0]!.compareDocumentPosition(amt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cashCols[0]!.querySelector(".y-badge")).toHaveTextContent("2");

    // Rows without new items still render the (empty) column so names align.
    const checkingBtn = screen.getByRole("button", { name: /checking/i });
    const checkingCols = checkingBtn.querySelectorAll(".y-side-newcol");
    expect(checkingCols).toHaveLength(1);
    expect(checkingCols[0]!.querySelector(".y-badge")).toBeNull();
  });

  it("sizes the amount column per group so badges align without cross-group push", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        newByAccount={{ 1: 2, 3: 1 }}
      />
    );

    const cashAmt = screen.getByRole("button", { name: /cash/i }).querySelector(".y-side-amt")!;
    const checkingAmt = screen.getByRole("button", { name: /checking/i }).querySelector(".y-side-amt")!;
    const chaseAmt = screen.getByRole("button", { name: /chase/i }).querySelector(".y-side-amt")!;
    // Same group shares one width (badges land underneath each other) ...
    expect(cashAmt.style.minWidth).toBe("7.65ch");
    expect(checkingAmt.style.minWidth).toBe("7.65ch");
    // ... while other groups size to their own balances, so the large
    // Retirement balance never pushes Credit Cards badges left.
    expect(chaseAmt.style.minWidth).toBe("6.65ch");
    const retirementHead = screen.getByRole("button", { name: /retirement/i }).querySelector(".y-side-amt")!;
    expect(retirementHead.style.minWidth).toBe("8.65ch");
  });

  it("renders no new-count column when no account has new items", () => {
    const { container } = render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );
    expect(container.querySelectorAll(".y-side-newcol")).toHaveLength(0);
  });

  it("renders the red duplicates badge first and the new-count badge second", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        newByAccount={{ 1: 2 }}
        duplicatesByAccount={{ 1: 3 }}
      />
    );

    const cashBtn = screen.getByRole("button", { name: /cash/i });
    const col = cashBtn.querySelector(".y-side-newcol")!;
    const badges = col.querySelectorAll(".y-badge");
    expect(badges).toHaveLength(2);

    // Duplicates first (plain red badge), new count second (green variant).
    const dupBadge = badges[0]!;
    expect(dupBadge).toHaveTextContent("3");
    expect(dupBadge).not.toHaveClass("y-badge--new");
    const newBadge = badges[1]!;
    expect(newBadge).toHaveTextContent("2");
    expect(newBadge).toHaveClass("y-badge--new");
    expect(dupBadge.compareDocumentPosition(newBadge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // One shared group width plus a fixed gap between the badges.
    expect(col.style.minWidth).toBe("36px");
    expect(col.style.gap).toBe("4px");

    // Rows without counts reserve the same space so amounts stay aligned.
    const checkingBtn = screen.getByRole("button", { name: /checking/i });
    const checkingCol = checkingBtn.querySelector(".y-side-newcol")!;
    expect(checkingCol.style.minWidth).toBe("36px");
    expect(checkingCol.querySelector(".y-badge")).toBeNull();
  });

  it("keeps one fixed gap between badges for wide counts", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        newByAccount={{ 1: 169, 2: 59 }}
        duplicatesByAccount={{ 1: 1, 2: 5 }}
      />
    );

    // Both rows share the group width (sized to the 3-digit count) and the
    // same fixed gap — the "5 / 59" row shows no wider a gap than "1 / 169".
    for (const name of [/cash/i, /checking/i]) {
      const btn = screen.getByRole("button", { name });
      const col = btn.querySelector(".y-side-newcol")!;
      expect(col.style.minWidth).toBe("47px");
      expect(col.style.gap).toBe("4px");
      expect(col.querySelectorAll(".y-badge")).toHaveLength(2);
    }
    const cashBadges = screen
      .getByRole("button", { name: /cash/i })
      .querySelectorAll(".y-side-newcol .y-badge");
    expect(cashBadges[0]).toHaveTextContent("1");
    expect(cashBadges[1]).toHaveTextContent("169");
  });

  it("renders only the duplicates badge when no account has new items", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        duplicatesByAccount={{ 2: 1 }}
      />
    );

    const checkingBtn = screen.getByRole("button", { name: /checking/i });
    const col = checkingBtn.querySelector(".y-side-newcol")!;
    expect(col.style.minWidth).toBe("16px");
    const dupBadge = col.querySelector(".y-badge")!;
    expect(dupBadge).toHaveTextContent("1");
    expect(dupBadge).not.toHaveClass("y-badge--new");

    // Other rows reserve the same space but render no badge.
    const cashBtn = screen.getByRole("button", { name: /cash/i });
    const cashCol = cashBtn.querySelector(".y-side-newcol")!;
    expect(cashCol.style.minWidth).toBe("16px");
    expect(cashCol.querySelector(".y-badge")).toBeNull();
  });

  it("renders the new-count badge with the green variant when no duplicates exist", () => {
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        newByAccount={{ 1: 2 }}
      />
    );

    const cashBtn = screen.getByRole("button", { name: /cash/i });
    const col = cashBtn.querySelector(".y-side-newcol")!;
    expect(col.style.minWidth).toBe("16px");
    const newBadge = col.querySelector(".y-badge")!;
    expect(newBadge).toHaveTextContent("2");
    expect(newBadge).toHaveClass("y-badge--new");
  });

  it("renders no badge column when no account has new items or duplicates", () => {
    const { container } = render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={accounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
        newByAccount={{}}
        duplicatesByAccount={{}}
      />
    );
    expect(container.querySelectorAll(".y-side-newcol")).toHaveLength(0);
  });

  it("shows a note indicator with the note as tooltip when an account has notes", () => {
    const notedAccounts: Account[] = [
      { id: 20, name: "Noted Checking", kind: "liquid", groupLabel: "Liquid", balance: "1000", onBudget: true, sort: 0, notes: "Closed after refinance" },
      { id: 21, name: "Plain Checking", kind: "liquid", groupLabel: "Liquid", balance: "1000", onBudget: true, sort: 1 },
    ];
    render(
      <Sidebar
        view="budget"
        setView={() => {}}
        accounts={notedAccounts}
        selectedAccountId={null}
        onSelectAccount={() => {}}
        onAddAccount={() => {}}
      />
    );

    expect(screen.getByLabelText("Note on Noted Checking")).toBeInTheDocument();
    expect(screen.queryByLabelText("Note on Plain Checking")).not.toBeInTheDocument();
  });
});

