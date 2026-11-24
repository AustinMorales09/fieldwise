// Simulated Microsoft identity platform + Graph (OneDrive items and the Excel workbook API) for the calls Fieldwise makes.
import { registerSimulator, sbAuthorized, sbGet, sbIssueTokens, sbList, sbPut, sbRefreshTokens, type SbRes } from "./sandbox";
import { buildXlsx, colName } from "./xlsx";

const P = "excel";
type Cells = (string | number)[][];
type Table = { id: string; name: string; sheet: string; cols: number; rows: number };
type Workbook = { id: string; name: string; path: string; webUrl: string; sheets: Record<string, Cells>; tables: Table[] };

const err = (status: number, code: string, message: string): SbRes => ({ status, json: { error: { code, message } } });
const colIndex = (letters: string) => letters.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

registerSimulator("login.microsoftonline.com", (req, owner) => {
  if (!req.url.pathname.endsWith("/oauth2/v2.0/token")) return err(404, "not_found", "Unknown endpoint");
  const f = new URLSearchParams(req.body);
  if (!f.get("client_id") || !f.get("client_secret")) return { status: 401, json: { error: "invalid_client" } };
  if (f.get("grant_type") === "authorization_code") {
    if (!f.get("code")?.startsWith("sbx_code_") || !f.get("code_verifier")) return { status: 400, json: { error: "invalid_grant", error_description: "AADSTS54005: code or PKCE verifier invalid" } };
    return { json: { ...sbIssueTokens(P, owner, 3600), scope: f.get("scope") } };
  }
  if (f.get("grant_type") === "refresh_token") {
    const t = sbRefreshTokens(P, owner, f.get("refresh_token") ?? "", true);
    return t ? { json: t } : { status: 400, json: { error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired" } };
  }
  return { status: 400, json: { error: "unsupported_grant_type" } };
});

registerSimulator("graph.microsoft.com", (req, owner) => {
  if (!sbAuthorized(req, P, owner)) return err(401, "InvalidAuthenticationToken", "Access token has expired or is not yet valid.");
  const path = decodeURIComponent(req.url.pathname.replace(/^\/v1\.0/, ""));
  if (path === "/me") return { json: { displayName: "Sandbox User", userPrincipalName: "sandbox.user@contoso.onmicrosoft.com", mail: "sandbox.user@contoso.onmicrosoft.com" } };

  const byPath = path.match(/^\/me\/drive\/root:\/(.+?)(:\/content)?:?$/);
  if (byPath) {
    const filePath = byPath[1].replace(/:$/, "");
    const existing = sbList<Workbook>(P, owner, "workbook").find((w) => w.path === filePath);
    if (req.method === "GET" && !byPath[2]) return existing ? { json: { id: existing.id, name: existing.name, webUrl: existing.webUrl } } : err(404, "itemNotFound", "The resource could not be found.");
    if (req.method === "PUT" && byPath[2]) {
      if (existing && req.url.searchParams.get("@microsoft.graph.conflictBehavior") === "fail") return err(409, "nameAlreadyExists", "The specified item name already exists.");
      if (!req.body.startsWith("PK")) return err(400, "invalidRequest", "Not a valid workbook");
      const id = existing?.id ?? `01SBX${Date.now().toString(36).toUpperCase()}`;
      const wb: Workbook = { id, name: filePath.split("/").pop()!, path: filePath, webUrl: "", sheets: { Sheet1: [] }, tables: [] };
      sbPut(P, owner, "workbook", id, wb);
      return { status: 201, json: { id, name: wb.name, webUrl: "" } };
    }
  }

  const item = path.match(/^\/me\/drive\/items\/([^/]+)(\/.*)?$/);
  if (!item) return err(400, "BadRequest", `Unsupported ${req.method} ${path}`);
  const wb = sbGet<Workbook>(P, owner, "workbook", item[1]);
  if (!wb) return err(404, "itemNotFound", "The resource could not be found.");
  const rest = item[2] ?? "";
  const save = () => sbPut(P, owner, "workbook", wb.id, wb);

  if (rest === "/content" && req.method === "GET") {
    return { bytes: new Uint8Array(buildXlsx(Object.entries(wb.sheets).map(([name, rows]) => ({ name, rows })))), headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } };
  }
  if (rest === "/workbook/worksheets/add" && req.method === "POST") {
    const { name } = req.json<{ name: string }>();
    if (Object.keys(wb.sheets).some((s) => s.toLowerCase() === name.toLowerCase())) return err(409, "ItemAlreadyExists", "A worksheet with the same name already exists.");
    wb.sheets[name] = [];
    save();
    return { status: 201, json: { id: `{${name}}`, name } };
  }
  const rangePatch = rest.match(/^\/workbook\/worksheets\/(.+?)\/range\(address='([A-Z]+)(\d+):([A-Z]+)(\d+)'\)$/);
  if (rangePatch && req.method === "PATCH") {
    const [, sheet, c1, r1, c2] = rangePatch;
    const cells = wb.sheets[sheet.replace(/''/g, "'")];
    if (!cells) return err(404, "ItemNotFound", "The requested resource doesn't exist.");
    const { values } = req.json<{ values: Cells }>();
    if (values[0]?.length !== colIndex(c2) - colIndex(c1) + 1) return err(400, "InvalidArgument", "The number of rows or columns in the input array doesn't match the size or dimensions of the range.");
    values.forEach((row, i) => { cells[Number(r1) - 1 + i] = row; });
    save();
    return { json: { address: `${sheet}!${c1}${r1}:${c2}${Number(r1) + values.length - 1}`, values } };
  }
  const tableAdd = rest.match(/^\/workbook\/worksheets\/(.+?)\/tables\/add$/);
  if (tableAdd && req.method === "POST") {
    const sheet = tableAdd[1].replace(/''/g, "'");
    if (!wb.sheets[sheet]) return err(404, "ItemNotFound", "The requested resource doesn't exist.");
    const { address, hasHeaders } = req.json<{ address: string; hasHeaders: boolean }>();
    const m = address.match(/^([A-Z]+)1:([A-Z]+)1$/);
    if (!m || !hasHeaders) return err(400, "InvalidArgument", "Expected a header row address like A1:F1");
    const t: Table = { id: `{SBX-TABLE-${wb.tables.length + 1}}`, name: `Table${wb.tables.length + 1}`, sheet, cols: colIndex(m[2]) + 1, rows: 0 };
    wb.tables.push(t);
    save();
    return { status: 201, json: { id: t.id, name: t.name } };
  }
  const tbl = rest.match(/^\/workbook\/tables\/(.+?)\/(range|rows\/add)$/);
  if (tbl) {
    const t = wb.tables.find((x) => x.id === tbl[1] || x.name === tbl[1]);
    if (!t) return err(404, "ItemNotFound", "The requested resource doesn't exist.");
    const cells = wb.sheets[t.sheet];
    if (tbl[2] === "range" && req.method === "GET") {
      const values = cells.slice(0, t.rows + 1).map((r) => Array.from({ length: t.cols }, (_, i) => r?.[i] ?? ""));
      return { json: { address: `${t.sheet}!A1:${colName(t.cols - 1)}${t.rows + 1}`, values } };
    }
    if (tbl[2] === "rows/add" && req.method === "POST") {
      const { values } = req.json<{ values: Cells }>();
      if (values.some((r) => r.length !== t.cols)) return err(400, "InvalidArgument", "The number of columns doesn't match the table.");
      for (const r of values) cells[++t.rows] = r;
      save();
      return { status: 201, json: { index: t.rows - 1, values } };
    }
  }
  return err(400, "BadRequest", `Unsupported ${req.method} ${rest}`);
});

export const simWorkbooks = (owner: number) => sbList<Workbook>(P, owner, "workbook");
