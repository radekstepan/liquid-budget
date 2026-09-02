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
  fireEvent.click(findOptionByValueAcrossListboxes(value));
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
  fireEvent.click(findOptionByValueAcrossListboxes(value));
}

/* -------------------------------------------------- searchable <Select>
 * A searchable select renders its search input in the field position (it is
 * the trigger). Focus it to open the dropdown, then pick an option.
 */

/**
 * Open a searchable <Select>. The search input only exists while the dropdown
 * is open, so click the closed trigger button first, then focus the input.
 */
export function openSearchable(label: string | RegExp): HTMLInputElement {
  const existing = screen.queryByRole("textbox", { name: label });
  if (existing) {
    act(() => {
      existing.focus();
    });
    return existing;
  }
  const trigger = screen.getByRole("button", { name: label });
  fireEvent.click(trigger);
  const input = screen.getByRole("textbox", { name: label });
  act(() => {
    input.focus();
  });
  return input;
}

/**
 * Open a <SearchList> (free-text combobox) by its placeholder text.
 */
export function openSearchlistByPlaceholder(
  placeholderLabel: string | RegExp
): HTMLInputElement {
  const input = (screen.queryByPlaceholderText(placeholderLabel) ??
    screen.queryByRole("textbox", { name: placeholderLabel })) as HTMLInputElement | null;
  if (input) {
    act(() => {
      input.focus();
    });
    return input;
  }
  const trigger = screen.getByText(placeholderLabel);
  fireEvent.click(trigger);
  const input2 = screen.getByPlaceholderText(placeholderLabel) as HTMLInputElement;
  act(() => {
    input2.focus();
  });
  return input2;
}

/**
 * Find the option with `value` across every currently open listbox (other
 * searchlists may keep their dropdown open, e.g. a typed payee field).
 */
function findOptionByValueAcrossListboxes(value: string): HTMLButtonElement {
  for (const list of screen.getAllByRole("listbox")) {
    const options = within(list).getAllByRole("option") as HTMLButtonElement[];
    const target = options.find((o) => o.getAttribute("data-value") === value);
    if (target) return target;
  }
  throw new Error(`No option with value="${value}" in any open searchable dropdown`);
}

/** Open a searchable <Select> by its accessible label and pick an option by value. */
export function pickFromOpenSearchableByValue(
  label: string | RegExp,
  value: string
): void {
  openSearchable(label);
  fireEvent.click(findOptionByValueAcrossListboxes(value));
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
  const triggers = screen
    .getAllByRole("button", { name: placeholderLabel })
    .filter((b) => b.getAttribute("aria-haspopup") === "listbox");
  const trigger = triggers[index];
  if (!trigger) {
    throw new Error(
      `No "${String(placeholderLabel)}" searchable trigger at index ${index} (found ${triggers.length})`
    );
  }
  fireEvent.click(trigger);
  fireEvent.click(findOptionByValueAcrossListboxes(value));
}
