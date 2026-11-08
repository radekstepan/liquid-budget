---
"@ynab/server": patch
---

## Hidden mangle linkage preservation (g-hidden-mangle)

Story: YNAB4 hides a sub-category by moving it under the Hidden master and
rewriting its name to a mangled "OldMaster ` Sub ` OldMasterEntityId" string
(`MangledHiddenNameComponents.as`, `MasterCategoryList.as:449-495`). Import
used to store that verbatim string as the display name and drop the linkage,
so the original master was unrecoverable and re-export wrote the mangled
blob back under the hidden master. Import now demangles hidden-master subs
to the plain sub name and persists the parsed components
(`old_master_name`, `old_master_entity_id`); export re-mangles from the
stored components verbatim, so the wire form round-trips.

Notes: new nullable `categories` columns via migration `0033_furry_maggott`.
Only names under the hidden master are parsed (YNAB4 rejects backticks in
fresh names, so a backtick elsewhere is never a mangle); unparseable shapes
keep their verbatim name with null lineage rather than failing the import.
Two-part legacy names ("OldMaster ` Sub", no entity id) store the name with
a null id and re-export 2-part. Plain hidden names (e.g. our own pre-fix
exports) keep null lineage and export untouched.
