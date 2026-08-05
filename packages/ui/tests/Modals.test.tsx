import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  CategoryModal,
  TransactionModal,
  RecurringModal,
} from "../src/Modals.js";
import type {
  Account,
  Category,
  Transaction,
  Recurring,
  RecurringSubTransaction,
} from "@ynab/logic";

const accounts: Account[] = [
  { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "100.00", onBudget: true, sort: 0 },
  { id: 2, name: "Credit", kind: "credit", groupLabel: "Cards", balance: "-50.00", onBudget: true, sort: 1 },
];

const categories: Category[] = [
  { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
  { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: "1500.00", linkedAccountId: null },
];

describe("CategoryModal", () => {
  it("calls onSave with the trimmed name and null goal when no goal is set", () => {
    const onSave = vi.fn();
    render(<CategoryModal onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Coffee  " } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ name: "Coffee", goalTarget: null });
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
    expect(onSave).toHaveBeenCalledWith({ name: "Vacation", goalTarget: 2000 });
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
    fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
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
      amount: -42.5,
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
    fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
      target: { value: "Payroll" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      payee: "Payroll",
      amount: 1000,
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

  it("edits an existing transaction with the initial values", () => {
    const onSave = vi.fn();
    const initial: Transaction = {
      id: 99,
      accountId: 1,
      categoryId: 10,
      date: "2026-06-10",
      payee: "IGA",
      memo: "",
      amount: "-12.34",
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
    expect(screen.getByDisplayValue("IGA")).toBeInTheDocument();
    // The amount field shows the signed value.
    expect(screen.getByDisplayValue("-12.34")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: 99, payee: "IGA" });
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
      expect(screen.queryByRole("combobox", { name: /category/i })).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: /transfer to/i })).toBeInTheDocument();
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
      fireEvent.change(screen.getByRole("combobox", { name: /transfer to/i }), {
        target: { value: "2" },
      });
      fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave.mock.calls[0]![0]).toMatchObject({
        accountId: 1,
        transferAccountId: 2,
        categoryId: null,
        amount: -100,
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
      expect(screen.getByText("Total")).toBeInTheDocument();
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
      fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
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
      fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
        target: { value: "Costco" },
      });
      const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
      const parent = allZeros[0]!;
      fireEvent.change(parent, { target: { value: "-100" } });

      const subAmounts = allZeros.slice(1) as HTMLInputElement[];
      const subCatSelects = screen
        .getAllByRole("combobox")
        .filter(
          (s) => (s as HTMLSelectElement).options[0]?.text === "Category…"
        ) as HTMLSelectElement[];
      fireEvent.change(subCatSelects[0]!, { target: { value: "10" } });
      fireEvent.change(subCatSelects[1]!, { target: { value: "11" } });
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
      expect(payload.amount).toBe(-100);
      expect(payload.categoryId).toBeNull();
      expect(payload.subTransactions).toHaveLength(2);
      // Children are passed through with their typed sign (no coercion).
      expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, amount: -60 });
      expect(payload.subTransactions[1]).toMatchObject({ categoryId: 11, amount: -40 });
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
      fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
        target: { value: "Employer Inc." },
      });
      const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
      const parent = allZeros[0]!;
      fireEvent.change(parent, { target: { value: "4000" } });

      const subAmounts = allZeros.slice(1) as HTMLInputElement[];
      const subCatSelects = screen
        .getAllByRole("combobox")
        .filter(
          (s) => (s as HTMLSelectElement).options[0]?.text === "Category…"
        ) as HTMLSelectElement[];
      fireEvent.change(subCatSelects[0]!, { target: { value: "10" } });
      fireEvent.change(subCatSelects[1]!, { target: { value: "11" } });
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
      expect(payload.amount).toBe(4000);
      expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, amount: 5000 });
      expect(payload.subTransactions[1]).toMatchObject({ categoryId: 11, amount: -1000 });
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
      fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
        target: { value: "X" },
      });
      const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
      const parent = allZeros[0]!;
      fireEvent.change(parent, { target: { value: "4000" } });
      const subAmounts = allZeros.slice(1) as HTMLInputElement[];
      const subCatSelects = screen
        .getAllByRole("combobox")
        .filter(
          (s) => (s as HTMLSelectElement).options[0]?.text === "Category…"
        ) as HTMLSelectElement[];
      fireEvent.change(subCatSelects[0]!, { target: { value: "10" } });
      fireEvent.change(subCatSelects[1]!, { target: { value: "11" } });
      fireEvent.change(subAmounts[0]!, { target: { value: "5000" } });
      fireEvent.change(subAmounts[1]!, { target: { value: "-2000" } });

      const saveBtn = screen.getByRole("button", { name: /save transaction/i });
      expect(saveBtn).toBeDisabled();
      fireEvent.click(saveBtn);
      expect(onSave).not.toHaveBeenCalled();
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
        amount: "-100",
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
          amount: "-60",
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
          amount: "-40",
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
  it("renders biweekly as an available frequency option", () => {
    render(
      <RecurringModal
        accounts={accounts}
        categories={categories}
        onClose={() => {}}
        onSave={() => {}}
      />
    );
    const select = screen.getByRole("combobox", { name: /frequency/i }) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("biweekly");
    expect(options).toContain("weekly");
    expect(options).toContain("monthly");
    expect(options).toContain("yearly");
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
    fireEvent.change(screen.getByLabelText(/^payee$/i), {
      target: { value: "Hydro" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-80" } });
    fireEvent.change(screen.getByRole("combobox", { name: /frequency/i }), {
      target: { value: "biweekly" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      payee: "Hydro",
      amount: -80,
      frequency: "biweekly",
    });
  });

  it("pre-fills the values and saves with id when editing", () => {
    const onSave = vi.fn();
    const initial: Recurring = {
      id: 7,
      accountId: 1,
      categoryId: 10,
      payee: "Spotify",
      amount: "-9.99",
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
    expect(screen.getByDisplayValue("Spotify")).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText(/transfer to/i), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "-500" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      accountId: 1,
      transferAccountId: 2,
      amount: -500,
    });
    expect(payload.categoryId).toBeNull();
    // Payee auto-derived as "Transfer : Credit" since blank.
    expect(payload.payee).toBe("Transfer : Credit");
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
    fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
      target: { value: "Costco" },
    });
    const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    const total = allZeros[0]!;
    fireEvent.change(total, { target: { value: "-200" } });

    const subAmounts = allZeros.slice(1) as HTMLInputElement[];
    const subCatSelects = screen
      .getAllByRole("combobox")
      .filter(
        (s) => (s as HTMLSelectElement).options[0]?.text === "Category…"
      ) as HTMLSelectElement[];
    fireEvent.change(subCatSelects[0]!, { target: { value: "10" } });
    fireEvent.change(subCatSelects[1]!, { target: { value: "11" } });
    // Children retain the typed sign (no coercion by the modal).
    fireEvent.change(subAmounts[0]!, { target: { value: "-120" } });
    fireEvent.change(subAmounts[1]!, { target: { value: "-80" } });

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![0] as {
      amount: number;
      subTransactions: { categoryId: number; amount: number }[];
      categoryId: number | null;
      payee: string;
    };
    expect(payload.amount).toBe(-200);
    expect(payload.categoryId).toBeNull();
    expect(payload.payee).toBe("Costco");
    expect(payload.subTransactions).toHaveLength(2);
    expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, amount: -120 });
    expect(payload.subTransactions[1]).toMatchObject({ categoryId: 11, amount: -80 });
  });

  it("re-uses transferAccountId and subTransactions when editing", () => {
    const onSave = vi.fn();
    const initial = {
      id: 9,
      accountId: 1,
      categoryId: null,
      payee: "AMEX Payment",
      amount: "-1000",
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
      amount: -1000,
    });
  });

  it("opens a split row in split mode with its children pre-populated", () => {
    const onSave = vi.fn();
    const subs: RecurringSubTransaction[] = [
      { id: 1, recurringId: 9, categoryId: 10, amount: "-120", memo: "g", sort: 0 },
      { id: 2, recurringId: 9, categoryId: 11, amount: "-80",  memo: "h", sort: 1 },
    ];
    const initial = {
      id: 9,
      accountId: 1,
      categoryId: null,
      payee: "Costco",
      amount: "-200",
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
    fireEvent.change(screen.getByPlaceholderText("e.g. Whole Foods"), {
      target: { value: "Employer Inc." },
    });
    const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    const total = allZeros[0]!;
    fireEvent.change(total, { target: { value: "4000" } });

    const subAmounts = allZeros.slice(1) as HTMLInputElement[];
    const subCatSelects = screen
      .getAllByRole("combobox")
      .filter(
        (s) => (s as HTMLSelectElement).options[0]?.text === "Category…"
      ) as HTMLSelectElement[];
    fireEvent.change(subCatSelects[0]!, { target: { value: "10" } });
    fireEvent.change(subCatSelects[1]!, { target: { value: "11" } });
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
    expect(payload.amount).toBe(4000);
    expect(payload.subTransactions[0]).toMatchObject({ categoryId: 10, amount: 5000 });
    expect(payload.subTransactions[1]).toMatchObject({ categoryId: 11, amount: -1000 });
  });
});
