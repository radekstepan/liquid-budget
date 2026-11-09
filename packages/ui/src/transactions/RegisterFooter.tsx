"use client";

import { Icon, Button, Tooltip } from "@ynab/theme";
import type { RegisterData } from "./useRegisterData.js";
import type { RegisterState } from "./useRegisterState.js";

export function RegisterFooter({
  state,
  data,
  onAdd,
  onAddTransfer,
  onReconcile,
}: {
  state: RegisterState;
  data: RegisterData;
  onAdd: () => void;
  onAddTransfer?: () => void;
  onReconcile: (accountId: number) => void;
}) {
  const { showScheduledDrawer, toggleScheduledDrawer } = state;
  const { filterAccount, scheduledRows, dueScheduledCount } = data;
  return (
      <div className="y-register-footer">
        <div className="flex items-center gap-2">
          <Tooltip
            tip={filterAccount?.archived ? "Reopen this account to add transactions." : undefined}
            side="bottom"
          >
            <Button onClick={onAdd} variant="primary" size="sm" disabled={filterAccount?.archived}>
              <Icon name="plus" size={11} color="#fff" />
              <span className="ml-1 font-bold">Add a new transaction</span>
            </Button>
          </Tooltip>

          {onAddTransfer && (
            <Tooltip
              tip={filterAccount?.archived ? "Reopen this account to add transactions." : undefined}
              side="bottom"
            >
              <Button onClick={onAddTransfer} variant="default" size="sm" disabled={filterAccount?.archived}>
                <Icon name="swap" size={11} color="var(--y-ink)" />
                <span className="ml-1">Make a transfer</span>
              </Button>
            </Tooltip>
          )}

          <Tooltip tip={showScheduledDrawer ? "Hide Scheduled Transactions drawer" : "Show Scheduled Transactions drawer"} side="bottom">
            <Button
              onClick={toggleScheduledDrawer}
              variant="default"
              size="sm"
              className="flex items-center gap-1.5"
              aria-label={showScheduledDrawer ? "Hide Scheduled Transactions drawer" : "Show Scheduled Transactions drawer"}
            >
              <Icon name="calendar" size={12} />
              <span>Scheduled Transactions</span>
              {dueScheduledCount > 0 ? (
                <Tooltip tip={`${dueScheduledCount} due`}>
                  <span className="y-badge ml-1">
                    {dueScheduledCount}
                  </span>
                </Tooltip>
              ) : scheduledRows.length > 0 ? (
              <span className="text-[10px] opacity-75 font-bold">({scheduledRows.length})</span>
            ) : null}
            <span className="text-[9px] ml-0.5">{showScheduledDrawer ? "▼" : "▲"}</span>
            </Button>
          </Tooltip>
        </div>

        {filterAccount && (
          <Tooltip tip="Reconcile this account against your bank statement" side="bottom">
            <Button
              variant="default"
              size="sm"
              onClick={() => onReconcile(filterAccount.id)}
              aria-label="Reconcile"
              className="font-semibold"
            >
              <Icon name="reconcile" size={11} color="var(--y-ink)" />
            <span className="ml-1">Reconcile</span>
            </Button>
          </Tooltip>
        )}
      </div>
  );
}
