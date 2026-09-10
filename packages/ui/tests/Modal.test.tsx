import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "../src/ui.js";

function renderModal(onClose = vi.fn()) {
  render(
    <Modal title="Rename payee" onClose={onClose}>
      <input aria-label="Payee name" defaultValue="Safeway" />
    </Modal>
  );
  const scrim = document.querySelector(".y-scrim") as HTMLElement;
  const input = screen.getByLabelText("Payee name");
  return { onClose, scrim, input };
}

describe("Modal scrim dismissal", () => {
  it("closes when the scrim itself is pressed and clicked", () => {
    const { onClose, scrim } = renderModal();
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when a text-select drag starting inside ends over the scrim", () => {
    const { onClose, scrim, input } = renderModal();
    // mousedown in the input, mouse released over the scrim: the resulting
    // click targets the scrim but the press did not start there.
    fireEvent.mouseDown(input);
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close when clicking inside the dialog", () => {
    const { onClose, input } = renderModal();
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    expect(onClose).not.toHaveBeenCalled();
  });
});
