import type { BudgetAppApi } from "@ynab/ui";
import { parseSnapshotsResponse } from "@ynab/logic";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createSnapshotsApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "listSnapshots" | "createSnapshot" | "restoreSnapshot" | "deleteSnapshot"> {
  const { runMutation, withSync } = deps;
  return {
  listSnapshots: async () => {
    const raw = await jsonReq<unknown>("/api/snapshots");
    return parseSnapshotsResponse(raw);
  },
  createSnapshot: async (name) => {
    return withSync(() =>
      runMutation(
        async () => {
          await jsonReq("/api/snapshots", {
            method: "POST",
            body: JSON.stringify({ name }),
          });
        },
        { success: "Snapshot saved.", failure: "Failed to save snapshot.", notifyFailure: false }
      )
    );
  },
  restoreSnapshot: async (id) => {
    return withSync(() =>
      runMutation(
        async () => {
          await jsonReq("/api/snapshots", {
            method: "POST",
            body: JSON.stringify({ action: "restore", id }),
          });
        },
        { success: "Snapshot restored.", failure: "Failed to restore snapshot.", notifyFailure: false }
      )
    );
  },
  deleteSnapshot: async (id) => {
    return withSync(() =>
      runMutation(
        async () => {
          await jsonReq(`/api/snapshots?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        },
        { success: "Snapshot deleted.", failure: "Failed to delete snapshot.", notifyFailure: false }
      )
    );
  },
  };
}
