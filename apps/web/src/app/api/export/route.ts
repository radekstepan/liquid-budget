import { NextRequest } from "next/server";
import { getDefaultDb, exportYnab4Zip } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const db = getDefaultDb();
    const today = new Date().toISOString().slice(0, 10);
    const buffer = await exportYnab4Zip(db);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="budget-${today}.y4backup"`,
      },
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Failed to export data" },
      { status: 500 }
    );
  }
}