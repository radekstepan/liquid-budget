import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MenuSettingsView } from "../src/MenuSettingsView.js";
import { DEFAULT_NAV_VISIBILITY } from "../src/navVisibility.js";
import type { View } from "../src/Sidebar.js";

function renderMenu(over: Partial<Record<View, boolean>> = {}) {
  const onToggle = vi.fn();
  render(
    <MenuSettingsView
      visible={{ ...DEFAULT_NAV_VISIBILITY, ...over }}
      onToggle={onToggle}
      privacyEnabled={false}
      onTogglePrivacy={vi.fn()}
      onRegeneratePrivacyAmounts={vi.fn()}
    />
  );
  return { onToggle };
}

describe("MenuSettingsView", () => {
  it("renders all three menu pages checked by default", () => {
    renderMenu();
    expect(screen.getByRole("heading", { name: "Page Visibility" })).toBeInTheDocument();
    for (const name of ["Budget", "Reports", "Transactions"]) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked();
    }
  });

  it("reflects hidden pages as unchecked", () => {
    renderMenu({ reports: false, transactions: false });
    expect(screen.getByRole("checkbox", { name: "Reports" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Transactions" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Budget" })).toBeChecked();
  });

  it("calls onToggle when a page is hidden or reshown", () => {
    const { onToggle } = renderMenu();
    fireEvent.click(screen.getByRole("checkbox", { name: "Budget" }));
    expect(onToggle).toHaveBeenCalledWith("budget", false);

    cleanup();
    const { onToggle: onToggle2 } = renderMenu({ reports: false });
    expect(onToggle2).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reports" }));
    expect(onToggle2).toHaveBeenCalledWith("reports", true);
  });

  it("greys out the last visible page so it cannot be hidden", () => {
    const { onToggle } = renderMenu({
      reports: false,
      transactions: false,
    });
    expect(screen.getByRole("checkbox", { name: "Budget" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Budget" }));
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Budget" })).toBeChecked();
    expect(screen.getByText(/at least one page must stay visible/i)).toBeInTheDocument();
  });
});
