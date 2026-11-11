import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { type GroupRow, type CatRow } from "@ynab/logic";
import { MonthCells, CategoryMonthCell } from "../src/MonthCells.js";

function groupRow(overrides: Partial<GroupRow> = {}): GroupRow {
  return {
    group: { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
    rows: [],
    assigned: 160000,
    outflow: -7000,
    available: 3000,
    ...overrides,
  };
}

function catRow(overrides: Partial<CatRow> = {}): CatRow {
  return {
    category: {
      id: 10,
      groupId: 1,
      name: "Groceries",
      sort: 0,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: null,
    },
    carryoverIn: 0,
    assigned: 10000,
    outflow: -5000,
    ccBuffer: 0,
    available: 5000,
    fundedPct: 1,
    ...overrides,
  };
}

function renderCells(cell: ReactElement) {
  return render(
    <table>
      <tbody>
        <tr>{cell}</tr>
      </tbody>
    </table>
  );
}

describe("MonthCells (ui-split slice 4)", () => {
  it("renders the group triple read-only", () => {
    renderCells(
      <MonthCells group={groupRow()} isOtherMonth={false} isFirstMonth isRowForGroup />
    );
    expect(screen.getByText("$1,600.00")).toBeDefined();
    expect(screen.getByText("-$70.00")).toBeDefined();
    expect(screen.getByText("$30.00")).toBeDefined();
  });

  it("renders a category assigned as plain text without onAssign", () => {
    renderCells(<MonthCells row={catRow()} isOtherMonth={false} isFirstMonth />);
    expect(screen.getByText("$100.00")).toBeDefined();
  });

  it("embeds the inline editor when onAssign is provided", () => {
    const onAssign = vi.fn();
    renderCells(
      <MonthCells row={catRow()} isOtherMonth={false} isFirstMonth onAssign={onAssign} />
    );
    fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
    const input = screen.getByLabelText("Edit assigned amount");
    fireEvent.change(input, { target: { value: "123.45" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith(12345);
  });

  it("shows the carry-over arrow for negative available with the flag set", () => {
    renderCells(
      <MonthCells
        row={catRow({
          available: -2000,
          category: {
            id: 11,
            groupId: 1,
            name: "Rent",
            sort: 1,
            carryover: "0",
            goalTarget: null,
            linkedAccountId: null,
            overspendCarriesOver: true,
          },
        })}
        isOtherMonth={false}
        isFirstMonth
      />
    );
    expect(screen.getByLabelText("Red arrow: carry over")).toBeDefined();
  });

  it("renders an empty triple without a row", () => {
    const { container } = renderCells(<MonthCells isOtherMonth={false} isFirstMonth />);
    expect(container.querySelector("td[colspan='3']")).not.toBeNull();
  });
});

describe("OverspentMarker (a11y slice 3)", () => {
  it("marks negative group balances without changing the amount text", () => {
    renderCells(
      <MonthCells
        group={groupRow({ available: -2000 })}
        isOtherMonth={false}
        isFirstMonth
        isRowForGroup
      />
    );
    expect(screen.getByText("-$20.00")).toBeDefined();
    expect(screen.getByLabelText("Overspent")).toBeDefined();
  });

  it("marks negative category balances without changing the amount text", () => {
    renderCells(
      <MonthCells
        row={catRow({ available: -2000 })}
        isOtherMonth={false}
        isFirstMonth
      />
    );
    expect(screen.getByText("-$20.00")).toBeDefined();
    expect(screen.getByLabelText("Overspent")).toBeDefined();
  });

  it("stays absent for zero and positive balances", () => {
    renderCells(
      <MonthCells group={groupRow()} isOtherMonth={false} isFirstMonth isRowForGroup />
    );
    expect(screen.queryByLabelText("Overspent")).toBeNull();

    renderCells(
      <MonthCells
        row={catRow({ available: 0 })}
        isOtherMonth={false}
        isFirstMonth
      />
    );
    expect(screen.queryByLabelText("Overspent")).toBeNull();
  });
});

describe("CategoryMonthCell (ui-split slice 4)", () => {
  it("discards the draft on Escape without assigning", () => {
    const onAssign = vi.fn();
    render(<CategoryMonthCell value={10000} onAssign={onAssign} />);
    fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
    const input = screen.getByLabelText("Edit assigned amount");
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onAssign).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Edit assigned amount")).toBeNull();
  });

  it("keeps blocked drafts open on Enter", () => {
    const onAssign = vi.fn();
    render(<CategoryMonthCell value={10000} onAssign={onAssign} />);
    fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
    const input = screen.getByLabelText("Edit assigned amount");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAssign).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Enter a valid amount")).toBeDefined();
  });

  it("assigns zero, clearing the category", () => {
    const onAssign = vi.fn();
    render(<CategoryMonthCell value={10000} onAssign={onAssign} />);
    fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
    const input = screen.getByLabelText("Edit assigned amount");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith(0);
  });
});
