import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { money } from "@ynab/theme";
import { Modal, Field } from "../src/ui.js";
import { AmountPreview } from "../src/AmountInput.js";

describe("money (BUG-09)", () => {
  it("formats positive, negative, and zero cents correctly", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0, false)).toBe("");
    expect(money(123450)).toBe("$1,234.50");
    expect(money(-123450)).toBe("-$1,234.50");
  });

  it("handles small negative cents without returning -$0.00", () => {
    expect(money(-0.2)).toBe("$0.00");
    expect(money(-0.2, false)).toBe("");
    expect(money(-0.01)).toBe("$0.00");
    expect(money(-0.49)).toBe("$0.00");
    expect(money(-0.5)).toBe("$0.00");
    expect(money(-0.51)).toBe("-$0.01");
    expect(money(-0)).toBe("$0.00");
    expect(money(0.2)).toBe("$0.00");
    expect(money(0.49)).toBe("$0.00");
    expect(money(0.5)).toBe("$0.01");
  });
});

describe("AmountPreview", () => {
  it("shows the evaluated result for an expression", () => {
    render(<AmountPreview value="100 + 50" />);
    expect(screen.getByText("= $150.00")).toBeInTheDocument();
  });

  it("shows a signed result for a negative expression", () => {
    render(<AmountPreview value="-50 + 10" />);
    expect(screen.getByText("= -$40.00")).toBeInTheDocument();
  });

  it("renders nothing for a plain number", () => {
    const { container } = render(<AmountPreview value="100" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an empty value", () => {
    const { container } = render(<AmountPreview value="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an invalid expression", () => {
    const { container } = render(<AmountPreview value="10 +" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Modal", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Test" onClose={onClose}>
        <div>body</div>
      </Modal>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on other keys", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Test" onClose={onClose}>
        <div>body</div>
      </Modal>
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders the title and children", () => {
    render(
      <Modal title="Test" onClose={() => {}}>
        <div>body</div>
      </Modal>
    );
    expect(screen.getByText("Test")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("stably calls the latest onClose callback after re-rendering with new props (UNI-49 / BUG-42)", () => {
    const onClose1 = vi.fn();
    const onClose2 = vi.fn();
    const { rerender } = render(
      <Modal title="Test" onClose={onClose1}>
        <div>body</div>
      </Modal>
    );

    rerender(
      <Modal title="Test Updated" onClose={onClose2}>
        <div>body updated</div>
      </Modal>
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose1).not.toHaveBeenCalled();
    expect(onClose2).toHaveBeenCalledTimes(1);
  });
});

describe("Field", () => {
  it("renders the label around its children", () => {
    render(
      <Field label="Amount">
        <input placeholder="0.00" />
      </Field>
    );
    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("0.00")).toBeInTheDocument();
  });
});
