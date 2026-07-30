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
        onDelete={() => {}}
      />
    );

    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    expect(screen.getAllByText("Acme Corp Payroll").length).toBeGreaterThan(0);

    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: "Whole" } });
    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    expect(screen.queryByText("Acme Corp Payroll")).not.toBeInTheDocument();
  });

  it("calls onAdd when Add Transaction is clicked", () => {
    const onAdd = vi.fn();
    render(
      <TransactionsView
        data={makeSeedBudgetData()}
        accountFilter={null}
        setAccountFilter={() => {}}
        onAdd={onAdd}
        onDelete={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
