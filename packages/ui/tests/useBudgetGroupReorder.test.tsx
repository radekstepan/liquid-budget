import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { renderHook, act } from "@testing-library/react";
import { type GroupRow } from "@ynab/logic";
import {
  useBudgetGroupReorder,
  type BudgetGroupReorderArgs,
} from "../src/useBudgetGroupReorder.js";

function groupRow(
  id: number,
  name: string,
  sort: number,
  extra?: Partial<{ isCreditCardPayments: boolean; isHidden: boolean }>
): GroupRow {
  return {
    group: { id, name, sort, isCreditCardPayments: false, ...extra },
    rows: [],
    assigned: 0,
    outflow: 0,
    available: 0,
  };
}

const groups: GroupRow[] = [
  groupRow(1, "Everyday", 0),
  groupRow(2, "Bills", 1),
  groupRow(3, "Fun", 2),
];

const groupsWithSpecial: GroupRow[] = [
  groupRow(1, "Everyday", 0),
  groupRow(4, "Credit Cards", 3, { isCreditCardPayments: true }),
  groupRow(2, "Bills", 1),
  groupRow(5, "Hidden Categories", 4, { isHidden: true }),
  groupRow(3, "Fun", 2),
  groupRow(6, "__Internal__", 5),
];

function hookArgs(overrides: Partial<BudgetGroupReorderArgs> = {}): BudgetGroupReorderArgs {
  return { groups, onReorderGroup: () => {}, ...overrides };
}

describe("useBudgetGroupReorder (ui-split slice 9)", () => {
  it("reports no drop target initially", () => {
    const { result } = renderHook(() => useBudgetGroupReorder(hookArgs()));
    expect(result.current.groupDragProps(1).isDragOver).toBe(false);
    expect(result.current.groupDragProps(2).isDragOver).toBe(false);
  });

  it("highlights the hovered group and clears on leave", () => {
    const { result } = renderHook(() => useBudgetGroupReorder(hookArgs()));
    act(() => {
      result.current.groupDragProps(2).onDragOver();
    });
    expect(result.current.groupDragProps(2).isDragOver).toBe(true);
    expect(result.current.groupDragProps(1).isDragOver).toBe(false);
    act(() => {
      result.current.groupDragProps(2).onDragLeave();
    });
    expect(result.current.groupDragProps(2).isDragOver).toBe(false);
  });

  it("reorders on drop and emits the changed sorts", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() => useBudgetGroupReorder(hookArgs({ onReorderGroup })));
    result.current.groupDragProps(1).onDragStart();
    act(() => {
      result.current.groupDragProps(3).onDragOver();
    });
    expect(result.current.groupDragProps(3).isDragOver).toBe(true);
    act(() => {
      result.current.groupDragProps(3).onDrop();
    });

    // [1,2,3] -> [2,3,1]: every position changed.
    expect(onReorderGroup).toHaveBeenCalledWith(2, 0);
    expect(onReorderGroup).toHaveBeenCalledWith(3, 1);
    expect(onReorderGroup).toHaveBeenCalledWith(1, 2);
    expect(onReorderGroup).toHaveBeenCalledTimes(3);
    // Successful drops clear the highlight.
    expect(result.current.groupDragProps(3).isDragOver).toBe(false);
  });

  it("emits only the sorts that changed", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() => useBudgetGroupReorder(hookArgs({ onReorderGroup })));
    result.current.groupDragProps(2).onDragStart();
    act(() => {
      result.current.groupDragProps(3).onDrop();
    });

    // [1,2,3] -> [1,3,2]: group 1 keeps sort 0.
    expect(onReorderGroup).toHaveBeenCalledWith(3, 1);
    expect(onReorderGroup).toHaveBeenCalledWith(2, 2);
    expect(onReorderGroup).toHaveBeenCalledTimes(2);
  });

  it("ignores drops onto the source group", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() => useBudgetGroupReorder(hookArgs({ onReorderGroup })));
    result.current.groupDragProps(1).onDragStart();
    act(() => {
      result.current.groupDragProps(1).onDrop();
    });
    expect(onReorderGroup).not.toHaveBeenCalled();
  });

  it("ignores drops without a drag source", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() => useBudgetGroupReorder(hookArgs({ onReorderGroup })));
    act(() => {
      result.current.groupDragProps(2).onDrop();
    });
    expect(onReorderGroup).not.toHaveBeenCalled();
  });

  it("ignores unknown source and target ids", () => {
    const onReorderGroup = vi.fn();
    const { result: unknownTarget } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ onReorderGroup }))
    );
    unknownTarget.current.groupDragProps(1).onDragStart();
    act(() => {
      unknownTarget.current.groupDragProps(999).onDrop();
    });
    expect(onReorderGroup).not.toHaveBeenCalled();

    const { result: unknownSource } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ onReorderGroup }))
    );
    unknownSource.current.groupDragProps(999).onDragStart();
    act(() => {
      unknownSource.current.groupDragProps(2).onDrop();
    });
    expect(onReorderGroup).not.toHaveBeenCalled();
  });

  it("excludes credit-card, hidden, and internal groups from reorder math", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ groups: groupsWithSpecial, onReorderGroup }))
    );
    result.current.groupDragProps(1).onDragStart();
    act(() => {
      result.current.groupDragProps(3).onDrop();
    });

    // Structure order [1,2,3] -> [2,3,1]; specials keep their sorts.
    expect(onReorderGroup).toHaveBeenCalledWith(2, 0);
    expect(onReorderGroup).toHaveBeenCalledWith(3, 1);
    expect(onReorderGroup).toHaveBeenCalledWith(1, 2);
    expect(onReorderGroup).toHaveBeenCalledTimes(3);
  });

  it("ignores drops onto special groups", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ groups: groupsWithSpecial, onReorderGroup }))
    );
    result.current.groupDragProps(1).onDragStart();
    act(() => {
      result.current.groupDragProps(4).onDrop();
    });
    expect(onReorderGroup).not.toHaveBeenCalled();
  });

  it("stays a safe no-op without onReorderGroup", () => {
    const { result } = renderHook(() => useBudgetGroupReorder({ groups }));
    result.current.groupDragProps(1).onDragStart();
    act(() => {
      result.current.groupDragProps(2).onDragOver();
    });
    expect(result.current.groupDragProps(2).isDragOver).toBe(true);
    act(() => {
      result.current.groupDragProps(2).onDrop();
    });
    act(() => {
      result.current.groupDragProps(2).onDragLeave();
    });
    expect(result.current.groupDragProps(2).isDragOver).toBe(false);
  });
});

describe("useBudgetGroupReorder keyboard (a11y slice 1)", () => {
  function fakeKey(key: string, altKey: boolean) {
    const preventDefault = vi.fn();
    const event = { altKey, key, preventDefault } as unknown as KeyboardEvent;
    return { event, preventDefault };
  }

  it("moves a group down one step with Alt+ArrowDown", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ onReorderGroup }))
    );
    const { event, preventDefault } = fakeKey("ArrowDown", true);
    result.current.groupDragProps(1).onKeyDown(event);

    // [1,2,3] -> [2,1,3]: group 3 keeps sort 2.
    expect(onReorderGroup).toHaveBeenCalledWith(2, 0);
    expect(onReorderGroup).toHaveBeenCalledWith(1, 1);
    expect(onReorderGroup).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("moves a group up one step with Alt+ArrowUp", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ onReorderGroup }))
    );
    const { event } = fakeKey("ArrowUp", true);
    result.current.groupDragProps(3).onKeyDown(event);

    // [1,2,3] -> [1,3,2]: group 1 keeps sort 0.
    expect(onReorderGroup).toHaveBeenCalledWith(3, 1);
    expect(onReorderGroup).toHaveBeenCalledWith(2, 2);
    expect(onReorderGroup).toHaveBeenCalledTimes(2);
  });

  it("ignores moves past either end of the structure order", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ onReorderGroup }))
    );
    result.current.groupDragProps(1).onKeyDown(fakeKey("ArrowUp", true).event);
    result.current.groupDragProps(3).onKeyDown(fakeKey("ArrowDown", true).event);
    expect(onReorderGroup).not.toHaveBeenCalled();
  });

  it("ignores plain arrows, other keys, and unknown ids", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ onReorderGroup }))
    );
    const plain = fakeKey("ArrowDown", false);
    result.current.groupDragProps(1).onKeyDown(plain.event);
    expect(plain.preventDefault).not.toHaveBeenCalled();

    result.current.groupDragProps(1).onKeyDown(fakeKey("ArrowLeft", true).event);
    result.current.groupDragProps(1).onKeyDown(fakeKey("Enter", true).event);
    result.current.groupDragProps(999).onKeyDown(fakeKey("ArrowDown", true).event);
    expect(onReorderGroup).not.toHaveBeenCalled();
  });

  it("moves within structure order, skipping special groups", () => {
    const onReorderGroup = vi.fn();
    const { result } = renderHook(() =>
      useBudgetGroupReorder(hookArgs({ groups: groupsWithSpecial, onReorderGroup }))
    );
    result.current.groupDragProps(1).onKeyDown(fakeKey("ArrowDown", true).event);

    // Structure [1,2,3] -> [2,1,3]; credit/hidden/internal untouched.
    expect(onReorderGroup).toHaveBeenCalledWith(2, 0);
    expect(onReorderGroup).toHaveBeenCalledWith(1, 1);
    expect(onReorderGroup).toHaveBeenCalledTimes(2);

    result.current.groupDragProps(4).onKeyDown(fakeKey("ArrowDown", true).event);
    expect(onReorderGroup).toHaveBeenCalledTimes(2);
  });

  it("stays a safe keyboard no-op without onReorderGroup", () => {
    const { result } = renderHook(() => useBudgetGroupReorder({ groups }));
    const { event, preventDefault } = fakeKey("ArrowDown", true);
    result.current.groupDragProps(1).onKeyDown(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});
