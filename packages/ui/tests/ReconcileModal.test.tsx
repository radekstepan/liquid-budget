import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReconcileModal, type ReconcileModalState } from "../src/ReconcileModal.js";
import type { Category, CategoryGroup } from "@ynab/logic";
import { openSearchable } from "./dropdown.js";

const state: ReconcileModalState = {
  accountId: 7,
  accountName: "Chequing",
  workingBalance: 125050,
  unclearedTotal: -5000,
  unclearedCount: 2,
  clearedCount: 3,
  reconciledCount: 10,
  lastReconciledAt: null,
  lastReconciledBalance: null,
};

const groups: CategoryGroup[] = [
  { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
  { id: 2, name: "Credit Cards", sort: 1, isCreditCardPayments: true },
];

const categories: Category[] = [
  { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
  { id: 11, groupId: 1, name: "Rent", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
  { id: 12, groupId: 2, name: "AMEX", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
];

function renderModal(overrides: Partial<Parameters<typeof ReconcileModal>[0]> = {}) {
  const onClose = vi.fn();
  const onReconcile = vi.fn(async () => {});
  const onUnreconcile = vi.fn(async () => {});
  const view = render(
    <ReconcileModal
      state={state}
      categories={categories}
      groups={groups}
      onClose={onClose}
      onReconcile={onReconcile}
      onUnreconcile={onUnreconcile}
      {...overrides}
    />
  );
  return { onClose, onReconcile, onUnreconcile, view };
}

describe("ReconcileModal", () => {
  it("shows the three summary stats", () => {
    renderModal();
    expect(screen.getByText("Working Balance")).toBeInTheDocument();
    expect(screen.getByText("$1,250.50")).toBeInTheDocument();
    expect(screen.getByText(/3 cleared \+ reconciled/)).toBeInTheDocument();
    expect(screen.getByText("Uncleared")).toBeInTheDocument();
    expect(screen.getByText("Last Reconciled")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
  });

  it("shows 'never' for Last Reconciled value when lastReconciledBalance is null", () => {
    renderModal();
    // The Last Reconciled value cell renders "—" for a null balance.
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the balanced banner and enables Reconcile when statement matches working balance", () => {
    const { onReconcile } = renderModal();
    expect(screen.getByText("Balanced — ready to reconcile")).toBeInTheDocument();
    const reconcile = screen.getByRole("button", { name: /^reconcile$/i });
    expect(reconcile).toBeEnabled();
    fireEvent.click(reconcile);
    expect(onReconcile).toHaveBeenCalledWith({
      accountId: 7,
      statementBalance: 125050,
      adjustmentCategoryId: null,
    });
  });

  it("shows the difference and disables Reconcile until armed when the statement differs", () => {
    const { onReconcile } = renderModal();
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1000" },
    });

    expect(screen.getByText("Difference: -$250.50")).toBeInTheDocument();
    expect(screen.getByText("Absorb the difference")).toBeInTheDocument();
    const reconcile = screen.getByRole("button", { name: /^reconcile$/i });
    expect(reconcile).toBeDisabled();
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("enables Reconcile with the chosen adjustment category after arming", () => {
    const { onReconcile } = renderModal();
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1000" },
    });

    const arm = screen.getByRole("button", { name: /mark for adjustment/i });
    expect(arm).toBeEnabled();
    fireEvent.click(arm);
    expect(screen.getByRole("button", { name: /will create adjustment/i })).toBeInTheDocument();

    const reconcile = screen.getByRole("button", { name: /^reconcile$/i });
    expect(reconcile).toBeEnabled();
    fireEvent.click(reconcile);
    expect(onReconcile).toHaveBeenCalledWith({
      accountId: 7,
      statementBalance: 100000,
      adjustmentCategoryId: 10,
    });
  });

  it("renders the adjustment category search input in the field position with group headings", () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "1000" } });

    const input = openSearchable(/category/i);
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Everyday")).toBeInTheDocument();
    expect(list).not.toContainElement(input);
    expect(input).toHaveFocus();
  });

  it("resets the armed state when the statement input changes again", () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /mark for adjustment/i }));
    expect(screen.getByRole("button", { name: /^reconcile$/i })).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1100" },
    });
    expect(screen.getByRole("button", { name: /^reconcile$/i })).toBeDisabled();
  });

  it("shows a signed difference for a positive diff", () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1400" },
    });
    expect(screen.getByText("Difference: +$149.50")).toBeInTheDocument();
  });

  it("excludes credit-card payment categories from the adjustment dropdown", () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1000" },
    });
    openSearchable(/category/i);
    const list = screen.getByRole("listbox");
    const optionEls = within(list).getAllByRole("option") as HTMLButtonElement[];
    const labels = optionEls.map(
      (o) => o.querySelector(".y-dropdown-item-label")?.textContent ?? ""
    );
    expect(labels).toEqual(["Groceries", "Rent"]);
  });

  it("shows 'No categories available' and disables arming when no eligible category exists", () => {
    renderModal({ categories: [categories[2]!] });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1000" },
    });
    // With no eligible categories the closed field shows the notice as its value.
    expect(screen.getByText("No categories available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark for adjustment/i })).toBeDisabled();
  });

  it("allows an expression in the statement balance field", () => {
    const { onReconcile } = renderModal();
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "1000 + 250.50" },
    });
    const reconcile = screen.getByRole("button", { name: /^reconcile$/i });
    expect(reconcile).toBeEnabled();
    fireEvent.click(reconcile);
    expect(onReconcile).toHaveBeenCalledWith({
      accountId: 7,
      statementBalance: 125050,
      adjustmentCategoryId: null,
    });
  });

  it("calls onUnreconcile when the undo link is clicked", () => {
    const { onUnreconcile } = renderModal({
      state: {
        ...state,
        lastReconciledAt: "2026-06-01",
        lastReconciledBalance: 120000,
      },
    });
    expect(screen.getByText(/already reconciled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undo the last reconciliation/i }));
    expect(onUnreconcile).toHaveBeenCalledWith(7);
  });

  it("hides the undo notice when onUnreconcile is not provided", () => {
    renderModal({
      state: { ...state, lastReconciledAt: "2026-06-01", lastReconciledBalance: 1200 },
      onUnreconcile: undefined,
    });
    expect(screen.queryByText(/already reconciled/i)).not.toBeInTheDocument();
  });

  it("disables the Reconcile button while busy", () => {
    renderModal({ busy: true });
    expect(screen.getByRole("button", { name: /^reconcile$/i })).toBeDisabled();
  });

  it("calls onClose from Cancel", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
