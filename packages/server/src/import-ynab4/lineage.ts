import type { TransactionFlagColor } from "@ynab/logic";
import type { Ynab4TxLineage } from "./types.js";

/** YNAB4 flag color name → our enum. Unknown/missing values map to null. */
export function ynabFlagToColor(flag: unknown): TransactionFlagColor | null {
  if (typeof flag !== "string") return null;
  const normalized = flag.trim().toLowerCase();
  switch (normalized) {
    case "red":
      return "red";
    case "orange":
      return "orange";
    case "yellow":
      return "yellow";
    case "green":
      return "green";
    case "blue":
      return "blue";
    case "purple":
      return "purple";
    default:
      return null;
  }
}

function cleanLineageString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

/** Pull the persistable lineage fields off any YNAB4 tx/sub-tx object. */
export function extractYnab4TxLineage(src: any): Ynab4TxLineage {
  return {
    checkNumber: cleanLineageString(src?.checkNumber),
    fitid: cleanLineageString(src?.FITID),
    ynabId: cleanLineageString(src?.YNABID),
    importedPayee: cleanLineageString(src?.importedPayee),
    source: cleanLineageString(src?.source),
  };
}
