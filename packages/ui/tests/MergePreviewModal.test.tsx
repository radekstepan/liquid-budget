import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MergePreviewModal } from "../src/MergePreviewModal.js";
import { makeSeedBudgetData, type MergeOverrides, type Transaction } from "@ynab/logic";
import { pickFromOpenSearchableByValue } from "./dropdown.js";

function setup(overrides?: {
  onClose?: () => void;
  onConfirm?: (ids: number[], patch: MergeOverrides) => Promise<void> | void;
}) {
  const data = makeSeedBudgetData();
  const categoryId = data.categories[0]!.id;
  const categoryName = data.categories[0]!.name;
  const otherCategoryId = data.categories[1]!.id;
  const otherAccountId = data.accounts.find((a) => a.id !== 1)!.id;
  const manual: Transaction = {
    id: 101,
    accountId: 1,
    categoryId,
    date: "2026-08-02",
    payee: "Whole Foods",
    memo: "weekly shop",
    amount: "-4999",
    status: "c",
    flagColor: "red",
  };
  const imported: Transaction = {
    id: 102,
    accountId: 1,
    categoryId: null,
    date: "2026-08-01",
    payee: "WHOLE FOODS #24",
    memo: "",
    amount: "-5000",
    status: "u",
    needsReview: true,
  };
  const onClose = overrides?.onClose ?? vi.fn();
  const onConfirm = overrides?.onConfirm ?? vi.fn();
  render(
    <MergePreviewModal
      accounts={data.accounts}
      categories={data.categories}
      groups={data.groups}
      transactions={[manual, imported]}
      ids={[101, 102]}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
  return { data, manual, imported, categoryName, otherCategoryId, otherAccountId, onClose, onConfirm };
}

describe("MergePreviewModal", () => {
  it("prepopulates the editable result with imported data winning", () => {
    const { categoryName } = setup();
    const result = screen.getByTestId("merge-result");
    // Imported bank data wins in the result...
    expect(within(result).getByDisplayValue("WHOLE FOODS #24")).toBeInTheDocument();
    expect(within(result).getByDisplayValue("2026-08-01")).toBeInTheDocument();
    expect(within(result).getByDisplayValue("-50.00")).toBeInTheDocument();
    expect(within(result).getByRole("button", { name: "Uncleared" })).toHaveTextContent("U");
    // ...while manual curation fills the gaps the import left empty.
    expect(within(result).getByText(categoryName)).toBeInTheDocument();
    expect(within(result).getByDisplayValue("weekly shop")).toBeInTheDocument();
    expect(within(result).getByRole("radio", { name: "Red" })).toBeChecked();
  });

  it("shows both constituents as plain rows", () => {
    setup();
    const constituents = screen.getByTestId("merge-constituents");
    expect(within(constituents).getByText("WHOLE FOODS #24")).toBeInTheDocument();
    expect(within(constituents).getByText("Whole Foods")).toBeInTheDocument();
    expect(within(constituents).getByText("2026-08-01")).toBeInTheDocument();
    expect(within(constituents).getByText("2026-08-02")).toBeInTheDocument();
    expect(within(constituents).queryByText("Kept")).not.toBeInTheDocument();
    expect(within(constituents).queryByText("Removed")).not.toBeInTheDocument();
  });

  it("confirms with the pair ids and no overrides when nothing was edited", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    setup({ onClose, onConfirm });

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([101, 102], {}));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends only the edited fields as overrides", async () => {
    const onConfirm = vi.fn();
    setup({ onConfirm });
    const result = screen.getByTestId("merge-result");

    fireEvent.change(within(result).getByDisplayValue("WHOLE FOODS #24"), {
      target: { value: "Whole Foods" },
    });
    fireEvent.change(within(result).getByDisplayValue("weekly shop"), {
      target: { value: "edited memo" },
    });
    fireEvent.change(within(result).getByDisplayValue("2026-08-01"), {
      target: { value: "2026-08-03" },
    });
    fireEvent.change(within(result).getByDisplayValue("-50.00"), {
      target: { value: "-51.00" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith([101, 102], {
        date: "2026-08-03",
        payee: "Whole Foods",
        memo: "edited memo",
        amount: -5100,
      })
    );
  });

  it("sends a status override when cleared is toggled", async () => {
    const onConfirm = vi.fn();
    setup({ onConfirm });
    const result = screen.getByTestId("merge-result");

    fireEvent.click(within(result).getByRole("button", { name: "Uncleared" }));

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([101, 102], { status: "c" }));
  });

  it("sends a flag override when the flag is changed", async () => {
    const onConfirm = vi.fn();
    setup({ onConfirm });
    const result = screen.getByTestId("merge-result");

    fireEvent.click(within(result).getByRole("radio", { name: "Green" }));

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([101, 102], { flagColor: "green" }));
  });

  it("sends a null flag override when the flag is cleared", async () => {
    const onConfirm = vi.fn();
    setup({ onConfirm });
    const result = screen.getByTestId("merge-result");

    fireEvent.click(within(result).getByRole("button", { name: "Clear flag" }));

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([101, 102], { flagColor: null }));
  });

  it("sends a category override when the category is changed", async () => {
    const onConfirm = vi.fn();
    const { otherCategoryId } = setup({ onConfirm });

    pickFromOpenSearchableByValue(/category/i, String(otherCategoryId));

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith([101, 102], {
        categoryId: otherCategoryId,
        incomeMonth: null,
      })
    );
  });

  it("sends an account override when the account is changed", async () => {
    const onConfirm = vi.fn();
    const { otherAccountId } = setup({ onConfirm });

    pickFromOpenSearchableByValue(/account/i, String(otherAccountId));

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith([101, 102], { accountId: otherAccountId })
    );
  });

  it("disables merging while the amount or date is invalid", () => {
    setup();
    const result = screen.getByTestId("merge-result");
    const mergeBtn = screen.getByRole("button", { name: "Merge transactions" });
    expect(mergeBtn).not.toBeDisabled();

    fireEvent.change(within(result).getByDisplayValue("-50.00"), { target: { value: "0" } });
    expect(mergeBtn).toBeDisabled();
    expect(within(result).getByText("Amount can't be zero.")).toBeInTheDocument();

    fireEvent.change(within(result).getByDisplayValue("0"), { target: { value: "-50.00" } });
    expect(mergeBtn).not.toBeDisabled();

    fireEvent.change(within(result).getByDisplayValue("2026-08-01"), {
      target: { value: "not-a-date" },
    });
    expect(mergeBtn).toBeDisabled();
    expect(within(result).getByText("Enter a valid date.")).toBeInTheDocument();
  });

  it("Cancel closes without confirming", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    setup({ onClose, onConfirm });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows the server error and stays open when confirming fails", async () => {
    const onClose = vi.fn();
    setup({ onClose, onConfirm: () => Promise.reject(new Error("Transaction is reconciled and locked.")) });

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() =>
      expect(screen.getByText("Transaction is reconciled and locked.")).toBeInTheDocument()
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Merge transactions" })).toBeInTheDocument();
  });
});
