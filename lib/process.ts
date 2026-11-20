import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { db, filesDir, type DocRow, type Org, type TemplateRow } from "./db";
import { AiUnavailable, claudeExtract } from "./claude";
import { normalize, runChecks, type Column, type Field, type Meta, type Row, type Template, type Value } from "./fields";
import { pdfText } from "./pdftext";
import { rulesExtract } from "./rules";
import { today } from "./time";

const g = globalThis as unknown as { __aiDown?: { until: number; reason: string } };

export function aiStatus(org: Pick<Org, "ai_enabled">): { mode: "claude" | "rules"; reason: string } {
  if (process.env.EXTRACT_AI === "off") return { mode: "rules", reason: "AI is turned off on this server (EXTRACT_AI=off)" };
  if (!org.ai_enabled) return { mode: "rules", reason: "AI is turned off in Settings" };
  if (g.__aiDown && g.__aiDown.until > Date.now()) return { mode: "rules", reason: `Claude isn't available: ${g.__aiDown.reason}` };
  return { mode: "claude", reason: "" };
}

export const toTemplate = (r: TemplateRow): Template => ({
  name: r.name, description: r.description, fields: JSON.parse(r.fields) as Field[], tableLabel: r.table_label, columns: JSON.parse(r.table_cols) as Column[],
});

const squash = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
export const isTextMime = (mime: string) => mime.startsWith("text/") || mime === "message/rfc822" || mime === "application/json";

/** Other documents of the same template that count for duplicate detection. */
export function siblings(doc: Pick<DocRow, "id" | "template_id">) {
  return (db.prepare("SELECT id, data FROM documents WHERE template_id = ? AND id != ? AND status IN ('needs_review', 'approved')").all(doc.template_id, doc.id) as { id: number; data: string }[])
    .map((o) => ({ id: o.id, data: JSON.parse(o.data) as Record<string, Value> }));
}

/**
 * Extracts a document with Claude (or the label-matching fallback), normalizes the values, verifies evidence
 * against the document text when we have it, runs the checks, and stores the result for review.
 */
export async function processDocument(docId: number, opts: { client?: Anthropic } = {}): Promise<{ status: DocRow["status"]; source: string; error: string | null }> {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as DocRow;
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(doc.org_id) as Org;
  const t = toTemplate(db.prepare("SELECT * FROM templates WHERE id = ?").get(doc.template_id) as TemplateRow);
  const bytes = fs.readFileSync(path.join(filesDir, doc.stored_as));
  const text = doc.text || (isTextMime(doc.mime) ? bytes.toString("utf8") : doc.mime === "application/pdf" ? pdfText(bytes) : "");
  const finish = (status: DocRow["status"], source: string, error: string | null, extra: { data?: object; meta?: object; rows?: object; checks?: object } = {}) => {
    db.prepare("UPDATE documents SET text = ?, status = ?, source = ?, error = ?, data = ?, meta = ?, rows = ?, checks = ?, edited = 0, reviewed_at = NULL WHERE id = ?").run(
      text, status, source, error, JSON.stringify(extra.data ?? {}), JSON.stringify(extra.meta ?? {}), JSON.stringify(extra.rows ?? []), JSON.stringify(extra.checks ?? []), doc.id,
    );
    return { status, source, error };
  };

  let data: Record<string, Value> = {};
  let meta: Meta = {};
  let rows: Row[] = [];
  let source: "claude" | "rules" = "rules";
  let error: string | null = null;
  let useRules = true;

  if (opts.client || aiStatus(org).mode === "claude") {
    try {
      const raw = await claudeExtract(t, { name: doc.name, mime: doc.mime, bytes, text }, opts.client);
      for (const f of t.fields) {
        const r = raw.fields[f.key];
        data[f.key] = normalize(f.type, r?.value ?? null);
        if (r && data[f.key] !== null) {
          // Evidence can only be verified when we have the document's text (text files, simple PDFs).
          const ok = !r.evidence ? null : text ? squash(text).includes(squash(r.evidence)) : null;
          meta[f.key] = { confidence: r.confidence, evidence: r.evidence ? r.evidence.slice(0, 200) : null, evidence_ok: ok };
        }
      }
      rows = raw.rows.slice(0, 200).map((r) => Object.fromEntries(t.columns.map((c) => [c.key, normalize(c.type, r[c.key] ?? null)])));
      source = "claude";
      useRules = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof AiUnavailable) g.__aiDown = { until: Date.now() + 10 * 60_000, reason: /resolve authentication/i.test(msg) ? "no Anthropic API credentials found on this server" : msg.slice(0, 160) };
      else error = `Claude couldn't read this (${msg.slice(0, 200)})`;
    }
  }
  if (useRules) {
    // Label matching needs text. Photos, scans and complex PDFs can't be read without the model.
    if (!text) return finish(error ? "failed" : "needs_ai", "", error ?? "This file has no readable text layer (a photo, scan or complex PDF). It needs Claude to be read.");
    ({ data, meta, rows } = rulesExtract(t, text));
    if (error) error += "; used label matching instead";
  }
  const checks = runChecks(t, data, rows, meta, siblings(doc), today(org.timezone));
  return finish("needs_review", source, error, { data, meta, rows, checks });
}
