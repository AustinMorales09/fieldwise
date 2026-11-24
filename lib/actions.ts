"use server";

import { redirect } from "next/navigation";
import { db, tx, type DocRow } from "./db";
import { createSession, destroySession, hashPassword, verifyPassword } from "./auth";
import { MAX_BYTES, myOrg, ownDoc, ownTemplate, sniff, storeFile } from "./access";
import { normalize, parseFieldLines, runChecks, STARTERS, type Meta, type Row, type Value } from "./fields";
import { processDocument, siblings, toTemplate } from "./process";
import { today } from "./time";
import { documentApproved } from "./integrations";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const q = (m: string) => encodeURIComponent(m);
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return !!tz;
  } catch {
    return false;
  }
};

// ---------- auth & settings ----------

function insertTemplate(orgId: number, s: (typeof STARTERS)[number]) {
  const fields = parseFieldLines(s.fields);
  const cols = parseFieldLines(s.columns, true);
  if ("error" in fields || "error" in cols) throw new Error("Bad starter template");
  db.prepare("INSERT INTO templates (org_id, name, description, fields, table_label, table_cols, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    orgId, s.name, s.description, JSON.stringify(fields.fields), s.tableLabel, JSON.stringify(cols.fields.map(({ key, label, type }) => ({ key, label, type }))), Date.now(),
  );
}

export async function signup(form: FormData) {
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");
  const name = str(form, "name").slice(0, 80);
  const tz = validTz(str(form, "timezone")) ? str(form, "timezone") : "America/New_York";
  if (!name) redirect(`/signup?error=${q("Enter your company name")}`);
  if (!validEmail(email)) redirect(`/signup?error=${q("Enter a valid email")}`);
  if (password.length < 8) redirect(`/signup?error=${q("Password must be at least 8 characters")}`);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) redirect(`/signup?error=${q("That email is already registered")}`);
  const uid = tx(() => {
    const id = Number(db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)").run(email, hashPassword(password), Date.now()).lastInsertRowid);
    const orgId = Number(db.prepare("INSERT INTO orgs (user_id, name, timezone, created_at) VALUES (?, ?, ?, ?)").run(id, name, tz, Date.now()).lastInsertRowid);
    for (const s of STARTERS) insertTemplate(orgId, s);
    return id;
  });
  await createSession(uid);
  redirect("/documents?welcome=1");
}

export async function login(form: FormData) {
  const email = str(form, "email").toLowerCase();
  const user = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email) as { id: number; password_hash: string } | undefined;
  if (!user || !verifyPassword(str(form, "password"), user.password_hash)) redirect(`/login?error=${q("Wrong email or password")}`);
  await createSession(user.id);
  redirect("/documents");
}

export async function logout() {
  await destroySession();
  redirect("/");
}

export async function saveSettings(form: FormData) {
  const org = await myOrg();
  const name = str(form, "name").slice(0, 80);
  const tz = str(form, "timezone");
  if (!name || !validTz(tz)) redirect(`/settings?error=${q("Enter a name and a valid time zone")}`);
  db.prepare("UPDATE orgs SET name = ?, timezone = ?, ai_enabled = ? WHERE id = ?").run(name, tz, form.get("ai_enabled") ? 1 : 0, org.id);
  redirect("/settings?saved=1");
}

// ---------- templates ----------

export async function saveTemplate(form: FormData) {
  const org = await myOrg();
  const id = Number(form.get("template_id")) || null;
  const back = id ? `/templates/${id}` : "/templates/new";
  const name = str(form, "name").slice(0, 60);
  const fields = parseFieldLines(String(form.get("fields") ?? ""));
  const cols = parseFieldLines(String(form.get("columns") ?? ""), true);
  if (!name) redirect(`${back}?error=${q("Name the template")}`);
  if ("error" in fields) redirect(`${back}?error=${q(`Fields: ${fields.error}`)}`);
  if ("error" in cols) redirect(`${back}?error=${q(`Table columns: ${cols.error}`)}`);
  if (!fields.fields.length) redirect(`${back}?error=${q("Add at least one field")}`);
  const vals = [name, str(form, "description").slice(0, 200), JSON.stringify(fields.fields), str(form, "table_label").slice(0, 40), JSON.stringify(cols.fields.map(({ key, label, type }) => ({ key, label, type })))];
  let tid = id;
  if (id) {
    await ownTemplate(id);
    db.prepare("UPDATE templates SET name = ?, description = ?, fields = ?, table_label = ?, table_cols = ? WHERE id = ?").run(...vals, id);
  } else {
    tid = Number(db.prepare("INSERT INTO templates (name, description, fields, table_label, table_cols, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(...vals, org.id, Date.now()).lastInsertRowid);
  }
  redirect(`/templates/${tid}?saved=1`);
}

export async function deleteTemplate(form: FormData) {
  const { tpl } = await ownTemplate(Number(form.get("template_id")));
  const n = (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE template_id = ?").get(tpl.id) as { n: number }).n;
  if (n) redirect(`/templates/${tpl.id}?error=${q(`This template has ${n} document${n > 1 ? "s" : ""}. Delete them first.`)}`);
  db.prepare("DELETE FROM templates WHERE id = ?").run(tpl.id);
  redirect("/templates");
}

// ---------- documents ----------

async function addDocument(orgId: number, templateId: number, name: string, mime: string, bytes: Buffer): Promise<number> {
  const id = Number(db.prepare("INSERT INTO documents (org_id, template_id, name, mime, size, stored_as, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    orgId, templateId, name.replace(/[\\/\0\r\n"]/g, "_").slice(0, 150), mime, bytes.length, storeFile(bytes), Date.now(),
  ).lastInsertRowid);
  try {
    await processDocument(id);
  } catch (err) {
    db.prepare("UPDATE documents SET status = 'failed', error = ? WHERE id = ?").run(err instanceof Error ? err.message.slice(0, 300) : "Extraction failed", id);
  }
  return id;
}

export async function upload(form: FormData) {
  const { org, tpl } = await ownTemplate(Number(form.get("template_id")));
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "size" in f && (f as File).size > 0);
  const pasted = String(form.get("text") ?? "").trim();
  if (!files.length && !pasted) redirect(`/documents?error=${q("Choose files to upload, or paste the document's text")}`);
  if (files.length > 20) redirect(`/documents?error=${q("Upload up to 20 files at a time")}`);
  const skipped: string[] = [];
  const ids: number[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) { skipped.push(`${f.name} (over 10 MB)`); continue; }
    const bytes = Buffer.from(await f.arrayBuffer());
    const mime = sniff(f.name, bytes);
    if (!mime) { skipped.push(`${f.name} (not a PDF, image or text file)`); continue; }
    ids.push(await addDocument(org.id, tpl.id, f.name, mime, bytes));
  }
  if (pasted) ids.push(await addDocument(org.id, tpl.id, str(form, "text_name") || "Pasted text", "text/plain", Buffer.from(pasted.slice(0, 500_000), "utf8")));
  const err = skipped.length ? `&error=${q(`Skipped: ${skipped.join(", ")}`)}` : "";
  redirect(ids.length === 1 && !skipped.length ? `/documents/${ids[0]}` : `/documents?uploaded=${ids.length}${err}`);
}

export async function reextract(form: FormData) {
  const { doc } = await ownDoc(Number(form.get("doc_id")));
  await processDocument(doc.id);
  redirect(`/documents/${doc.id}?reextracted=${Date.now()}`);
}

export async function deleteDoc(form: FormData) {
  const { doc } = await ownDoc(Number(form.get("doc_id")));
  db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
  redirect("/documents");
}

/**
 * Saves a reviewer's corrections and re-runs the checks on the corrected values. Approving is blocked while a
 * required field is empty; warnings (totals that don't add up, possible duplicates) can be approved knowingly.
 */
export async function review(form: FormData) {
  const { org, doc, tpl } = await ownDoc(Number(form.get("doc_id")));
  const t = toTemplate(tpl);
  const intent = str(form, "intent");
  if (intent === "reject") {
    db.prepare("UPDATE documents SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(Date.now(), doc.id);
    redirect("/documents?rejected=1");
  }
  const old = JSON.parse(doc.data) as Record<string, Value>;
  const meta = JSON.parse(doc.meta) as Meta;
  const data: Record<string, Value> = {};
  let edited = doc.edited;
  for (const f of t.fields) {
    const raw = f.type === "yesno" ? str(form, `f_${f.key}`) : String(form.get(`f_${f.key}`) ?? "");
    data[f.key] = normalize(f.type, raw === "" ? null : raw);
    if (data[f.key] !== (old[f.key] ?? null)) {
      delete meta[f.key]; // a human set this value: the model's confidence and evidence no longer apply
      edited = 1;
    }
  }
  const rowCount = Math.min(Number(form.get("row_count")) || 0, 300);
  const rows: Row[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row: Row = Object.fromEntries(t.columns.map((c) => [c.key, normalize(c.type, String(form.get(`r_${i}_${c.key}`) ?? "") || null)]));
    if (Object.values(row).some((v) => v !== null)) rows.push(row);
  }
  if (JSON.stringify(rows) !== doc.rows) edited = 1;
  const checks = runChecks(t, data, rows, meta, siblings(doc), today(org.timezone));
  const blocked = intent === "approve" && checks.some((c) => c.level === "error");
  const status: DocRow["status"] = intent === "approve" && !blocked ? "approved" : doc.status === "approved" ? "needs_review" : doc.status === "rejected" ? "needs_review" : doc.status;
  db.prepare("UPDATE documents SET data = ?, meta = ?, rows = ?, checks = ?, edited = ?, status = ?, reviewed_at = ? WHERE id = ?").run(
    JSON.stringify(data), JSON.stringify(meta), JSON.stringify(rows), JSON.stringify(checks), edited, status, status === "approved" ? Date.now() : null, doc.id,
  );
  if (blocked) redirect(`/documents/${doc.id}?error=${q("Fill in the required fields before approving")}`);
  if (status !== "approved") redirect(`/documents/${doc.id}?saved=${Date.now()}`);
  // Send to connected systems after the response (QuickBooks, Excel). Failures are retried and shown on the Integrations page.
  await documentApproved(org.id, doc.id);
  // After approving, go straight to the next document waiting for review.
  const next = db.prepare("SELECT id FROM documents WHERE org_id = ? AND status = 'needs_review' ORDER BY id LIMIT 1").get(org.id) as { id: number } | undefined;
  redirect(next ? `/documents/${next.id}?approved=${doc.id}` : `/documents?approved=${doc.id}`);
}

// ---------- demo ----------

const DEMO: [string, string, string][] = [
  ["Invoice", "acme-inv-2041.txt", "ACME Supplies Ltd\n14 Dock Road, Portland OR\n\nInvoice Number: INV-2041\nInvoice Date: 11/03/2026\nDue Date: Dec 3, 2026\nPO Number: PO-7781\n\nDescription Qty Unit Price Amount\nWidget A 10 12.50 125.00\nWidget B 4 30.00 120.00\n\nSubtotal: $245.00\nTax: $19.60\nTotal: $264.60"],
  ["Invoice", "northside-print-881.txt", "Northside Print Co.\n\nInvoice #: 881\nDate: November 5, 2026\nDue: November 19, 2026\n\nDescription Qty Unit Price Amount\nBusiness cards 500 0.10 50.00\nPoster A2 20 4.50 90.00\nRush fee 1 25.00 25.00\n\nSubtotal: $165.00\nTax: $13.20\nTotal: $187.20"],
  ["Invoice", "acme-inv-2041-resent.txt", "ACME Supplies Ltd\n\nInvoice Number: INV-2041\nInvoice Date: 11/03/2026\nDue Date: Dec 3, 2026\n\nSubtotal: $245.00\nTax: $19.60\nTotal: $264.60\n\n(Second copy sent by email)"],
  ["Receipt", "lunch-receipt.txt", "Blue Door Cafe\nDate: 11/10/2026\n2 x Lunch special\nTax: $2.10\nTotal: $28.35\nPaid with: Visa ending 4242"],
];

/** Sample text documents, including one whose line items don't add up and one duplicate. */
export async function loadDemo() {
  const org = await myOrg();
  for (const [tplName, name, text] of DEMO) {
    const tpl = db.prepare("SELECT id FROM templates WHERE org_id = ? AND name = ?").get(org.id, tplName) as { id: number } | undefined;
    if (tpl) await addDocument(org.id, tpl.id, name, "text/plain", Buffer.from(text, "utf8"));
  }
  redirect("/documents?uploaded=demo");
}
