import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { TransactionsView } from "../src/TransactionsView.js";
import { makeSeedBudgetData } from "@ynab/logic";

describe("TransactionsView", () => {
  it("renders transaction rows and search filters them", () => {
    const data = makeSeedBudgetData();
    render(
      <TransactionsView
        data={data}
        accountFilter={null}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );

    expect(screen.getAllByText("Superstore").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SAP Concur").length).toBeGreaterThan(0);

    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: "Superstore" } });
    expect(screen.getAllByText("Superstore").length).toBeGreaterThan(0);
    expect(screen.queryByText("SAP Concur")).not.toBeInTheDocument();
  });

  it("calls onAdd when Add Transaction is clicked", () => {
    const onAdd = vi.fn();
    render(
      <TransactionsView
        data={makeSeedBudgetData()}
        accountFilter={null}
        onAdd={onAdd}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("renders a Balance column anchored at each account's current balance", () => {
    const data = makeSeedBudgetData();
    // Pick any account that has transactions; the seed's TD Unlimited
    // Chequing (id=1) has several rows.
    render(
      <TransactionsView
        data={data}
        accountFilter={1}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    // The Balance header is present.
    expect(screen.getByText("Balance")).toBeInTheDocument();

    // The first body row in the table corresponds to the newest TD
    // transaction in the seed. Its running balance should equal the
    // account's current balance: $10,875.55.
    const tbody = screen.getAllByRole("rowgroup")[1]!;
    const firstRow = within(tbody).getAllByRole("row")[0]!;
    const cells = within(firstRow).getAllByRole("cell");
    const balanceCell = cells[cells.length - 1]!;
    expect(balanceCell.textContent).toBe("$10,875.55");
  });

  it("does not render subtransactions in the list and shows Split (Multiple Categories) for split parent", () => {
    const data = makeSeedBudgetData();
    const onEdit = vi.fn();
    const splitParent = {
      id: 9001,
      accountId: 1,
      categoryId: null,
      date: "2026-07-15",
      payee: "Costco Wholesale Split",
      memo: "Groceries and Electronics",
      amount: "-150.00",
      status: "c" as const,
      transferAccountId: null,
      parentId: null,
    };
    const splitChild1 = {
      id: 9002,
      accountId: 1,
      categoryId: 1,
      date: "2026-07-15",
      payee: "Costco Wholesale Split",
      memo: "Groceries part",
      amount: "-100.00",
      status: "c" as const,
      transferAccountId: null,
      parentId: 9001,
    };
    const splitChild2 = {
      id: 9003,
      accountId: 1,
      categoryId: 2,
      date: "2026-07-15",
      payee: "Costco Wholesale Split",
      memo: "Electronics part",
      amount: "-50.00",
      status: "c" as const,
      transferAccountId: null,
      parentId: 9001,
    };

    data.transactions.unshift(splitParent, splitChild1, splitChild2);

    render(
      <TransactionsView
        data={data}
        accountFilter={1}
        onAdd={() => {}}
        onEdit={onEdit}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    // Parent row is rendered
    expect(screen.getAllByText("Costco Wholesale Split").length).toBe(1);
    expect(screen.getByText("Split (Multiple Categories)")).toBeInTheDocument();

    // Child memos or child rows are NOT rendered in the table list
    expect(screen.queryByText("Groceries part")).not.toBeInTheDocument();
    expect(screen.queryByText("Electronics part")).not.toBeInTheDocument();
    expect(screen.queryByText("↳")).not.toBeInTheDocument();

    // Clicking parent row opens it for edit
    fireEvent.click(screen.getByText("Costco Wholesale Split"));
    expect(onEdit).toHaveBeenCalledWith(9001);
  });

  it("renders incoming split transfers on the destination account register", () => {
    const data = makeSeedBudgetData();
    const onEdit = vi.fn();
    // Account 1 (TD) has a split with an expense child and a transfer child to Account 2 (Rewards Visa).
    const splitParent = {
      id: 9100,
      accountId: 1,
      categoryId: null,
      date: "2026-07-20",
      payee: "Expense & Visa Transfer",
      memo: "Combined",
      amount: "-100.00",
      status: "c" as const,
      transferAccountId: null,
      parentId: null,
    };
    const splitExpenseChild = {
      id: 9101,
      accountId: 1,
      categoryId: 1,
      date: "2026-07-20",
      payee: "Expense & Visa Transfer",
      memo: "Expense part",
      amount: "-60.00",
      status: "c" as const,
      transferAccountId: null,
      parentId: 9100,
    };
    const splitTransferChild = {
      id: 9102,
      accountId: 1,
      categoryId: null,
      date: "2026-07-20",
      payee: "Transfer : TD First Class Travel Visa",
      memo: "Visa transfer part",
      amount: "-40.00",
      status: "c" as const,
      transferAccountId: 2,
      parentId: 9100,
    };

    data.transactions.unshift(splitParent, splitExpenseChild, splitTransferChild);

    render(
      <TransactionsView
        data={data}
        accountFilter={2} // Viewing Account 2 (Rewards Visa)
        onAdd={() => {}}
        onEdit={onEdit}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    // On Account 2's register, the incoming split transfer should display with payee "Transfer : TD Unlimited Chequing"
    expect(screen.getByText("Transfer : TD Unlimited Chequing")).toBeInTheDocument();
    expect(screen.getByText("$40.00")).toBeInTheDocument();

    // Clicking the transfer opens the parent split transaction (9100)
    fireEvent.click(screen.getByText("Transfer : TD Unlimited Chequing"));
    expect(onEdit).toHaveBeenCalledWith(9100);
  });
});


