import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionModal } from "../src/Modals.js";
import type { Account, Category, SplitTemplate } from "@ynab/logic";
import { openSearchlistByPlaceholder, pickPlaceholderSearchableByIndexByValue } from "./dropdown.js";

const accounts: Account[] = [
  { id: 1, name: "Chequing", kind: "liquid", groupLabel: "Liquid", balance: "10000", onBudget: true, sort: 0 },
  { id: 4, name: "Susie", kind: "liquid", groupLabel: "Liquid", balance: "0", onBudget: true, sort: 1 },
];

const categories: Category[] = [
  { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
  { id: 11, groupId: 1, name: "Uber", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
];

const susieTemplate: SplitTemplate = {
  id: 1,
  name: "Susie 85/15",
  legs: [
    { kind: "category", categoryId: 10, transferAccountId: null, shareBps: 8500 },
    { kind: "transfer", categoryId: null, transferAccountId: 4, shareBps: 1500 },
  ],
};

describe("TransactionModal split templates", () => {
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

  it("keeps already-set sub-transaction categories and memos and only applies the split ratio", () => {
    // Mirrors the shipped "Susie 85/15" preset: the category leg leaves
    // its category unset ("choose when applying").
    const chooseWhenApplying: SplitTemplate = {
      id: 1,
      name: "Susie 85/15",
      legs: [
        { kind: "category", categoryId: null, transferAccountId: null, shareBps: 8500 },
        { kind: "transfer", categoryId: null, transferAccountId: 4, shareBps: 1500 },
      ],
    };
    const onSave = vi.fn();
    render(
      <TransactionModal
        accounts={accounts}
        categories={categories}
        defaultAccountId={1}
        splitTemplates={[chooseWhenApplying]}
        onClose={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^split$/i }));
    fireEvent.change(openSearchlistByPlaceholder("e.g. Whole Foods"), {
      target: { value: "Costco" },
    });
    const allZeros = screen.getAllByPlaceholderText("0.00") as HTMLInputElement[];
    fireEvent.change(allZeros[0]!, { target: { value: "-100" } });

    // The user already split the transaction into Uber + a Susie
    // transfer with a 50/50 guess at the amounts.
    pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "category:11");
    pickPlaceholderSearchableByIndexByValue(/category or transfer…/i, 0, "transfer:4");
    const subAmounts = screen.getAllByPlaceholderText("0.00").slice(1) as HTMLInputElement[];
    fireEvent.change(subAmounts[0]!, { target: { value: "-50" } });
    fireEvent.change(subAmounts[1]!, { target: { value: "-50" } });
    // A typed memo on the first row; the second row is left blank so
    // it still picks up the parent payee default.
    fireEvent.change(screen.getByLabelText("Sub-transaction 1 memo"), {
      target: { value: "Uber ride" },
    });

    fireEvent.click(screen.getByRole("button", { name: /choose split template/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Susie 85/15" }));

    // Amounts follow the template ratio, categories and memos stay untouched.
    expect(screen.getByLabelText("Sub-transaction 1 amount")).toHaveValue("-85.00");
    expect(screen.getByLabelText("Sub-transaction 2 amount")).toHaveValue("-15.00");
    expect(screen.getByLabelText("Sub-transaction 1 memo")).toHaveValue("Uber ride");
    expect(screen.getByLabelText("Sub-transaction 2 memo")).toHaveValue("Costco");

    const saveBtn = screen.getByRole("button", { name: /save transaction/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      mode: "split",
      subTransactions: [
        { categoryId: 11, amount: -8500, memo: "Uber ride" },
        { transferAccountId: 4, amount: -1500, memo: "Costco" },
      ],
    });
  });

});
