import {
  createSnapshot,
  deleteSnapshot,
  getDefaultDb,
  listSnapshots,
  restoreSnapshot,
  suggestSnapshotName,
} from "@ynab/server";
import { apiErrorResponse } from "../errors";

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
 * POST /api/snapshots { name? }
 * Saves a snapshot of the live database. An empty/omitted name falls back to
 * the suggested name.
 *
 * POST /api/snapshots?action=restore { id }
 * Replaces the live database with the snapshot.
 */
export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    if (action === "restore") {
      const id = (json as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id.trim() === "") {
        return Response.json({ error: "snapshot id is required" }, { status: 400 });
      }
      const snapshot = await restoreSnapshot(id);
      return Response.json({ ok: true, snapshot });
    }

    const name = (json as { name?: unknown } | null)?.name;
    if (name !== undefined && typeof name !== "string") {
      return Response.json({ error: "snapshot name must be a string" }, { status: 400 });
    }
    const snapshot = await createSnapshot(getDefaultDb(), { name });
    return Response.json({ ok: true, snapshot });
  } catch (e) {
    return apiErrorResponse(e);
  }
}

/**
 * DELETE /api/snapshots?id=<snapshotId>
 */
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";
  try {
    deleteSnapshot(id);
    return Response.json({ ok: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
