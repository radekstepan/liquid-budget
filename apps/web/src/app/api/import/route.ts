import { NextRequest, NextResponse } from "next/server";
import { getDefaultDb, importYnab4, extractYnab4DataFromZip } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    let ynabData: any;
    let settingsXml: string | undefined;
    try {
      const extracted = extractYnab4DataFromZip(arrayBuffer);
      ynabData = extracted.ynabData;
      settingsXml = extracted.settingsXml;
    } catch (e: any) {
      return NextResponse.json({ error: e.message || "Invalid backup archive" }, { status: 400 });
    }

    const db = getDefaultDb();
    const summary = await importYnab4(db, ynabData, settingsXml);

    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    console.error("[import] Error:", e);
    return NextResponse.json({ error: e.message || "Failed to import" }, { status: 500 });
  }
}
