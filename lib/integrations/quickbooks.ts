// QuickBooks Online: approved supplier invoices become Bills (accounts payable), with the vendor found or created.
// OAuth 2.0 authorization code flow; access tokens last an hour and refresh tokens rotate on every refresh.
import { db, type DocRow, type TemplateRow } from "../db";
import type { Row, Value } from "../fields";
import { ApiError, authedJson, getLink, hashOf, httpJson, log, registerJob, setLink, settingsOf, toTokens, updateConn, type Conn, type Ctx, type Tokens } from "./core";
import { basic, form, type Provider } from "./provider";

export const QBO = "quickbooks";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const MINOR = "75";

export type QboSettings = { realmId: string; company: string; accountId: string; accounts: { id: string; name: string }[]; templates: string[]; env: "sandbox" | "production" };

/** Intuit's sandbox companies and production companies live on different hosts. Default to Intuit's sandbox. */
const apiBase = (s: Pick<QboSettings, "env">) => (s.env === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com");

const creds = () => ({ id: process.env.QBO_CLIENT_ID ?? "", secret: process.env.QBO_CLIENT_SECRET ?? "" });

async function tokenRequest(ctx: Ctx, body: URLSearchParams, prev?: Tokens): Promise<Tokens> {
  const { id, secret } = ctx.mode === "sandbox" ? { id: "sandbox", secret: "sandbox" } : creds();
  const r = await httpJson<{ access_token: string; refresh_token: string; expires_in: number }>(ctx, TOKEN_URL, {
    method: "POST", body, idempotent: false, headers: { Authorization: basic(id, secret), "Content-Type": "application/x-www-form-urlencoded" },
  });
  return toTokens(r, prev);
}

const refresher = (ctx: Ctx) => (t: Tokens) => tokenRequest(ctx, form({ grant_type: "refresh_token", refresh_token: t.refresh_token }), t);

export const quickbooks: Provider = {
  id: QBO,
  name: "QuickBooks Online",
  blurb: "Approved invoices become Bills in QuickBooks, under the right vendor, ready to pay.",
  env: ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET"],
  authorizeUrl: (state, _challenge, redirectUri) =>
    `${AUTH_URL}?${new URLSearchParams({ client_id: creds().id, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: redirectUri, state })}`,
  async exchange(ctx, code, redirectUri, _verifier, params) {
    const realmId = params.get("realmId") ?? "";
    if (!/^[\w-]{1,40}$/.test(realmId)) throw new Error("QuickBooks didn't say which company was connected");
    const secret = await tokenRequest(ctx, form({ grant_type: "authorization_code", code, redirect_uri: redirectUri }));
    const env = ctx.mode === "live" && process.env.QBO_ENV === "production" ? "production" : "sandbox";
    const info = await httpJson<{ CompanyInfo?: { CompanyName?: string } }>(ctx, `${apiBase({ env })}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=${MINOR}`, {
      headers: { Authorization: `Bearer ${secret.access_token}` },
    });
    const company = info.CompanyInfo?.CompanyName ?? `Company ${realmId}`;
    return { account: company, secret, settings: { realmId, company, env, accountId: "", accounts: [], templates: ["Invoice"] } satisfies QboSettings };
  },
  async afterConnect(c, ctx) {
    await loadAccounts(c, ctx);
  },
};

// ---------- API helpers ----------

const api = (c: Conn, ctx: Ctx, pathAndQuery: string, init: Parameters<typeof authedJson>[4] = {}) => {
  const s = settingsOf<QboSettings>(c);
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  return authedJson<Record<string, unknown>>(ctx, c, refresher(ctx), `${apiBase(s)}/v3/company/${s.realmId}/${pathAndQuery}${sep}minorversion=${MINOR}`, init);
};

/** QuickBooks query language: strings are single-quoted, with \ and ' escaped by a backslash. */
export const qstr = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function query<T>(c: Conn, ctx: Ctx, entity: string, sql: string): Promise<T[]> {
  const r = await api(c, ctx, `query?query=${encodeURIComponent(sql)}`);
  return ((r.QueryResponse as Record<string, unknown> | undefined)?.[entity] as T[] | undefined) ?? [];
}

export async function loadAccounts(c: Conn, ctx: Ctx) {
  const rows = await query<{ Id: string; Name: string; Active?: boolean }>(c, ctx, "Account", "select * from Account where AccountType = 'Expense' MAXRESULTS 200");
  const s = settingsOf<QboSettings>(c);
  const accounts = rows.filter((a) => a.Active !== false).map((a) => ({ id: a.Id, name: a.Name })).sort((a, b) => a.name.localeCompare(b.name));
  const keep = accounts.some((a) => a.id === s.accountId) ? s.accountId : (accounts.find((a) => /supplies|office|expense/i.test(a.name)) ?? accounts[0])?.id ?? "";
  updateConn(c, { settings: { ...s, accounts, accountId: keep } });
  log(c.owner_id, QBO, "info", `Loaded ${accounts.length} expense accounts`);
}

// ---------- mapping ----------

const pick = (d: Record<string, Value>, ...keys: string[]) => keys.map((k) => d[k]).find((v) => v !== null && v !== undefined && v !== "") ?? null;
const num = (v: Value | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r2 = (n: number) => Math.round(n * 100) / 100;

export type BillDraft = { vendor: string; bill: Record<string, unknown>; note: string | null };

/**
 * Builds the Bill. Line items are used when they add up to the total (with tax as its own line); otherwise the bill
 * gets one line for the approved total, so QuickBooks never disagrees with what the reviewer approved.
 */
export function mapBill(docId: number, data: Record<string, Value>, rows: Row[], accountId: string): BillDraft {
  const vendor = String(pick(data, "vendor", "merchant", "supplier") ?? "").trim();
  const total = num(pick(data, "total", "amount_due"));
  if (!vendor) throw new MappingError("The document has no vendor");
  if (total === null || total <= 0) throw new MappingError("The document has no positive total");
  if (!accountId) throw new MappingError("Choose an expense account on the Integrations page");
  const acct = { AccountRef: { value: accountId } };
  const line = (amount: number, description: string) => ({ DetailType: "AccountBasedExpenseLineDetail", Amount: r2(amount), Description: description.slice(0, 4000), AccountBasedExpenseLineDetail: acct });
  const items = rows.filter((r) => num(r.amount) !== null && num(r.amount) !== 0);
  const tax = num(data.tax) ?? 0;
  let lines = items.map((r) => line(num(r.amount)!, [r.description, num(r.quantity) !== null && num(r.unit_price) !== null ? `(${r.quantity} × ${num(r.unit_price)!.toFixed(2)})` : null].filter(Boolean).join(" ") || "Item"));
  if (tax > 0) lines.push(line(tax, "Tax"));
  let note: string | null = null;
  const sum = r2(lines.reduce((s, l) => s + l.Amount, 0));
  if (!items.length || Math.abs(sum - total) > 0.01) {
    if (items.length) note = `Line items (${sum.toFixed(2)}) don't add up to the total (${total.toFixed(2)}); sent as one line`;
    lines = [line(total, `Invoice ${pick(data, "invoice_number") ?? ""}`.trim())];
  }
  const docNumber = String(pick(data, "invoice_number", "number") ?? "").slice(0, 21) || undefined;
  const txnDate = pick(data, "invoice_date", "date");
  const due = pick(data, "due_date");
  const currency = String(pick(data, "currency") ?? "").toUpperCase();
  const po = pick(data, "po_number");
  const bill: Record<string, unknown> = {
    Line: lines,
    ...(docNumber ? { DocNumber: docNumber } : {}),
    ...(typeof txnDate === "string" ? { TxnDate: txnDate } : {}),
    ...(typeof due === "string" ? { DueDate: due } : {}),
    ...(/^[A-Z]{3}$/.test(currency) && currency !== "USD" ? { CurrencyRef: { value: currency } } : {}),
    PrivateNote: [`From Fieldwise document #${docId}`, po ? `PO ${po}` : null, note].filter(Boolean).join(". ").slice(0, 4000),
  };
  return { vendor: vendor.replace(/:/g, " ").slice(0, 100), bill, note };
}

/** Data that will never succeed as-is: the job fails right away instead of retrying. */
export class MappingError extends ApiError {
  constructor(message: string) {
    super(422, message, "https://quickbooks.local");
    this.message = message;
  }
}

// ---------- jobs ----------

async function vendorId(c: Conn, ctx: Ctx, name: string): Promise<string> {
  const key = name.toLowerCase();
  const linked = getLink(c.owner_id, QBO, "vendor", key);
  if (linked) return linked.remote_id;
  const found = await query<{ Id: string }>(c, ctx, "Vendor", `select * from Vendor where DisplayName = ${qstr(name)}`);
  let id = found[0]?.Id;
  if (!id) {
    try {
      const r = await api(c, ctx, "vendor", { method: "POST", json: { DisplayName: name }, idempotent: false });
      id = (r.Vendor as { Id: string }).Id;
      log(c.owner_id, QBO, "info", `Created vendor "${name}"`);
    } catch (err) {
      // Created by someone else between our query and our insert (QuickBooks error 6240: duplicate name).
      if (err instanceof ApiError && err.status === 400 && /6240|Duplicate/i.test(err.body)) {
        id = (await query<{ Id: string }>(c, ctx, "Vendor", `select * from Vendor where DisplayName = ${qstr(name)}`))[0]?.Id;
      }
      if (!id) throw err;
    }
  }
  setLink(c.owner_id, QBO, "vendor", key, id);
  return id;
}

registerJob(QBO, "push_doc", async (c, ctx, payload) => {
  const docId = Number(payload.docId);
  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND org_id = ?").get(docId, c.owner_id) as DocRow | undefined;
  if (!doc || doc.status !== "approved") return "skipped: not approved";
  const tpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(doc.template_id) as TemplateRow;
  const s = settingsOf<QboSettings>(c);
  if (!s.templates.includes(tpl.name)) return `skipped: "${tpl.name}" documents aren't sent to QuickBooks`;
  const draft = mapBill(doc.id, JSON.parse(doc.data), JSON.parse(doc.rows), s.accountId);
  const vid = await vendorId(c, ctx, draft.vendor);
  const bill: Record<string, unknown> = { ...draft.bill, VendorRef: { value: vid } };
  const hash = hashOf(bill);
  const link = getLink(c.owner_id, QBO, "document", doc.id);
  if (link?.hash === hash) return `unchanged (bill ${link.remote_id})`;

  if (link) {
    // Full update: QuickBooks needs the current SyncToken (optimistic locking); on a stale token, re-read and retry once.
    for (let i = 0; ; i++) {
      const cur = (await api(c, ctx, `bill/${link.remote_id}`)).Bill as { Id: string; SyncToken: string };
      try {
        await api(c, ctx, "bill", { method: "POST", json: { ...bill, Id: cur.Id, SyncToken: cur.SyncToken }, idempotent: true });
        break;
      } catch (err) {
        if (i === 0 && err instanceof ApiError && err.status === 400 && /5010|stale/i.test(err.body)) continue;
        throw err;
      }
    }
    setLink(c.owner_id, QBO, "document", doc.id, link.remote_id, hash);
    return `Bill ${link.remote_id} updated${draft.note ? ` (${draft.note})` : ""}`;
  }

  // Same vendor + invoice number already in QuickBooks (entered by hand, or by an earlier connection): link, don't duplicate.
  if (bill.DocNumber) {
    const same = (await query<{ Id: string; VendorRef: { value: string } }>(c, ctx, "Bill", `select * from Bill where DocNumber = ${qstr(String(bill.DocNumber))}`)).find((b) => b.VendorRef?.value === vid);
    if (same) {
      setLink(c.owner_id, QBO, "document", doc.id, same.Id, "");
      log(c.owner_id, QBO, "warn", `Document #${doc.id}: bill ${bill.DocNumber} was already in QuickBooks (${same.Id}); linked instead of creating a duplicate`);
      return `already in QuickBooks as bill ${same.Id}; linked`;
    }
  }
  // requestid makes the create idempotent on Intuit's side, so a retry after a timeout can't create two bills.
  const requestId = `fw-${c.owner_id}-${doc.id}-${doc.reviewed_at ?? 0}`;
  const r = await api(c, ctx, `bill?requestid=${encodeURIComponent(requestId)}`, { method: "POST", json: bill, idempotent: true });
  const id = (r.Bill as { Id: string }).Id;
  setLink(c.owner_id, QBO, "document", doc.id, id, hash);
  return `Bill ${id} created${draft.note ? ` (${draft.note})` : ""}`;
});

export const billUrl = (c: Conn, billId: string) =>
  c.mode === "sandbox" ? null : `https://app.${settingsOf<QboSettings>(c).env === "production" ? "" : "sandbox."}qbo.intuit.com/app/bill?txnId=${encodeURIComponent(billId)}`;
