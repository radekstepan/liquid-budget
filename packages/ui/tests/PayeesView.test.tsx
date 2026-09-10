import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PayeesView } from "../src/PayeesView.js";
import type { Category, CategoryGroup, Payee } from "@ynab/logic";

const groups: CategoryGroup[] = [
  { id: 1, name: "Daily", sort: 0, isCreditCardPayments: false },
];

const categories: Category[] = [
  { id: 10, groupId: 1, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
  { id: 11, groupId: 1, name: "Coffee", sort: 1, carryover: "0", goalTarget: null, linkedAccountId: null },
];

const payees: Payee[] = [
  { id: 1, name: "Safeway", autoCategoryId: 10, createdAt: "" },
  { id: 2, name: "Starbucks #123", autoCategoryId: null, createdAt: "" },
];

const transactions = [
  { payee: "Safeway", parentId: null },
  { payee: "Safeway", parentId: null },
  { payee: "Text Only Cafe", parentId: null },
  { payee: "Transfer : Savings", parentId: null },
];

const recurring = [{ payee: "Safeway" }];

function renderView(over: Partial<Parameters<typeof PayeesView>[0]> = {}) {
  const onEnsurePayee = vi.fn().mockResolvedValue(99);
  const onRename = vi.fn().mockResolvedValue(undefined);
  const onSetDefaultCategory = vi.fn().mockResolvedValue(undefined);
  const onMerge = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  render(
    <PayeesView
      payees={over.payees ?? payees}
      transactions={over.transactions ?? transactions}
      recurring={over.recurring ?? recurring}
      categories={over.categories ?? categories}
      groups={over.groups ?? groups}
      onEnsurePayee={over.onEnsurePayee ?? onEnsurePayee}
      onRename={over.onRename ?? onRename}
      onSetDefaultCategory={over.onSetDefaultCategory ?? onSetDefaultCategory}
      onMerge={over.onMerge ?? onMerge}
      onDelete={over.onDelete ?? onDelete}
    />
  );
  return { onEnsurePayee, onRename, onSetDefaultCategory, onMerge, onDelete };
}

describe("PayeesView", () => {
  it("lists payees with uses and includes text-only names but not transfers", () => {
    renderView();
    expect(screen.getByText("Payees Manager")).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Safeway")).toBeInTheDocument();
    expect(table.getByText("Starbucks #123")).toBeInTheDocument();
    expect(table.getByText("Text Only Cafe")).toBeInTheDocument();
    expect(table.queryByText("Transfer : Savings")).not.toBeInTheDocument();
    // Safeway: 2 transactions + 1 scheduled
    expect(table.getByText("Safeway").closest("tr")).toHaveTextContent("3");
  });

  it("filters the list by name", () => {
    renderView();
    fireEvent.change(screen.getByLabelText("Filter payees"), { target: { value: "safe" } });
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Safeway")).toBeInTheDocument();
    expect(table.queryByText("Starbucks #123")).not.toBeInTheDocument();
  });

  it("renames a payee through the modal", async () => {
    const { onRename } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /rename payee Safeway/i }));
    fireEvent.change(screen.getByLabelText("Payee name"), { target: { value: "Safeway Market" } });
    fireEvent.click(screen.getByRole("button", { name: /save payee/i }));
    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith(1, "Safeway Market");
    });
  });

  it("renders payee names and default categories as links, with no rename icon button", () => {
    renderView();
    // Exactly one rename trigger per payee: the name link itself.
    const renameButtons = screen.getAllByRole("button", { name: /rename payee Safeway/i });
    expect(renameButtons).toHaveLength(1);
    expect(renameButtons[0]).toHaveTextContent("Safeway");
    expect(renameButtons[0]).toHaveStyle({ color: "var(--y-blue)" });
    // Default category cell is a link in theme blue, including "No default".
    const setCategory = screen.getByRole("button", { name: /set default category for Safeway/i });
    expect(setCategory).toHaveStyle({ color: "var(--y-blue)" });
    const noDefault = screen.getByRole("button", { name: /set default category for Starbucks #123/i });
    expect(noDefault).toHaveTextContent("No default");
    expect(noDefault).toHaveStyle({ color: "var(--y-blue)" });
  });

  it("renders the table inside a scrollable region", () => {
    renderView();
    expect(screen.getByTestId("payees-scroll")).toContainElement(screen.getByRole("table"));
  });

  it("changes the default category through the picker", async () => {
    const { onSetDefaultCategory } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /set default category for Starbucks #123/i }));
    fireEvent.click(screen.getByRole("button", { name: /use Coffee as default category/i }));
    await waitFor(() => {
      expect(onSetDefaultCategory).toHaveBeenCalledWith(2, 11);
    });
  });

  it("creates a saved payee when setting the default category of a text-only name", async () => {
    const { onEnsurePayee, onSetDefaultCategory } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /set default category for Text Only Cafe/i }));
    fireEvent.click(screen.getByRole("button", { name: /use Coffee as default category/i }));
    await waitFor(() => {
      expect(onEnsurePayee).toHaveBeenCalledWith("Text Only Cafe");
      expect(onSetDefaultCategory).toHaveBeenCalledWith(99, 11);
    });
  });

  it("clears the default category through the picker", async () => {
    const { onSetDefaultCategory } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /set default category for Safeway/i }));
    fireEvent.click(screen.getByRole("button", { name: /^no default$/i }));
    await waitFor(() => {
      expect(onSetDefaultCategory).toHaveBeenCalledWith(1, null);
    });
  });

  it("merges two selected payees into the most-used one", async () => {
    const { onMerge } = renderView();
    fireEvent.click(screen.getByLabelText("Select payee Safeway for merge"));
    fireEvent.click(screen.getByLabelText("Select payee Starbucks #123 for merge"));
    fireEvent.click(screen.getByRole("button", { name: /merge into one/i }));
    // Confirm in the merge modal (Safeway is the default survivor: 3 uses).
    fireEvent.click(screen.getByRole("button", { name: /^merge payees$/i }));
    await waitFor(() => {
      expect(onMerge).toHaveBeenCalledWith(1, [2]);
    });
  });

  it("deletes a payee after a two-step confirm", async () => {
    const { onDelete } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /delete payee Starbucks #123/i }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith(2);
    });
  });

  it("shows an empty state when there are no payees", () => {
    renderView({ payees: [], transactions: [], recurring: [] });
    expect(screen.getByText(/no payees yet/i)).toBeInTheDocument();
  });

  describe("full-list rendering", () => {
    const bigPayees: Payee[] = Array.from({ length: 500 }, (_, i) => ({
      id: 1000 + i,
      name: `Payee ${String(i).padStart(3, "0")}`,
      autoCategoryId: null,
      createdAt: "",
    }));

    const rows = () => within(screen.getByRole("table")).getAllByRole("row");

    it("renders the whole list up front so the scrollbar reflects the true size", () => {
      renderView({ payees: bigPayees, transactions: [], recurring: [] });
      // 1 header row + all 500 payee rows; no sentinel, no paging button.
      expect(rows()).toHaveLength(501);
      expect(screen.getByText("Payee 499")).toBeInTheDocument();
      expect(screen.queryByTestId("payees-sentinel")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
      expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "501");
    });

    it("still narrows the rendered rows when filtering", () => {
      renderView({ payees: bigPayees, transactions: [], recurring: [] });
      fireEvent.change(screen.getByLabelText("Filter payees"), { target: { value: "Payee 00" } });
      // "Payee 00x" matches 10 payees + 1 header row.
      expect(rows()).toHaveLength(11);
    });
  });
});
