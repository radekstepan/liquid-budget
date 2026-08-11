import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
});
