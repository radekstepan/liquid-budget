"use client";

import { useMemo, useState } from "react";
import type { RenameRule } from "@ynab/logic";
import { isPatternRule } from "@ynab/logic";
import { Icon, Notice, Button } from "@ynab/theme";
import { Modal, Field, Btn, inputCls } from "./ui.js";

type RuleDraft = {
  sourcePattern: string;
  targetPayee: string;
};

export function SettingsView({
  rules,
  onAdd,
  onUpdate,
  onDelete,
}: {
  rules: RenameRule[];
  onAdd: (sourcePattern: string, targetPayee: string) => Promise<void>;
  onUpdate: (id: number, sourcePattern: string, targetPayee: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState<RenameRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...rules].sort((a, b) => a.sourcePattern.localeCompare(b.sourcePattern)),
    [rules]
  );

  const openCreate = () => {
    setError(null);
    setEditing(null);
    setCreating(true);
  };

  const save = async (draft: RuleDraft) => {
    setError(null);
    setBusy(true);
    try {
      if (creating) {
        await onAdd(draft.sourcePattern, draft.targetPayee);
      } else if (editing) {
        await onUpdate(editing.id, draft.sourcePattern, draft.targetPayee);
      }
      setCreating(false);
      setEditing(null);
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    setError(null);
    try {
      await onDelete(id);
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
    }
  };

  return (
    <div className="p-5 y-scroll overflow-auto" style={{ background: "var(--y-row)" }}>
      <div className="max-w-[760px]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-[16px] font-bold" style={{ color: "var(--y-ink)" }}>
              Payee Rename Rules
            </h1>
            <p className="y-hint text-[12px] mt-1 max-w-[560px]">
              These rules are applied automatically to payees in future CSV imports.
              They are learned when you rename a transaction payee (for example{" "}
              <span className="y-num">BCF1</span> → <span className="y-num">BC Ferries</span>).
              Renaming <span className="y-num">BCF2</span> the same way generalises the rule
              to <span className="y-num">BCF[N] → BC Ferries</span>, where <span className="y-num">[N]</span>{" "}
              matches one or more digits.
            </p>
          </div>
          <Button size="sm" variant="primary" onClick={openCreate} aria-label="Add rename rule">
            <Icon name="plus" size={12} /> Add rule
          </Button>
        </div>

        {error && (
          <Notice tone="danger" title="Rule not saved" className="mt-3">
            {error}
          </Notice>
        )}

        {sorted.length === 0 ? (
          <div className="mt-5">
            <Notice tone="info" title="No rename rules yet">
              Rename a payee on a transaction after a CSV import, or add a rule manually, to
              keep future imports tidy.
            </Notice>
          </div>
        ) : (
          <div className="y-scroll mt-4 overflow-auto border rounded" style={{ borderColor: "var(--y-line)" }}>
            <table className="y-table w-full text-left">
              <thead className="y-thead--sticky">
                <tr>
                  <th>Source (matches)</th>
                  <th>Renamed to</th>
                  <th className="w-[92px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.id} className="y-row">
                    <td className="y-num whitespace-nowrap">{r.sourcePattern}</td>
                    <td className="truncate">{r.targetPayee}</td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button
                          className="y-icon-btn"
                          title="Edit rule"
                          aria-label={`Edit rule ${r.sourcePattern}`}
                          onClick={() => {
                            setError(null);
                            setConfirmId(null);
                            setCreating(false);
                            setEditing(r);
                          }}
                        >
                          <Icon name="edit" size={12} />
                        </button>
                        <button
                          className="y-icon-btn"
                          title="Delete rule"
                          aria-label={`Delete rule ${r.sourcePattern}`}
                          onClick={() => remove(r.id)}
                        >
                          {confirmId === r.id ? (
                            <span className="text-[10px] font-bold px-0.5">Confirm?</span>
                          ) : (
                            <Icon name="trash" size={12} />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(creating || editing) && (
        <RuleFormModal
          title={creating ? "Add rename rule" : "Edit rename rule"}
          initial={
            editing
              ? { sourcePattern: editing.sourcePattern, targetPayee: editing.targetPayee }
              : { sourcePattern: "", targetPayee: "" }
          }
          busy={busy}
          onClose={() => {
            if (!busy) {
              setCreating(false);
              setEditing(null);
            }
          }}
          onSave={save}
        />
      )}
    </div>
  );
}

function RuleFormModal({
  title,
  initial,
  busy,
  onClose,
  onSave,
}: {
  title: string;
  initial: RuleDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: RuleDraft) => void;
}) {
  const [sourcePattern, setSourcePattern] = useState(initial.sourcePattern);
  const [targetPayee, setTargetPayee] = useState(initial.targetPayee);

  const valid = sourcePattern.trim().length > 0 && targetPayee.trim().length > 0;

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={!valid || busy}
            onClick={() => {
              if (sourcePattern.trim() && targetPayee.trim()) {
                onSave({ sourcePattern, targetPayee });
              }
            }}
          >
            Save rule
          </Btn>
        </>
      }
    >
      <Field label="Source (matches)">
        <input
          className={inputCls}
          value={sourcePattern}
          onChange={(e) => setSourcePattern(e.target.value)}
          placeholder='e.g. BCF1 or BCF[N]'
          aria-label="Source pattern"
        />
      </Field>
      <Field label="Renamed to">
        <input
          className={inputCls}
          value={targetPayee}
          onChange={(e) => setTargetPayee(e.target.value)}
          placeholder="e.g. BC Ferries"
          aria-label="Target payee"
        />
      </Field>
      <p className="y-hint text-[11px] -mt-1">
        Use <span className="y-num">[N]</span> to match one or more digits, e.g.{" "}
        <span className="y-num">BCF[N]</span> matches <span className="y-num">BCF1</span>,{" "}
        <span className="y-num">BCF2</span>, <span className="y-num">BCF10</span>. Leave it out for
        an exact match.
      </p>
      {isPatternRule(sourcePattern) && (
        <div className="mt-3">
          <Notice tone="ok" title="Pattern detected">
            <span className="y-num">{sourcePattern}</span> will match any payee whose digits
            vary, and rename it to <span className="y-num">{targetPayee || "…"}</span>.
          </Notice>
        </div>
      )}
    </Modal>
  );
}
