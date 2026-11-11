import { arrayField, asRecord } from "../guards.js";
import type { Ynab4ImportContext } from "../types.js";

export function reportDroppedOfxMappings(ynabData: unknown, ctx: Ynab4ImportContext): void {
  const yAccounts = arrayField(ynabData, "accounts");
  // 5d. G-10: `accountMappings` (OFX import config) are
  // intentionally dropped. YNAB4's `AccountMappingVO` carries `fid,
  // shortenedAccountId, hash, salt, targetYNABAccountId,
  // dateSequence, shouldFlipPayeesMemos, shouldImportMemos (=true),
  // skipImport` (`data/AccountMapping.as`,
  // `AccountMappingManager.as`, `dataAccess/importing/` OFX/QIF
  // readers). None of it feeds budget math and no OFX import is
  // modeled here, so persisting it would be dead weight. The
  // aggregate count plus one line per mapped account (naming the
  // account and the three per-account import booleans) keep the
  // loss visible in warnings, never silent. If OFX import is ever
  // built, revisit storing at least the three per-account booleans
  // (`skipImport`, `shouldFlipPayeesMemos`, `shouldImportMemos`).
  {
    const mappings = arrayField(ynabData, "accountMappings");
    const liveMappings = mappings.filter((m) => !asRecord(m)?.isTombstone);
    if (liveMappings.length > 0) {
      ctx.warnings.push(
        `Dropped ${liveMappings.length} OFX account mapping(s) (fid/shortenedAccountId/targetYNABAccountId + import preferences); OFX import is not modeled`
      );
      const accountNameByEntity = new Map<string, string>();
      for (const a of yAccounts) {
        const row = asRecord(a);
        const entityId = row == null ? undefined : row.entityId;
        const accountName = row == null ? undefined : row.accountName;
        if (row != null && !row.isTombstone && typeof entityId === "string" && typeof accountName === "string") {
          accountNameByEntity.set(entityId, accountName);
        }
      }
      for (const m of liveMappings) {
        const row = asRecord(m);
        const target = typeof row?.targetYNABAccountId === "string" ? row.targetYNABAccountId : "";
        const name = accountNameByEntity.get(target);
        const label = name ? `"${name}" (targetYNABAccountId ${target})` : `targetYNABAccountId ${target || "unknown"}`;
        ctx.warnings.push(
          `OFX account mapping for ${label}: dropped import preferences skipImport=${row?.skipImport ?? false}, shouldFlipPayeesMemos=${row?.shouldFlipPayeesMemos ?? false}, shouldImportMemos=${row?.shouldImportMemos ?? true}; OFX import is not modeled`
        );
      }
    }
  }
}
