import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SettingsView } from "../src/SettingsView.js";
import type { RenameRule } from "@ynab/logic";

const rules: RenameRule[] = [
  { id: 1, sourcePattern: "BCF1", targetPayee: "BC Ferries", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: 2, sourcePattern: "BCF[N]", targetPayee: "BC Ferries", createdAt: "2026-01-02T00:00:00.000Z" },
  { id: 3, sourcePattern: "UBER", targetPayee: "Uber", createdAt: "2026-01-03T00:00:00.000Z" },
];

function renderView(over: Partial<Parameters<typeof SettingsView>[0]> = {}) {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <SettingsView
      rules={over.rules ?? rules}
      onAdd={over.onAdd ?? onAdd}
      onUpdate={over.onUpdate ?? onUpdate}
      onDelete={over.onDelete ?? onDelete}
      existingPayees={over.existingPayees}
      onApply={over.onApply}
    />
  );
  return { view, onAdd, onUpdate, onDelete };
}

describe("SettingsView", () => {
  it("renders the rename rules with source and target columns", () => {
    renderView();
    expect(screen.getByText("Payee Rename Rules")).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("BCF1")).toBeInTheDocument();
    expect(table.getByText("BCF[N]")).toBeInTheDocument();
    expect(table.getAllByText("BC Ferries")).toHaveLength(2);
    expect(table.getByText("Uber")).toBeInTheDocument();
  });

  it("shows an empty state when there are no rules", () => {
    renderView({ rules: [] });
    expect(screen.getByText(/no rename rules yet/i)).toBeInTheDocument();
  });

  it("adds a rule through the modal and calls onAdd", async () => {
    const { onAdd } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /add rename rule/i }));

    const modal = document.body;
    const source = within(modal).getByLabelText("Source pattern");
    const target = within(modal).getByLabelText("Target payee");
    fireEvent.change(source, { target: { value: "BCF5" } });
    fireEvent.change(target, { target: { value: "BC Ferries" } });

    fireEvent.click(screen.getByRole("button", { name: /save rule/i }));
    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith("BCF5", "BC Ferries");
    });
  });

  it("edits an existing rule and calls onUpdate", async () => {
    const { onUpdate } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /edit rule BCF1/i }));

    const target = document.body;
    const source = within(target).getByLabelText("Source pattern");
    fireEvent.change(source, { target: { value: "BCF1X" } });
    fireEvent.click(screen.getByRole("button", { name: /save rule/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(1, "BCF1X", "BC Ferries");
    });
  });

  it("deletes a rule after a two-step confirm", async () => {
    const { onDelete } = renderView();
    fireEvent.click(screen.getByRole("button", { name: /delete rule BCF1/i }));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /yes, delete it/i }));
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith(1);
    });
  });

  it("hides match counts and apply actions without history props", () => {
    renderView();
    const table = within(screen.getByRole("table"));
    expect(table.getAllByText("—").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /apply rule/i })
    ).not.toBeInTheDocument();
  });

  it("shows per-rule existing match counts", () => {
    renderView({
      existingPayees: ["BCF1", "BCF9", "BC Ferries", "UBER TRIP"],
      onApply: vi.fn().mockResolvedValue({ updated: 0, skippedLocked: 0 }),
    });
    // BCF1 (exact) matches 1; BCF[N] matches BCF1 + BCF9; UBER matches none.
    expect(screen.getByLabelText("1 existing transactions match BCF1")).toBeInTheDocument();
    expect(screen.getByLabelText("2 existing transactions match BCF[N]")).toBeInTheDocument();
    expect(screen.getByLabelText("0 existing transactions match UBER")).toBeInTheDocument();
  });

  it("applies a rule and reports the result", async () => {
    const onApply = vi.fn().mockResolvedValue({ updated: 2, skippedLocked: 1 });
    renderView({ existingPayees: ["BCF1", "BCF2"], onApply });

    fireEvent.click(
      screen.getByRole("button", { name: /apply rule BCF\[N\] to existing transactions/i })
    );
    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith(2);
    });
    await waitFor(() => {
      expect(screen.getByText("Rule applied")).toBeInTheDocument();
    });
    expect(screen.getByText(/renamed 2 existing transactions/)).toBeInTheDocument();
    expect(screen.getByText(/1 reconciled left untouched/)).toBeInTheDocument();
  });

  it("disables apply when a rule matches nothing", () => {
    renderView({
      existingPayees: ["BC Ferries"],
      onApply: vi.fn().mockResolvedValue({ updated: 0, skippedLocked: 0 }),
    });
    expect(
      screen.getByRole("button", { name: /apply rule UBER to existing transactions/i })
    ).toBeDisabled();
  });

  it("keeps the rules list in its own scroll region inside the overlay", () => {
    renderView({
      existingPayees: [],
      onApply: vi.fn().mockResolvedValue({ updated: 0, skippedLocked: 0 }),
    });
    // The settings overlay clips its content, so the list must scroll
    // internally (like the payees manager) instead of growing past it.
    const scroller = screen.getByTestId("rules-scroll");
    expect(within(scroller).getByRole("table")).toBeInTheDocument();
    expect(scroller.className).toContain("overflow-auto");
    expect(scroller.className).toContain("min-h-0");
  });
});
