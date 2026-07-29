import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "../src/Sidebar.js";
import type { Account } from "@ynab/logic";

const accounts: Account[] = [
  { id: 1, name: "Cash", kind: "liquid", groupLabel: "Liquid", balance: "320.00", onBudget: true, sort: 0 },
  { id: 2, name: "Checking", kind: "liquid", groupLabel: "Liquid", balance: "1658.08", onBudget: true, sort: 1 },
  { id: 3, name: "Chase", kind: "credit", groupLabel: "Credit Cards", balance: "-823.47", onBudget: true, sort: 2 },
  { id: 4, name: "Retirement", kind: "offbudget", groupLabel: "Retirement", balance: "58000.00", onBudget: false, sort: 3 },
];

describe("Sidebar", () => {
  it("renders all 6 nav buttons", () => {
    render(
      <Sidebar view="budget" setView={() => {}} accounts={accounts} onSelectAccount={() => {}} onAddAccount={() => {}} />
    );
    expect(screen.getByRole("button", { name: /budget/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reports/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /calendar/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /projections/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /all transactions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /recurring transactions/i })).toBeInTheDocument();
  });

  it("calls setView when a nav button is clicked", () => {
    const setView = vi.fn();
    render(
      <Sidebar view="budget" setView={setView} accounts={accounts} onSelectAccount={() => {}} onAddAccount={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: /reports/i }));
    expect(setView).toHaveBeenCalledWith("reports");
  });

  it("calls onAddAccount when the Add Account button is clicked", () => {
    const onAddAccount = vi.fn();
    render(
      <Sidebar view="budget" setView={() => {}} accounts={accounts} onSelectAccount={() => {}} onAddAccount={onAddAccount} />
    );
    fireEvent.click(screen.getByRole("button", { name: /add account/i }));
    expect(onAddAccount).toHaveBeenCalledTimes(1);
  });

  it("calls onSelectAccount with the account id", () => {
    const onSelectAccount = vi.fn();
    render(
      <Sidebar view="budget" setView={() => {}} accounts={accounts} onSelectAccount={onSelectAccount} onAddAccount={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: /cash/i }));
    expect(onSelectAccount).toHaveBeenCalledWith(1);
  });
});
