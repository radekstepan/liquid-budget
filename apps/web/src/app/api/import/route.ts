import { NextRequest, NextResponse } from "next/server";
import AdmZip from "adm-zip";
import { getDefaultDb, importYnab4 } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Parse ZIP
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    
    // Find the .ynab4 file
    let ynab4JsonStr = "";
    for (const entry of zipEntries) {
      if (entry.entryName.endsWith(".ynab4")) {
        ynab4JsonStr = zip.readAsText(entry);
        break;
      }
    }

    if (!ynab4JsonStr) {
      return NextResponse.json({ error: "Could not find .ynab4 file inside the zip" }, { status: 400 });
    }

    const ynabData = JSON.parse(ynab4JsonStr);

    const db = getDefaultDb();
    const summary = await importYnab4(db, ynabData);

    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    console.error("[import] Error:", e);
    return NextResponse.json({ error: e.message || "Failed to import" }, { status: 500 });
  }
}
