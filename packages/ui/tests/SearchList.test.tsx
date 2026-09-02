import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SearchList, type SearchListOption } from "@ynab/theme";

const payees: SearchListOption[] = [
  { value: "Whole Foods", label: "Whole Foods" },
  { value: "IGA", label: "IGA" },
  { value: "Costco", label: "Costco" },
];

/** Controlled wrapper mirroring real usage (parent stores the raw text). */
function Harness({
  onChange,
  ...props
}: Omit<React.ComponentProps<typeof SearchList>, "value" | "onChange"> & {
  onChange?: (v: string) => void;
}) {
  const [v, setV] = useState("");
  return (
    <SearchList
      {...props}
      value={v}
      onChange={(n) => {
        setV(n);
        onChange?.(n);
      }}
    />
  );
}

describe("SearchList", () => {
  function openField() {
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    return input;
  }

  it("renders a text input with text cursor and opens dropdown on focus", () => {
    render(<Harness options={payees} placeholder="Search payees" />);
    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters options as user types into the input", () => {
    render(<Harness options={payees} placeholder="Search" />);
    const input = openField();
    const list = screen.getByRole("listbox");
    expect(list).not.toContainElement(input);
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.change(input, { target: { value: "COST" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Costco"]);
  });

  it("commits the picked option label on click and closes the dropdown", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} placeholder="Search" />);
    const input = openField();
    fireEvent.change(input, { target: { value: "ig" } });
    fireEvent.click(screen.getByRole("option", { name: "IGA" }));
    expect(onChange).toHaveBeenLastCalledWith("IGA");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("offers a Create row for a brand-new value when allowCreate is set", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} allowCreate placeholder="Search" />);
    const input = openField();
    fireEvent.change(input, { target: { value: "Uber" } });
    fireEvent.click(screen.getByRole("option", { name: /create “uber”/i }));
    expect(onChange).toHaveBeenLastCalledWith("Uber");
  });

  it("does not offer a Create row when the typed text exactly matches an option", () => {
    render(<Harness options={payees} allowCreate placeholder="Search" />);
    const input = openField();
    fireEvent.change(input, { target: { value: "Costco" } });
    expect(screen.queryByRole("option", { name: /create/i })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Costco" })).toBeInTheDocument();
  });

  it("is pick-only (no Create row) and shows 'No matches' when allowCreate is false", () => {
    render(<Harness options={payees} placeholder="Search" />);
    const input = openField();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryByRole("option", { name: /create/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });

  it("navigates with arrow keys and commits with Enter", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} placeholder="Search" />);
    const input = openField();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("IGA");
  });

  it("closes on Escape without committing and keeps the input focused", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} placeholder="Search" />);
    openField();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders group headings above options", () => {
    const cats: SearchListOption[] = [
      { value: "1", label: "Groceries", group: "Everyday" },
      { value: "2", label: "Rent", group: "Everyday" },
      { value: "3", label: "Movies", group: "Fun" },
    ];
    render(<Harness options={cats} placeholder="Search" />);
    openField();
    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.getByText("Fun")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});
