import { screen, fireEvent, within, act } from "@testing-library/react";

/**
 * Test helpers for the custom <Select> dropdown component.
 *
 * The dropdown renders as a <button> trigger + a portaled listbox of
 * <button role="option"> items. Use these helpers to drive that flow
 * the same way a user would.
 */

/** All dropdown triggers in the current document, in DOM order. */
export function listAllDropdownTriggers(): HTMLButtonElement[] {
  return screen
    .getAllByRole("button", { name: /.*/ })
    .filter((b) => b.getAttribute("aria-haspopup") === "listbox") as HTMLButtonElement[];
}

export function openDropdown(label: string | RegExp): HTMLButtonElement {
  const trigger = screen.getByRole("button", { name: label });
  fireEvent.click(trigger);
  return trigger;
}

export function pickFromOpenDropdown(
  label: string | RegExp,
  optionLabel: string | RegExp
): void {
  openDropdown(label);
  const list = screen.getByRole("listbox");
  const option = within(list).getByRole("option", { name: optionLabel });
  fireEvent.click(option);
}

/**
 * Pick an option by its underlying string value (matching the original
 * <option value="..."> attribute). Useful when option labels and
 * values differ or when label text is duplicated across options.
 */
export function pickFromOpenDropdownByValue(
  label: string | RegExp,
  value: string
): void {
  openDropdown(label);
  const list = screen.getByRole("listbox");
  const options = within(list).getAllByRole("option") as HTMLButtonElement[];
  const target = options.find((o) => o.getAttribute("data-value") === value);
  if (!target) {
    throw new Error(
      `No option with value="${value}" in dropdown (label=${String(label)})`
    );
  }
  fireEvent.click(target);
}

/**
 * Find dropdown triggers whose currently-displayed label matches
 * (i.e. they still show the placeholder). Used to disambiguate
 * dropdowns in collections like split-transaction sub-rows where the
 * trigger text changes once a value is picked.
 */
export function listDropdownTriggersShowing(
  label: string | RegExp
): HTMLButtonElement[] {
  return screen
    .getAllByRole("button", { name: label })
    .filter((b) => b.getAttribute("aria-haspopup") === "listbox") as HTMLButtonElement[];
}

/**
 * Pick the n-th dropdown trigger whose displayed label still matches
 * the placeholder, and select an option by value.
 */
export function pickPlaceholderDropdownByIndexByValue(
  placeholderLabel: string | RegExp,
  index: number,
  value: string
): void {
  const triggers = listDropdownTriggersShowing(placeholderLabel);
  const trigger = triggers[index];
  if (!trigger) {
    throw new Error(
      `No "${String(placeholderLabel)}" trigger at index ${index} (found ${triggers.length})`
    );
  }
  fireEvent.click(trigger);
  const list = screen.getByRole("listbox");
  const options = within(list).getAllByRole("option") as HTMLButtonElement[];
  const target = options.find((o) => o.getAttribute("data-value") === value);
  if (!target) {
    throw new Error(`No option with value="${value}" in dropdown`);
  }
  fireEvent.click(target);
}

/* -------------------------------------------------- searchable <Select>
 * A searchable select renders its search input in the field position (it is
 * the trigger). Focus it to open the dropdown, then pick an option.
 */

/** Focus the inline search input of a searchable <Select> (opens the dropdown). */
export function openSearchable(label: string | RegExp): HTMLInputElement {
  const input = screen.getByRole("textbox", { name: label });
  act(() => {
    input.focus();
  });
  return input;
}

/** Open a searchable <Select> by its accessible label and pick an option by value. */
export function pickFromOpenSearchableByValue(
  label: string | RegExp,
  value: string
): void {
  openSearchable(label);
  const list = screen.getByRole("listbox");
  const options = within(list).getAllByRole("option") as HTMLButtonElement[];
  const target = options.find((o) => o.getAttribute("data-value") === value);
  if (!target) {
    throw new Error(
      `No option with value="${value}" in searchable dropdown (label=${String(label)})`
    );
  }
  fireEvent.click(target);
}

/**
 * Pick from the n-th searchable input that still shows the given placeholder
 * (i.e. has no committed selection yet), and select an option by value.
 * Used for split-transaction sub-row selectors.
 */
export function pickPlaceholderSearchableByIndexByValue(
  placeholderLabel: string | RegExp,
  index: number,
  value: string
): void {
  const inputs = screen.getAllByPlaceholderText(placeholderLabel) as HTMLInputElement[];
  const input = inputs[index];
  if (!input) {
    throw new Error(
      `No "${String(placeholderLabel)}" searchable input at index ${index} (found ${inputs.length})`
    );
  }
  act(() => {
    input.focus();
  });
  const list = screen.getByRole("listbox");
  const options = within(list).getAllByRole("option") as HTMLButtonElement[];
  const target = options.find((o) => o.getAttribute("data-value") === value);
  if (!target) {
    throw new Error(`No option with value="${value}" in searchable dropdown`);
  }
  fireEvent.click(target);
}
