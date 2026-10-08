import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionModal } from "../src/Modals.js";
import type { Account, Category, SplitTemplate, Transaction } from "@ynab/logic";
import { openSearchlistByPlaceholder } from "./dropdown.js";

const accounts: Account[] = [
  { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "10000", onBudget: true, sort: 0 },
  { id: 4, name: "Susie", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 1 },
];

const categories: Category[] = [
  { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
];

const susieTemplate: SplitTemplate = {
  id: 1,
  name: "Susie 85/15",
  legs: [
    { kind: "category", categoryId: 10, transferAccountId: null, shareBps: 8500 },
    { kind: "transfer", categoryId: null, transferAccountId: 4, shareBps: 1500 },
  ],
};

const single: Transaction = {
  id: 5,
  accountId: 1,
  categoryId: 10,
  date: "2026-09-01",
  payee: "Costco",
  memo: "",
  amount: "-10000",
  status: "c",
  parentId: null,
  transferAccountId: null,
};

describe("TransactionModal split templates", () => {
  it("opens a single transaction in split mode with the template applied", () => {
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={1}
        initial={single}
        allTransactions={[single]}
        splitTemplates={[susieTemplate]}
        initialSplitTemplateId={1}
        onClose={() => {}}
        onSave={onSave}
      />
    );

    // Already in split mode: no need to touch the mode toggle.
    expect(screen.getByText("Sub-transactions")).toBeInTheDocument();
    expect(screen.getByLabelText("Sub-transaction 1 amount")).toHaveValue("-85.00");
    expect(screen.getByLabelText("Sub-transaction 2 amount")).toHaveValue("-15.00");

    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      mode: "split",
      id: 5,
      amount: -10000,
      subTransactions: [
        { categoryId: 10, transferAccountId: null, amount: -8500 },
        { categoryId: null, transferAccountId: 4, amount: -1500 },
      ],
    });
  });

  it("enters blank split mode from the main Split button", () => {
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={1}
        splitTemplates={[susieTemplate]}
        onClose={() => {}}
        onSave={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
    expect(screen.getByText("Sub-transactions")).toBeInTheDocument();
    expect(screen.getByLabelText("Sub-transaction 1 amount")).toHaveValue("");
    expect(screen.getByLabelText("Sub-transaction 2 amount")).toHaveValue("");
  });

  it("applies a template from the Split button caret menu", () => {
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={1}
        splitTemplates={[susieTemplate]}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Costco" },
    });
    const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    fireEvent.change(allZeros[0]!, { target: { value: "-100" } });

    // The caret next to Split opens the template menu; the main Split
    // button is untouched so the mode only changes via the template.
    fireEvent.click(screen.getByRole("button", { name: /choose split template/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Susie 85/15" }));

    expect(screen.getByLabelText("Sub-transaction 1 amount")).toHaveValue("-85.00");
    expect(screen.getByLabelText("Sub-transaction 2 amount")).toHaveValue("-15.00");

    const saveBtn = screen.getByRole("button", { name: /save transaction/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      mode: "split",
      subTransactions: [
        { categoryId: 10, amount: -8500 },
        { transferAccountId: 4, amount: -1500 },
      ],
    });
  });

});
