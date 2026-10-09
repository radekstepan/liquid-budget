import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  THEMES,
  THEME_IDS,
  THEME_STORAGE_KEY,
  DEFAULT_THEME_ID,
  isThemeId,
  applyThemeId,
} from "@ynab/theme";
import { makeSeedBudgetData } from "@ynab/logic";
import { ThemesView } from "../src/ThemesView.js";
import { BudgetApp, type BudgetAppApi } from "../src/BudgetApp.js";
import { Inspector } from "../src/Inspector.js";

const HEX = /^#[0-9a-f]{6}$/i;

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("themes", () => {
  it("lists every theme id exactly once with valid swatches", () => {
    expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    for (const theme of THEMES) {
      expect(theme.label.length).toBeGreaterThan(0);
      expect(theme.description.length).toBeGreaterThan(0);
      expect(theme.swatches.sideTop).toMatch(HEX);
      expect(theme.swatches.sideBot).toMatch(HEX);
      expect(theme.swatches.accent).toMatch(HEX);
    }
    expect(DEFAULT_THEME_ID).toBe("classic");
  });

  it("validates stored theme ids", () => {
    for (const id of THEME_IDS) {
      expect(isThemeId(id)).toBe(true);
    }
    expect(isThemeId("neon")).toBe(false);
    expect(isThemeId("")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId(3)).toBe(false);
    expect(isThemeId({})).toBe(false);
  });

  it("applyThemeId points <html data-theme> at the theme", () => {
    applyThemeId("forest");
    expect(document.documentElement.dataset.theme).toBe("forest");
    applyThemeId("classic");
    expect(document.documentElement.dataset.theme).toBe("classic");
  });
});

describe("ThemesView", () => {
  it("renders every theme as a radio with the active one checked", () => {
    render(<ThemesView themeId="midnight" onSelect={() => {}} />);
    expect(screen.getByRole("heading", { name: "Themes" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Themes" })).toBeInTheDocument();
    for (const theme of THEMES) {
      const radio = screen.getByRole("radio", { name: theme.label });
      expect(radio).toBeInTheDocument();
      if (theme.id === "midnight") {
        expect(radio).toBeChecked();
      } else {
        expect(radio).not.toBeChecked();
      }
    }
  });

  it("calls onSelect with the clicked theme", () => {
    const onSelect = vi.fn();
    render(<ThemesView themeId="classic" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("radio", { name: "Ember" }));
    expect(onSelect).toHaveBeenCalledWith("ember");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("Inspector themes menu item", () => {
  const baseProps = {
    groups: [],
    month: "2026-06",
    tbb: 0,
    overBudgeted: false,
    onSelectMonth: () => {},
  };

  it("opens the themes page when the menu item is clicked", () => {
    const onOpenThemes = vi.fn();
    render(<Inspector {...baseProps} onOpenThemes={onOpenThemes} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByText("Themes"));
    expect(onOpenThemes).toHaveBeenCalledTimes(1);
  });

  it("hides the menu item when the callback is not provided", () => {
    render(<Inspector {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.queryByText("Themes")).not.toBeInTheDocument();
  });
});

describe("BudgetApp themes integration", () => {
  // Themes need no server round-trip, so a no-op api is enough.
  const api = new Proxy(
    {},
    { get: () => async () => {} }
  ) as unknown as BudgetAppApi;

  function openThemes() {
    render(<BudgetApp data={makeSeedBudgetData()} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByText("Themes"));
    expect(screen.getByRole("heading", { name: "Themes" })).toBeInTheDocument();
  }

  it("opens Themes from the cog menu and persists the selection", () => {
    openThemes();
    expect(screen.getByRole("radio", { name: "Classic Blue" })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe("classic");

    fireEvent.click(screen.getByRole("radio", { name: "Forest" }));

    expect(screen.getByRole("radio", { name: "Forest" })).toBeChecked();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('"forest"');
    expect(document.documentElement.dataset.theme).toBe("forest");
  });

  it("restores the persisted theme on load", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, '"ember"');
    openThemes();
    expect(screen.getByRole("radio", { name: "Ember" })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe("ember");
  });
});
