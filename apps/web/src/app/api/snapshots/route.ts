import {
  createSnapshot,
  deleteSnapshot,
  getDefaultDb,
  listSnapshots,
  restoreSnapshot,
  suggestSnapshotName,
} from "@ynab/server";
import { resolveAction } from "../action";
import { apiErrorResponse } from "../errors";
import { mutationGuardResponse } from "../guard";
import {
  formatZodError,
  SnapshotCreateSchema,
  SnapshotRestoreSchema,
} from "../schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/snapshots
 * Lists manual snapshots newest-first plus a suggested name for the next one
 * (derived from the latest transaction; the UI leaves it editable).
 */
export async function GET() {
  try {
    const db = getDefaultDb();
    const snapshots = listSnapshots();
    const suggestedName = await suggestSnapshotName(db);
    return Response.json({ snapshots, suggestedName });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

/**
 * POST /api/snapshots { name? } — create; both branches return the uniform
 * {ok:true,snapshot} envelope.
 *
 * POST /api/snapshots { action:"restore", id } — restore. Canonical
 * discriminator is the body; `?action=restore` is a deprecated alias.
 */
export async function POST(req: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const action = resolveAction(req, json, ["restore"]);

  try {
    if (action === "restore") {
      // Accept the legacy query spelling `?action=restore` with a bare
      // `{id}` body: normalise to the canonical body discriminator before
      // validation so both spellings share one schema.
      const raw = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
      const parsed = SnapshotRestoreSchema.safeParse({ ...raw, action: "restore" });
      if (!parsed.success) {
        return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
      }
      const snapshot = await restoreSnapshot(parsed.data.id);
      return Response.json({ ok: true, snapshot });
    }

    const parsed = SnapshotCreateSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    const snapshot = await createSnapshot(getDefaultDb(), { name: parsed.data.name });
    return Response.json({ ok: true, snapshot });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

/**
 * DELETE /api/snapshots?id=<snapshotId>
 */
export async function DELETE(req: Request) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";
  try {
    deleteSnapshot(id);
    return Response.json({ ok: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
