"use client";

import { useState } from "react";
import type { Category, CategoryGroup } from "@ynab/logic";
import { dollarsToCents, evalAmount, num } from "@ynab/logic";
import { TextField, Select, Checkbox, Notice } from "@ynab/theme";
import { Modal, Field, Btn } from "../ui.js";
import { AmountPreview } from "../AmountInput.js";
import { inputClass } from "./shared.js";

export function CategoryModal({
  initial,
  transactionCount = 0,
  otherCategories = [],
  groups,
  onClose,
  onSave,
  onDelete,
}: {
  initial?: Category;
  transactionCount?: number;
  otherCategories?: Category[];
  groups?: CategoryGroup[];
  onClose: () => void;
  onSave: (v: { name: string; groupId?: number; goalTarget: number | null; carryover?: number; overspendCarriesOver?: boolean }) => void;
  onDelete?: (opts?: { moveToCategoryId?: number }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [groupId, setGroupId] = useState<number | undefined>(
    initial?.groupId ?? (groups && groups[0]?.id ? groups[0].id : undefined)
  );
  const [hasGoal, setHasGoal] = useState(!!initial?.goalTarget);
  const initGoal = initial?.goalTarget ? num(initial.goalTarget) / 100 : 0;
  const [goal, setGoal] = useState(initGoal !== 0 ? initGoal.toFixed(2) : "");
  const initCarryover = initial?.carryover ? num(initial.carryover) / 100 : 0;
  const [hasCarryover, setHasCarryover] = useState(initCarryover !== 0);
  const [carryover, setCarryover] = useState(
    initCarryover !== 0 ? initCarryover.toFixed(2) : ""
  );
  const [overspendCarriesOver, setOverspendCarriesOver] = useState(
    Boolean(initial?.overspendCarriesOver)
  );

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moveToCategoryId, setMoveToCategoryId] = useState<number | "">(
    otherCategories[0]?.id ?? ""
  );

  const confirmDelete = async () => {
    if (!onDelete) return;
    if (transactionCount > 0 && !moveToCategoryId) return;
    setDeleting(true);
    try {
      await onDelete(
        transactionCount > 0 ? { moveToCategoryId: Number(moveToCategoryId) } : undefined
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={
        confirmingDelete
          ? `Delete "${initial?.name}"?`
          : initial
            ? "Edit Category"
            : "New Category"
      }
      onClose={onClose}
      footer={
        confirmingDelete ? (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                Cancel
              </Btn>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn
                variant="danger"
                onClick={confirmDelete}
                disabled={deleting || (transactionCount > 0 && !moveToCategoryId)}
              >
                {deleting ? "Deleting" : "Yes, delete it"}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mr-auto">
              <Btn onClick={onClose}>Cancel</Btn>
              {initial && onDelete && (
                <Btn variant="danger" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </Btn>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Btn
                variant="primary"
                onClick={() =>
                  name.trim() &&
                  onSave({
                    name: name.trim(),
                    groupId: groupId ? Number(groupId) : undefined,
                    goalTarget: hasGoal && evalAmount(goal) != null ? dollarsToCents(evalAmount(goal)) : null,
                    carryover: hasCarryover && evalAmount(carryover) != null ? dollarsToCents(evalAmount(carryover)) : 0,
                    overspendCarriesOver,
                  })
                }
              >
                Save
              </Btn>
            </div>
          </>
        )
      }
    >
      {confirmingDelete ? (
        <div className="space-y-3 text-[12.5px] leading-relaxed" style={{ color: "var(--y-ink)" }}>
          <p>
            Are you sure you want to delete <strong>{initial?.name}</strong>?
          </p>
          {transactionCount > 0 ? (
            <div>
              <Notice tone="warn" title="Existing transactions">
                This category is referenced by {transactionCount} transaction(s).
                Please select another category to reassign them to before deleting.
              </Notice>
              <div className="mt-3">
                <Field label="Move transactions to">
                  <Select
                    value={moveToCategoryId}
                    onChange={(v) => setMoveToCategoryId(v === "" ? "" : Number(v))}
                    className="w-full"
                    searchable
                  >
                    <option value="">Select replacement category…</option>
                    {groups && groups.length > 0 ? (
                      groups.map((g) => (
                        <optgroup key={g.id} label={g.name}>
                          {otherCategories
                            .filter((c) => c.groupId === g.id)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </optgroup>
                      ))
                    ) : (
                      otherCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))
                    )}
                  </Select>
                </Field>
              </div>
            </div>
          ) : (
            <p className="y-hint text-[11.5px]">This category has no transactions and will be removed.</p>
          )}
        </div>
      ) : (
        <>
          <Field label="Name">
            <TextField value={name} onChange={(e) => setName(e.target.value)} autoFocus className={inputClass} />
          </Field>
          {groups && groups.length > 0 && (
            <Field label="Group">
              <Select
                value={groupId ?? ""}
                onChange={(v) => setGroupId(Number(v))}
                className="w-full"
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="mb-2">
            <Checkbox
              checked={hasGoal}
              onChange={setHasGoal}
              label="Set a funding goal"
            />
          </div>
          {hasGoal && (
            <Field label="Goal Target">
              <TextField
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="1000.00"
                inputMode="decimal"
                className={inputClass}
              />
              <AmountPreview value={goal} />
            </Field>
          )}
          <div className="mb-2">
            <Checkbox
              checked={hasCarryover}
              onChange={setHasCarryover}
              label="Set opening carryover balance"
            />
          </div>
          {hasCarryover && (
            <Field label="Carryover Amount">
              <TextField
                value={carryover}
                onChange={(e) => setCarryover(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className={inputClass}
              />
              <AmountPreview value={carryover} />
            </Field>
          )}
          <div className="mb-2">
            <Checkbox
              checked={overspendCarriesOver}
              onChange={setOverspendCarriesOver}
              label="Red Arrow: Carry negative balance over to next month"
            />
          </div>
        </>
      )}
    </Modal>
  );
}
