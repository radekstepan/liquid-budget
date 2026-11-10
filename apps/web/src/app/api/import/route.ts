import { NextRequest, NextResponse } from "next/server";
import { getDefaultDb, importYnab4, extractYnab4DataFromZip, type Ynab4BudgetMetaData } from "@ynab/server";
import { optionalErrorMessage } from "../errors";

export const dynamic = "force-dynamic";

// TODO(P0) [import-caps]: reject Content-Length > ~50MB before arrayBuffer(); cap ynab entry
// count/size in archive.ts to prevent zip-bomb OOM (AdmZip inflates fully in memory).
// TODO(P1) [thin-route]: move extractYnab4DataFromZip call into importYnab4(db, arrayBuffer)
// so route stays thin and server owns archive parsing.
// TODO(P2) [logging]: replace console.error below with logger abstraction + apiErrorResponse.

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    let ynabData: unknown;
    let settingsXml: string | undefined;
    let warnings: string[] = [];
    let budgetMetaData: Ynab4BudgetMetaData | undefined;
    try {
      const extracted = extractYnab4DataFromZip(arrayBuffer);
      ynabData = extracted.ynabData;
      settingsXml = extracted.settingsXml;
      warnings = extracted.warnings;
      budgetMetaData = extracted.budgetMetaData;
    } catch (e) {
      return NextResponse.json({ error: optionalErrorMessage(e) || "Invalid backup archive" }, { status: 400 });
    }

    const db = getDefaultDb();
    const summary = await importYnab4(db, ynabData, settingsXml, { warnings, budgetMetaData });

    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    console.error("[import] Error:", e);
    return NextResponse.json({ error: optionalErrorMessage(e) || "Failed to import" }, { status: 500 });
  }
}
