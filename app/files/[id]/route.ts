import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { db, filesDir, type DocRow } from "@/lib/db";

// The stored type comes from the file's own bytes (see sniff), so "inline" is only ever a real PDF or image.
// Those can't run script in our origin; everything else is sent as a download.
const INLINE_OK = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getUser();
  const d = user ? (db.prepare("SELECT d.* FROM documents d JOIN orgs o ON o.id = d.org_id WHERE d.id = ? AND o.user_id = ?").get(Number(id), user.id) as DocRow | undefined) : undefined;
  if (!d) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const p = path.join(filesDir, d.stored_as);
  if (!fs.existsSync(p)) return NextResponse.json({ error: "Missing" }, { status: 404 });
  const inline = req.nextUrl.searchParams.get("inline") === "1" && INLINE_OK.has(d.mime);
  return new NextResponse(Readable.toWeb(fs.createReadStream(p)) as ReadableStream, {
    headers: {
      "Content-Type": inline ? d.mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${d.name.replace(/[^\x20-\x7e]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff",
      // A sandbox CSP stops the browser's PDF viewer from rendering, so verified inline PDFs go without it.
      ...(inline && d.mime === "application/pdf" ? {} : { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" }),
      "Cache-Control": "private, no-store",
    },
  });
}
