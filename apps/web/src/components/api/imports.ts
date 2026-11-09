import type { BudgetAppApi } from "@ynab/ui";
import type { ImportSkippedEntry, ImportSummary } from "@ynab/logic";
import { parseDuplicateAnalysisResponse, parseDuplicateDismissResponse } from "@ynab/logic";
import type { BudgetApiDeps } from "./types";
import { jsonReq } from "./client";

export function createImportsApi(deps: BudgetApiDeps): Pick<BudgetAppApi, "importCsv" | "importYnab4" | "analyzeDuplicates" | "dismissDuplicateGroup"> {
  const { runMutation, withSync, addToast } = deps;
  return {
  importCsv: async ({ accountId, swap, dateFormat, csv }) => {
    return withSync(() =>
      runMutation(
        async () => {
          const res = await fetch("/api/import/csv", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId, swap, dateFormat, csv }),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Import failed (${res.status}): ${text}`);
          }
          const json = (await res.json()) as {
            imported?: number;
            skipped?: ImportSkippedEntry[];
          };
          const count = json.imported ?? 0;
          const skipped = json.skipped?.length ?? 0;
          return { count, skipped };
        },
        {
          success: undefined,
          failure: "Failed to import CSV.",
          onSuccess: ({ count, skipped }) => {
            addToast(
              skipped > 0
                ? `Imported ${count} transaction${count === 1 ? "" : "s"} (${skipped} row${skipped === 1 ? "" : "s"} skipped).`
                : `Imported ${count} transaction${count === 1 ? "" : "s"}.`,
              "ok"
            );
          },
        }
      )
    ).then(({ count }) => count);
  },
  analyzeDuplicates: async () => {
    return withSync(() =>
      runMutation(
        async () => {
          return parseDuplicateAnalysisResponse(
            await jsonReq<unknown>("/api/duplicates", {
              method: "POST",
            })
          );
        },
        { failure: "Failed to analyze duplicates." }
      )
    );
  },
  dismissDuplicateGroup: async (fingerprint) => {
    return withSync(() =>
      runMutation(
        async () => {
          return parseDuplicateDismissResponse(
            await jsonReq<unknown>("/api/duplicates/dismiss", {
              method: "POST",
              body: JSON.stringify({ fingerprint }),
            })
          );
        },
        { success: "Marked as not duplicates.", failure: "Failed to dismiss duplicates." }
      )
    ).then(() => undefined);
  },
    importYnab4: async (file: File) => {
    return withSync(() =>
      runMutation(
        async () => {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/import", {
            method: "POST",
            body: formData,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Import failed (${res.status}): ${text}`);
          }
          const json = (await res.json()) as { summary?: ImportSummary };
          return json?.summary;
        },
        {
          success: undefined,
          failure: "Failed to import YNAB4 backup.",
          onSuccess: (summary?: ImportSummary) => {
            if (summary && !summary.duplicatesSkipped?.length) {
              addToast(`Imported ${summary.transactions} transaction${summary.transactions === 1 ? "" : "s"}.`, "ok");
            }
          },
        }
      )
    );
  },
  };
}
