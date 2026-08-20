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
  it("opens on focus and filters options by case-insensitive substring", () => {
    render(<Harness options={payees} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.change(input, { target: { value: "COST" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Costco"]);
  });

  it("commits the picked option label on click", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ig" } });
    fireEvent.click(screen.getByRole("option", { name: "IGA" }));
    expect(onChange).toHaveBeenLastCalledWith("IGA");
  });

  it("closes the dropdown after picking an option (no reopen on refocus)", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ig" } });
    fireEvent.click(screen.getByRole("option", { name: "IGA" }));
    expect(onChange).toHaveBeenLastCalledWith("IGA");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("offers a Create row for a brand-new value when allowCreate is set", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} allowCreate />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Uber" } });
    fireEvent.click(screen.getByRole("option", { name: /create “uber”/i }));
    expect(onChange).toHaveBeenLastCalledWith("Uber");
  });

  it("does not offer a Create row when the typed text exactly matches an option", () => {
    render(<Harness options={payees} allowCreate />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Costco" } });
    expect(screen.queryByRole("option", { name: /create/i })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Costco" })).toBeInTheDocument();
  });

  it("is pick-only (no Create row) and shows 'No matches' when allowCreate is false", () => {
    render(<Harness options={payees} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryByRole("option", { name: /create/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });

  it("navigates with arrow keys and commits with Enter", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("IGA");
  });

  it("closes on Escape without committing", () => {
    const onChange = vi.fn();
    render(<Harness options={payees} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders group headings above options", () => {
    const cats: SearchListOption[] = [
      { value: "1", label: "Groceries", group: "Everyday" },
      { value: "2", label: "Rent", group: "Everyday" },
      { value: "3", label: "Movies", group: "Fun" },
    ];
    render(<Harness options={cats} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.getByText("Fun")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});
