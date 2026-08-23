import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { TransactionsView } from "../src/TransactionsView.js";
import { makeSeedBudgetData, type TransactionFlagColor } from "@ynab/logic";

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
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    expect(screen.getAllByText("Superstore").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SAP Concur").length).toBeGreaterThan(0);

    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: "Superstore" } });
    expect(screen.getAllByText("Superstore").length).toBeGreaterThan(0);
    expect(screen.queryByText("SAP Concur")).not.toBeInTheDocument();
  });

  it("calls onAdd when Add a new transaction is clicked", () => {
    const onAdd = vi.fn();
    render(
      <TransactionsView
        data={makeSeedBudgetData()}
        accountFilter={null}
        onAdd={onAdd}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /add.*transaction/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("renders a Balance column anchored at each account's current balance", () => {
    const data = makeSeedBudgetData();
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

    expect(screen.getByText("Balance")).toBeInTheDocument();

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
      amount: "-15000",
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
      amount: "-10000",
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
      amount: "-5000",
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

    expect(screen.getAllByText("Costco Wholesale Split").length).toBe(1);
    expect(screen.getByText("Split (Multiple Categories)")).toBeInTheDocument();

    expect(screen.queryByText("Groceries part")).not.toBeInTheDocument();
    expect(screen.queryByText("Electronics part")).not.toBeInTheDocument();
    expect(screen.queryByText("↳")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Costco Wholesale Split"));
    expect(onEdit).toHaveBeenCalledWith(9001);
  });

  it("renders incoming split transfers on the destination account register", () => {
    const data = makeSeedBudgetData();
    const onEdit = vi.fn();
    const splitParent = {
      id: 9100,
      accountId: 1,
      categoryId: null,
      date: "2026-07-20",
      payee: "Expense & Visa Transfer",
      memo: "Combined",
      amount: "-10000",
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
      amount: "-6000",
      status: "c" as const,
      transferAccountId: null,
      parentId: 9100,
    };
    const splitTransferChild = {
      id: 9102,
      accountId: 1,
      categoryId: null,
      date: "2026-07-20",
      payee: "Transfer : Scotia Passport Visa",
      memo: "Visa transfer part",
      amount: "-4000",
      status: "c" as const,
      transferAccountId: 6,
      parentId: 9100,
    };

    data.transactions.unshift(splitParent, splitExpenseChild, splitTransferChild);

    render(
      <TransactionsView
        data={data}
        accountFilter={6}
        onAdd={() => {}}
        onEdit={onEdit}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    expect(screen.getByText("Transfer : TD Unlimited Chequing")).toBeInTheDocument();
    expect(screen.getByText("$40.00")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Transfer : TD Unlimited Chequing"));
    expect(onEdit).toHaveBeenCalledWith(9100);
  });

  it("supports keyboard navigation (ArrowDown/Up, Enter, 'c', Delete)", () => {
    const data = makeSeedBudgetData();
    const onEdit = vi.fn();
    const onCycleStatus = vi.fn();
    const onDelete = vi.fn();

    const { container } = render(
      <TransactionsView
        data={data}
        accountFilter={null}
        onAdd={() => {}}
        onEdit={onEdit}
        onDelete={onDelete}
        onReconcile={() => {}}
        onCycleStatus={onCycleStatus}
      />
    );

    const scrollContainer = container.querySelector(".y-scroll")!;
    expect(scrollContainer).toBeInTheDocument();

    // Arrow down selects the first row
    fireEvent.keyDown(scrollContainer, { key: "ArrowDown" });
    // Press 'c' to cycle status of selected row
    fireEvent.keyDown(scrollContainer, { key: "c" });
    expect(onCycleStatus).toHaveBeenCalledTimes(1);

    // Press Enter to edit selected row. Opening the editor clears the
    // selection so the row is not still highlighted after cancelling.
    fireEvent.keyDown(scrollContainer, { key: "Enter" });
    expect(onEdit).toHaveBeenCalledTimes(1);

    // Re-select a row with the keyboard before deleting it.
    fireEvent.keyDown(scrollContainer, { key: "ArrowDown" });
    // Press Delete to delete selected row
    fireEvent.keyDown(scrollContainer, { key: "Delete" });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("clears the row selection when the edit modal is opened", () => {
    const data = makeSeedBudgetData();
    const onEdit = vi.fn();
    const { container } = render(
      <TransactionsView
        data={data}
        accountFilter={null}
        onAdd={() => {}}
        onEdit={onEdit}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    // Keyboard-select the first row, then press Enter to open the editor.
    const scrollContainer = container.querySelector(".y-scroll")!;
    fireEvent.keyDown(scrollContainer, { key: "ArrowDown" });
    expect(container.querySelector("tr.y-row--selected")).not.toBeNull();

    fireEvent.keyDown(scrollContainer, { key: "Enter" });
    expect(onEdit).toHaveBeenCalledTimes(1);

    // The selection is cleared once the modal opens, so cancelling the
    // modal leaves no highlighted row behind.
    expect(container.querySelector("tr.y-row--selected")).toBeNull();
  });

  it("supports multi-selection and bulk actions", async () => {
    const data = makeSeedBudgetData();
    const onBulkDelete = vi.fn();
    const onBulkUpdate = vi.fn();

    render(
      <TransactionsView
        data={data}
        accountFilter={null}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
        onBulkDelete={onBulkDelete}
        onBulkUpdate={onBulkUpdate}
      />
    );

    const rowCheckboxes = screen.getAllByRole("checkbox");
    const firstRowCheckbox = rowCheckboxes[1]!;
    fireEvent.click(firstRowCheckbox);

    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark cleared/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark uncleared/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete \(1\)/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /mark cleared/i }));
    expect(onBulkUpdate).toHaveBeenCalledWith(expect.any(Array), { status: "c" });

    fireEvent.click(firstRowCheckbox);
    expect(screen.getByRole("button", { name: /delete \(1\)/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /delete \(1\)/i }));
    expect(onBulkDelete).toHaveBeenCalledWith(expect.any(Array));
  });

  it("renders scheduled transactions drawer, toggles it, and handles schedule/post actions", () => {
    const data = makeSeedBudgetData();
    const onAddRecurring = vi.fn();
    const onAddRecurringTransfer = vi.fn();
    const onEditRecurring = vi.fn();
    const onPostRecurring = vi.fn();

    render(
      <TransactionsView
        data={data}
        accountFilter={1}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
        onAddRecurring={onAddRecurring}
        onAddRecurringTransfer={onAddRecurringTransfer}
        onEditRecurring={onEditRecurring}
        onPostRecurring={onPostRecurring}
      />
    );

    // Scheduled Transactions toggle button exists
    const drawerBtn = screen.getByRole("button", { name: /scheduled transactions/i });
    expect(drawerBtn).toBeInTheDocument();

    // Drawer is open by default
    expect(screen.getByRole("button", { name: /schedule a new transaction/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /schedule a transfer/i })).toBeInTheDocument();

    // Trigger schedule buttons
    fireEvent.click(screen.getByRole("button", { name: /schedule a new transaction/i }));
    expect(onAddRecurring).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /schedule a transfer/i }));
    expect(onAddRecurringTransfer).toHaveBeenCalledTimes(1);

    // Click toggle button to collapse drawer
    fireEvent.click(drawerBtn);
    expect(screen.queryByRole("button", { name: /schedule a new transaction/i })).not.toBeInTheDocument();

    // Click toggle button again to reopen
    fireEvent.click(drawerBtn);
    expect(screen.getByRole("button", { name: /schedule a new transaction/i })).toBeInTheDocument();
  });

  describe("column sorting", () => {
    const renderView = (data = makeSeedBudgetData()) =>
      render(
        <TransactionsView
          data={data}
          accountFilter={null}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
        />
      );

    const visiblePayees = (): string[] => {
      const tbody = screen.getAllByRole("rowgroup")[1]!;
      // A flag column (when present) shifts every data cell one column right.
      const hasFlagHeader = screen.queryAllByRole("columnheader", { name: /^f$/i }).length > 0;
      const payeeIdx = hasFlagHeader ? 4 : 3;
      const payees: string[] = [];
      for (const r of within(tbody).getAllByRole("row")) {
        const cells = within(r).getAllByRole("cell");
        if (cells.length <= payeeIdx) continue;
        payees.push(cells[payeeIdx]!.textContent ?? "");
      }
      return payees;
    };

    const mk = (id: number, payee: string, amount = "-100", flagColor?: TransactionFlagColor | "duplicate" | null) => ({
      id: 100000 + id,
      accountId: 1,
      categoryId: null,
      date: "2026-07-01",
      payee,
      memo: "",
      amount,
      status: "c" as const,
      transferAccountId: null,
      parentId: null,
      ...(flagColor !== undefined ? { flagColor } : {}),
    });

    it("defaults to Date descending and toggles direction on header clicks", () => {
      renderView();
      const dateTh = screen.getAllByRole("columnheader", { name: /^date/i })[0]!;
      expect(dateTh).toHaveAttribute("aria-sort", "descending");

      fireEvent.click(screen.getByRole("button", { name: /^date$/i }));
      expect(dateTh).toHaveAttribute("aria-sort", "ascending");

      fireEvent.click(screen.getByRole("button", { name: /^date$/i }));
      expect(dateTh).toHaveAttribute("aria-sort", "descending");
    });

    it("sorts rows by Payee on header click, toggling asc/desc", () => {
      const data = makeSeedBudgetData();
      // Copy the (module-shared) transactions array before adding rows so
      // we never mutate the seed state reused by later tests.
      data.transactions = [
        ...data.transactions,
        mk(1, "SORTX MMM Middle"),
        mk(2, "SORTX ZZZ Apple"),
        mk(3, "SORTX AAA Zebra"),
      ];
      renderView(data);

      // Scope the register to just our rows so all of them fit in the
      // virtualization window.
      fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "sortx" } });

      fireEvent.click(screen.getByRole("button", { name: /^payee$/i }));
      expect(visiblePayees()).toEqual(["SORTX AAA Zebra", "SORTX MMM Middle", "SORTX ZZZ Apple"]);

      fireEvent.click(screen.getByRole("button", { name: /^payee$/i }));
      expect(visiblePayees()).toEqual(["SORTX ZZZ Apple", "SORTX MMM Middle", "SORTX AAA Zebra"]);
    });

    it("sorts the Outflow column numerically", () => {
      const data = makeSeedBudgetData();
      data.transactions = [
        ...data.transactions,
        mk(1, "SORTX O Small", "-100"),
        mk(2, "SORTX O Medium", "-5000"),
        mk(3, "SORTX O Big", "-99999900"),
      ];
      renderView(data);

      fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "sortx" } });

      fireEvent.click(screen.getByRole("button", { name: /^outflow$/i }));
      expect(visiblePayees()).toEqual(["SORTX O Small", "SORTX O Medium", "SORTX O Big"]);

      fireEvent.click(screen.getByRole("button", { name: /^outflow$/i }));
      expect(visiblePayees()).toEqual(["SORTX O Big", "SORTX O Medium", "SORTX O Small"]);
    });

    it("sorts rows by flag color when the F header is clicked", () => {
      const data = makeSeedBudgetData();
      data.transactions = [
        ...data.transactions,
        mk(1, "SORTX F Purple", "-100", "purple"),
        mk(2, "SORTX F None", "-100", null),
        mk(3, "SORTX F Red", "-100", "red"),
      ];
      renderView(data);

      fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "sortx" } });

      // Ascending: unflagged first, then palette order (red before purple).
      fireEvent.click(screen.getByRole("button", { name: /^f$/i }));
      expect(visiblePayees()).toEqual(["SORTX F None", "SORTX F Red", "SORTX F Purple"]);

      fireEvent.click(screen.getByRole("button", { name: /^f$/i }));
      expect(visiblePayees()).toEqual(["SORTX F Purple", "SORTX F Red", "SORTX F None"]);
    });

    it("keeps the selection column width and reserves sort indicator space", () => {
      const { container } = renderView();
      const firstTh = screen.getAllByRole("columnheader")[0]!;
      expect(firstTh).toHaveStyle("width: 34px");

      // Every sortable header always reserves an indicator slot so the table
      // never reflows when the active sort column changes.
      const sortBtns = Array.from(container.querySelectorAll(".y-sort-btn"));
      expect(sortBtns.length).toBeGreaterThan(0);
      for (const btn of sortBtns) {
        expect(btn.querySelector(".y-sort-ind")).not.toBeNull();
      }

      // Sorting by Payee must not shrink the selection column.
      fireEvent.click(screen.getByRole("button", { name: /^payee$/i }));
      expect(screen.getAllByRole("columnheader")[0]).toHaveStyle("width: 34px");
    });

    it("keeps the register and scheduled headers sticky via y-thead--sticky", () => {
      renderView();
      const stickyHeaders = document.querySelectorAll(
        "table.y-table thead.y-thead--sticky"
      );
      // Register table + scheduled transactions drawer table.
      expect(stickyHeaders.length).toBe(2);
    });

    it("checks and selects the transaction specified by focusTransaction", () => {
      const data = makeSeedBudgetData();
      // data has transaction with id 2
      render(
        <TransactionsView
          data={data}
          accountFilter={null}
          focusTransaction={{ id: 2, nonce: 1 }}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
          onFlag={() => {}}
        />
      );

      // Row with data-txn-id="2" should have is-sel class and its checkbox should be checked
      const row = document.querySelector('tr[data-txn-id="2"]');
      expect(row).not.toBeNull();
      expect(row!.classList.contains("is-sel")).toBe(true);

      const checkbox = row!.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox).not.toBeNull();
      expect(checkbox.checked).toBe(true);

      // Summary bar should show 1 selected
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });
  });
});

