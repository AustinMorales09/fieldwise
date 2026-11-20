import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import { requireUser } from "./auth";
import { db, filesDir, type DocRow, type Org, type TemplateRow } from "./db";

export async function myOrg(): Promise<Org> {
  const user = await requireUser();
  return db.prepare("SELECT * FROM orgs WHERE user_id = ?").get(user.id) as Org;
}

export async function ownDoc(id: number) {
  const org = await myOrg();
  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND org_id = ?").get(id, org.id) as DocRow | undefined;
  if (!doc) notFound();
  const tpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(doc.template_id) as TemplateRow;
  return { org, doc, tpl };
}

export async function ownTemplate(id: number) {
  const org = await myOrg();
  const tpl = db.prepare("SELECT * FROM templates WHERE id = ? AND org_id = ?").get(id, org.id) as TemplateRow | undefined;
  if (!tpl) notFound();
  return { org, tpl };
}

const TEXT_EXT = /\.(txt|csv|md|eml|json|tsv|log)$/i;

/** The real type from the file's first bytes (never the browser-supplied one); null = not supported. */
export function sniff(name: string, b: Buffer): string | null {
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  // Text: by extension, and only if it really decodes as text (no NUL bytes).
  if (TEXT_EXT.test(name) && !b.subarray(0, 4000).includes(0)) return "text/plain";
  return null;
}

export const MAX_BYTES = 10 * 1024 * 1024;

export function storeFile(bytes: Buffer): string {
  const storedAs = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(filesDir, storedAs), bytes);
  return storedAs;
}
