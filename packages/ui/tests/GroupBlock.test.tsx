import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { type GroupRow, type CatRow } from "@ynab/logic";
import { GroupBlock, type GroupBlockProps } from "../src/GroupBlock.js";

function catRow(overrides: Partial<CatRow> = {}): CatRow {
  return {
    category: {
      id: 10,
      groupId: 1,
      name: "Groceries",
      sort: 0,
      carryover: "0",
      goalTarget: null,
      linkedAccountId: null,
    },
    carryoverIn: 0,
    assigned: 10000,
    outflow: -5000,
    ccBuffer: 0,
    available: 5000,
    fundedPct: 1,
    ...overrides,
  };
}

function groupRow(overrides: Partial<GroupRow> = {}): GroupRow {
  return {
    group: { id: 1, name: "Everyday", sort: 0, isCreditCardPayments: false },
    rows: [
      catRow(),
      catRow({
        category: {
          id: 11,
          groupId: 1,
          name: "Rent",
          sort: 1,
          carryover: "0",
          goalTarget: null,
          linkedAccountId: null,
        },
        assigned: 150000,
        outflow: -152000,
        available: -2000,
      }),
    ],
    assigned: 160000,
    outflow: -7000,
    available: 3000,
    ...overrides,
  };
}

const noop = () => {};

function baseProps(overrides: Partial<GroupBlockProps> = {}): GroupBlockProps {
  const group = overrides.group ?? groupRow();
  return {
    group,
    rowOffset: 0,
    collapsed: false,
    onToggle: noop,
    onAssign: noop,
    currentMonth: "2026-06",
    visibleMonths: ["2026-06"],
    groupsByMonth: [new Map([[group.group.id, group]])],
    showMulti: false,
    onAddCategory: noop,
    onEditCategory: noop,
    onDeleteCategory: noop,
    onEditGroup: noop,
    onDeleteGroup: noop,
    ...overrides,
  };
}

function renderBlock(props: Partial<GroupBlockProps> = {}) {
  const el: ReactElement = (
    <table>
      <tbody>
        <GroupBlock {...baseProps(props)} />
      </tbody>
    </table>
  );
  return render(el);
}

function catRows() {
  return screen
    .getAllByRole("row")
    .filter((r) => r.getAttribute("data-cat-row") !== null);
}

describe("GroupBlock (ui-split slice 7)", () => {
  it("renders the group header triple and category rows in single-month mode", () => {
    renderBlock();
    expect(screen.getByText("Everyday")).toBeDefined();
    expect(screen.getByText("$1,600.00")).toBeDefined();
    expect(screen.getByText("-$70.00")).toBeDefined();
    expect(screen.getByText("$30.00")).toBeDefined();
    expect(screen.getByText("Groceries")).toBeDefined();
    expect(screen.getByText("Rent")).toBeDefined();
    // Assigned renders through the inline editor button.
    expect(screen.getByRole("button", { name: "$100.00" })).toBeDefined();
  });

  it("hides category rows when collapsed", () => {
    renderBlock({ collapsed: true });
    expect(screen.getByText("Everyday")).toBeDefined();
    expect(screen.queryByText("Groceries")).toBeNull();
    expect(screen.queryByText("Rent")).toBeNull();
  });

  it("fires toggle, edit-group, add-category, and edit-category callbacks", () => {
    const onToggle = vi.fn();
    const onEditGroup = vi.fn();
    const onAddCategory = vi.fn();
    const onEditCategory = vi.fn();
    renderBlock({ onToggle, onEditGroup, onAddCategory, onEditCategory });
    fireEvent.click(screen.getByRole("button", { name: "Toggle Everyday group" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Everyday" }));
    expect(onEditGroup).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Add category" }));
    expect(onAddCategory).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit Groceries" }));
    expect(onEditCategory).toHaveBeenCalledWith(10);
  });

  it("reorders categories within the group via local drag state", () => {
    const onReorderCategory = vi.fn();
    renderBlock({ onReorderCategory });
    const rows = catRows();
    const groceries = rows.find((r) => within(r).queryByText("Groceries"))!;
    const rent = rows.find((r) => within(r).queryByText("Rent"))!;
    const dt = { effectAllowed: "", dropEffect: "" };

    fireEvent.dragStart(groceries, { dataTransfer: dt });
    fireEvent.dragOver(rent, { dataTransfer: dt });
    expect(rent.classList.contains("is-drop-target")).toBe(true);
    fireEvent.drop(rent, { dataTransfer: dt });

    expect(onReorderCategory).toHaveBeenCalledWith(11, 0);
    expect(onReorderCategory).toHaveBeenCalledWith(10, 1);
  });

  it("ignores a category drop onto itself", () => {
    const onReorderCategory = vi.fn();
    renderBlock({ onReorderCategory });
    const groceries = catRows().find((r) => within(r).queryByText("Groceries"))!;
    const dt = { effectAllowed: "", dropEffect: "" };

    fireEvent.dragStart(groceries, { dataTransfer: dt });
    fireEvent.drop(groceries, { dataTransfer: dt });
    expect(onReorderCategory).not.toHaveBeenCalled();
  });

  it("renders one triple per visible month in multi-month mode", () => {
    const may = groupRow({ assigned: 100000, outflow: -1000, available: 4000 });
    const jun = groupRow({ assigned: 200000, outflow: -2000, available: 8000 });
    renderBlock({
      group: jun,
      showMulti: true,
      visibleMonths: ["2026-05", "2026-06"],
      groupsByMonth: [new Map([[1, may]]), new Map([[1, jun]])],
    });
    expect(screen.getByText("$1,000.00")).toBeDefined();
    expect(screen.getByText("$2,000.00")).toBeDefined();
  });

  it("marks special groups non-draggable", () => {
    const cc = groupRow({
      group: { id: 3, name: "Credit Cards", sort: 2, isCreditCardPayments: true },
    });
    renderBlock({ group: cc, onDrop: noop });
    const header = screen
      .getAllByRole("row")
      .find((r) => r.classList.contains("y-master"))!;
    expect(header.getAttribute("draggable")).toBe("false");
  });

  it("selects rows and marks the selected one", () => {
    const onSelectCategory = vi.fn();
    renderBlock({ selectedCategoryId: 10, onSelectCategory });
    const rows = catRows();
    const groceries = rows.find((r) => within(r).queryByText("Groceries"))!;
    const rent = rows.find((r) => within(r).queryByText("Rent"))!;
    expect(groceries.classList.contains("is-sel")).toBe(true);
    expect(rent.classList.contains("is-sel")).toBe(false);
    fireEvent.click(rent);
    expect(onSelectCategory).toHaveBeenCalledWith(11);
    fireEvent.click(groceries);
    expect(onSelectCategory).toHaveBeenCalledWith(null);
  });

  it("routes the inline assign editor with category, value, and month", () => {
    const onAssign = vi.fn();
    renderBlock({ onAssign });
    fireEvent.click(screen.getByRole("button", { name: "$100.00" }));
    const input = screen.getByLabelText("Edit assigned amount");
    fireEvent.change(input, { target: { value: "123.45" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAssign).toHaveBeenCalledWith(10, 12345, "2026-06");
  });

  it("offers unassign for overspent rows with an assignment", () => {
    const onAssign = vi.fn();
    renderBlock({ onAssign });
    fireEvent.click(screen.getByRole("button", { name: "Unassign $1,500.00 from Rent" }));
    expect(onAssign).toHaveBeenCalledWith(11, 0, "2026-06");
  });

  it("labels zero-assigned overspent rows without an unassign action", () => {
    renderBlock({
      group: groupRow({
        rows: [
          catRow({
            category: {
              id: 12,
              groupId: 1,
              name: "Fees",
              sort: 0,
              carryover: "0",
              goalTarget: null,
              linkedAccountId: null,
            },
            assigned: 0,
            outflow: -2500,
            available: -2500,
          }),
        ],
      }),
    });
    expect(screen.getByText("Fees")).toBeDefined();
    expect(screen.getByText("overspent")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Unassign/ })).toBeNull();
  });

  it("offsets zebra striping by rowOffset", () => {
    renderBlock({ rowOffset: 1 });
    const rows = catRows();
    // (1 + 0) is odd, so the first row takes the alt stripe.
    expect(rows[0]!.classList.contains("alt")).toBe(true);
    expect(rows[1]!.classList.contains("alt")).toBe(false);
  });
});

describe("GroupBlock keyboard reorder (a11y slice 1)", () => {
  it("moves a category down with Alt+ArrowDown and emits changed sorts", () => {
    const onReorderCategory = vi.fn();
    renderBlock({ onReorderCategory });
    const groceries = catRows().find((r) => within(r).queryByText("Groceries"))!;
    groceries.focus();
    const canceled = fireEvent.keyDown(groceries, { key: "ArrowDown", altKey: true });
    expect(canceled).toBe(false);
    expect(onReorderCategory).toHaveBeenCalledWith(11, 0);
    expect(onReorderCategory).toHaveBeenCalledWith(10, 1);
    expect(onReorderCategory).toHaveBeenCalledTimes(2);
  });

  it("moves a category up with Alt+ArrowUp", () => {
    const onReorderCategory = vi.fn();
    renderBlock({ onReorderCategory });
    const rent = catRows().find((r) => within(r).queryByText("Rent"))!;
    fireEvent.keyDown(rent, { key: "ArrowUp", altKey: true });
    expect(onReorderCategory).toHaveBeenCalledWith(11, 0);
    expect(onReorderCategory).toHaveBeenCalledWith(10, 1);
    expect(onReorderCategory).toHaveBeenCalledTimes(2);
  });

  it("ignores moves past either end of the group", () => {
    const onReorderCategory = vi.fn();
    renderBlock({ onReorderCategory });
    const groceries = catRows().find((r) => within(r).queryByText("Groceries"))!;
    const rent = catRows().find((r) => within(r).queryByText("Rent"))!;
    fireEvent.keyDown(groceries, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(rent, { key: "ArrowDown", altKey: true });
    expect(onReorderCategory).not.toHaveBeenCalled();
  });

  it("ignores plain arrows and other Alt combinations", () => {
    const onReorderCategory = vi.fn();
    renderBlock({ onReorderCategory });
    const groceries = catRows().find((r) => within(r).queryByText("Groceries"))!;
    expect(fireEvent.keyDown(groceries, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(groceries, { key: "ArrowLeft", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(groceries, { key: "Enter", altKey: true })).toBe(true);
    expect(onReorderCategory).not.toHaveBeenCalled();
  });

  it("announces the shortcut only on reorderable rows", () => {
    const view = renderBlock({ onReorderCategory: vi.fn() });
    const row = catRows()[0]!;
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");

    view.rerender(
      <table>
        <tbody>
          <GroupBlock {...baseProps()} />
        </tbody>
      </table>
    );
    const plain = catRows()[0]!;
    expect(plain.getAttribute("tabindex")).toBeNull();
    expect(plain.getAttribute("aria-keyshortcuts")).toBeNull();
  });

  it("moves (not recreates) keyed rows on reorder so focus survives reloads", () => {
    const view = renderBlock({ onReorderCategory: vi.fn() });
    const groceries = catRows().find((r) => within(r).queryByText("Groceries"))!;
    groceries.focus();
    expect(document.activeElement).toBe(groceries);

    const group = groupRow();
    view.rerender(
      <table>
        <tbody>
          <GroupBlock
            {...baseProps({ group: { ...group, rows: [group.rows[1]!, group.rows[0]!] } })}
          />
        </tbody>
      </table>
    );
    // Same DOM node moved to its new position: browsers keep focus on moved
    // nodes, so the async reload after a keyboard move doesn't strand focus.
    // (jsdom unfocuses on any DOM move, so activeElement itself is untestable.)
    expect(catRows()[1]).toBe(groceries);
  });

  it("wires keyboard props onto draggable group headers", () => {
    const onKeyDown = vi.fn();
    renderBlock({ onKeyDown, onDrop: noop });
    const header = screen
      .getAllByRole("row")
      .find((r) => r.classList.contains("y-master"))!;
    expect(header.getAttribute("tabindex")).toBe("0");
    expect(header.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
    fireEvent.keyDown(header, { key: "ArrowDown", altKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("leaves special group headers out of keyboard reorder", () => {
    const cc = groupRow({
      group: { id: 3, name: "Credit Cards", sort: 2, isCreditCardPayments: true },
    });
    renderBlock({ group: cc, onKeyDown: vi.fn(), onDrop: noop });
    const header = screen
      .getAllByRole("row")
      .find((r) => r.classList.contains("y-master"))!;
    expect(header.getAttribute("tabindex")).toBeNull();
    expect(header.getAttribute("aria-keyshortcuts")).toBeNull();
  });
});

describe("GroupBlock overspent cue (a11y slice 3)", () => {
  it("marks a negative group header balance", () => {
    renderBlock({ group: groupRow({ available: -1000 }) });
    expect(screen.getByText("-$10.00")).toBeDefined();
    const header = screen
      .getAllByRole("row")
      .find((r) => r.classList.contains("y-master"))!;
    expect(within(header).getByLabelText("Overspent")).toBeDefined();
  });

  it("marks negative category balances alongside existing cues", () => {
    renderBlock();
    // Rent is overspent with an assignment: the universal marker coexists
    // with the Unassign action.
    expect(screen.getByLabelText("Overspent")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Unassign $1,500.00 from Rent" })
    ).toBeDefined();
    // Groceries is funded: no marker anywhere on its row.
    const groceries = catRows().find((r) => within(r).queryByText("Groceries"))!;
    expect(within(groceries).queryByLabelText("Overspent")).toBeNull();
  });

  it("marks every negative month cell in multi-month mode", () => {
    const group = groupRow();
    renderBlock({
      group,
      showMulti: true,
      visibleMonths: ["2026-05", "2026-06"],
      groupsByMonth: [new Map([[1, group]]), new Map([[1, group]])],
    });
    // Group header is funded; only Rent's two month cells are negative.
    expect(screen.getAllByLabelText("Overspent")).toHaveLength(2);
  });

  it("stays absent for zero balances", () => {
    renderBlock({
      group: groupRow({
        assigned: 0,
        outflow: 0,
        available: 0,
        rows: [catRow({ assigned: 0, outflow: 0, available: 0 })],
      }),
    });
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Overspent")).toBeNull();
  });
});
