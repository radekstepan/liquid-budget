"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { GroupRow } from "@ynab/logic";
import { isHiddenGroup, isInternalGroup } from "./budgetViewHelpers.js";

export type BudgetGroupReorderArgs = {
  groups: GroupRow[];
  onReorderGroup?: (id: number, sort: number) => void;
};

export type GroupDragProps = {
  isDragOver: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
};

export type BudgetGroupReorder = {
  groupDragProps: (groupId: number) => GroupDragProps;
};

/** Master-category drag-and-drop reorder state (ui-split slice 9). Owns
 * the drag source, the drop-target highlight, and the drop math over the
 * structure groups (credit-card, hidden, and internal groups are fixed
 * and excluded). Spread `groupDragProps(id)` onto each draggable group
 * header. Also exposes the Alt+ArrowUp/Down keyboard path (a11y slice 1)
 * over the same structure order. */
export function useBudgetGroupReorder({
  groups,
  onReorderGroup,
}: BudgetGroupReorderArgs): BudgetGroupReorder {
  const dragGroupId = useRef<number | null>(null);
  const [groupOverId, setGroupOverId] = useState<number | null>(null);

  const getStructureGroups = () =>
    groups.filter(
      (g) => !g.group.isCreditCardPayments && !isInternalGroup(g.group) && !isHiddenGroup(g.group)
    );

  const commitGroupOrder = (reordered: GroupRow[]) => {
    if (!onReorderGroup) return;
    reordered.forEach((g, i) => {
      if (g.group.sort !== i) onReorderGroup(g.group.id, i);
    });
  };

  const handleGroupDrop = (targetId: number) => {
    const srcId = dragGroupId.current;
    if (srcId == null || srcId === targetId || !onReorderGroup) return;
    const structureGroups = getStructureGroups();
    const srcIdx = structureGroups.findIndex((g) => g.group.id === srcId);
    const tgtIdx = structureGroups.findIndex((g) => g.group.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;

    const reordered = [...structureGroups];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved!);
    commitGroupOrder(reordered);
    dragGroupId.current = null;
    setGroupOverId(null);
  };

  // Keyboard reorder path (a11y slice 1): Alt+ArrowUp/Down moves one step
  // in structure order. Plain arrows are left to screen-reader table nav.
  const moveGroupNeighbor = (groupId: number, dir: -1 | 1) => {
    if (!onReorderGroup) return;
    const structureGroups = getStructureGroups();
    const srcIdx = structureGroups.findIndex((g) => g.group.id === groupId);
    if (srcIdx === -1) return;
    if (dir === -1 && srcIdx === 0) return;
    if (dir === 1 && srcIdx === structureGroups.length - 1) return;
    const reordered = [...structureGroups];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(srcIdx + dir, 0, moved!);
    commitGroupOrder(reordered);
  };

  const handleGroupKeyDown = (groupId: number, e: KeyboardEvent) => {
    if (!e.altKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    moveGroupNeighbor(groupId, e.key === "ArrowUp" ? -1 : 1);
  };

  const groupDragProps = (groupId: number): GroupDragProps => ({
    isDragOver: groupOverId === groupId,
    onDragStart: () => {
      dragGroupId.current = groupId;
    },
    onDragOver: () => setGroupOverId(groupId),
    onDragLeave: () => setGroupOverId(null),
    onDrop: () => handleGroupDrop(groupId),
    onKeyDown: (e) => handleGroupKeyDown(groupId, e),
  });

  return { groupDragProps };
}
