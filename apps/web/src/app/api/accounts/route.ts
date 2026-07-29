import { createAccount, getDefaultDb } from "@ynab/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  if (!body.name) return Response.json({ error: "invalid" }, { status: 400 });
  const row = await createAccount(getDefaultDb(), body);
  return Response.json(row);
}
