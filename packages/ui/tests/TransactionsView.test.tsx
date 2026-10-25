import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { SCHEDULED_HEIGHT_STORAGE_KEY, TransactionsView } from "../src/TransactionsView.js";
import { addDaysISO, duplicateFingerprint, makeSeedBudgetData, todayISO, type BudgetData, type Query, type TransactionFlagColor } from "@ynab/logic";

describe("TransactionsView", () => {
  it("renders transaction rows and narrows them via an applied search query", () => {
    const data = makeSeedBudgetData();
    const props = {
      data,
      accountFilter: null as number | null,
      onAdd: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onReconcile: () => {},
      onCycleStatus: () => {},
    };
    const { rerender } = render(<TransactionsView {...props} />);

    expect(screen.getAllByText("Superstore").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SAP Concur").length).toBeGreaterThan(0);

    rerender(
      <TransactionsView
        {...props}
        externalFilter={{ query: { filters: [], text: "Superstore" }, nonce: 1 }}
      />
    );
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

  it("disables add actions and shows Closed badge plus notes on a closed account register", () => {
    const data = makeSeedBudgetData();
    data.accounts = data.accounts.map((a) =>
      a.id === 1 ? { ...a, archived: true, notes: "Closed after refinance" } : a
    );
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
    expect(screen.getByText("Closed", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Closed after refinance")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add.*transaction/i })).toBeDisabled();
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
    expect(balanceCell.textContent).toBe("-$8,053.19");
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

    data.transactions = [splitParent, splitChild1, splitChild2, ...data.transactions];

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

    // Collapsed by default
    expect(screen.queryByText("Groceries part")).not.toBeInTheDocument();
    expect(screen.queryByText("Electronics part")).not.toBeInTheDocument();
    expect(screen.queryByText("↳")).not.toBeInTheDocument();

    // Click expand button
    const expandBtn = screen.getByRole("button", { name: /expand split sub-transactions/i });
    fireEvent.click(expandBtn);

    // Now sub-rows are visible with their categories, memos, and ↳ glyphs
    expect(screen.getByText("Groceries part")).toBeInTheDocument();
    expect(screen.getByText("Electronics part")).toBeInTheDocument();
    expect(screen.getAllByText("↳").length).toBe(2);

    // Clicking collapse button hides them again
    const collapseBtn = screen.getByRole("button", { name: /collapse split sub-transactions/i });
    fireEvent.click(collapseBtn);
    expect(screen.queryByText("Groceries part")).not.toBeInTheDocument();
    expect(screen.queryByText("Electronics part")).not.toBeInTheDocument();

    // Clicking the parent row opens the edit modal with parent id
    fireEvent.click(screen.getByText("Costco Wholesale Split"));
    expect(onEdit).toHaveBeenCalledWith(9001);
  });

  it("clicking a child sub-row opens the parent split transaction in the edit modal (BUG-19)", () => {
    const data = makeSeedBudgetData();
    const onEdit = vi.fn();
    const splitParent = {
      id: 9001,
      accountId: 1,
      categoryId: null,
      date: "2026-07-15",
      payee: "Costco Wholesale Split",
      memo: "Combined run",
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

    data.transactions = [splitParent, splitChild1, splitChild2, ...data.transactions];

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

    // Expand
    fireEvent.click(screen.getByRole("button", { name: /expand split sub-transactions/i }));

    // Click child row
    fireEvent.click(screen.getByText("Groceries part"));
    expect(onEdit).toHaveBeenCalledWith(9001);
  });

  it("auto-expands split sub-transactions when searching for a child's memo or category (BUG-19)", () => {
    const data = makeSeedBudgetData();
    const splitParent = {
      id: 9001,
      accountId: 1,
      categoryId: null,
      date: "2026-07-15",
      payee: "Costco Wholesale Split",
      memo: "Combined run",
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
      memo: "UniqueGroceriesMemo123",
      amount: "-10000",
      status: "c" as const,
      transferAccountId: null,
      parentId: 9001,
    };

    data.transactions = [splitParent, splitChild1, ...data.transactions];

    render(
      <TransactionsView
        data={data}
        accountFilter={1}
        externalFilter={{ query: { filters: [], text: "UniqueGroceriesMemo123" }, nonce: 1 }}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    // Both parent and child should be rendered
    expect(screen.getAllByText("Costco Wholesale Split").length).toBe(2);
    expect(screen.getByText("UniqueGroceriesMemo123")).toBeInTheDocument();
    expect(screen.getByText("↳")).toBeInTheDocument();
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

    data.transactions = [splitParent, splitExpenseChild, splitTransferChild, ...data.transactions];

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
    const onEdit = vi.fn();
    const onBulkEdit = vi.fn();
    const onBulkDelete = vi.fn();
    const onBulkUpdate = vi.fn();

    render(
      <TransactionsView
        data={data}
        accountFilter={null}
        onAdd={() => {}}
        onEdit={onEdit}
        onBulkEdit={onBulkEdit}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
        onBulkDelete={onBulkDelete}
        onBulkUpdate={onBulkUpdate}
      />
    );

    const rowCheckboxes = screen.getAllByRole("checkbox");
    const firstRowCheckbox = rowCheckboxes[1]!;
    const secondRowCheckbox = rowCheckboxes[2]!;
    fireEvent.click(firstRowCheckbox);

    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark cleared/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark uncleared/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete \(1\)/i })).toBeInTheDocument();

    // Clicking Edit with 1 selected calls onEdit
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledWith(expect.any(Number));

    // Select second row -> Edit (2)
    fireEvent.click(secondRowCheckbox);
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    const editMultipleBtn = screen.getByRole("button", { name: /edit \(2\)/i });
    expect(editMultipleBtn).toBeInTheDocument();

    // Clicking Edit with >1 calls onBulkEdit
    fireEvent.click(editMultipleBtn);
    expect(onBulkEdit).toHaveBeenCalledWith(expect.any(Array));

    expect(screen.getByRole("button", { name: /delete \(2\)/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /delete \(2\)/i }));
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

  it("resizes the scheduled drawer height via the drag handle and remembers it per account", () => {
    window.localStorage.removeItem(SCHEDULED_HEIGHT_STORAGE_KEY);
    const data = makeSeedBudgetData();
    const base = {
      data,
      onAdd: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onReconcile: () => {},
      onCycleStatus: () => {},
    };
    const { rerender } = render(<TransactionsView {...base} accountFilter={1} />);
    if (!screen.queryByLabelText("Resize scheduled transactions")) {
      fireEvent.click(screen.getByRole("button", { name: /scheduled transactions/i }));
    }
    const drawer = document.querySelector(".y-scheduled-drawer") as HTMLElement;
    expect(drawer).toBeInTheDocument();
    // Auto height by default (no explicit inline height).
    expect(drawer.style.height).toBe("");

    const dragHandle = (clientY: number) => {
      fireEvent.mouseDown(screen.getByLabelText("Resize scheduled transactions"), { clientY: 500 });
      fireEvent.mouseMove(document, { clientY });
      fireEvent.mouseUp(document, { clientY });
    };

    // jsdom reports no layout height, so the drag delta from clientY 500 sets the height.
    dragHandle(300);
    expect(drawer.style.height).toBe("200px");
    expect(JSON.parse(window.localStorage.getItem(SCHEDULED_HEIGHT_STORAGE_KEY)!)).toEqual({ 1: 200 });

    // Another account still uses auto height until resized itself.
    rerender(<TransactionsView {...base} accountFilter={2} />);
    expect(drawer.style.height).toBe("");
    dragHandle(250);
    expect(drawer.style.height).toBe("250px");
    expect(JSON.parse(window.localStorage.getItem(SCHEDULED_HEIGHT_STORAGE_KEY)!)).toEqual({
      1: 200,
      2: 250,
    });

    // Switching back restores the first account's height.
    rerender(<TransactionsView {...base} accountFilter={1} />);
    expect(drawer.style.height).toBe("200px");

    // Double-click resets to auto height and forgets that account's value.
    fireEvent.doubleClick(screen.getByLabelText("Resize scheduled transactions"));
    expect(drawer.style.height).toBe("");
    expect(JSON.parse(window.localStorage.getItem(SCHEDULED_HEIGHT_STORAGE_KEY)!)).toEqual({ 2: 250 });

    window.localStorage.removeItem(SCHEDULED_HEIGHT_STORAGE_KEY);
  });

  it("bolds due scheduled rows like unreviewed imports, leaving future rows plain", () => {
    const data = makeSeedBudgetData();
    const today = todayISO();
    data.recurring = [
      {
        id: 9001,
        accountId: 1,
        categoryId: null,
        payee: "SCHEDBOLD Due Row",
        memo: "",
        amount: "-5000",
        frequency: "monthly",
        nextDate: addDaysISO(today, -1),
        active: true,
        transferAccountId: null,
        subTransactions: [],
      },
      {
        id: 9002,
        accountId: 1,
        categoryId: null,
        payee: "SCHEDBOLD Future Row",
        memo: "",
        amount: "-5000",
        frequency: "monthly",
        nextDate: addDaysISO(today, 30),
        active: true,
        transferAccountId: null,
        subTransactions: [],
      },
    ];
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

    // Drawer is open by default.
    const dueRow = screen.getByText("SCHEDBOLD Due Row").closest("tr")!;
    const futureRow = screen.getByText("SCHEDBOLD Future Row").closest("tr")!;
    expect(dueRow.classList.contains("font-bold")).toBe(true);
    expect(futureRow.classList.contains("font-bold")).toBe(false);
  });

  describe("column sorting", () => {
    const renderView = (data = makeSeedBudgetData()) =>
      render(
        <TransactionsView
          data={data}
          accountFilter={null}
          externalFilter={{ query: { filters: [], text: "sortx" }, nonce: 1 }}
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
      // Scoped to just our rows via renderView's applied query so all of
      // them fit in the virtualization window.
      renderView(data);

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

    it("BUG-23: computes footer totals correctly without double-counting split parents when child transfer legs are present", () => {
      const data = makeSeedBudgetData();
      // Add a split on Account 1 where child 1 is an incoming transfer into Account 2
      // and child 2 is a category expense on Account 1
      const splitParent = {
        id: 8001,
        accountId: 1,
        categoryId: null,
        date: "2026-08-01",
        payee: "Multi-leg Split",
        memo: "",
        amount: "-10000",
        status: "c" as const,
        transferAccountId: null,
        parentId: null,
      };
      const splitChildTransfer = {
        id: 8002,
        accountId: 1,
        categoryId: null,
        date: "2026-08-01",
        payee: "Multi-leg Split",
        memo: "Transfer part",
        amount: "-4000",
        status: "c" as const,
        transferAccountId: 2,
        parentId: 8001,
      };
      const splitChildExpense = {
        id: 8003,
        accountId: 1,
        categoryId: 1,
        date: "2026-08-01",
        payee: "Multi-leg Split",
        memo: "Expense part",
        amount: "-6000",
        status: "c" as const,
        transferAccountId: null,
        parentId: 8001,
      };

      // Set only this split transaction in data to test exact totals
      data.transactions = [splitParent, splitChildTransfer, splitChildExpense];

      // 1. In Account 1 view: split parent is visible (outflow $100.00), child legs are not individually listed
      const { unmount: unmount1 } = render(
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
      expect(screen.getByText("1 transactions")).toBeInTheDocument();
      expect(screen.getByText("Outflow −$100.00")).toBeInTheDocument();
      expect(screen.getByText("Net -$100.00")).toBeInTheDocument();
      unmount1();

      // 2. In Account 2 view: incoming transfer child is visible (inflow $40.00), parent is not listed
      const { unmount: unmount2 } = render(
        <TransactionsView
          data={data}
          accountFilter={2}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
        />
      );
      expect(screen.getByText("1 transactions")).toBeInTheDocument();
      expect(screen.getByText("Inflow $40.00")).toBeInTheDocument();
      expect(screen.getByText("Net $40.00")).toBeInTheDocument();
      unmount2();

      // 3. Edge case: parent also matches filter via transferAccountId or leg, so both parent and inbound child are in filtered
      const edgeParent = {
        ...splitParent,
        transferAccountId: 2, // Parent also matches account 2 filter
      };
      data.transactions = [edgeParent, splitChildTransfer, splitChildExpense];

      render(
        <TransactionsView
          data={data}
          accountFilter={2}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
        />
      );
      // Because child transfer is visible, edgeParent must NOT be double-counted in totals
      expect(screen.getByText("1 transactions")).toBeInTheDocument();
      expect(screen.getByText("Inflow $40.00")).toBeInTheDocument();
      expect(screen.getByText("Net $40.00")).toBeInTheDocument();
    });

    it("renders transfer icon in Category column instead of 'Transfer' text and navigates to the other account on click", () => {
      const data = makeSeedBudgetData();
      const onGoToTransfer = vi.fn();
      const onEdit = vi.fn();

      // Account 1: TD Unlimited Chequing, Account 2: EQ Bank
      const transferTxn = {
        id: 9200,
        accountId: 1,
        transferAccountId: 2,
        categoryId: null,
        date: "2026-07-25",
        payee: "Transfer : EQ Bank",
        memo: "Savings transfer",
        amount: "-5000",
        status: "c" as const,
        parentId: null,
      };

      data.transactions = [transferTxn, ...data.transactions];

      render(
        <TransactionsView
          data={data}
          accountFilter={1}
          onGoToTransfer={onGoToTransfer}
          onAdd={() => {}}
          onEdit={onEdit}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
          onFlag={() => {}}
        />
      );

      // Verify the text "Transfer" is not in the Category cell for this row
      const row = document.querySelector('tr[data-txn-id="9200"]');
      expect(row).not.toBeNull();

      // Find the transfer jump button inside the row
      const transferBtn = row!.querySelector('button[aria-label="Go to transfer in EQ Bank"]');
      expect(transferBtn).not.toBeNull();
      expect(transferBtn).toBeInTheDocument();
      expect((transferBtn as HTMLElement).style.color).toBe("var(--y-blue)");
      expect(transferBtn!.closest("td")!.style.color).toBe("var(--y-blue)");

      // Click the transfer button
      fireEvent.click(transferBtn!);

      // Should call onGoToTransfer with destination account (2) and transaction id (9200)
      expect(onGoToTransfer).toHaveBeenCalledTimes(1);
      expect(onGoToTransfer).toHaveBeenCalledWith(2, 9200);

      // Should not trigger onEdit because stopPropagation was called
      expect(onEdit).not.toHaveBeenCalled();
    });

    it("navigates to source account when clicking transfer icon on an incoming transfer", () => {
      const data = makeSeedBudgetData();
      const onGoToTransfer = vi.fn();

      // Account 1 -> Account 2 transfer
      const transferTxn = {
        id: 9201,
        accountId: 1,
        transferAccountId: 2,
        categoryId: null,
        date: "2026-07-25",
        payee: "Transfer : TD Unlimited Chequing",
        memo: "Savings deposit",
        amount: "-5000",
        status: "c" as const,
        parentId: null,
      };

      data.transactions = [transferTxn, ...data.transactions];

      // Viewing from destination account (Account 2)
      render(
        <TransactionsView
          data={data}
          accountFilter={2}
          onGoToTransfer={onGoToTransfer}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
          onFlag={() => {}}
        />
      );

      const row = document.querySelector('tr[data-txn-id="9201"]');
      expect(row).not.toBeNull();

      const transferBtn = row!.querySelector('button[aria-label="Go to transfer in TD Unlimited Chequing"]');
      expect(transferBtn).not.toBeNull();

      fireEvent.click(transferBtn!);
      expect(onGoToTransfer).toHaveBeenCalledWith(1, 9201);
    });

    it("renders transfer icon for split child transfer leg and navigates to the target account", () => {
      const data = makeSeedBudgetData();
      const onGoToTransfer = vi.fn();

      const splitParent = {
        id: 9300,
        accountId: 1,
        categoryId: null,
        date: "2026-07-20",
        payee: "Split with Transfer",
        memo: "Split parent",
        amount: "-10000",
        status: "c" as const,
        transferAccountId: null,
        parentId: null,
      };
      const splitChildExpense = {
        id: 9301,
        accountId: 1,
        categoryId: 1,
        date: "2026-07-20",
        payee: "Split with Transfer",
        memo: "Expense leg",
        amount: "-6000",
        status: "c" as const,
        transferAccountId: null,
        parentId: 9300,
      };
      const splitChildTransfer = {
        id: 9302,
        accountId: 1,
        categoryId: null,
        date: "2026-07-20",
        payee: "Transfer : EQ Bank",
        memo: "Transfer leg",
        amount: "-4000",
        status: "c" as const,
        transferAccountId: 2,
        parentId: 9300,
      };

      data.transactions = [splitParent, splitChildExpense, splitChildTransfer, ...data.transactions];

      render(
        <TransactionsView
          data={data}
          accountFilter={1}
          onGoToTransfer={onGoToTransfer}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
          onFlag={() => {}}
        />
      );

      // Expand split parent
      const expandBtn = screen.getByRole("button", { name: "Expand split sub-transactions" });
      fireEvent.click(expandBtn);

      // Child transfer row should be visible with transfer icon
      const childRow = document.querySelector('tr[data-txn-id="9302"]');
      expect(childRow).not.toBeNull();

      const transferBtn = childRow!.querySelector('button[aria-label="Go to transfer in EQ Bank"]');
      expect(transferBtn).not.toBeNull();

      fireEvent.click(transferBtn!);
      expect(onGoToTransfer).toHaveBeenCalledWith(2, 9302);
    });
  });

  describe("applied search query (filter bar)", () => {
    function filterFixture(): BudgetData {
      return {
        accounts: [
          { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 },
        ],
        groups: [{ id: 10, name: "Food", sort: 0, isCreditCardPayments: false }],
        categories: [
          { id: 100, groupId: 10, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
        ],
        assignments: [],
        transactions: [
          { id: 1, accountId: 1, categoryId: 100, date: "2026-09-01", payee: "Whole Foods", memo: "", amount: "-5000", status: "c", parentId: null, transferAccountId: null },
          { id: 2, accountId: 1, categoryId: 100, date: "2026-08-01", payee: "Old Grocer", memo: "", amount: "-2000", status: "c", parentId: null, transferAccountId: null },
        ],
        recurring: [],
      };
    }

    function renderWithQuery(
      query: Query,
      opts?: { onEditFilter?: (q: Query) => void; onClearFilter?: () => void }
    ) {
      return render(
        <TransactionsView
          data={filterFixture()}
          accountFilter={null}
          externalFilter={{ query, nonce: 1 }}
          onEditFilter={opts?.onEditFilter}
          onClearFilter={opts?.onClearFilter}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
        />
      );
    }

    it("narrows rows to a structured date filter and shows it as a chip in the toolbar", () => {
      renderWithQuery({
        filters: [{ kind: "date", start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" }],
        text: "",
      });
      expect(screen.getAllByText("Whole Foods").length).toBeGreaterThan(0);
      expect(screen.queryByText("Old Grocer")).not.toBeInTheDocument();
      // The filter lives in the toolbar — no separate search box or extra row.
      expect(screen.getByTestId("register-filter-bar")).toBeInTheDocument();
      expect(screen.getByText("Sep 2026")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Filter transactions" })).not.toBeInTheDocument();
    });

    it("opens the editor with the applied query when a chip is clicked", () => {
      const onEditFilter = vi.fn();
      const query: Query = {
        filters: [{ kind: "date", start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" }],
        text: "",
      };
      renderWithQuery(query, { onEditFilter });
      fireEvent.click(screen.getByRole("button", { name: "Edit Date filter" }));
      expect(onEditFilter).toHaveBeenCalledWith(query);
    });

    it("styles filter-bar chips with the theme and tooltips edit/remove affordances", () => {
      const { container } = renderWithQuery({
        filters: [{ kind: "date", start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" }],
        text: "",
      });
      const chip = container.querySelector("#register-filter-bar .y-chip, [data-testid='register-filter-bar'] .y-chip");
      expect(chip).not.toBeNull();
      const editBtn = screen.getByRole("button", { name: "Edit Date filter" });
      const removeBtn = screen.getByRole("button", { name: "Remove Date filter" });
      expect(editBtn.classList.contains("y-chip-edit")).toBe(true);
      expect(removeBtn.classList.contains("y-chip-x")).toBe(true);
      fireEvent.mouseOver(editBtn.closest(".y-tip-wrap")!);
      expect(screen.getByRole("tooltip")).toHaveTextContent("Edit Date filter");
      fireEvent.mouseOut(editBtn.closest(".y-tip-wrap")!);
      fireEvent.mouseOver(removeBtn.closest(".y-tip-wrap")!);
      expect(screen.getByRole("tooltip")).toHaveTextContent("Remove Date filter");
      fireEvent.mouseOut(removeBtn.closest(".y-tip-wrap")!);
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("shows a Filter button (and no search box) when nothing is applied", () => {
      const onEditFilter = vi.fn();
      render(
        <TransactionsView
          data={filterFixture()}
          accountFilter={null}
          onEditFilter={onEditFilter}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
        />
      );
      expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
      expect(screen.queryByTestId("register-filter-bar")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Filter transactions" }));
      expect(onEditFilter).toHaveBeenCalledWith({ filters: [], text: "" });
    });

    it("removing the chip restores all rows and hides the bar", () => {
      renderWithQuery({
        filters: [{ kind: "date", start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" }],
        text: "",
      });
      expect(screen.queryByText("Old Grocer")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Remove Date filter" }));
      expect(screen.getByText("Old Grocer")).toBeInTheDocument();
      expect(screen.queryByTestId("register-filter-bar")).not.toBeInTheDocument();
    });

    it("clear resets a text-only applied query", () => {
      renderWithQuery({ filters: [], text: "whole" });
      expect(screen.queryByText("Old Grocer")).not.toBeInTheDocument();
      expect(screen.getByTestId("register-filter-bar")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.getByText("Old Grocer")).toBeInTheDocument();
      expect(screen.queryByTestId("register-filter-bar")).not.toBeInTheDocument();
    });

    it("notifies the owner when cleared so the filter can't come back on remount", () => {
      const onClearFilter = vi.fn();
      renderWithQuery(
        {
          filters: [{ kind: "date", start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" }],
          text: "",
        },
        { onClearFilter }
      );
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(onClearFilter).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("register-filter-bar")).not.toBeInTheDocument();
    });

    it("notifies the owner only when removing the last remaining chip", () => {
      const onClearFilter = vi.fn();
      renderWithQuery(
        {
          filters: [
            { kind: "date", start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" },
            { kind: "is", value: "cleared" },
          ],
          text: "",
        },
        { onClearFilter }
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove Date filter" }));
      expect(screen.getByTestId("register-filter-bar")).toBeInTheDocument();
      expect(onClearFilter).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Remove Is filter" }));
      expect(onClearFilter).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("register-filter-bar")).not.toBeInTheDocument();
    });
  });

  it("shows no split-template UI when a single transaction is selected", () => {
    const data = makeSeedBudgetData();
    const { container } = render(
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
    const renderedIds = Array.from(container.querySelectorAll("tr[data-txn-id]")).map((r) =>
      Number(r.getAttribute("data-txn-id"))
    );
    expect(renderedIds.length).toBeGreaterThan(0);
    const row = container.querySelector(`tr[data-txn-id="${renderedIds[0]}"]`);
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("checkbox"));
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/split with template/i)).not.toBeInTheDocument();
  });

  it("renders freshly imported rows bold until they are reviewed", () => {
    const data = makeSeedBudgetData();
    const props = {
      data,
      accountFilter: null as number | null,
      onAdd: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onReconcile: () => {},
      onCycleStatus: () => {},
    };
    const { container, rerender } = render(<TransactionsView {...props} />);
    // The register virtualizes rows: flag two ids known to be rendered.
    const renderedIds = Array.from(container.querySelectorAll("tr[data-txn-id]")).map((r) =>
      Number(r.getAttribute("data-txn-id"))
    );
    expect(renderedIds.length).toBeGreaterThanOrEqual(2);
    const [flaggedId, plainId] = renderedIds;
    rerender(
      <TransactionsView
        {...props}
        data={{
          ...data,
          transactions: data.transactions.map((t) =>
            t.id === flaggedId ? { ...t, needsReview: true } : t
          ),
        }}
      />
    );
    const flagged = container.querySelector(`tr[data-txn-id="${flaggedId}"]`);
    expect(flagged).not.toBeNull();
    expect(flagged!.classList.contains("font-bold")).toBe(true);
    const plain = container.querySelector(`tr[data-txn-id="${plainId}"]`);
    expect(plain).not.toBeNull();
    expect(plain!.classList.contains("font-bold")).toBe(false);
  });

  it("shows unreviewed imports as New in the C column (clicking approves)", () => {
    const data = makeSeedBudgetData();
    const onCycleStatus = vi.fn();
    const props = {
      data,
      accountFilter: null as number | null,
      onAdd: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onReconcile: () => {},
      onCycleStatus,
    };
    const { container, rerender } = render(<TransactionsView {...props} />);
    // The register virtualizes rows: flag two ids known to be rendered.
    const renderedIds = Array.from(container.querySelectorAll("tr[data-txn-id]")).map((r) =>
      Number(r.getAttribute("data-txn-id"))
    );
    expect(renderedIds.length).toBeGreaterThanOrEqual(2);
    const [flaggedId, plainId] = renderedIds;
    rerender(
      <TransactionsView
        {...props}
        data={{
          ...data,
          transactions: data.transactions.map((t) =>
            t.id === flaggedId ? { ...t, status: "u" as const, needsReview: true } : t
          ),
        }}
      />
    );
    const flagged = container.querySelector(`tr[data-txn-id="${flaggedId}"]`);
    expect(flagged).not.toBeNull();
    const flaggedBadge = flagged!.querySelector(".y-cleared");
    expect(flaggedBadge).not.toBeNull();
    expect(flaggedBadge!.textContent).toBe("N");
    expect(flaggedBadge!.getAttribute("aria-label")).toBe("New");
    // The row stays bold (YNAB4-style) alongside the C-column badge.
    expect(flagged!.classList.contains("font-bold")).toBe(true);

    const plain = container.querySelector(`tr[data-txn-id="${plainId}"]`);
    expect(plain).not.toBeNull();
    const plainBadge = plain!.querySelector(".y-cleared");
    expect(plainBadge).not.toBeNull();
    expect(plainBadge!.textContent).not.toBe("N");

    // Clicking the New badge approves via the standard status cycle.
    fireEvent.click(flaggedBadge!);
    expect(onCycleStatus).toHaveBeenCalledWith(flaggedId);
  });

  it("offers Merge only when exactly two transactions are selected", () => {
    const data = makeSeedBudgetData();
    const onMergeTransactions = vi.fn();
    render(
      <TransactionsView
        data={data}
        accountFilter={null}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
        onMergeTransactions={onMergeTransactions}
      />
    );

    const rowCheckboxes = screen.getAllByRole("checkbox");
    fireEvent.click(rowCheckboxes[1]!);
    expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();

    fireEvent.click(rowCheckboxes[2]!);
    expect(screen.getByRole("button", { name: /merge \(2\)/i })).toBeInTheDocument();

    // Selecting a third row hides Merge again.
    fireEvent.click(rowCheckboxes[3]!);
    expect(screen.getByText(/3 selected/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();
  });

  it("opens a merge preview and keeps the merged transaction selected after confirming", async () => {
    const data = makeSeedBudgetData();
    const onMergeTransactions = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <TransactionsView
        data={data}
        accountFilter={null}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
        onMergeTransactions={onMergeTransactions}
      />
    );

    const rowCheckboxes = screen.getAllByRole("checkbox");
    fireEvent.click(rowCheckboxes[1]!);
    fireEvent.click(rowCheckboxes[2]!);
    const renderedIds = Array.from(container.querySelectorAll("tr[data-txn-id]")).map((r) =>
      Number(r.getAttribute("data-txn-id"))
    );
    const [firstId, secondId] = renderedIds;

    // Merge opens a preview first — nothing is merged yet.
    fireEvent.click(screen.getByRole("button", { name: /merge \(2\)/i }));
    expect(onMergeTransactions).not.toHaveBeenCalled();
    expect(screen.getByTestId("merge-result")).toBeInTheDocument();
    expect(screen.getByTestId("merge-constituents")).toBeInTheDocument();

    // Confirming merges and leaves the surviving row selected.
    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() => expect(onMergeTransactions).toHaveBeenCalledWith([firstId, secondId], {}));
    await waitFor(() => expect(screen.queryByTestId("merge-result")).not.toBeInTheDocument());
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    const survivorId = Math.min(firstId!, secondId!);
    const removedId = survivorId === firstId ? secondId! : firstId!;
    const survivorRow = container.querySelector(`tr[data-txn-id="${survivorId}"]`)!;
    expect(within(survivorRow as HTMLElement).getByRole("checkbox")).toBeChecked();
    const removedRow = container.querySelector(`tr[data-txn-id="${removedId}"]`)!;
    expect(within(removedRow as HTMLElement).getByRole("checkbox")).not.toBeChecked();
  });

  it("cancelling the merge preview merges nothing and keeps the selection", () => {
    const data = makeSeedBudgetData();
    const onMergeTransactions = vi.fn();
    render(
      <TransactionsView
        data={data}
        accountFilter={null}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
        onMergeTransactions={onMergeTransactions}
      />
    );

    const rowCheckboxes = screen.getAllByRole("checkbox");
    fireEvent.click(rowCheckboxes[1]!);
    fireEvent.click(rowCheckboxes[2]!);
    fireEvent.click(screen.getByRole("button", { name: /merge \(2\)/i }));
    expect(screen.getByTestId("merge-result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onMergeTransactions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("merge-result")).not.toBeInTheDocument();
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
  });

  it("hides Merge when the merge handler is not provided", () => {
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

    const rowCheckboxes = screen.getAllByRole("checkbox");
    fireEvent.click(rowCheckboxes[1]!);
    fireEvent.click(rowCheckboxes[2]!);
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();
  });

  it("does not allow selecting subtransactions, only parent transactions", () => {
    const data = makeSeedBudgetData();
    const splitParent = {
      id: 9001,
      accountId: 1,
      categoryId: null,
      date: "2026-07-15",
      payee: "Costco Wholesale Split",
      memo: "Combined run",
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
    const otherParent = {
      id: 9004,
      accountId: 1,
      categoryId: 1,
      date: "2026-07-16",
      payee: "Regular Grocer",
      memo: "",
      amount: "-2000",
      status: "c" as const,
      transferAccountId: null,
      parentId: null,
    };
    data.transactions = [splitParent, splitChild1, splitChild2, otherParent];

    const { container } = render(
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

    fireEvent.click(screen.getByRole("button", { name: /expand split sub-transactions/i }));

    const parentRow = container.querySelector('tr[data-txn-id="9001"]');
    const childRow1 = container.querySelector('tr[data-txn-id="9002"]');
    const childRow2 = container.querySelector('tr[data-txn-id="9003"]');
    expect(parentRow).not.toBeNull();
    expect(childRow1).not.toBeNull();
    expect(childRow2).not.toBeNull();
    expect(within(parentRow as HTMLElement).queryByRole("checkbox")).not.toBeNull();
    expect(within(childRow1 as HTMLElement).queryByRole("checkbox")).toBeNull();
    expect(within(childRow2 as HTMLElement).queryByRole("checkbox")).toBeNull();

    // Select-all covers parents only.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all transactions" }));
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    expect(within(parentRow as HTMLElement).getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /deselect all/i }));

    // Keyboard navigation skips sub-rows: 9004 -> 9001 -> wrap to 9004.
    const scrollContainer = container.querySelector(".y-scroll")!;
    const selectedTxnId = () =>
      container.querySelector("tr.y-row--selected")?.getAttribute("data-txn-id");
    fireEvent.keyDown(scrollContainer, { key: "ArrowDown" });
    expect(selectedTxnId()).toBe("9004");
    fireEvent.keyDown(scrollContainer, { key: "ArrowDown" });
    expect(selectedTxnId()).toBe("9001");
    fireEvent.keyDown(scrollContainer, { key: "ArrowDown" });
    expect(selectedTxnId()).toBe("9004");
    fireEvent.keyDown(scrollContainer, { key: "ArrowUp" });
    expect(selectedTxnId()).toBe("9001");
  });

  it("selects the parent when focusTransaction targets a subtransaction", () => {
    const data = makeSeedBudgetData();
    data.transactions = [
      {
        id: 9001,
        accountId: 1,
        categoryId: null,
        date: "2026-07-15",
        payee: "Costco Wholesale Split",
        memo: "Combined run",
        amount: "-15000",
        status: "c" as const,
        transferAccountId: null,
        parentId: null,
      },
      {
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
      },
    ];

    const { container } = render(
      <TransactionsView
        data={data}
        accountFilter={1}
        focusTransaction={{ id: 9002, nonce: 1 }}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    // The split expands so the child is visible, but selection lands on the parent.
    expect(screen.getByText("Groceries part")).toBeInTheDocument();
    const parentRow = container.querySelector('tr[data-txn-id="9001"]');
    const childRow = container.querySelector('tr[data-txn-id="9002"]');
    expect(parentRow!.classList.contains("is-sel")).toBe(true);
    expect(childRow!.classList.contains("is-sel")).toBe(false);
    expect(within(parentRow as HTMLElement).getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("keeps incoming split transfer legs selectable on the destination account", () => {
    const data = makeSeedBudgetData();
    data.transactions = [
      {
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
      },
      {
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
      },
      {
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
      },
    ];

    const { container } = render(
      <TransactionsView
        data={data}
        accountFilter={6}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
      />
    );

    // The incoming leg renders as a top-level transfer row, not a ↳ sub-row,
    // so it stays selectable like any other top-level row.
    const row = container.querySelector('tr[data-txn-id="9102"]');
    expect(row).not.toBeNull();
    expect(row!.classList.contains("y-subrow")).toBe(false);
    fireEvent.click(within(row as HTMLElement).getByRole("checkbox"));
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
  });

  it("toggles row selection when the checkbox cell is clicked, without opening the editor", () => {
    const data = makeSeedBudgetData();
    data.transactions = [
      {
        id: 9501,
        accountId: 1,
        categoryId: 1,
        date: "2026-07-15",
        payee: "Cell Click Grocer",
        memo: "",
        amount: "-2000",
        status: "c" as const,
        transferAccountId: null,
        parentId: null,
      },
    ];
    const onEdit = vi.fn();
    const { container } = render(
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

    const row = container.querySelector('tr[data-txn-id="9501"]') as HTMLElement;
    const cell = within(row).getByRole("checkbox").closest("td") as HTMLElement;
    fireEvent.click(cell);
    expect(within(row).getByRole("checkbox")).toBeChecked();
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();

    fireEvent.click(cell);
    expect(within(row).getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByText(/1 selected/i)).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("toggles scheduled row selection when the checkbox cell is clicked, without opening the editor", () => {
    const data = makeSeedBudgetData();
    data.recurring = [
      {
        id: 9601,
        accountId: 1,
        categoryId: null,
        payee: "SCHED Cell Click",
        memo: "",
        amount: "-5000",
        frequency: "monthly",
        nextDate: "2026-08-01",
        active: true,
        transferAccountId: null,
        subTransactions: [],
      },
    ];
    const onEditRecurring = vi.fn();
    render(
      <TransactionsView
        data={data}
        accountFilter={1}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReconcile={() => {}}
        onCycleStatus={() => {}}
        onEditRecurring={onEditRecurring}
      />
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Select scheduled transaction SCHED Cell Click",
    });
    const cell = checkbox.closest("td") as HTMLElement;
    fireEvent.click(cell);
    expect(checkbox).toBeChecked();
    expect(screen.getByText(/1 scheduled selected/i)).toBeInTheDocument();
    expect(onEditRecurring).not.toHaveBeenCalled();

    fireEvent.click(cell);
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText(/1 scheduled selected/i)).not.toBeInTheDocument();
    expect(onEditRecurring).not.toHaveBeenCalled();
  });

  describe("duplicate inspector", () => {
    const dupePair = () => [
      {
        id: 9701,
        accountId: 1,
        categoryId: 1,
        date: "2026-07-15",
        payee: "Dupe Grocer",
        memo: "",
        amount: "-2000",
        status: "c" as const,
        transferAccountId: null,
        parentId: null,
      },
      {
        id: 9702,
        accountId: 1,
        categoryId: 1,
        date: "2026-07-15",
        payee: "Dupe Grocer",
        memo: "",
        amount: "-2000",
        status: "c" as const,
        transferAccountId: null,
        parentId: null,
        flagColor: "duplicate" as const,
      },
    ];

    const renderDuplicatesView = (overrides?: {
      transactions?: ReturnType<typeof makeSeedBudgetData>["transactions"];
      onEdit?: () => void;
      onDelete?: (id: number) => void;
      onFlag?: (id: number, color: TransactionFlagColor | null) => void;
      onDismissDuplicateGroup?: (fingerprint: string) => Promise<void> | void;
    }) => {
      const data = makeSeedBudgetData();
      data.transactions = overrides?.transactions ?? [...data.transactions, ...dupePair()];
      const onEdit = overrides?.onEdit ?? (() => {});
      const onDelete = overrides?.onDelete ?? (() => {});
      const onFlag = overrides?.onFlag ?? (() => {});
      render(
        <TransactionsView
          data={data}
          accountFilter={1}
          externalFilter={{ query: { filters: [{ kind: "is", value: "duplicate" }], text: "" }, nonce: 1 }}
          onAdd={() => {}}
          onEdit={onEdit}
          onDelete={onDelete}
          onReconcile={() => {}}
          onCycleStatus={() => {}}
          onFlag={onFlag}
          onDismissDuplicateGroup={overrides?.onDismissDuplicateGroup}
        />
      );
      return { data, onEdit, onDelete, onFlag };
    };

    it("shows only flagged rows in the duplicates filter", () => {
      renderDuplicatesView();

      // The keeper stays hidden here — the D badge reveals it on demand.
      expect(document.querySelector('tr[data-txn-id="9701"]')).toBeNull();
      expect(document.querySelector('tr[data-txn-id="9702"]')).not.toBeNull();
    });

    it("opens the duplicate group when the D badge is clicked, without opening the editor", () => {
      const onEdit = vi.fn();
      renderDuplicatesView({ onEdit });

      expect(screen.queryByText("Duplicate transactions")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show duplicate transactions" }));

      expect(screen.getByText("Duplicate transactions")).toBeInTheDocument();
      expect(document.querySelector('[data-duplicate-id="9701"]')).not.toBeNull();
      expect(document.querySelector('[data-duplicate-id="9702"]')).not.toBeNull();
      expect(onEdit).not.toHaveBeenCalled();
    });

    it("never opens the flag picker from the D badge (the marker cannot be changed there)", () => {
      renderDuplicatesView();

      fireEvent.click(screen.getByRole("button", { name: "Show duplicate transactions" }));

      expect(screen.getByText("Duplicate transactions")).toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "Choose flag color" })
      ).not.toBeInTheDocument();
    });

    it("edits and deletes group rows from the inspector", () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();
      renderDuplicatesView({ onEdit, onDelete });

      fireEvent.click(screen.getByRole("button", { name: "Show duplicate transactions" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Edit transaction Dupe Grocer" })[0]!);
      expect(onEdit).toHaveBeenCalledWith(9701);
      fireEvent.click(screen.getAllByRole("button", { name: "Delete transaction Dupe Grocer" })[1]!);
      expect(onDelete).toHaveBeenCalledWith(9702);
    });

    it("shows all group rows in the register and clears the filter", () => {
      renderDuplicatesView();

      fireEvent.click(screen.getByRole("button", { name: "Show duplicate transactions" }));
      fireEvent.click(screen.getByRole("button", { name: "Show all in register" }));

      expect(screen.queryByText("Duplicate transactions")).not.toBeInTheDocument();
      expect(screen.getByText("2 selected")).toBeInTheDocument();
      expect(screen.queryByTestId("register-filter-bar")).not.toBeInTheDocument();
    });

    it("offers to clear a stale marker when nothing else matches", () => {
      const data = makeSeedBudgetData();
      data.transactions = [
        ...data.transactions,
        {
          id: 9703,
          accountId: 1,
          categoryId: 1,
          date: "2026-07-16",
          payee: "Stale Dupe Grocer",
          memo: "",
          amount: "-3000",
          status: "c" as const,
          transferAccountId: null,
          parentId: null,
          flagColor: "duplicate" as const,
        },
      ];
      const onFlag = vi.fn();
      renderDuplicatesView({ transactions: data.transactions, onFlag });

      fireEvent.click(screen.getByRole("button", { name: "Show duplicate transactions" }));
      expect(screen.getByText("No other matching transactions")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Clear marker" }));
      expect(onFlag).toHaveBeenCalledWith(9703, null);
      expect(screen.queryByText("No other matching transactions")).not.toBeInTheDocument();
    });

    it("confirms the group as not duplicates and closes", async () => {
      const onDismissDuplicateGroup = vi.fn().mockResolvedValue(undefined);
      renderDuplicatesView({ onDismissDuplicateGroup });

      fireEvent.click(screen.getByRole("button", { name: "Show duplicate transactions" }));
      fireEvent.click(screen.getByRole("button", { name: "Not duplicates" }));

      expect(onDismissDuplicateGroup).toHaveBeenCalledWith(
        duplicateFingerprint({
          accountId: 1,
          date: "2026-07-15",
          amount: -2000,
          payee: "Dupe Grocer",
          memo: "",
        })
      );
      await waitFor(() => {
        expect(screen.queryByText("Duplicate transactions")).not.toBeInTheDocument();
      });
    });

    it("hides the dismiss button when no dismiss handler is provided", () => {
      renderDuplicatesView();

      fireEvent.click(screen.getByRole("button", { name: "Show duplicate transactions" }));
      expect(screen.queryByRole("button", { name: "Not duplicates" })).not.toBeInTheDocument();
    });

    it("keeps the modal open with an error when dismissing fails", async () => {
      const onDismissDuplicateGroup = vi.fn().mockRejectedValue(new Error("nope"));
      renderDuplicatesView({ onDismissDuplicateGroup });

      fireEvent.click(screen.getByRole("button", { name: "Show duplicate transactions" }));
      fireEvent.click(screen.getByRole("button", { name: "Not duplicates" }));

      await waitFor(() => {
        expect(screen.getByText("Could not confirm")).toBeInTheDocument();
      });
      expect(screen.getByText("Duplicate transactions")).toBeInTheDocument();
    });
  });
});

