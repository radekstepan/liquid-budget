import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { Select } from "@ynab/theme";

function renderSelect(props: React.ComponentProps<typeof Select>) {
  return render(<Select {...props} />);
}

describe("Dropdown (Select)", () => {
  it("renders the currently selected label on the trigger", () => {
    renderSelect({
      value: "b",
      onChange: () => {},
      children: (
        <>
          <option value="a">Apple</option>
          <option value="b">Banana</option>
          <option value="c">Cherry</option>
        </>
      ),
    });
    expect(screen.getByRole("button", { name: /banana/i })).toBeInTheDocument();
  });

  it("opens the listbox on click and closes on outside click", () => {
    renderSelect({
      value: "a",
      onChange: () => {},
      children: (
        <>
          <option value="a">Apple</option>
          <option value="b">Banana</option>
        </>
      ),
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /apple/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("calls onChange with the new value when an option is clicked", () => {
    const onChange = vi.fn();
    renderSelect({
      value: "a",
      onChange,
      children: (
        <>
          <option value="a">Apple</option>
          <option value="b">Banana</option>
        </>
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: /apple/i }));
    fireEvent.click(screen.getByRole("option", { name: /banana/i }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    renderSelect({
      value: "a",
      onChange: () => {},
      children: (
        <>
          <option value="a">Apple</option>
          <option value="b">Banana</option>
        </>
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: /apple/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("navigates with ArrowDown / ArrowUp and commits with Enter", () => {
    const onChange = vi.fn();
    renderSelect({
      value: "a",
      onChange,
      children: (
        <>
          <option value="a">Apple</option>
          <option value="b">Banana</option>
          <option value="c">Cherry</option>
        </>
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: /apple/i }));
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("does not open when disabled", () => {
    renderSelect({
      value: "a",
      onChange: () => {},
      disabled: true,
      children: (
        <>
          <option value="a">Apple</option>
          <option value="b">Banana</option>
        </>
      ),
    });
    const trigger = screen.getByRole("button", { name: /apple/i });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports the options prop (string form)", () => {
    const onChange = vi.fn();
    renderSelect({
      value: "x",
      onChange,
      options: ["x", "y", "z"],
    });
    fireEvent.click(screen.getByRole("button", { name: "x" }));
    fireEvent.click(screen.getByRole("option", { name: "z" }));
    expect(onChange).toHaveBeenCalledWith("z");
  });

  describe("searchable", () => {
    const accounts = [
      { value: "1", label: "Checking" },
      { value: "2", label: "Savings" },
      { value: "3", label: "Credit Card" },
      { value: "4", label: "Cash" },
    ];

    function renderSearchable(value = "1") {
      return renderSelect({
        value,
        onChange: () => {},
        searchable: true,
        ariaLabel: "Account",
        options: accounts,
      });
    }

    function openSearchableControl(value = "1") {
      const trigger = screen.getByRole("button", { name: /account/i });
      fireEvent.click(trigger);
      const input = screen.getByRole("textbox", { name: /account/i });
      act(() => {
        input.focus();
      });
      return input;
    }

    it("shows the selected label on the closed trigger, then the input on open", () => {
      renderSearchable();
      // Closed: the field is a trigger button showing the selection, with no
      // search input rendered.
      expect(screen.queryByRole("textbox", { name: /account/i })).not.toBeInTheDocument();
      const trigger = screen.getByRole("button", { name: /account/i });
      expect(trigger).toHaveTextContent("Checking");

      openSearchableControl();
      const input = screen.getByRole("textbox", { name: /account/i });
      // The input lives in the field position, not inside the dropdown, and
      // is focused. The query starts empty (the selection is the placeholder).
      const list = screen.getByRole("listbox");
      expect(list).not.toContainElement(input);
      expect(input).toHaveValue("");
      expect(input).toHaveFocus();
    });

    it("filters options by case-insensitive substring as the user types", () => {
      renderSearchable();
      const input = openSearchableControl();
      fireEvent.change(input, { target: { value: "cre" } });
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Credit Card"]);

      fireEvent.change(input, { target: { value: "CASH" } });
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Cash"]);
    });

    it("shows a 'No matches' placeholder when nothing matches", () => {
      renderSearchable();
      const input = openSearchableControl();
      fireEvent.change(input, { target: { value: "zzz" } });
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(screen.getByText(/no matches/i)).toBeInTheDocument();
    });

    it("restores the full list when the query is cleared", () => {
      renderSearchable();
      const input = openSearchableControl();
      fireEvent.change(input, { target: { value: "cre" } });
      expect(screen.getAllByRole("option")).toHaveLength(1);

      fireEvent.change(input, { target: { value: "" } });
      expect(screen.getAllByRole("option")).toHaveLength(4);
    });

    it("closes to the trigger and resets the query when reopened", () => {
      renderSearchable();
      const input = openSearchableControl();
      fireEvent.change(input, { target: { value: "cre" } });
      expect(screen.getAllByRole("option")).toHaveLength(1);

      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      // The input disappears; the selection is shown on the trigger again.
      expect(screen.queryByRole("textbox", { name: /account/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /account/i })).toHaveTextContent("Checking");

      // Reopening restores a clean (empty) query.
      openSearchableControl();
      expect(screen.getByRole("textbox", { name: /account/i })).toHaveValue("");
      expect(screen.getAllByRole("option")).toHaveLength(4);
    });

    it("commits against the filtered list, not the snapshot", () => {
      const onChange = vi.fn();
      render(
        <Select
          value="1"
          onChange={onChange}
          searchable
          ariaLabel="Account"
          options={accounts}
        />
      );
      const input = openSearchableControl();
      fireEvent.change(input, { target: { value: "sav" } });
      fireEvent.click(screen.getByRole("option", { name: "Savings" }));
      expect(onChange).toHaveBeenCalledWith("2");
    });

    it("hides the input and shows the picked value on the trigger after committing", () => {
      const onChange = vi.fn();
      function Harness() {
        const [v, setV] = useState("1");
        return (
          <Select
            value={v}
            onChange={(n) => {
              setV(n);
              onChange(n);
            }}
            searchable
            ariaLabel="Account"
            options={accounts}
          />
        );
      }
      render(<Harness />);
      const input = openSearchableControl();
      fireEvent.change(input, { target: { value: "sav" } });
      fireEvent.click(screen.getByRole("option", { name: "Savings" }));
      expect(onChange).toHaveBeenCalledWith("2");
      // After committing, the input is hidden and the new value is shown on
      // the closed trigger.
      expect(screen.queryByRole("textbox", { name: /account/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /account/i })).toHaveTextContent("Savings");
    });
  });

  describe("disabled options", () => {
    it("cannot be selected by click", () => {
      const onChange = vi.fn();
      renderSelect({
        value: "b",
        onChange,
        children: (
          <>
            <option value="" disabled>Select account…</option>
            <option value="a">Chequing</option>
            <option value="b">Savings</option>
          </>
        ),
      });
      fireEvent.click(screen.getByRole("button", { name: "Savings" }));
      const placeholder = screen.getByRole("option", { name: /select account/i });
      expect(placeholder).toBeDisabled();
      fireEvent.click(placeholder);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("is not marked as selected even when its value matches the current value", () => {
      renderSelect({
        value: "",
        onChange: () => {},
        children: (
          <>
            <option value="" disabled>Select account…</option>
            <option value="a">Chequing</option>
          </>
        ),
      });
      fireEvent.click(screen.getByRole("button", { name: /select account/i }));
      const placeholder = screen.getByRole("option", { name: /select account/i });
      expect(placeholder).toHaveAttribute("aria-selected", "false");
      expect(within(placeholder).queryByText("✓")).not.toBeInTheDocument();
    });

    it("is skipped by arrow-key navigation and cannot be committed with Enter", () => {
      const onChange = vi.fn();
      renderSelect({
        value: "",
        onChange,
        children: (
          <>
            <option value="" disabled>Select account…</option>
            <option value="a">Chequing</option>
            <option value="b">Savings</option>
          </>
        ),
      });
      fireEvent.click(screen.getByRole("button", { name: /select account/i }));
      const list = screen.getByRole("listbox");
      // ArrowDown from the placeholder (index 0, disabled) skips to the first
      // enabled option; Enter must commit that option, not the placeholder.
      fireEvent.keyDown(list, { key: "ArrowDown" });
      fireEvent.keyDown(list, { key: "Enter" });
      expect(onChange).toHaveBeenCalledWith("a");
    });
  });

  describe("optgroup headings", () => {
    const children = (
      <>
        <option value="">Pick…</option>
        <optgroup label="Everyday">
          <option value="a">Groceries</option>
          <option value="b">Rent</option>
        </optgroup>
        <optgroup label="Fun">
          <option value="c">Movies</option>
        </optgroup>
      </>
    );

    it("renders each optgroup label as a heading above its options", () => {
      renderSelect({ value: "", onChange: () => {}, children });
      fireEvent.click(screen.getByRole("button", { name: "Pick…" }));
      const list = screen.getByRole("listbox");
      expect(within(list).getByText("Everyday")).toBeInTheDocument();
      expect(within(list).getByText("Fun")).toBeInTheDocument();
      // Headings are presentational and must not count as options.
      expect(within(list).getAllByRole("option")).toHaveLength(4);
    });

    it("keeps the heading of the matched group while filtering search results", () => {
      renderSelect({ value: "", onChange: () => {}, searchable: true, ariaLabel: "Category", children });
      fireEvent.click(screen.getByRole("button", { name: /category/i }));
      const input = screen.getByRole("textbox", { name: /category/i });
      act(() => {
      input.focus();
    });
      fireEvent.change(input, { target: { value: "mov" } });
      const list = screen.getByRole("listbox");
      expect(within(list).getByRole("option", { name: "Movies" })).toBeInTheDocument();
      expect(within(list).getByText("Fun")).toBeInTheDocument();
      expect(within(list).queryByText("Everyday")).not.toBeInTheDocument();
    });
  });
});
