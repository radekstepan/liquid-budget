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
    const { ynabData } = extractYnab4DataFromZip(arrayBuffer);

    const db = getDefaultDb();
    const summary = await importYnab4(db, ynabData);

    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    console.error("[import] Error:", e);
    return NextResponse.json({ error: e.message || "Failed to import" }, { status: 500 });
  }
}
