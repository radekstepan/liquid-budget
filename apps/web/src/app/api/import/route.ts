import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getDefaultDb, importYnab4FromArchive } from "@ynab/server";
import { apiErrorResponse, optionalErrorMessage } from "../errors";
import { mutationGuardResponse } from "../guard";
import { createScopedLogger, toLogDetails } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const MAX_IMPORT_UPLOAD_BYTES = 50 * 1024 * 1024;
// Multipart overhead: Content-Length covers the whole form, not just the file.
export const MAX_IMPORT_CONTENT_LENGTH = 55 * 1024 * 1024;

const log = createScopedLogger("import");

export async function POST(req: NextRequest) {
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_CONTENT_LENGTH) {
    return NextResponse.json({ error: "Upload exceeds the 50MB limit" }, { status: 413 });
  }
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (typeof file.size === "number" && file.size > MAX_IMPORT_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Upload exceeds the 50MB limit" }, { status: 413 });
    }

    const arrayBuffer = await file.arrayBuffer();
    let summary;
    try {
      summary = await importYnab4FromArchive(getDefaultDb(), Buffer.from(arrayBuffer));
    } catch (e) {
      return NextResponse.json({ error: optionalErrorMessage(e) || "Invalid backup archive" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    log.error("Error:", toLogDetails(e));
    return apiErrorResponse(e);
  }
}
