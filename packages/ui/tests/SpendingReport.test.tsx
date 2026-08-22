import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SpendingReport, type SpendingItem } from "../src/SpendingReport.js";

const sampleSpending: SpendingItem[] = [
  { name: "Mortgage Interest", value: -100000 },
  { name: "Groceries", value: -40000 },
  { name: "Electric Bill", value: -15000 },
];

describe("SpendingReport", () => {
  it("renders the panel title and total", () => {
    render(<SpendingReport spending={sampleSpending} total={-155000} />);
    expect(screen.getByText("Spending by Category")).toBeInTheDocument();
    expect(screen.getByText(/Total:/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,550\.00/)).toBeInTheDocument();
  });

  it("renders each spending row with name, amount, and percent", () => {
    render(<SpendingReport spending={sampleSpending} total={-155000} />);
    expect(screen.getByText("Mortgage Interest")).toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Electric Bill")).toBeInTheDocument();
    expect(screen.getByText("65%")).toBeInTheDocument();
    expect(screen.getByText("26%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("renders bar tracks for each item in bars mode", () => {
    const { container } = render(<SpendingReport spending={sampleSpending} total={-155000} />);
    expect(container.querySelectorAll(".y-bar-track").length).toBe(3);
  });

  it("shows empty state when spending is empty", () => {
    render(<SpendingReport spending={[]} total={0} />);
    expect(screen.getByText("No data for this timeframe.")).toBeInTheDocument();
  });

  it("shows View toggle buttons", () => {
    render(<SpendingReport spending={sampleSpending} total={-155000} />);
    expect(screen.getByRole("button", { name: "Bars", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Donut", exact: true })).toBeInTheDocument();
  });

  it("displays row count in the header", () => {
    render(<SpendingReport spending={sampleSpending} total={-155000} />);
    expect(screen.getByText("3 categories")).toBeInTheDocument();
  });

  it("uses singular 'category' for a single item", () => {
    render(<SpendingReport spending={[{ name: "Only One", value: -1000 }]} total={-1000} />);
    expect(screen.getByText("1 category")).toBeInTheDocument();
  });
});
