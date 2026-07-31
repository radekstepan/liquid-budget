import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionsView } from "../src/TransactionsView.js";
import { makeSeedBudgetData } from "@ynab/logic";

describe("TransactionsView", () => {
  it("renders transaction rows and search filters them", () => {
    const data = makeSeedBudgetData();
    render(
      <TransactionsView
        data={data}
        accountFilter={null}
        setAccountFilter={() => {}}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );

    expect(screen.getAllByText("Superstore").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SAP Concur").length).toBeGreaterThan(0);

    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: "Superstore" } });
    expect(screen.getAllByText("Superstore").length).toBeGreaterThan(0);
    expect(screen.queryByText("SAP Concur")).not.toBeInTheDocument();
  });

  it("calls onAdd when Add Transaction is clicked", () => {
    const onAdd = vi.fn();
    render(
      <TransactionsView
        data={makeSeedBudgetData()}
        accountFilter={null}
        setAccountFilter={() => {}}
        onAdd={onAdd}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
