"use client";

import { useEffect, useState } from "react";
import { Icon, Notice, Button } from "@ynab/theme";
import { Modal, Btn, inputCls } from "./ui.js";

export type SnapshotSummary = {
  id: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
};

export function formatSnapshotSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatSnapshotDate(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return createdAt;
  return d.toLocaleString();
}

export function SnapshotsView({
  snapshots,
  suggestedName,
  loading,
  error,
  onCreate,
  onRestore,
  onDelete,
}: {
  snapshots: SnapshotSummary[];
  suggestedName: string;
  loading?: boolean;
  error?: string | null;
  onCreate: (name: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(suggestedName);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Prefill the editable name from the latest transaction until the user
  // types their own. Resetting `touched` (after a save) re-arms the prefill.
  useEffect(() => {
    if (!touched) setName(suggestedName);
  }, [suggestedName, touched]);

  const create = async () => {
    setLocalError(null);
    setBusy(true);
    try {
      await onCreate(name.trim());
      setTouched(false);
      setName(suggestedName);
    } catch (e: any) {
      setLocalError(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (restoringId == null) return;
    setLocalError(null);
    setBusy(true);
    try {
      await onRestore(restoringId);
      setRestoringId(null);
    } catch (e: any) {
      setLocalError(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (deletingId == null) return;
    setLocalError(null);
    setBusy(true);
    try {
      await onDelete(deletingId);
      setDeletingId(null);
    } catch (e: any) {
      setLocalError(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const restoring = snapshots.find((s) => s.id === restoringId) ?? null;
  const deleting = snapshots.find((s) => s.id === deletingId) ?? null;

  return (
    <div className="p-5 y-scroll overflow-auto" style={{ background: "var(--y-row)" }}>
      <div className="max-w-[760px]">
        <div>
          <h1 className="text-[16px] font-bold" style={{ color: "var(--y-ink)" }}>
            Snapshots
          </h1>
          <p className="y-hint text-[12px] mt-1 max-w-[560px]">
            Save a snapshot before a risky change — a tricky import, a bulk edit,
            a reconcile. Restoring a snapshot replaces your current budget with
            the saved copy.
          </p>
        </div>

        <div className="mt-4 flex items-end gap-2 max-w-[560px]">
          <div className="flex-1">
            <label
              className="y-hint text-[11.5px] block mb-1"
              htmlFor="snapshot-name"
            >
              Snapshot name (suggested from your latest transaction — edit freely)
            </label>
            <input
              id="snapshot-name"
              className={inputCls}
              value={name}
              onChange={(e) => {
                setTouched(true);
                setName(e.target.value);
              }}
              placeholder={suggestedName}
              aria-label="Snapshot name"
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={create}
            disabled={busy || loading}
            aria-label="Save snapshot"
          >
            <Icon name="plus" size={12} /> {busy ? "Saving" : "Save snapshot"}
          </Button>
        </div>

        {(error || localError) && (
          <Notice tone="danger" title="Snapshot failed" className="mt-3 max-w-[560px]">
            {localError ?? error}
          </Notice>
        )}

        {loading ? (
          <div className="mt-5">
            <Notice tone="info" title="Loading snapshots">
              Fetching your saved snapshots…
            </Notice>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="mt-5">
            <Notice tone="info" title="No snapshots yet">
              Save your first snapshot above — it only takes a moment and gives
              you a way back.
            </Notice>
          </div>
        ) : (
          <div className="y-scroll mt-4 overflow-auto border rounded" style={{ borderColor: "var(--y-line)" }}>
            <table className="y-table w-full text-left">
              <thead className="y-thead--sticky">
                <tr>
                  <th>Name</th>
                  <th>Saved</th>
                  <th>Size</th>
                  <th className="w-[92px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id} className="y-row">
                    <td className="truncate max-w-[280px]" title={s.name}>
                      {s.name}
                    </td>
                    <td className="y-num whitespace-nowrap">{formatSnapshotDate(s.createdAt)}</td>
                    <td className="y-num whitespace-nowrap">{formatSnapshotSize(s.sizeBytes)}</td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button
                          className="y-icon-btn"
                          title="Restore this snapshot"
                          aria-label={`Restore snapshot ${s.name}`}
                          onClick={() => setRestoringId(s.id)}
                        >
                          <Icon name="clock" size={12} />
                        </button>
                        <button
                          className="y-icon-btn"
                          title="Delete snapshot"
                          aria-label={`Delete snapshot ${s.name}`}
                          onClick={() => setDeletingId(s.id)}
                        >
                          <Icon name="trash" size={12} />
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

      {restoring && (
        <Modal
          title="Restore snapshot"
          onClose={() => setRestoringId(null)}
          footer={
            <>
              <Btn onClick={() => setRestoringId(null)} disabled={busy}>
                Cancel
              </Btn>
              <Btn variant="primary" onClick={confirmRestore} disabled={busy}>
                {busy ? "Restoring" : "Yes, restore it"}
              </Btn>
            </>
          }
        >
          <div className="text-[12.5px]" style={{ color: "var(--y-ink)" }}>
            <p>
              Replace your current budget with <strong>{restoring.name}</strong>{" "}
              (saved {formatSnapshotDate(restoring.createdAt)})? Changes made
              since the snapshot will be lost.
            </p>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal
          title="Delete snapshot"
          onClose={() => setDeletingId(null)}
          footer={
            <>
              <Btn onClick={() => setDeletingId(null)} disabled={busy}>
                Cancel
              </Btn>
              <Btn variant="danger" onClick={confirmDelete} disabled={busy}>
                {busy ? "Deleting" : "Yes, delete it"}
              </Btn>
            </>
          }
        >
          <div className="text-[12.5px]" style={{ color: "var(--y-ink)" }}>
            <p>
              Are you sure you want to delete the snapshot{" "}
              <strong>{deleting.name}</strong>? Your current budget is not
              affected.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
