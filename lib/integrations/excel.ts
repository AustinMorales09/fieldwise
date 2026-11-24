// Excel on OneDrive / SharePoint through Microsoft Graph: each approved document becomes (or updates) one row in an
// Excel table, one worksheet per template, in a workbook the app creates on first connect.
import { db, type DocRow, type Org, type TemplateRow } from "../db";
import type { Value } from "../fields";
import { toTemplate } from "../process";
import { accessToken, authedJson, getLink, hashOf, http, httpJson, log, registerJob, setLink, settingsOf, toTokens, updateConn, type Conn, type Ctx, type Tokens } from "./core";
import { form, type Provider } from "./provider";
import { buildXlsx, colName, sheetName } from "./xlsx";

export const EXCEL = "excel";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access User.Read Files.ReadWrite";
const tenant = () => process.env.MS_TENANT || "common";
const loginBase = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`;

export type ExcelTable = { sheet: string; tableId: string; columns: string[] };
export type ExcelSettings = { user: string; path: string; itemId: string; webUrl: string; tables: Record<string, ExcelTable> };

async function tokenRequest(ctx: Ctx, f: Record<string, string | undefined>, prev?: Tokens): Promise<Tokens> {
  const live = ctx.mode === "live";
  const body = form({ client_id: live ? process.env.MS_CLIENT_ID : "sandbox", client_secret: live ? process.env.MS_CLIENT_SECRET : "sandbox", scope: SCOPES, ...f });
  const r = await httpJson<{ access_token: string; refresh_token?: string; expires_in: number }>(ctx, `${loginBase()}/token`, {
    method: "POST", body, idempotent: false, headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return toTokens(r, prev);
}

const refresher = (ctx: Ctx) => (t: Tokens) => tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: t.refresh_token }, t);
const graph = <T,>(c: Conn, ctx: Ctx, path: string, init: Parameters<typeof authedJson>[4] = {}) => authedJson<T>(ctx, c, refresher(ctx), `${GRAPH}${path}`, init);
const enc = (s: string) => encodeURIComponent(s).replace(/'/g, "''");

export const excel: Provider = {
  id: EXCEL,
  name: "Excel (Microsoft 365)",
  blurb: "Approved documents land as rows in an Excel table on OneDrive, one sheet per template, updated if you correct them later.",
  env: ["MS_CLIENT_ID", "MS_CLIENT_SECRET"],
  authorizeUrl: (state, challenge, redirectUri) =>
    `${loginBase()}/authorize?${new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID ?? "", response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: SCOPES, state,
      code_challenge: challenge, code_challenge_method: "S256",
    })}`,
  async exchange(ctx, code, redirectUri, verifier) {
    const secret = await tokenRequest(ctx, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    const me = await httpJson<{ userPrincipalName?: string; mail?: string; displayName?: string }>(ctx, `${GRAPH}/me`, { headers: { Authorization: `Bearer ${secret.access_token}` } });
    const user = me.mail || me.userPrincipalName || me.displayName || "Microsoft account";
    return { account: user, secret, settings: { user, path: "Fieldwise/Fieldwise exports.xlsx", itemId: "", webUrl: "", tables: {} } satisfies ExcelSettings };
  },
  async afterConnect(c, ctx) {
    await ensureWorkbook(c, ctx);
  },
};

type DriveItem = { id: string; name: string; webUrl?: string };

/** Finds the workbook, or uploads a new empty one. conflictBehavior=fail keeps an existing file untouched. */
export async function ensureWorkbook(c: Conn, ctx: Ctx): Promise<string> {
  const s = settingsOf<ExcelSettings>(c);
  if (s.itemId) return s.itemId;
  const p = s.path.split("/").map(encodeURIComponent).join("/");
  let item: DriveItem;
  try {
    item = await graph<DriveItem>(c, ctx, `/me/drive/root:/${p}`);
  } catch (err) {
    if (!(err instanceof Error && /^404/.test(err.message))) throw err;
    item = await graph<DriveItem>(c, ctx, `/me/drive/root:/${p}:/content?@microsoft.graph.conflictBehavior=fail`, {
      method: "PUT", body: new Uint8Array(buildXlsx([])), headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    });
    log(c.owner_id, EXCEL, "info", `Created ${s.path} on OneDrive`);
  }
  updateConn(c, { settings: { ...s, itemId: item.id, webUrl: item.webUrl ?? "" } });
  return item.id;
}

export const headerFor = (fieldLabels: string[]) => ["Document #", "File", "Approved", ...fieldLabels];

/** A worksheet and table per template, created the first time one of its documents is sent. */
async function ensureTable(c: Conn, ctx: Ctx, itemId: string, tpl: TemplateRow): Promise<ExcelTable> {
  const s = settingsOf<ExcelSettings>(c);
  if (s.tables[tpl.id]) return s.tables[tpl.id];
  const t = toTemplate(tpl);
  const columns = headerFor(t.fields.map((f) => f.label));
  const taken = new Set(Object.values(s.tables).map((x) => x.sheet.toLowerCase()));
  let sheet = sheetName(t.name);
  if (taken.has(sheet.toLowerCase())) sheet = sheetName(`${t.name.slice(0, 24)} ${tpl.id}`);
  const wb = `/me/drive/items/${itemId}/workbook`;
  try {
    await graph(c, ctx, `${wb}/worksheets/add`, { method: "POST", json: { name: sheet }, idempotent: true });
  } catch (err) {
    if (!(err instanceof Error && /ItemAlreadyExists|already exists/i.test(err.message))) throw err;
  }
  const end = `${colName(columns.length - 1)}1`;
  await graph(c, ctx, `${wb}/worksheets/${enc(sheet)}/range(address='A1:${end}')`, { method: "PATCH", json: { values: [columns] } });
  const table = await graph<{ id: string; name: string }>(c, ctx, `${wb}/worksheets/${enc(sheet)}/tables/add`, { method: "POST", json: { address: `A1:${end}`, hasHeaders: true }, idempotent: false });
  const entry = { sheet, tableId: table.id, columns };
  updateConn(c, { settings: { ...s, tables: { ...s.tables, [tpl.id]: entry } } });
  log(c.owner_id, EXCEL, "info", `Added worksheet "${sheet}" with a table of ${columns.length} columns`);
  return entry;
}

/** Strings Excel would treat as formulas are prefixed with an apostrophe (formula injection). */
export const safeCell = (v: string | number | null): string | number => (v === null ? "" : typeof v === "number" ? v : /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function rowFor(doc: Pick<DocRow, "id" | "name" | "reviewed_at" | "data">, fields: { key: string; type: string }[], tz: string): (string | number)[] {
  const data = JSON.parse(doc.data) as Record<string, Value>;
  const approved = doc.reviewed_at ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(doc.reviewed_at) : "";
  return [doc.id, doc.name, approved, ...fields.map((f) => {
    const v = data[f.key] ?? null;
    return safeCell(v === null ? null : typeof v === "number" ? v : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
  })].map(safeCell);
}

/** Row number (1-based, in sheet terms) of a document in the table's range, from the range's own address. */
export function findRow(range: { address: string; values: unknown[][] }, docId: number): number | null {
  const start = Number(range.address.split("!").pop()!.match(/[A-Z]+(\d+)/)?.[1] ?? 1);
  const i = range.values.findIndex((r, idx) => idx > 0 && Number(r[0]) === docId);
  return i > 0 ? start + i : null;
}

registerJob(EXCEL, "push_doc", async (c, ctx, payload) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ? AND org_id = ?").get(Number(payload.docId), c.owner_id) as DocRow | undefined;
  if (!doc || doc.status !== "approved") return "skipped: not approved";
  const tpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(doc.template_id) as TemplateRow;
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(c.owner_id) as Org;
  const itemId = await ensureWorkbook(c, ctx);
  const table = await ensureTable(c, ctx, itemId, tpl);
  const fields = toTemplate(tpl).fields.slice(0, table.columns.length - 3);
  const values = rowFor(doc, fields, org.timezone);
  const hash = hashOf({ values, table: table.tableId });
  const link = getLink(c.owner_id, EXCEL, "document", doc.id);
  if (link?.hash === hash) return "unchanged";
  // Look the row up by document number every time: people sort and filter the sheet, so positions can't be trusted.
  // This also makes the append idempotent: a retried job finds the row it already added.
  const wb = `/me/drive/items/${itemId}/workbook`;
  const range = await graph<{ address: string; values: unknown[][] }>(c, ctx, `${wb}/tables/${enc(table.tableId)}/range`);
  const row = findRow(range, doc.id);
  if (row) {
    await graph(c, ctx, `${wb}/worksheets/${enc(table.sheet)}/range(address='A${row}:${colName(values.length - 1)}${row}')`, { method: "PATCH", json: { values: [values] } });
  } else {
    await graph(c, ctx, `${wb}/tables/${enc(table.tableId)}/rows/add`, { method: "POST", json: { values: [values] }, idempotent: false });
  }
  setLink(c.owner_id, EXCEL, "document", doc.id, `${table.sheet}#${doc.id}`, hash);
  return row ? `row ${row} on "${table.sheet}" updated` : `row added to "${table.sheet}"`;
});

/** The workbook's current bytes (used to download the simulator's copy). */
export async function workbookBytes(c: Conn, ctx: Ctx): Promise<ArrayBuffer> {
  const itemId = await ensureWorkbook(c, ctx);
  const t = await accessToken(c, refresher(ctx));
  const res = await http(ctx, `${GRAPH}/me/drive/items/${itemId}/content`, { headers: { Authorization: `Bearer ${t}` } });
  return res.arrayBuffer();
}
