"use client";

import { useCallback, useState } from "react";
import type { RenameSuggestStatusResponse } from "@ynab/logic";
import type { SnapshotSummary } from "./SnapshotsView.js";

/** Snapshot list state for the settings overlay, refreshed on open. */
export function useSnapshots(api: {
  listSnapshots?: () => Promise<{ snapshots: SnapshotSummary[]; suggestedName: string }>;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [snapshotSuggestion, setSnapshotSuggestion] = useState("");
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);

  const refreshSnapshots = useCallback(async () => {
    if (!api.listSnapshots) return;
    setSnapshotsLoading(true);
    setSnapshotsError(null);
    try {
      const res = await api.listSnapshots();
      setSnapshots(res.snapshots);
      setSnapshotSuggestion(res.suggestedName);
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e && e.message
          ? String(e.message)
          : String(e);
      setSnapshotsError(message);
    } finally {
      setSnapshotsLoading(false);
    }
  }, [api]);

  return { snapshots, snapshotSuggestion, snapshotsLoading, snapshotsError, refreshSnapshots };
}

/** AI rename-suggestion availability; best-effort (failures hide the button). */
export function useRenameSuggestStatus(api: {
  getRenameSuggestStatus?: () => Promise<RenameSuggestStatusResponse>;
}) {
  const [renameSuggestStatus, setRenameSuggestStatus] =
    useState<RenameSuggestStatusResponse | null>(null);

  const refreshRenameSuggestStatus = useCallback(async () => {
    if (!api.getRenameSuggestStatus) return;
    try {
      setRenameSuggestStatus(await api.getRenameSuggestStatus());
    } catch {
      // Status is best-effort: a failure just hides the AI button.
      setRenameSuggestStatus(null);
    }
  }, [api]);

  return { renameSuggestStatus, refreshRenameSuggestStatus };
}
