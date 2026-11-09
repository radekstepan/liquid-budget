import type { Ynab4ImportContext } from "../types.js";

export function reportDroppedOfxMappings(ynabData: any, ctx: Ynab4ImportContext): void {
  const yAccounts = ynabData.accounts || [];
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
    const mappings = Array.isArray(ynabData.accountMappings) ? ynabData.accountMappings : [];
    const liveMappings = mappings.filter((m: any) => !m?.isTombstone);
    if (liveMappings.length > 0) {
      ctx.warnings.push(
        `Dropped ${liveMappings.length} OFX account mapping(s) (fid/shortenedAccountId/targetYNABAccountId + import preferences); OFX import is not modeled`
      );
      const accountNameByEntity = new Map<string, string>();
      for (const a of yAccounts) {
        if (!a?.isTombstone && typeof a?.entityId === "string" && typeof a?.accountName === "string") {
          accountNameByEntity.set(a.entityId, a.accountName);
        }
      }
      for (const m of liveMappings) {
        const target = typeof m?.targetYNABAccountId === "string" ? m.targetYNABAccountId : "";
        const name = accountNameByEntity.get(target);
        const label = name ? `"${name}" (targetYNABAccountId ${target})` : `targetYNABAccountId ${target || "unknown"}`;
        ctx.warnings.push(
          `OFX account mapping for ${label}: dropped import preferences skipImport=${m?.skipImport ?? false}, shouldFlipPayeesMemos=${m?.shouldFlipPayeesMemos ?? false}, shouldImportMemos=${m?.shouldImportMemos ?? true}; OFX import is not modeled`
        );
      }
    }
  }
}
