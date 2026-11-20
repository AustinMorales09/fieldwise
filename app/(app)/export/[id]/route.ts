import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { db, type DocRow, type TemplateRow } from "@/lib/db";
import { show, type Row, type Value } from "@/lib/fields";
import { toTemplate } from "@/lib/process";

const cell = (v: string | number) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // block spreadsheet formulas, but keep negative numbers
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// /export/<templateId>?what=documents|rows&status=approved|all  → CSV
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getUser();
  const tpl = user ? (db.prepare("SELECT t.* FROM templates t JOIN orgs o ON o.id = t.org_id WHERE t.id = ? AND o.user_id = ?").get(Number(id), user.id) as TemplateRow | undefined) : undefined;
  if (!tpl) return NextResponse.json({ error: user ? "Not found" : "Not signed in" }, { status: user ? 404 : 401 });
  const t = toTemplate(tpl);
  const what = req.nextUrl.searchParams.get("what") === "rows" ? "rows" : "documents";
  const all = req.nextUrl.searchParams.get("status") === "all";
  const docs = db.prepare(`SELECT * FROM documents WHERE template_id = ? AND status IN (${all ? "'approved', 'needs_review'" : "'approved'"}) ORDER BY id`).all(tpl.id) as DocRow[];
  const idField = t.fields.find((f) => f.id) ?? t.fields[0];
  const lines: string[] = [];
  if (what === "documents") {
    lines.push(["Document", "File", "Status", ...t.fields.map((f) => f.label)].map(cell).join(","));
    for (const d of docs) {
      const data = JSON.parse(d.data) as Record<string, Value>;
      lines.push([d.id, d.name, d.status, ...t.fields.map((f) => show(f.type, data[f.key] ?? null))].map(cell).join(","));
    }
  } else {
    lines.push(["Document", idField.label, "Row", ...t.columns.map((c) => c.label)].map(cell).join(","));
    for (const d of docs) {
      const data = JSON.parse(d.data) as Record<string, Value>;
      (JSON.parse(d.rows) as Row[]).forEach((r, i) => lines.push([d.id, show(idField.type, data[idField.key] ?? null), i + 1, ...t.columns.map((c) => show(c.type, r[c.key] ?? null))].map(cell).join(",")));
    }
  }
  const slug = tpl.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return new NextResponse(lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${slug}-${what}.csv"`, "Cache-Control": "no-store" },
  });
}
