"use client";

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar.js";

describe("Sidebar logo", () => {
  it("renders the Font Awesome seedling mark in the logo badge", () => {
    const { container } = render(
      <Sidebar
        view="budget"
        setView={vi.fn()}
        accounts={[]}
        selectedAccountId={null}
        onSelectAccount={vi.fn()}
        onAddAccount={vi.fn()}
      />
    );
    const badge = container.querySelector(".y-logo");
    expect(badge).not.toBeNull();
    expect(badge?.querySelector("i.fa-solid.fa-seedling")).not.toBeNull();
  });
});
