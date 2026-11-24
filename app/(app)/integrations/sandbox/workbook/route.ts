import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { db, type Org } from "@/lib/db";
import { EXCEL } from "@/lib/integrations";
import { ctxFor, getConn } from "@/lib/integrations/core";
import { workbookBytes } from "@/lib/integrations/excel";

// Downloads the simulator's copy of the OneDrive workbook, built from the cells the Graph calls wrote.
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const org = db.prepare("SELECT * FROM orgs WHERE user_id = ?").get(user.id) as Org;
  const c = getConn(org.id, EXCEL);
  if (!c || c.mode !== "sandbox") return NextResponse.json({ error: "No simulated workbook" }, { status: 404 });
  const bytes = await workbookBytes(c, ctxFor(org.id, EXCEL, "sandbox"));
  return new NextResponse(bytes, {
    headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="Fieldwise exports (simulated OneDrive).xlsx"', "Cache-Control": "no-store" },
  });
}
