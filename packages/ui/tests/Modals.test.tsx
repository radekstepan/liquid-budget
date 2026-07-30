import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  CategoryModal,
  TransactionModal,
  RecurringModal,
} from "../src/Modals.js";
import type { Account, Category, Transaction, Recurring } from "@ynab/logic";

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
  it("calls onSave with a negative amount when type is outflow (default)", () => {
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
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "42.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save transaction/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      payee: "Whole Foods",
      amount: -42.5,
      categoryId: null,
    });
  });

  it("calls onSave with a positive amount when type is inflow", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /inflow/i }));
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
    expect(screen.getByDisplayValue("12.34")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: 99, payee: "IGA" });
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

  it("calls onSave with the biweekly frequency when chosen", () => {
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
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "80" } });
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
});
