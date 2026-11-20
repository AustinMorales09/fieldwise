// Templates (which fields to pull out), value normalization, and the deterministic checks run on every extraction.

export const FIELD_TYPES = ["text", "number", "money", "date", "yesno"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type Field = { key: string; label: string; type: FieldType; required: boolean; id: boolean; hint: string };
export type Column = { key: string; label: string; type: FieldType };
export type Template = { name: string; description: string; fields: Field[]; tableLabel: string; columns: Column[] };
export type Value = string | number | boolean | null;
export type Confidence = "high" | "medium" | "low";
export type Meta = Record<string, { confidence: Confidence; evidence: string | null; evidence_ok: boolean | null }>;
export type Row = Record<string, Value>;
export type Check = { level: "error" | "warn"; field: string | null; message: string };

// ---------- template editor format ----------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

/**
 * One field per line: "Label | type | flags | hint". Type defaults to text; flags are "required" and/or "id"
 * (id = identifies the document, used to spot duplicates). Returns the fields or a line-specific error.
 */
export function parseFieldLines(text: string, forTable = false): { fields: Field[] } | { error: string } {
  const fields: Field[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const [label = "", type = "text", flags = "", ...hint] = line.split("|").map((s) => s.trim());
    const key = slug(label);
    if (!key) return { error: `Line ${i + 1}: give the field a name` };
    if (seen.has(key)) return { error: `Line ${i + 1}: "${label}" is listed twice` };
    const t = (type || "text").toLowerCase().replace(/[^a-z]/g, "");
    const mapped = ({ string: "text", amount: "money", currency: "money", bool: "yesno", boolean: "yesno", checkbox: "yesno", int: "number", integer: "number" } as Record<string, string>)[t] ?? t;
    if (!FIELD_TYPES.includes(mapped as FieldType)) return { error: `Line ${i + 1}: type "${type}" isn't one of ${FIELD_TYPES.join(", ")}` };
    seen.add(key);
    const f = flags.toLowerCase();
    fields.push({ key, label: label.slice(0, 60), type: mapped as FieldType, required: !forTable && /required|\*/.test(f), id: !forTable && /\bid\b|unique/.test(f), hint: hint.join(" | ").slice(0, 200) });
  }
  if (fields.length > (forTable ? 10 : 40)) return { error: `Too many ${forTable ? "columns (max 10)" : "fields (max 40)"}` };
  return { fields };
}

export const fieldLines = (fields: Pick<Field, "label" | "type" | "required" | "id" | "hint">[]) =>
  fields.map((f) => [f.label, f.type, [f.required ? "required" : "", f.id ? "id" : ""].filter(Boolean).join(" "), f.hint].join(" | ").replace(/( \| )+$/, "")).join("\n");

export const STARTERS: { name: string; description: string; fields: string; tableLabel: string; columns: string }[] = [
  {
    name: "Invoice",
    description: "Supplier invoices: who billed, how much, and when it's due",
    fields: "Vendor | text | required | The company that issued the invoice, not the customer\nInvoice number | text | required id\nInvoice date | date | required\nDue date | date\nPO number | text\nSubtotal | money\nTax | money\nTotal | money | required | The final amount due\nCurrency | text | | ISO code such as USD or EUR",
    tableLabel: "Line items",
    columns: "Description | text\nQuantity | number\nUnit price | money\nAmount | money",
  },
  {
    name: "Receipt",
    description: "Expense receipts for reimbursement",
    fields: "Merchant | text | required id\nDate | date | required id\nTotal | money | required id\nTax | money\nPayment method | text | | e.g. Visa ending 4242, cash\nCategory | text | | Meals, travel, lodging, supplies or other",
    tableLabel: "",
    columns: "",
  },
];

// ---------- normalization ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y: number, m: number, d: number) => {
  if (y < 100) y += 2000;
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(s + "T00:00:00Z");
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && dt.getUTCDate() === d && dt.getUTCMonth() === m - 1 ? s : null;
};

/** Many written date forms → YYYY-MM-DD. Slashes are read as month/day/year (US); dots as day.month.year. */
export function toDate(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  let m: RegExpExecArray | null;
  if ((m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s))) return iso(+m[1], +m[2], +m[3]);
  if ((m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(s))) return iso(+m[3], +m[1], +m[2]);
  if ((m = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/.exec(s))) return iso(+m[3], +m[2], +m[1]);
  const mon = `(${MONTHS.join("|")})[a-z]*\\.?`;
  if ((m = new RegExp(`\\b${mon}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`).exec(s))) return iso(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]);
  if ((m = new RegExp(`\\b(\\d{1,2})\\s+${mon},?\\s+(\\d{4})\\b`).exec(s))) return iso(+m[3], MONTHS.indexOf(m[2]) + 1, +m[1]);
  return null;
}

/** "$1,234.50", "1.234,50 €", "(45.00)" → number. */
export function toNumber(raw: string): number | null {
  let s = raw.trim();
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
  s = s.replace(/[^\d.,]/g, "");
  if (!/\d/.test(s)) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 1.234,50 or 12,5
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

export function normalize(type: FieldType, raw: unknown): Value {
  if (raw === null || raw === undefined) return null;
  if (type === "yesno") return typeof raw === "boolean" ? raw : /^(yes|y|true|x|checked|✓|1)$/i.test(String(raw).trim()) ? true : /^(no|n|false|unchecked|0)$/i.test(String(raw).trim()) ? false : null;
  if (type === "number" || type === "money") {
    const n = typeof raw === "number" ? raw : toNumber(String(raw));
    return n === null || !Number.isFinite(n) ? null : type === "money" ? Math.round(n * 100) / 100 : n;
  }
  const s = String(raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return type === "date" ? toDate(s) : s.slice(0, 500);
}

export const show = (type: FieldType, v: Value) =>
  v === null ? "" : type === "money" && typeof v === "number" ? v.toFixed(2) : type === "yesno" ? (v ? "yes" : "no") : String(v);

// ---------- checks ----------

const num = (v: Value | undefined) => (typeof v === "number" ? v : null);
const near = (a: number, b: number) => Math.abs(a - b) <= 0.02;
const fmt = (n: number) => n.toFixed(2);

/**
 * Deterministic checks that don't depend on the model being right: required fields, totals that add up,
 * suspicious dates, low confidence, evidence that wasn't found, and duplicates of earlier documents.
 */
export function runChecks(t: Template, data: Record<string, Value>, rows: Row[], meta: Meta, others: { id: number; data: Record<string, Value> }[], today: string): Check[] {
  const out: Check[] = [];
  for (const f of t.fields) {
    const v = data[f.key] ?? null;
    if (f.required && v === null) out.push({ level: "error", field: f.key, message: `${f.label} is required but wasn't found` });
    const m = meta[f.key];
    if (v !== null && m?.confidence === "low") out.push({ level: "warn", field: f.key, message: `${f.label}: the extraction wasn't confident about this value` });
    if (v !== null && m?.evidence_ok === false) out.push({ level: "warn", field: f.key, message: `${f.label}: the quoted source text wasn't found in the document` });
    if (f.type === "date" && typeof v === "string" && (v < "1990-01-01" || v > `${Number(today.slice(0, 4)) + 2}-12-31`)) out.push({ level: "warn", field: f.key, message: `${f.label} (${v}) looks unlikely` });
  }
  const issued = (data.invoice_date ?? data.date ?? null) as string | null;
  if (typeof data.due_date === "string" && typeof issued === "string" && data.due_date < issued) out.push({ level: "warn", field: "due_date", message: "The due date is before the document date" });

  const subtotal = num(data.subtotal), tax = num(data.tax), total = num(data.total);
  if (subtotal !== null && tax !== null && total !== null && !near(subtotal + tax, total)) out.push({ level: "warn", field: "total", message: `Subtotal ${fmt(subtotal)} + tax ${fmt(tax)} = ${fmt(subtotal + tax)}, but the total says ${fmt(total)}` });
  if (rows.length && t.columns.some((c) => c.key === "amount")) {
    const amounts = rows.map((r) => num(r.amount));
    if (amounts.every((a) => a !== null)) {
      const sum = (amounts as number[]).reduce((s, a) => s + a, 0);
      const target = subtotal ?? (total !== null ? total - (tax ?? 0) : null);
      if (target !== null && !near(sum, target)) out.push({ level: "warn", field: null, message: `${t.tableLabel || "Rows"} add up to ${fmt(sum)}, but the ${subtotal !== null ? "subtotal" : "total before tax"} is ${fmt(target)}` });
    }
    rows.forEach((r, i) => {
      const q = num(r.quantity), p = num(r.unit_price), a = num(r.amount);
      if (q !== null && p !== null && a !== null && !near(q * p, a)) out.push({ level: "warn", field: null, message: `Row ${i + 1}: ${q} × ${fmt(p)} = ${fmt(q * p)}, but the amount says ${fmt(a)}` });
    });
  }
  const ids = t.fields.filter((f) => f.id);
  if (ids.length && ids.every((f) => (data[f.key] ?? null) !== null)) {
    const same = (a: Value, b: Value) => (typeof a === "string" && typeof b === "string" ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b);
    const dup = others.find((o) => ids.every((f) => same(o.data[f.key] ?? null, data[f.key] ?? null)));
    if (dup) out.push({ level: "warn", field: ids[0].key, message: `Possible duplicate of document #${dup.id} (same ${ids.map((f) => f.label.toLowerCase()).join(" + ")})` });
  }
  return out;
}
