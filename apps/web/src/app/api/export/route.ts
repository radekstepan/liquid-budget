import type { NextRequest } from "next/server";
import { createReadStream, promises as fsp } from "node:fs";
import { Readable } from "node:stream";
import { getDefaultDb, exportYnab4ZipToFile, exportBudgetCsv, exportBudgetJson, exportBudgetSqlite } from "@ynab/server";
import { apiErrorResponse } from "../errors";
import { mutationGuardResponse } from "../guard";
import { createScopedLogger, toLogDetails } from "@/lib/logger";

export const dynamic = "force-dynamic";

const log = createScopedLogger("export");

export async function GET(req: NextRequest) {
  // Full-budget dump: sensitive read, same loopback bar as mutations.
  const blocked = mutationGuardResponse(req);
  if (blocked) return blocked;
  // BudgetExport.body is string | Uint8Array<ArrayBufferLike>; copying the
  // binary case into a fresh Uint8Array<ArrayBuffer> satisfies BodyInit.
  const toResponseBody = (body: string | Uint8Array): BodyInit =>
    typeof body === "string" ? body : new Uint8Array(body);
  try {
    const format = req.nextUrl?.searchParams?.get("format")?.toLowerCase();
    const db = getDefaultDb();
    const today = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      const out = await exportBudgetJson(db, today);
      return new Response(toResponseBody(out.body), {
        headers: {
          "Content-Type": out.contentType,
          "Content-Disposition": `attachment; filename="${out.filename}"`,
        },
      });
    }

    if (format === "sqlite" || format === "db") {
      const out = await exportBudgetSqlite(db, today);
      return new Response(toResponseBody(out.body), {
        headers: {
          "Content-Type": out.contentType,
          "Content-Disposition": `attachment; filename="${out.filename}"`,
        },
      });
    }

    if (format === "csv") {
      const out = await exportBudgetCsv(db, today);
      return new Response(toResponseBody(out.body), {
        headers: {
          "Content-Type": out.contentType,
          "Content-Disposition": `attachment; filename="${out.filename}"`,
        },
      });
    }

    // P1 export-perf: the archive is assembled on disk with bounded memory
    // and streamed to the client; only the staging path (never the bytes)
    // is held. Cleanup runs when the file stream closes (or errors).
    const tmp = await exportYnab4ZipToFile(db);
    const cleanup = () => {
      fsp.unlink(tmp.filePath).catch(() => {});
    };
    try {
      const size = (await fsp.stat(tmp.filePath)).size;
      const nodeStream = createReadStream(tmp.filePath);
      nodeStream.on("error", cleanup);
      nodeStream.on("close", cleanup);
      return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="budget-${today}.y4backup"`,
          "Content-Length": String(size),
        },
      });
    } catch (err) {
      cleanup();
      throw err;
    }
  } catch (err) {
    log.error("Error:", toLogDetails(err));
    return apiErrorResponse(err);
  }
}
