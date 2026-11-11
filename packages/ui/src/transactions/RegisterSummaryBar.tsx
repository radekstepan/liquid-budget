"use client";

import type { MergeOverrides, TransactionMergeResponse } from "@ynab/logic";
import { Button, Tooltip, money } from "@ynab/theme";
import type { RegisterData } from "./useRegisterData.js";
import type { RegisterState } from "./useRegisterState.js";

export function RegisterSummaryBar({
  state,
  data,
  onEdit,
  onBulkEdit,
  onDelete,
  onBulkDelete,
  onMergeTransactions,
}: {
  state: RegisterState;
  data: RegisterData;
  onEdit: (id: number) => void;
  onBulkEdit?: (ids: number[]) => void;
  onDelete: (id: number) => void;
  onBulkDelete?: (ids: number[]) => Promise<void> | void;
  onMergeTransactions?: (ids: number[], overrides?: MergeOverrides) => Promise<TransactionMergeResponse | void> | void;
}) {
  const { selectedIds, setSelectedIds, setMergePreviewIds } = state;
  const { totals } = data;
  return (
      <div className="y-subbar flex items-center gap-2 px-3 py-1 text-[11px] flex-shrink-0 min-h-[28px]">
        {selectedIds.size > 0 ? (
          <>
            <span className="y-caps font-bold" style={{ color: "var(--y-ink)" }}>
              {selectedIds.size} selected
            </span>
            <div className="y-tb-sep mx-1" style={{ height: 14 }} />
            <Button
              variant="default"
              size="sm"
              className="!py-0.5 !px-2 text-[11px]"
              onClick={() => {
                const ids = Array.from(selectedIds);
                if (ids.length === 1 && ids[0] !== undefined) {
                  onEdit(ids[0]);
                } else if (onBulkEdit) {
                  onBulkEdit(ids);
                } else if (ids.length > 0 && ids[0] !== undefined) {
                  onEdit(ids[0]);
                }
              }}
            >
              Edit{selectedIds.size > 1 ? ` (${selectedIds.size})` : ""}
            </Button>
            {selectedIds.size === 2 && onMergeTransactions && (
              <Tooltip tip="Merge the two selected transactions into one (imported data wins)">
                <Button
                  variant="default"
                  size="sm"
                  className="!py-0.5 !px-2 text-[11px]"
                  onClick={() => setMergePreviewIds(Array.from(selectedIds))}
                >
                  Merge (2)
                </Button>
              </Tooltip>
            )}
            <Button
              variant="danger"
              size="sm"
              className="!py-0.5 !px-2 text-[11px]"
              onClick={async () => {
                const ids = Array.from(selectedIds);
                setSelectedIds(new Set());
                if (onBulkDelete) await onBulkDelete(ids);
                else for (const id of ids) onDelete(id);
              }}
            >
              Delete ({selectedIds.size})
            </Button>
            <Button
              variant="default"
              size="sm"
              className="ml-auto !py-0.5 !px-2 text-[11px]"
              onClick={() => setSelectedIds(new Set())}
            >
              Deselect All
            </Button>
          </>
        ) : (
          <>
            <span className="y-caps">{totals.count} transactions</span>
            <span className="y-num font-bold" style={{ color: "var(--y-ink)" }}>
              Inflow {money(totals.inflow)}
            </span>
            <span className="y-num font-bold" style={{ color: "var(--y-ink-soft)" }}>
              Outflow −{money(totals.outflow)}
            </span>
            <span
              className="y-num font-bold ml-auto"
              style={{ color: totals.net >= 0 ? "var(--y-green-dk)" : "var(--y-red)" }}
            >
              Net {money(totals.net)}
            </span>
          </>
        )}
      </div>
  );
}
