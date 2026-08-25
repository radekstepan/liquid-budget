import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import {
  CategoryModal,
  TransactionModal,
  RecurringModal,
  GroupModal,
  AccountModal,
} from "../src/Modals.js";
import type {
  Account,
  Category,
  Transaction,
  Recurring,
  RecurringSubTransaction,
} from "@ynab/logic";
import {
  openSearchable,
  openSearchlistByPlaceholder,
  pickFromOpenDropdownByValue,
  pickFromOpenSearchableByValue,
  pickPlaceholderDropdownByIndexByValue,
  pickPlaceholderSearchableByIndexByValue,
} from "./dropdown.js";

const accounts: Account[] = [
  { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "10000", onBudget: true, sort: 0 },
  { id: 2, name: "Credit", kind: "credit", groupLabel: "Cards", balance: "-5000", onBudget: true, sort: 1 },
  { id: 3, name: "Brokerage", kind: "offbudget", groupLabel: "Off Budget", balance: "50000", onBudget: false, sort: 2 },
];

const categories: Category[] = [
  { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
  { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: "150000", linkedAccountId: null },
];

describe("CategoryModal", () => {
  it("calls onSave with the trimmed name and null goal when no goal is set", () => {
    const onSave = vi.fn();
    render(<CategoryModal onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Coffee  " } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ name: "Coffee", goalTarget: null, overspendCarriesOver: false });
  });

  it("does not call onSave when name is empty", () => {
    const onSave = vi.fn();
    render(<CategoryModal onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("reveals the goal input and passes goalTarget when 'Set a funding goal' is checked", () => {
    const onSave = vi.fn();
    render(<CategoryModal onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Vacation" } });
    fireEvent.click(screen.getByLabelText(/set a funding goal/i));
    const goalInput = screen.getByPlaceholderText("1000.00");
    fireEvent.change(goalInput, { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ name: "Vacation", goalTarget: 200000, overspendCarriesOver: false });
  });

  it("UNI-20 / F-16: toggles overspendCarriesOver (Red Arrow)", () => {
    const onSave = vi.fn();
    render(<CategoryModal onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Reimbursements" } });
    fireEvent.click(screen.getByLabelText(/red arrow: carry negative balance over to next month/i));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ name: "Reimbursements", goalTarget: null, overspendCarriesOver: true });
  });

  it("pre-fills the name and goal when editing an existing category", () => {
    const onSave = vi.fn();
    render(
      <CategoryModal
        initial={categories[1]!}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    expect(screen.getByDisplayValue("Rent")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1500.00")).toBeInTheDocument();
  });

  it("UNI-03 / F-03: renders Delete button when initial and onDelete provided, requires reassignment when transactionCount > 0", async () => {
    const onDelete = vi.fn();
    render(
      <CategoryModal
        initial={categories[0]!}
        transactionCount={5}
        otherCategories={[categories[1]!]}
        onClose={() => {}}
        onSave={() => {}}
        onDelete={onDelete}
      />
    );

    // Click delete
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(screen.getByText(/Delete "Groceries"\?/i)).toBeInTheDocument();
    expect(screen.getByText(/This category is referenced by 5 transaction\(s\)/i)).toBeInTheDocument();

    // Confirm deletion with reassignment
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });
    expect(onDelete).toHaveBeenCalledWith({ moveToCategoryId: 11 });
  });

  it("UNI-03 / F-03: allows direct deletion when category has 0 transactions", async () => {
    const onDelete = vi.fn();
    render(
      <CategoryModal
        initial={categories[0]!}
        transactionCount={0}
        otherCategories={[categories[1]!]}
        onClose={() => {}}
        onSave={() => {}}
        onDelete={onDelete}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(screen.getByText(/This category has no transactions and will be removed/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    });
    expect(onDelete).toHaveBeenCalledWith(undefined);
  });

  it("UNI-03 / F-03: renders the reassignment dropdown searchable with group headings", () => {
    const onDelete = vi.fn();
    render(
      <CategoryModal
        initial={categories[0]!}
        transactionCount={3}
        otherCategories={[categories[1]!]}
        groups={[{ id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false }]}
        onClose={() => {}}
        onSave={() => {}}
        onDelete={onDelete}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    openSearchable(/move transactions to/i);
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Everyday")).toBeInTheDocument();
  });
});

describe("TransactionModal", () => {
  it("calls onSave with the typed amount (sign convention: positive = inflow)", () => {
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={null}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Whole Foods" },
    });
    // The only "0.00" placeholder in single mode is the amount field.
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "-42.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      payee: "Whole Foods",
      amount: -4250,
      categoryId: null,
    });
  });

  it("calls onSave with a positive amount when the user types a positive number", () => {
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={null}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Payroll" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      payee: "Payroll",
      amount: 100000,
    });
  });

  it("does not call onSave when payee is empty", () => {
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={null}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("filters existing payees and picks one from the search list", () => {
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        payees={[
          { value: "Whole Foods", label: "Whole Foods" },
          { value: "IGA", label: "IGA" },
        ]}
        defaultAccountId={null}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    const input = openSearchlistByPlaceholder("e.g. Whole Foods");
    fireEvent.change(input, { target: { value: "iga" } });
    fireEvent.click(screen.getByRole("option", { name: "IGA" }));
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-10" } });
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ payee: "IGA" });
  });

  it("saves a brand-new payee typed into the field (create allowed)", () => {
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        payees={[{ value: "IGA", label: "IGA" }]}
        defaultAccountId={null}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "New Coffee Shop" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ payee: "New Coffee Shop" });
  });

  it("groups category options by group and lets the user search within them", () => {
    const groups = [{ id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false }];
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        groups={groups}
        defaultAccountId={null}
        onClose={() => {}}
        onSave={() => {}}
      />
    );
    const category = openSearchable(/category/i);
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Everyday")).toBeInTheDocument();

    fireEvent.change(category, { target: { value: "gro" } });
    expect(within(list).getByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(within(list).queryByRole("option", { name: "Rent" })).not.toBeInTheDocument();
    // The group heading persists while filtering.
    expect(within(list).getByText("Everyday")).toBeInTheDocument();
  });

  it("pre-fills the date from defaultDate when provided", () => {
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={null}
        defaultDate="2026-07-15"
        onClose={() => {}}
        onSave={() => {}}
      />
    );
    const dateInput = screen.getByDisplayValue("2026-07-15") as HTMLInputElement;
    expect(dateInput).toBeInTheDocument();
    expect(dateInput.type).toBe("date");
  });

  it("hides category picker and saves categoryId null when account is off-budget", () => {
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={3} // Brokerage (off-budget)
        onClose={() => {}}
        onSave={onSave}
      />
    );
    // Category dropdown trigger should not be in the document
    expect(screen.queryByRole("button", { name: /category/i })).not.toBeInTheDocument();

    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Stock Dividend" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "250.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      accountId: 3,
      payee: "Stock Dividend",
      amount: 25000,
      categoryId: null,
      incomeMonth: null,
    });
  });

  it("edits an existing transaction with the initial values", () => {
    const onSave = vi.fn();
    const initial: Transaction = {
      id: 99,
      accountId: 1,
      categoryId: 10,
      date: "2026-06-10",
      payee: "IGA",
      memo: "",
      amount: "-1234",
      cleared: true,
    };
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={null}
        initial={initial}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    expect(screen.getByText("IGA")).toBeInTheDocument();
    // The amount field shows the signed value.
    expect(screen.getByDisplayValue("-12.34")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: 99, payee: "IGA" });
  });

  describe("deletion flow", () => {
    it("does not render a delete button in add mode", () => {
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={() => {}}
        />
      );
      expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    });

    it("renders a delete button in edit mode when onDelete is provided", () => {
      const initial: Transaction = {
        id: 99,
        accountId: 1,
        categoryId: 10,
        date: "2026-06-10",
        payee: "IGA",
        memo: "",
        amount: "-1234",
        cleared: true,
      };
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          initial={initial}
          onClose={() => {}}
          onSave={() => {}}
          onDelete={() => {}}
        />
      );
      expect(screen.getByRole("button", { name: /^delete/i })).toBeInTheDocument();
    });

    it("triggers two-step confirmation and calls onDelete when confirmed", async () => {
      const onDelete = vi.fn();
      const initial: Transaction = {
        id: 99,
        accountId: 1,
        categoryId: 10,
        date: "2026-06-10",
        payee: "IGA",
        memo: "",
        amount: "-1234",
        cleared: true,
      };
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          initial={initial}
          onClose={() => {}}
          onSave={() => {}}
          onDelete={onDelete}
        />
      );

      // Step 1: click Delete… to enter confirmation
      fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
      expect(screen.getByText('Delete "IGA"?')).toBeInTheDocument();
      expect(screen.getByText(/are you sure you want to delete this transaction/i)).toBeInTheDocument();

      // Step 2: cancel returns to edit form without deleting
      fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
      expect(onDelete).not.toHaveBeenCalled();
      expect(screen.getByText("Edit Transaction")).toBeInTheDocument();

      // Re-enter confirmation and confirm
      fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
      });
      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("shows linked transfer notice when deleting a transfer transaction", () => {
      const initial: Transaction = {
        id: 101,
        accountId: 1,
        transferAccountId: 2,
        categoryId: null,
        date: "2026-06-10",
        payee: "Transfer : Savings",
        memo: "",
        amount: "-5000",
        cleared: true,
      };
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          initial={initial}
          onClose={() => {}}
          onSave={() => {}}
          onDelete={() => {}}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
      expect(screen.getByText(/linked transfer/i)).toBeInTheDocument();
      expect(screen.getByText(/also remove the corresponding transaction in the linked account/i)).toBeInTheDocument();
    });

    it("shows split transaction notice when deleting a split parent", () => {
      const parent: Transaction = {
        id: 10,
        accountId: 1,
        categoryId: null,
        date: "2026-06-10",
        payee: "Target",
        memo: "",
        amount: "-10000",
        cleared: true,
      };
      const allTxns: Transaction[] = [
        parent,
        { id: 11, parentId: 10, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Target", amount: "-6000", cleared: true },
        { id: 12, parentId: 10, accountId: 1, categoryId: 11, date: "2026-06-10", payee: "Target", amount: "-4000", cleared: true },
      ];
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          allTransactions={allTxns}
          initial={parent}
          onClose={() => {}}
          onSave={() => {}}
          onDelete={() => {}}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
      expect(screen.getByText(/split transaction/i)).toBeInTheDocument();
      expect(screen.getByText(/also delete all of its 2 sub-transactions/i)).toBeInTheDocument();
    });

    it("handles deleting a split parent that includes transfer sub-transactions", async () => {
      const onDelete = vi.fn();
      const parent: Transaction = {
        id: 20,
        accountId: 1,
        categoryId: null,
        date: "2026-06-10",
        payee: "Payroll Split",
        memo: "",
        amount: "50000",
        cleared: true,
      };
      const allTxns: Transaction[] = [
        parent,
        { id: 21, parentId: 20, accountId: 1, categoryId: 10, date: "2026-06-10", payee: "Payroll Split", amount: "40000", cleared: true },
        { id: 22, parentId: 20, accountId: 1, categoryId: null, transferAccountId: 2, date: "2026-06-10", payee: "Transfer : Savings", amount: "10000", cleared: true },
      ];
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          allTransactions={allTxns}
          initial={parent}
          onClose={() => {}}
          onSave={() => {}}
          onDelete={onDelete}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
      expect(screen.getByText('Delete "Payroll Split"?')).toBeInTheDocument();
      expect(screen.getByText(/split transaction/i)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
      });
      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("renders fallback title 'Delete Transaction?' when initial payee is empty", () => {
      const initial: Transaction = {
        id: 30,
        accountId: 1,
        categoryId: 10,
        date: "2026-06-10",
        payee: "   ",
        memo: "",
        amount: "-1000",
        cleared: true,
      };
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          initial={initial}
          onClose={() => {}}
          onSave={() => {}}
          onDelete={() => {}}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
      expect(screen.getByText("Delete Transaction?")).toBeInTheDocument();
    });

    it("resets confirmingDelete state when initial transaction id changes", () => {
      const t1: Transaction = {
        id: 41,
        accountId: 1,
        categoryId: 10,
        date: "2026-06-10",
        payee: "Tx 1",
        memo: "",
        amount: "-1000",
        cleared: true,
      };
      const t2: Transaction = {
        id: 42,
        accountId: 1,
        categoryId: 10,
        date: "2026-06-10",
        payee: "Tx 2",
        memo: "",
        amount: "-2000",
        cleared: true,
      };

      const { rerender } = render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          initial={t1}
          onClose={() => {}}
          onSave={() => {}}
          onDelete={() => {}}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
      expect(screen.getByText('Delete "Tx 1"?')).toBeInTheDocument();

      // Rerender with t2
      rerender(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          initial={t2}
          onClose={() => {}}
          onSave={() => {}}
          onDelete={() => {}}
        />
      );
      expect(screen.getByText("Edit Transaction")).toBeInTheDocument();
      expect(screen.queryByText('Delete "Tx 1"?')).not.toBeInTheDocument();
    });
  });

  describe("transfer mode", () => {
    it("hides the Category field and shows the destination account dropdown", () => {
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={() => {}}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
      expect(screen.queryByRole("textbox", { name: /category/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /transfer to/i })).toBeInTheDocument();
    });

    it("renders the Transfer-to search input in the field position", () => {
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={() => {}}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
      const input = openSearchable(/transfer to/i);

      const list = screen.getByRole("listbox");
      expect(list).not.toContainElement(input);
      expect(input).toHaveFocus();

      fireEvent.change(input, { target: { value: "cre" } });
      const visible = within(list).getAllByRole("option");
      expect(visible.map((o) => o.textContent)).toEqual(["Credit"]);
    });

    it("does not allow selecting the 'Select account…' placeholder", () => {
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
      openSearchable(/transfer to/i);

      const placeholder = screen.getByRole("option", { name: /select account/i });
      expect(placeholder).toBeDisabled();
      expect(screen.getByRole("option", { name: "Credit" })).toBeEnabled();

      // Clicking the placeholder must not commit a destination.
      fireEvent.click(placeholder);
      fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-100" } });
      fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
      expect(onSave).not.toHaveBeenCalled();
    });

    it("calls onSave with transferAccountId and the destination name as payee", () => {
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
      fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-100" } });
      pickFromOpenSearchableByValue(/transfer to/i, "2");
      fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave.mock.calls[0]![0]).toMatchObject({
        accountId: 1,
        transferAccountId: 2,
        categoryId: null,
        amount: -10000,
        payee: "Transfer : Credit",
      });
    });

    it("does not call onSave when no destination account is chosen", () => {
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
      fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-100" } });
      fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
      expect(onSave).not.toHaveBeenCalled();
    });

    it("requires category for boundary transfer outflow to off-budget account", () => {
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
      fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-100" } });
      // Select Brokerage (account 3, off-budget)
      pickFromOpenSearchableByValue(/transfer to/i, "3");

      // Category selector should now appear because it's a boundary outflow
      expect(screen.getByRole("button", { name: /category/i })).toBeInTheDocument();

      // Save button should be disabled when category is not yet picked
      const saveBtn = screen.getByRole("button", { name: /save transaction/i });
      expect(saveBtn).toBeDisabled();

      // Pick Groceries category (id 10)
      pickFromOpenSearchableByValue(/category/i, "10");
      expect(saveBtn).toBeEnabled();

      fireEvent.click(saveBtn);
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave.mock.calls[0]![0]).toMatchObject({
        accountId: 1,
        transferAccountId: 3,
        categoryId: 10,
        amount: -10000,
        payee: "Transfer : Brokerage",
      });
    });

    it("supports boundary transfer inflow from off-budget account", () => {
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
      // +100 inflow to Chequing from Brokerage
      fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "100" } });
      pickFromOpenSearchableByValue(/transfer to/i, "3");

      const saveBtn = screen.getByRole("button", { name: /save transaction/i });
      expect(saveBtn).toBeEnabled();

      fireEvent.click(saveBtn);
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave.mock.calls[0]![0]).toMatchObject({
        accountId: 1,
        transferAccountId: 3,
        categoryId: null,
        amount: 10000,
        payee: "Transfer : Brokerage",
      });
    });
  });

  describe("split mode", () => {
    it("reveals a sub-row editor with the parent amount as 'Total'", () => {
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={() => {}}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
      expect(screen.getByText("Total Amount")).toBeInTheDocument();
      expect(screen.getByText("Sub-transactions")).toBeInTheDocument();
    });

    it("disables save until children sum equals the parent total", () => {
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
      fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
        target: { value: "Costco" },
      });
      // Type the parent total first.
      const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
      const parent = allZeros[0]!;
      fireEvent.change(parent, { target: { value: "-100" } });
      // Type child amounts that DON'T sum to 100 yet.
      const subAmounts = allZeros.slice(1) as HTMLInputElement[];
      fireEvent.change(subAmounts[0]!, { target: { value: "60" } });
      fireEvent.change(subAmounts[1]!, { target: { value: "39.99" } });
      // Sum 99.99 ≠ 100 → save disabled.
      const saveBtn = screen.getByRole("button", { name: /save transaction/i });
      expect(saveBtn).toBeDisabled();
      fireEvent.click(saveBtn);
      expect(onSave).not.toHaveBeenCalled();
    });

    it("enables save and emits subTransactions when children sum matches the parent", () => {
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
      fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
        target: { value: "Costco" },
      });
      const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
      const parent = allZeros[0]!;
      fireEvent.change(parent, { target: { value: "-100" } });

      const subAmounts = allZeros.slice(1) as HTMLInputElement[];
      pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:10");
      pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:11");
      // Children retain the sign the user types. Parent is -100, so we
      // type -60 and -40; the sum matches the parent.
      fireEvent.change(subAmounts[0]!, { target: { value: "-60" } });
      fireEvent.change(subAmounts[1]!, { target: { value: "-40" } });

      const saveBtn = screen.getByRole("button", { name: /save transaction/i });
      expect(saveBtn).not.toBeDisabled();
      fireEvent.click(saveBtn);
      expect(onSave).toHaveBeenCalledTimes(1);
      const payload = onSave.mock.calls[0]![0] as {
        amount: number;
        subTransactions: { categoryId: number; amount: number }[];
        categoryId: number | null;
      };
      expect(payload.amount).toBe(-10000);
      expect(payload.categoryId).toBeNull();
      expect(payload.subTransactions).toHaveLength(2);
      // Children are passed through with their typed sign (no coercion).
      expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, amount: -6000 });
      expect(payload.subTransactions[1]).toMatchObject({ categoryId: 11, amount: -4000 });
    });

    it("enables save for a mixed-sign split (Paycheck + tax deduction)", () => {
      // Bug fix: a +4000 net paycheck with a +5000 gross pay and a
      // -1000 tax deduction. The new signed-sum validation must accept
      // this and the modal must pass the signed values through to onSave.
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
      fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
        target: { value: "Employer Inc." },
      });
      const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
      const parent = allZeros[0]!;
      fireEvent.change(parent, { target: { value: "4000" } });

      const subAmounts = allZeros.slice(1) as HTMLInputElement[];
      pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:10");
      pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:11");
      fireEvent.change(subAmounts[0]!, { target: { value: "5000" } });
      fireEvent.change(subAmounts[1]!, { target: { value: "-1000" } });

      const saveBtn = screen.getByRole("button", { name: /save transaction/i });
      expect(saveBtn).not.toBeDisabled();
      fireEvent.click(saveBtn);
      expect(onSave).toHaveBeenCalledTimes(1);
      const payload = onSave.mock.calls[0]![0] as {
        amount: number;
        subTransactions: { categoryId: number; amount: number }[];
      };
      expect(payload.amount).toBe(400000);
      expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, amount: 500000 });
      expect(payload.subTransactions[1]).toMatchObject({ categoryId: 11, amount: -100000 });
    });

    it("keeps save disabled when signed child sum doesn't match parent", () => {
      // Parent +4000, children +5000 and -2000 → +3000 ≠ +4000.
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
      fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
        target: { value: "X" },
      });
      const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
      const parent = allZeros[0]!;
      fireEvent.change(parent, { target: { value: "4000" } });
      const subAmounts = allZeros.slice(1) as HTMLInputElement[];
      pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:10");
      pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:11");
      fireEvent.change(subAmounts[0]!, { target: { value: "5000" } });
      fireEvent.change(subAmounts[1]!, { target: { value: "-2000" } });

      const saveBtn = screen.getByRole("button", { name: /save transaction/i });
      expect(saveBtn).toBeDisabled();
      fireEvent.click(saveBtn);
      expect(onSave).not.toHaveBeenCalled();
    });

    it("enables save for a split containing a transfer sub-transaction", () => {
      const onSave = vi.fn();
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={1}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
      fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
        target: { value: "Split with Transfer" },
      });
      const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
      const parent = allZeros[0]!;
      fireEvent.change(parent, { target: { value: "-100" } });

      const subAmounts = allZeros.slice(1) as HTMLInputElement[];
      pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:10");
      pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "transfer:2");
      fireEvent.change(subAmounts[0]!, { target: { value: "-60" } });
      fireEvent.change(subAmounts[1]!, { target: { value: "-40" } });

      const saveBtn = screen.getByRole("button", { name: /save transaction/i });
      expect(saveBtn).not.toBeDisabled();
      fireEvent.click(saveBtn);
      expect(onSave).toHaveBeenCalledTimes(1);
      const payload = onSave.mock.calls[0]![0] as {
        amount: number;
        subTransactions: { categoryId: number | null; transferAccountId: number | null; amount: number }[];
      };
      expect(payload.amount).toBe(-10000);
      expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, transferAccountId: null, amount: -6000 });
      expect(payload.subTransactions[1]).toMatchObject({ categoryId: null, transferAccountId: 2, amount: -4000 });
    });

    it("pre-populates sub-rows when editing an existing split parent", () => {
      const onSave = vi.fn();
      const initial: Transaction = {
        id: 1,
        accountId: 1,
        categoryId: null,
        date: "2026-07-01",
        payee: "Costco",
        memo: "",
        amount: "-10000",
        cleared: true,
      };
      const allTransactions: Transaction[] = [
        initial,
        {
          id: 2,
          accountId: 1,
          categoryId: 10,
          date: "2026-07-01",
          payee: "Costco",
          memo: "",
          amount: "-6000",
          cleared: true,
          parentId: 1,
        },
        {
          id: 3,
          accountId: 1,
          categoryId: 11,
          date: "2026-07-01",
          payee: "Costco",
          memo: "",
          amount: "-4000",
          cleared: true,
          parentId: 1,
        },
      ];
      render(
        <TransactionModal
          accounts={accounts}
          categories={categories}
          defaultAccountId={null}
          initial={initial}
          allTransactions={allTransactions}
          onClose={() => {}}
          onSave={onSave}
        />
      );
      const saveBtn = screen.getByRole("button", { name: /save changes/i });
      expect(saveBtn).not.toBeDisabled();
      fireEvent.click(saveBtn);
      expect(onSave).toHaveBeenCalledTimes(1);
      const payload = onSave.mock.calls[0]![0] as {
        id: number;
        subTransactions: { categoryId: number; amount: number }[];
      };
      expect(payload.id).toBe(1);
      expect(payload.subTransactions).toHaveLength(2);
    });
  });
});

describe("RecurringModal", () => {
  it("renders all 13 frequencies as available options (UNI-23)", () => {
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        onClose={() => {}}
        onSave={() => {}}
      />
    );
    const trigger = screen.getByRole("button", { name: /frequency/i });
    fireEvent.click(trigger);
    const list = screen.getByRole("listbox");
    const optionEls = within(list).getAllByRole("option") as HTMLButtonElement[];
    const values = optionEls.map((o) => o.getAttribute("data-value"));
    expect(values).toHaveLength(13);
    expect(values).toEqual([
      "never",
      "daily",
      "weekly",
      "everyotherweek",
      "twiceamonth",
      "every4weeks",
      "monthly",
      "everyothermonth",
      "every3months",
      "every4months",
      "twiceayear",
      "yearly",
      "every2years",
    ]);
  });

  it("calls onSave with a signed amount (no Outflow/Inflow toggle)", () => {
    const onSave = vi.fn();
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Hydro" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-80" } });
    pickFromOpenDropdownByValue(/frequency/i, "everyotherweek");
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      payee: "Hydro",
      amount: -8000,
      frequency: "everyotherweek",
    });
  });

  it("hides category picker and saves categoryId null in recurring modal when account is off-budget", () => {
    const onSave = vi.fn();
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={3} // Brokerage (off-budget)
        onClose={() => {}}
        onSave={onSave}
      />
    );
    // Category dropdown trigger should not be in the document
    expect(screen.queryByRole("button", { name: /category/i })).not.toBeInTheDocument();

    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Monthly Dividend" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      accountId: 3,
      payee: "Monthly Dividend",
      amount: 15000,
      categoryId: null,
    });
  });

  it("offers the searchable payee list in the recurring modal", () => {
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        payees={[{ value: "Telus", label: "Telus" }]}
        defaultAccountId={null}
        onClose={() => {}}
        onSave={() => {}}
      />
    );
    const input = openSearchlistByPlaceholder("e.g. Whole Foods");
    fireEvent.change(input, { target: { value: "tel" } });
    expect(screen.getByRole("option", { name: "Telus" })).toBeInTheDocument();
  });

  it("pre-fills the values and saves with id when editing", () => {
    const onSave = vi.fn();
    const initial: Recurring = {
      id: 7,
      accountId: 1,
      categoryId: 10,
      payee: "Spotify",
      amount: "-999",
      frequency: "monthly",
      nextDate: "2026-07-01",
      active: true,
    };
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        initial={initial}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: 7, payee: "Spotify", active: true });
  });

  it("renders Transfer mode and emits transferAccountId on save", () => {
    const onSave = vi.fn();
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
    // Source account stays the first one (Chequing); pick the destination.
    pickFromOpenSearchableByValue(/transfer to/i, "2");
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-500" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      accountId: 1,
      transferAccountId: 2,
      amount: -50000,
    });
    expect(payload.categoryId).toBeNull();
    // Payee auto-derived as "Transfer : Credit" since blank.
    expect(payload.payee).toBe("Transfer : Credit");
  });

  it("does not allow selecting the 'Select account…' placeholder in Transfer mode", () => {
    const onSave = vi.fn();
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^transfer$/i }));
    openSearchable(/transfer to/i);

    const placeholder = screen.getByRole("option", { name: /select account/i });
    expect(placeholder).toBeDisabled();
    expect(screen.getByRole("option", { name: "Credit" })).toBeEnabled();
  });

  it("renders Split mode and emits subTransactions on save", () => {
    const onSave = vi.fn();
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Costco" },
    });
    const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    const total = allZeros[0]!;
    fireEvent.change(total, { target: { value: "-200" } });

    const subAmounts = allZeros.slice(1) as HTMLInputElement[];
    pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:10");
    pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:11");
    // Children retain the typed sign (no coercion by the modal).
    fireEvent.change(subAmounts[0]!, { target: { value: "-120" } });
    fireEvent.change(subAmounts[1]!, { target: { value: "-80" } });

    const memoInputs = screen.getAllByPlaceholderText("Memo") as HTMLInputElement[];
    fireEvent.change(memoInputs[0]!, { target: { value: "Weekly food" } });
    fireEvent.change(memoInputs[1]!, { target: { value: "Supplies" } });

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![0] as {
      amount: number;
      subTransactions: { categoryId: number; amount: number; memo?: string }[];
      categoryId: number | null;
      payee: string;
    };
    expect(payload.amount).toBe(-20000);
    expect(payload.categoryId).toBeNull();
    expect(payload.payee).toBe("Costco");
    expect(payload.subTransactions).toHaveLength(2);
    expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, amount: -12000, memo: "Weekly food" });
    expect(payload.subTransactions[1]).toMatchObject({ categoryId: 11, amount: -8000, memo: "Supplies" });
  });

  it("re-uses transferAccountId and subTransactions when editing", () => {
    const onSave = vi.fn();
    const initial = {
      id: 9,
      accountId: 1,
      categoryId: null,
      payee: "AMEX Payment",
      amount: "-100000",
      frequency: "monthly",
      nextDate: "2026-07-20",
      active: true,
      transferAccountId: 2,
    };
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        initial={initial}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    // The Transfer toggle should be active.
    const transferBtn = screen.getByRole("button", { name: /^transfer$/i });
    expect(transferBtn.className).toMatch(/primary|active/);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      id: 9,
      accountId: 1,
      transferAccountId: 2,
      payee: "AMEX Payment",
      amount: -100000,
    });
  });

  it("opens a split row in split mode with its children pre-populated", () => {
    const onSave = vi.fn();
    const subs: RecurringSubTransaction[] = [
      { id: 1, recurringId: 9, categoryId: 10, amount: "-12000", memo: "g", sort: 0 },
      { id: 2, recurringId: 9, categoryId: 11, amount: "-8000",  memo: "h", sort: 1 },
    ];
    const initial = {
      id: 9,
      accountId: 1,
      categoryId: null,
      payee: "Costco",
      amount: "-20000",
      frequency: "monthly",
      nextDate: "2026-07-01",
      active: true,
      subTransactions: subs,
    };
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        initial={initial}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    const splitBtn = screen.getByRole("button", { name: /^split$/i });
    expect(splitBtn.className).toMatch(/primary|active/);
    // Single is disabled when the initial is a split.
    const singleBtn = screen.getByRole("button", { name: /^single$/i });
    expect(singleBtn).toBeDisabled();
  });

  it("emits a mixed-sign split (Paycheck + tax deduction)", () => {
    // Bug fix: a +4000 net biweekly paycheck with a +5000 gross pay
    // and a -1000 tax deduction is valid under the new signed validation.
    const onSave = vi.fn();
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Employer Inc." },
    });
    const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    const total = allZeros[0]!;
    fireEvent.change(total, { target: { value: "4000" } });

    const subAmounts = allZeros.slice(1) as HTMLInputElement[];
    pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:10");
    pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:11");
    fireEvent.change(subAmounts[0]!, { target: { value: "5000" } });
    fireEvent.change(subAmounts[1]!, { target: { value: "-1000" } });

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![0] as {
      amount: number;
      subTransactions: { categoryId: number; amount: number }[];
    };
    expect(payload.amount).toBe(400000);
    expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, amount: 500000 });
    expect(payload.subTransactions[1]).toMatchObject({ categoryId: 11, amount: -100000 });
  });

  it("allows saving an imported paycheck split with a positive null-category income child", () => {
    const onSave = vi.fn();
    const subs: RecurringSubTransaction[] = [
      { id: 1, recurringId: 9, categoryId: null, amount: "300000", memo: "Gross pay", sort: 0 },
      { id: 2, recurringId: 9, categoryId: 10, amount: "-50000", memo: "Tax", sort: 1 },
    ];
    const initial = {
      id: 9,
      accountId: 1,
      categoryId: null,
      payee: "Employer Inc.",
      amount: "250000",
      frequency: "biweekly",
      nextDate: "2026-07-15",
      active: true,
      subTransactions: subs,
    };
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        initial={initial}
        onClose={() => {}}
        onSave={onSave}
      />
    );

    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![0] as {
      id?: number;
      amount: number;
      subTransactions: { categoryId: number | null; amount: number; memo?: string }[];
    };
    expect(payload.id).toBe(9);
    expect(payload.amount).toBe(250000);
    expect(payload.subTransactions).toHaveLength(2);
    expect(payload.subTransactions[0]).toMatchObject({
      categoryId: null,
      amount: 300000,
      memo: "Gross pay",
    });
    expect(payload.subTransactions[1]).toMatchObject({
      categoryId: 10,
      amount: -50000,
      memo: "Tax",
    });
  });
});

describe("GroupModal", () => {
  it("calls onSave with the trimmed name when creating", () => {
    const onSave = vi.fn();
    render(<GroupModal onClose={() => {}} onSave={onSave} />);
    expect(screen.getByText("New Category Group")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Bills  " } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("Bills");
  });

  it("does not call onSave for an empty name", () => {
    const onSave = vi.fn();
    render(<GroupModal onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("pre-fills the name and uses the rename title when editing", () => {
    const onSave = vi.fn();
    render(<GroupModal initialName="Everyday" onClose={() => {}} onSave={onSave} />);
    expect(screen.getByText("Rename Group")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Everyday")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Daily" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("Daily");
  });

  it("calls onClose from Cancel", () => {
    const onClose = vi.fn();
    render(<GroupModal onClose={onClose} onSave={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("AccountModal", () => {
  it("saves a liquid account with a positive balance", () => {
    const onSave = vi.fn();
    render(<AccountModal onClose={() => {}} onSave={onSave} />);
    expect(screen.getAllByText("Add Account")[0]).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
      target: { value: "Savings" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "250.75" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add account$/i }));
    expect(onSave).toHaveBeenCalledWith({
      name: "Savings",
      kind: "liquid",
      groupLabel: "Liquid",
      balance: 25075,
      onBudget: true,
    });
  });

  it("saves a credit card account on-budget", () => {
    const onSave = vi.fn();
    render(<AccountModal onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
      target: { value: "Visa" },
    });
    pickFromOpenDropdownByValue(/type/i, "credit");
    expect(
      screen.getByText("Credit card balance represents debt owed (stored as a negative starting balance).")
    ).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "-300" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add account$/i }));
    expect(onSave).toHaveBeenCalledWith({
      name: "Visa",
      kind: "credit",
      groupLabel: "Credit Cards",
      balance: -30000,
      onBudget: true,
    });
  });

  it("saves an off-budget account", () => {
    const onSave = vi.fn();
    render(<AccountModal onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox", { name: /name/i }), {
      target: { value: "RRSP" },
    });
    pickFromOpenDropdownByValue(/type/i, "offbudget");
    fireEvent.click(screen.getByRole("button", { name: /^add account$/i }));
    expect(onSave).toHaveBeenCalledWith({
      name: "RRSP",
      kind: "offbudget",
      groupLabel: "Retirement",
      balance: 0,
      onBudget: false,
    });
  });

  it("does not call onSave when the name is empty", () => {
    const onSave = vi.fn();
    render(<AccountModal onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /^add account$/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("pre-fills and saves the edit payload", () => {
    const onSave = vi.fn();
    render(
      <AccountModal
        initial={{ name: "Chequing", kind: "liquid", balance: "-12500" }}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    expect(screen.getByText("Edit Account")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Chequing")).toBeInTheDocument();
    expect(screen.getByDisplayValue("125.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    expect(onSave).toHaveBeenCalledWith({
      name: "Chequing",
      kind: "liquid",
      groupLabel: "Liquid",
      balance: 12500,
      onBudget: true,
    });
  });

  it("calls onClose from Cancel", () => {
    const onClose = vi.fn();
    render(<AccountModal onClose={onClose} onSave={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("triggers onArchive from the confirmation step in edit mode", async () => {
    const onArchive = vi.fn();
    render(
      <AccountModal
        initial={{ id: 1, name: "Active Checking", kind: "liquid", balance: "10000", onBudget: true, sort: 0 }}
        onClose={() => {}}
        onSave={() => {}}
        onArchive={onArchive}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /archive account/i }));
    expect(screen.getByText(/archived accounts are hidden/i)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes, archive it/i }));
    });
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("triggers onUnarchive when editing an archived account", async () => {
    const onUnarchive = vi.fn();
    render(
      <AccountModal
        initial={{ id: 2, name: "Old Checking", kind: "liquid", balance: "0", onBudget: true, sort: 1, archived: true }}
        onClose={() => {}}
        onSave={() => {}}
        onUnarchive={onUnarchive}
      />
    );

    expect(screen.getByText(/edit account \(archived\)/i)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /unarchive account/i }));
    });
    expect(onUnarchive).toHaveBeenCalledTimes(1);
  });
});
