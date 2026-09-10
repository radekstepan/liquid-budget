"use client";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GlobalSearchModal } from "./GlobalSearchModal.js";
import type { BudgetData } from "@ynab/logic";

function fixture(): BudgetData {
  return {
    accounts: [
      { id: 1, name: "Checking", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 0 },
      { id: 2, name: "Savings", kind: "liquid", groupLabel: "Cash", balance: "0", onBudget: true, sort: 1 },
    ],
    groups: [{ id: 10, name: "Food", sort: 0, isCreditCardPayments: false }],
    categories: [
      { id: 100, groupId: 10, name: "Groceries", sort: 0, carryover: "0", goalTarget: null, linkedAccountId: null },
    ],
    assignments: [],
    transactions: [
      { id: 1, accountId: 1, categoryId: 100, date: "2026-09-01", payee: "Whole Foods", memo: "", amount: "-5000", status: "c", parentId: null, transferAccountId: null },
      { id: 2, accountId: 2, categoryId: 100, date: "2026-09-02", payee: "Landlord", memo: "", amount: "-100000", status: "c", parentId: null, transferAccountId: null },
    ],
    recurring: [],
  };
}

describe("GlobalSearchModal", () => {
  it("scopes to the account and expands to all via toggle", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(
      <GlobalSearchModal data={fixture()} scopeAccountId={1} open onClose={onClose} onJump={onJump} />
    );
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "landlord" } });
    // Scoped to Checking: the Savings transaction is hidden from grouped hits.
    await waitFor(() => expect(screen.queryByText("Transactions")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /searching checking/i }));
    await waitFor(() => expect(screen.queryByText("Transactions")).not.toBeNull());
  });

  it("converts payee: typing into context mode and jumps on Enter", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(
      <GlobalSearchModal data={fixture()} scopeAccountId={null} open onClose={onClose} onJump={onJump} />
    );
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "payee:whole" } });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /whole foods/i })).not.toBeNull()
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith({ kind: "payee", payee: "Whole Foods" });
    expect(onClose).toHaveBeenCalled();
  });

  it("lists matching transactions for chip-only filters and applies them to the register", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(
      <GlobalSearchModal data={fixture()} scopeAccountId={null} open onClose={onClose} onJump={onJump} />
    );
    const input = screen.getByTestId("global-search-input");
    // The input is a bespoke transparent field, not a nested y-input box.
    expect(input.classList.contains("y-input")).toBe(false);
    // Commit a structured filter via raw key:value + Enter.
    fireEvent.change(input, { target: { value: "is:cleared" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("Matching transactions")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Show in register" }));
    expect(onJump).toHaveBeenCalledWith({
      kind: "query",
      query: { filters: [{ kind: "is", value: "cleared" }], text: "" },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("carries committed chips along on free-text jumps", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(
      <GlobalSearchModal data={fixture()} scopeAccountId={null} open onClose={onClose} onJump={onJump} />
    );
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "is:cleared" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("Matching transactions")).not.toBeNull());
    fireEvent.change(input, { target: { value: "landlord" } });
    await waitFor(() => expect(screen.queryByText("Transactions")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    // First selectable item is the "Search everything" row.
    expect(onJump).toHaveBeenCalledWith({
      kind: "query",
      query: { filters: [{ kind: "is", value: "cleared" }], text: "landlord" },
    });
  });

  it("pre-fills chips and text from initialQuery when editing", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(
      <GlobalSearchModal
        data={fixture()}
        scopeAccountId={null}
        open
        onClose={onClose}
        onJump={onJump}
        initialQuery={{ filters: [{ kind: "is", value: "cleared" }], text: "whole" }}
      />
    );
    // Seeded chip + text are visible immediately, with live results.
    await waitFor(() => expect(screen.queryByText("Transactions")).not.toBeNull());
    expect(screen.getByTestId("global-search-input")).toHaveValue("whole");
    fireEvent.click(screen.getByRole("button", { name: "Show in register" }));
    expect(onJump).toHaveBeenCalledWith({
      kind: "query",
      query: { filters: [{ kind: "is", value: "cleared" }], text: "whole" },
    });
  });

  it("styles committed chips with the theme and tooltips edit/remove affordances", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <GlobalSearchModal
        data={fixture()}
        scopeAccountId={null}
        open
        onClose={onClose}
        onJump={onJump}
        initialQuery={{ filters: [{ kind: "is", value: "cleared" }], text: "" }}
      />
    );
    // Theme chip styling: chrome-gradient chip inside a y-input-language box.
    expect(container.querySelector(".y-searchbox")).not.toBeNull();
    const chip = container.querySelector(".y-chip");
    expect(chip).not.toBeNull();
    const editBtn = screen.getByRole("button", { name: "Edit Is filter" });
    const removeBtn = screen.getByRole("button", { name: "Remove Is filter" });
    expect(chip!.contains(editBtn)).toBe(true);
    expect(chip!.contains(removeBtn)).toBe(true);
    // Both halves use the theme chip classes that carry cursor:pointer.
    expect(editBtn.classList.contains("y-chip-edit")).toBe(true);
    expect(removeBtn.classList.contains("y-chip-x")).toBe(true);
    // Hovering the chip body offers an edit tooltip; hovering x offers remove.
    fireEvent.mouseOver(editBtn.closest(".y-tip-wrap")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Edit Is filter");
    fireEvent.mouseOut(editBtn.closest(".y-tip-wrap")!);
    fireEvent.mouseOver(removeBtn.closest(".y-tip-wrap")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Remove Is filter");
    fireEvent.mouseOut(removeBtn.closest(".y-tip-wrap")!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders the key pill with the blue theme treatment instead of white-on-black", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <GlobalSearchModal data={fixture()} scopeAccountId={null} open onClose={onClose} onJump={onJump} />
    );
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "payee:" } });
    const pill = container.querySelector(".y-chip--key");
    expect(pill).not.toBeNull();
    expect(pill).toHaveTextContent("Payee");
    expect(pill!.classList.contains("text-white")).toBe(false);
  });

  it("renders the results list inline with no popover drop shadow", () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(
      <GlobalSearchModal data={fixture()} scopeAccountId={null} open onClose={onClose} onJump={onJump} />
    );
    const list = screen.getByRole("listbox", { name: "Search results" });
    expect(list.classList.contains("y-dropdown")).toBe(true);
    expect(list.classList.contains("y-dropdown--inline")).toBe(true);
  });

  it("jumps to a transaction from free-text results", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(
      <GlobalSearchModal data={fixture()} scopeAccountId={null} open onClose={onClose} onJump={onJump} />
    );
    const input = screen.getByTestId("global-search-input");
    fireEvent.change(input, { target: { value: "whole" } });
    await waitFor(() => expect(screen.queryByText("Transactions")).not.toBeNull());
    const txOption = screen
      .getAllByRole("option")
      .find((el) => el.textContent?.includes("Whole Foods") && el.textContent?.includes("2026-09-01"));
    expect(txOption).not.toBeUndefined();
    fireEvent.click(txOption!);
    expect(onJump).toHaveBeenCalledWith({ kind: "transaction", transactionId: 1, accountId: 1 });
    expect(onClose).toHaveBeenCalled();
  });
});
