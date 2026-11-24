// Simulated QuickBooks Online: token endpoint, company info, query, vendors and bills, with QuickBooks' validation,
// SyncToken locking, duplicate-name errors and requestid idempotency.
import { registerSimulator, sbAuthorized, sbGet, sbIssueTokens, sbList, sbNextId, sbPut, sbRefreshTokens, type SbReq, type SbRes } from "./sandbox";

const P = "quickbooks";
const fault = (status: number, code: string, message: string, detail = message): SbRes => ({ status, json: { Fault: { Error: [{ Message: message, Detail: detail, code }], type: "ValidationFault" }, time: new Date().toISOString() } });

type Bill = { Id: string; SyncToken: string; VendorRef: { value: string; name?: string }; Line: { Amount: number; Description?: string }[]; TotalAmt: number; DocNumber?: string; TxnDate?: string; DueDate?: string; PrivateNote?: string; MetaData: { CreateTime: string; LastUpdatedTime: string } };
type Vendor = { Id: string; DisplayName: string; SyncToken: string; Active: boolean };

const ACCOUNTS = [
  { Id: "7", Name: "Advertising", AccountType: "Expense", Active: true },
  { Id: "13", Name: "Meals and Entertainment", AccountType: "Expense", Active: true },
  { Id: "15", Name: "Office Expenses", AccountType: "Expense", Active: true },
  { Id: "20", Name: "Supplies", AccountType: "Expense", Active: true },
  { Id: "24", Name: "Job Expenses", AccountType: "Expense", Active: true },
];

registerSimulator("oauth.platform.intuit.com", (req, owner) => {
  const f = new URLSearchParams(req.body);
  if (!/^Basic /.test(req.headers.get("authorization") ?? "")) return { status: 401, json: { error: "invalid_client" } };
  if (f.get("grant_type") === "authorization_code") {
    return f.get("code")?.startsWith("sbx_code_") ? { json: { ...sbIssueTokens(P, owner, 3600), x_refresh_token_expires_in: 8_726_400 } } : { status: 400, json: { error: "invalid_grant" } };
  }
  if (f.get("grant_type") === "refresh_token") {
    const t = sbRefreshTokens(P, owner, f.get("refresh_token") ?? "", true);
    return t ? { json: { ...t, x_refresh_token_expires_in: 8_726_400 } } : { status: 400, json: { error: "invalid_grant" } };
  }
  return { status: 400, json: { error: "unsupported_grant_type" } };
});

function api(req: SbReq, owner: number): SbRes {
  if (!sbAuthorized(req, P, owner)) return { status: 401, json: { fault: { error: [{ message: "message=AuthenticationFailed; errorCode=003200; statusCode=401", code: "3200" }] } } };
  const m = req.url.pathname.match(/^\/v3\/company\/([\w-]+)\/(.+)$/);
  if (!m) return fault(404, "610", "Object Not Found");
  const [, realm, rest] = m;
  const now = new Date().toISOString();
  const wrap = (o: Record<string, unknown>) => ({ json: { ...o, time: now } });

  if (rest.startsWith("companyinfo/")) return wrap({ CompanyInfo: { CompanyName: "Sandbox Company_US_1", Id: realm } });

  if (rest === "query") {
    const q = req.url.searchParams.get("query") ?? "";
    const ent = q.match(/from\s+(\w+)/i)?.[1] ?? "";
    const where = [...q.matchAll(/(\w+)\s*=\s*'((?:\\.|[^'\\])*)'/g)].map(([, k, v]) => [k, v.replace(/\\(.)/g, "$1")] as const);
    const match = (o: Record<string, unknown>) => where.every(([k, v]) => String(o[k] ?? "") === v);
    const all = ent === "Account" ? ACCOUNTS : ent === "Vendor" ? sbList<Vendor>(P, owner, "Vendor") : ent === "Bill" ? sbList<Bill>(P, owner, "Bill") : null;
    if (!all) return fault(400, "4000", "Error parsing query", `Unknown entity ${ent}`);
    const rows = (all as Record<string, unknown>[]).filter(match);
    return wrap({ QueryResponse: rows.length ? { [ent]: rows, startPosition: 1, maxResults: rows.length } : {} });
  }

  if (rest === "vendor" && req.method === "POST") {
    const v = req.json<{ DisplayName?: string }>();
    const name = (v.DisplayName ?? "").trim();
    if (!name) return fault(400, "2020", "Required param missing, need to supply the required value for the API", "DisplayName is required");
    if (sbList<Vendor>(P, owner, "Vendor").some((x) => x.DisplayName.toLowerCase() === name.toLowerCase())) return fault(400, "6240", "Duplicate Name Exists Error", `The name supplied already exists. : ${name}`);
    const vendor: Vendor = { Id: String(sbNextId(P, owner, "Vendor", 55)), DisplayName: name, SyncToken: "0", Active: true };
    sbPut(P, owner, "Vendor", vendor.Id, vendor);
    return wrap({ Vendor: vendor });
  }

  const bm = rest.match(/^bill(?:\/(\d+))?$/);
  if (bm && req.method === "GET" && bm[1]) {
    const b = sbGet<Bill>(P, owner, "Bill", bm[1]);
    return b ? wrap({ Bill: b }) : fault(400, "610", "Object Not Found", `Bill ${bm[1]} not found`);
  }
  if (bm && req.method === "POST") {
    const rid = req.url.searchParams.get("requestid");
    if (rid) {
      const prior = sbGet<SbRes>(P, owner, "_request", rid);
      if (prior) return prior;
    }
    const b = req.json<Partial<Bill> & { Id?: string; SyncToken?: string }>();
    const vendor = b.VendorRef?.value ? sbGet<Vendor>(P, owner, "Vendor", b.VendorRef.value) : undefined;
    if (!vendor) return fault(400, "2500", "Invalid Reference Id", "VendorRef is missing or invalid");
    if (!Array.isArray(b.Line) || !b.Line.length) return fault(400, "2020", "Required param missing, need to supply the required value for the API", "Line is required");
    for (const l of b.Line as Record<string, unknown>[]) {
      const acct = (l.AccountBasedExpenseLineDetail as { AccountRef?: { value?: string } } | undefined)?.AccountRef?.value;
      if (typeof l.Amount !== "number" || l.DetailType !== "AccountBasedExpenseLineDetail" || !ACCOUNTS.some((a) => a.Id === acct)) return fault(400, "2050", "Invalid line", "Each line needs an Amount and a valid expense AccountRef");
    }
    const total = Math.round(b.Line.reduce((s, l) => s + (l.Amount ?? 0), 0) * 100) / 100;
    let out: SbRes;
    if (b.Id) {
      const cur = sbGet<Bill>(P, owner, "Bill", b.Id);
      if (!cur) return fault(400, "610", "Object Not Found");
      if (cur.SyncToken !== b.SyncToken) return fault(400, "5010", "Stale Object Error", `You and someone else are editing the same thing. SyncToken ${b.SyncToken} is not current (${cur.SyncToken}).`);
      const next: Bill = { ...(b as Bill), Id: cur.Id, SyncToken: String(Number(cur.SyncToken) + 1), VendorRef: { value: vendor.Id, name: vendor.DisplayName }, TotalAmt: total, MetaData: { CreateTime: cur.MetaData.CreateTime, LastUpdatedTime: now } };
      sbPut(P, owner, "Bill", next.Id, next);
      out = wrap({ Bill: next });
    } else {
      const bill: Bill = { ...(b as Bill), Id: String(sbNextId(P, owner, "Bill", 140)), SyncToken: "0", VendorRef: { value: vendor.Id, name: vendor.DisplayName }, TotalAmt: total, MetaData: { CreateTime: now, LastUpdatedTime: now } };
      sbPut(P, owner, "Bill", bill.Id, bill);
      out = wrap({ Bill: bill });
    }
    if (rid) sbPut(P, owner, "_request", rid, out);
    return out;
  }
  return fault(404, "610", "Object Not Found", `${req.method} ${rest}`);
}

registerSimulator("sandbox-quickbooks.api.intuit.com", api);
registerSimulator("quickbooks.api.intuit.com", api);

export const simBills = (owner: number) => sbList<Bill>(P, owner, "Bill");
