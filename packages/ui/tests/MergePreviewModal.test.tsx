import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MergePreviewModal } from "../src/MergePreviewModal.js";
import { makeSeedBudgetData, type Transaction } from "@ynab/logic";

function setup(overrides?: {
  onClose?: () => void;
  onConfirm?: (ids: number[]) => Promise<void> | void;
}) {
  const data = makeSeedBudgetData();
  const categoryId = data.categories[0]!.id;
  const categoryName = data.categories[0]!.name;
  const manual: Transaction = {
    id: 101,
    accountId: 1,
    categoryId,
    date: "2026-08-02",
    payee: "Whole Foods",
    memo: "weekly shop",
    amount: "-4999",
    status: "c",
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
      transactions={[manual, imported]}
      ids={[101, 102]}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
  return { data, manual, imported, categoryName, onClose, onConfirm };
}

describe("MergePreviewModal", () => {
  it("previews the resulting transaction with imported data winning", () => {
    const { categoryName } = setup();
    const result = screen.getByTestId("merge-result");
    // Imported bank data wins in the result...
    expect(within(result).getByText("WHOLE FOODS #24")).toBeInTheDocument();
    expect(within(result).getByText("2026-08-01")).toBeInTheDocument();
    expect(within(result).getByText("-$50.00")).toBeInTheDocument();
    expect(within(result).getByText("Uncleared")).toBeInTheDocument();
    // ...while manual curation fills the gaps the import left empty.
    expect(within(result).getByText(categoryName)).toBeInTheDocument();
    expect(within(result).getByText("weekly shop")).toBeInTheDocument();
  });

  it("shows both constituents with kept/removed roles", () => {
    setup();
    const constituents = screen.getByTestId("merge-constituents");
    expect(within(constituents).getByText("WHOLE FOODS #24")).toBeInTheDocument();
    expect(within(constituents).getByText("Whole Foods")).toBeInTheDocument();
    expect(within(constituents).getByText("Kept")).toBeInTheDocument();
    expect(within(constituents).getByText("Removed")).toBeInTheDocument();
  });

  it("marks result fields with their Imported/Manual source", () => {
    setup();
    const result = screen.getByTestId("merge-result");
    expect(within(result).getAllByText("Imported").length).toBeGreaterThan(0);
    expect(within(result).getAllByText("Manual").length).toBeGreaterThan(0);
  });

  it("confirms with the pair ids", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    setup({ onClose, onConfirm });

    fireEvent.click(screen.getByRole("button", { name: "Merge transactions" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([101, 102]));
    expect(onClose).not.toHaveBeenCalled();
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
