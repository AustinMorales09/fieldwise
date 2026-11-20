// Label-matching extraction for when Claude isn't available. It needs the document's text and only finds values
// that sit next to a recognizable label ("Invoice number: INV-204"). Everything it finds is marked for review.

import { normalize, type Field, type Meta, type Row, type Template, type Value } from "./fields";

export type Extraction = { data: Record<string, Value>; meta: Meta; rows: Row[] };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SYNONYMS: Record<string, string[]> = {
  invoice_number: ["invoice no", "invoice #", "invoice num", "inv no", "inv #", "invoice id"],
  invoice_date: ["date of issue", "issue date", "issued", "invoice date", "date"],
  due_date: ["payment due", "due by", "due"],
  po_number: ["po #", "po no", "purchase order", "p.o. number", "po"],
  total: ["amount due", "total due", "balance due", "grand total", "total"],
  subtotal: ["sub total", "sub-total"],
  tax: ["sales tax", "vat", "gst"],
  vendor: ["from", "supplier", "seller", "billed by"],
  merchant: ["store", "sold by"],
  payment_method: ["paid with", "payment", "card"],
  date: ["date"],
};
const VALUE_RE: Partial<Record<Field["type"], RegExp>> = {
  money: /[($€£-]?\s?\d[\d.,]*\d|\d/,
  number: /-?\d[\d.,]*/,
  date: /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2}(?:st|nd|rd|th)? [A-Za-z]{3,9}\.?,? \d{4}/,
};

export function rulesExtract(t: Template, text: string): Extraction {
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const data: Record<string, Value> = {};
  const meta: Meta = {};

  for (const f of t.fields) {
    const labels = [f.label.toLowerCase(), ...(SYNONYMS[f.key] ?? [])].sort((a, b) => b.length - a.length);
    let found: { value: Value; line: string } | null = null;
    // Totals usually come last, so search bottom-up for money; everything else top-down.
    const order = f.type === "money" ? [...lines.keys()].reverse() : [...lines.keys()];
    outer: for (const label of labels) {
      // The label must be a whole word: "total" mustn't match inside "subtotal", nor "po" inside "Poster".
      const re = new RegExp(`(?:^|[^a-z])${esc(label)}(?![a-z])\\s*(?:#|no\\.?|number)?\\s*[:\\-–]?\\s*(.*)$`, "i");
      for (const i of order) {
        const m = re.exec(lines[i]);
        if (!m) continue;
        const rest = m[1].trim() || lines[i + 1] || "";
        const piece = VALUE_RE[f.type] ? VALUE_RE[f.type]!.exec(rest)?.[0] ?? "" : rest.split(/\s{2,}|\s\|\s/)[0];
        const value = normalize(f.type, f.type === "yesno" ? rest.split(" ")[0] : piece);
        if (value !== null) {
          found = { value, line: lines[i] };
          break outer;
        }
      }
    }
    if (!found && /^(vendor|merchant|supplier|company|seller|store)$/.test(f.key) && lines[0]) {
      // Letterhead guess: the first line is usually who issued it.
      data[f.key] = lines[0].slice(0, 120);
      meta[f.key] = { confidence: "low", evidence: lines[0], evidence_ok: true };
      continue;
    }
    data[f.key] = found?.value ?? null;
    if (found) meta[f.key] = { confidence: "medium", evidence: found.line.slice(0, 200), evidence_ok: true };
  }

  // Table rows: "description  qty  unit price  amount" lines, when the template has those columns.
  const rows: Row[] = [];
  const keys = new Set(t.columns.map((c) => c.key));
  if (keys.has("description") && keys.has("amount")) {
    for (const l of lines) {
      const m = /^(.+?)\s+(\d+(?:\.\d+)?)\s+[$€£]?\s?([\d,]+\.\d{2})\s+[$€£]?\s?([\d,]+\.\d{2})$/.exec(l);
      if (!m || /\b(sub\s?total|total|tax|vat|balance|amount due)\b/i.test(m[1])) continue;
      const row: Row = {};
      for (const c of t.columns) row[c.key] = c.key === "description" ? m[1].trim() : c.key === "quantity" ? normalize("number", m[2]) : c.key === "unit_price" ? normalize("money", m[3]) : c.key === "amount" ? normalize("money", m[4]) : null;
      rows.push(row);
    }
  }
  return { data, meta, rows: rows.slice(0, 200) };
}
