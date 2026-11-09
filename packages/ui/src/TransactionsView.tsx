"use client";

import { memo } from "react";
import type {
  BudgetData,
  BulkUpdateTransactionPatch,
  MergeOverrides,
  Query,
  TransactionFlagColor,
} from "@ynab/logic";
import type { SearchListOption } from "@ynab/theme";
import { MergePreviewModal } from "./MergePreviewModal.js";
import { DuplicateGroupModal } from "./transactions/DuplicateGroupModal.js";
import { RegisterFooter } from "./transactions/RegisterFooter.js";
import { RegisterSummaryBar } from "./transactions/RegisterSummaryBar.js";
import { RegisterTable } from "./transactions/RegisterTable.js";
import { RegisterToolbar } from "./transactions/RegisterToolbar.js";
import { ScheduledDrawer } from "./transactions/ScheduledDrawer.js";
import {
  SCHEDULED_HEIGHT_STORAGE_KEY,
  isScheduledHeights,
} from "./transactions/scheduledHeights.js";
import { useRegisterData } from "./transactions/useRegisterData.js";
import { useRegisterKeyboard } from "./transactions/useRegisterKeyboard.js";
import { useRegisterState } from "./transactions/useRegisterState.js";

export { SCHEDULED_HEIGHT_STORAGE_KEY, isScheduledHeights };

export const TransactionsView = memo(function TransactionsView({
  data,
  accountFilter,
  focusTransaction,
  externalFilter,
  selectedId: controlledSelectedId,
  onSelectedIdChange,
  selectedIds: controlledSelectedIds,
  onSelectedIdsChange,
  selectedRecurringIds: controlledSelectedRecurringIds,
  onSelectedRecurringIdsChange,
  onGoToTransfer,
  onAdd,
  onAddTransfer,
  onEdit,
  onBulkEdit,
  onDelete,
  onReconcile,
  onCycleStatus,
  onFlag,
  onBulkDelete,
  onBulkUpdate,
  onMergeTransactions,
  onDismissDuplicateGroup,
  payees,
  onAddRecurring,
  onAddRecurringTransfer,
  onEditRecurring,
  onDeleteRecurring,
  onPostRecurring,
  onFlagRecurring,
  onBulkPostRecurring,
  onBulkUpdateRecurring,
  onBulkDeleteRecurring,
  onEditFilter,
  onClearFilter,
}: {
  data: BudgetData;
  accountFilter: number | null;
  focusTransaction?: { id: number; nonce: number } | null;
  externalFilter?: {
    payee?: string;
    categoryId?: number | null;
    text?: string;
    query?: Query;
    nonce: number;
  } | null;
  /** Controlled register selection (lifted to the owner so it survives view
      switches). When omitted the register keeps selection in local state. */
  selectedId?: number | null;
  onSelectedIdChange?: (update: number | null | ((prev: number | null) => number | null)) => void;
  selectedIds?: Set<number>;
  onSelectedIdsChange?: (update: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
  selectedRecurringIds?: Set<number>;
  onSelectedRecurringIdsChange?: (update: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
  onGoToTransfer?: (accountId: number, transactionId: number) => void;
  onAdd: () => void;
  onAddTransfer?: () => void;
  onEdit: (id: number) => void;
  onBulkEdit?: (ids: number[]) => void;
  onDelete: (id: number) => void;
  onReconcile: (accountId: number) => void;
  onCycleStatus: (id: number) => void;
  onFlag: (id: number, color: TransactionFlagColor | null) => void;
  onBulkDelete?: (ids: number[]) => Promise<void> | void;
  onBulkUpdate?: (ids: number[], patch: BulkUpdateTransactionPatch) => Promise<void> | void;
  onMergeTransactions?: (ids: number[], overrides?: MergeOverrides) => Promise<void> | void;
  /** Confirm a duplicate group as legitimate so it is never flagged again. */
  onDismissDuplicateGroup?: (fingerprint: string) => Promise<void> | void;
  /** Existing payee names for the searchable payee field in the merge preview. */
  payees?: SearchListOption[];
  onAddRecurring?: () => void;
  onAddRecurringTransfer?: () => void;
  onEditRecurring?: (id: number) => void;
  onDeleteRecurring?: (id: number) => void;
  onPostRecurring?: (id: number, date?: string) => void;
  onFlagRecurring?: (id: number, color: TransactionFlagColor | null) => void;
  onBulkPostRecurring?: (ids: number[], date?: string) => Promise<void> | void;
  onBulkUpdateRecurring?: (ids: number[], patch: { flagColor?: TransactionFlagColor | null; active?: boolean }) => Promise<void> | void;
  onBulkDeleteRecurring?: (ids: number[]) => Promise<void> | void;
  /** Open the search modal pre-filled with `query` so the filter can be edited. */
  onEditFilter?: (query: Query) => void;
  /** Notify the owner that the applied filter was cleared so stale external
      filters can't re-apply on remount (e.g. after navigating away and back). */
  onClearFilter?: () => void;
}) {
  const state = useRegisterState({
    data,
    accountFilter,
    controlledSelectedId,
    onSelectedIdChange,
    controlledSelectedIds,
    onSelectedIdsChange,
    controlledSelectedRecurringIds,
    onSelectedRecurringIdsChange,
    onMergeTransactions,
    onClearFilter,
  });
  const registerData = useRegisterData({ data, accountFilter, state });
  const handleKeyDown = useRegisterKeyboard({
    data,
    accountFilter,
    focusTransaction,
    externalFilter,
    onEdit,
    onCycleStatus,
    onDelete,
    onClearFilter,
    state,
    filtered: registerData.filtered,
    isSelectableTxn: registerData.isSelectableTxn,
  });
  const {
    mergePreviewIds,
    setMergePreviewIds,
    confirmMergePreview,
    duplicateInspectorId,
    setDuplicateInspectorId,
  } = state;
  const {
    activeDuplicateGroup,
    accountById,
    categoryById,
    showDuplicateGroupInRegister,
  } = registerData;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white" onKeyDown={handleKeyDown} tabIndex={0}>
      <RegisterToolbar state={state} data={registerData} onEditFilter={onEditFilter} />

      <RegisterSummaryBar
        state={state}
        data={registerData}
        onEdit={onEdit}
        onBulkEdit={onBulkEdit}
        onDelete={onDelete}
        onBulkDelete={onBulkDelete}
        onMergeTransactions={onMergeTransactions}
      />

      <RegisterTable
        state={state}
        data={registerData}
        budgetData={data}
        accountFilter={accountFilter}
        externalFilter={externalFilter}
        onGoToTransfer={onGoToTransfer}
        onAdd={onAdd}
        onEdit={onEdit}
        onCycleStatus={onCycleStatus}
        onFlag={onFlag}
        onClearFilter={onClearFilter}
      />

      <RegisterFooter
        state={state}
        data={registerData}
        onAdd={onAdd}
        onAddTransfer={onAddTransfer}
        onReconcile={onReconcile}
      />

      {state.showScheduledDrawer && (
        <ScheduledDrawer
          state={state}
          data={registerData}
          accountFilter={accountFilter}
          onAddRecurring={onAddRecurring}
          onAddRecurringTransfer={onAddRecurringTransfer}
          onEditRecurring={onEditRecurring}
          onFlagRecurring={onFlagRecurring}
          onBulkDeleteRecurring={onBulkDeleteRecurring}
        />
      )}

      {mergePreviewIds != null &&
        mergePreviewIds.length === 2 &&
        mergePreviewIds.every((id) => data.transactions.some((t) => t.id === id)) &&
        onMergeTransactions && (
          <MergePreviewModal
            accounts={data.accounts}
            categories={data.categories}
            groups={data.groups}
            payees={payees}
            transactions={data.transactions}
            ids={mergePreviewIds}
            onClose={() => setMergePreviewIds(null)}
            onConfirm={confirmMergePreview}
          />
        )}

      {duplicateInspectorId != null && (
        <DuplicateGroupModal
          transactionId={duplicateInspectorId}
          group={activeDuplicateGroup}
          transactions={data.transactions}
          accountById={accountById}
          categoryById={categoryById}
          showAccountColumn={accountFilter == null}
          onEdit={onEdit}
          onDelete={onDelete}
          onClearMarker={(id) => onFlag(id, null)}
          onDismiss={onDismissDuplicateGroup}
          onShowInRegister={showDuplicateGroupInRegister}
          onClose={() => setDuplicateInspectorId(null)}
        />
      )}
    </div>
  );
});
