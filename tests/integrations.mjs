// Integration tests for QuickBooks + Excel: the core (sealing, retries, token refresh, queue, OAuth state) and
// both providers end to end against the built-in simulators. Run with `npm test`.
import assert from "node:assert/strict";
import zlib from "node:zlib";
const { db } = await import("./lib/db.ts");
const F = await import("./lib/fields.ts");
const core = await import("./lib/integrations/core.ts");
const I = await import("./lib/integrations/index.ts");
const { quickbooks, mapBill, qstr } = await import("./lib/integrations/quickbooks.ts");
const { excel, rowFor, findRow, safeCell } = await import("./lib/integrations/excel.ts");
const { simBills } = await import("./lib/integrations/sim-quickbooks.ts");
const { simWorkbooks } = await import("./lib/integrations/sim-excel.ts");
const { sbExpireTokens } = await import("./lib/integrations/sandbox.ts");
const { buildXlsx } = await import("./lib/integrations/xlsx.ts");

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const noSleep = { sleep: async () => {} };

// ---------- fixtures ----------
const now = Date.now();
db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (1, 'a@example.com', 'x', ?)").run(now);
db.prepare("INSERT INTO orgs (id, user_id, name, timezone, created_at) VALUES (1, 1, 'Acme Books', 'America/New_York', ?)").run(now);
const starter = F.STARTERS.find((s) => s.name === "Invoice");
const fields = F.parseFieldLines(starter.fields).fields;
const cols = F.parseFieldLines(starter.columns, true).fields.map(({ key, label, type }) => ({ key, label, type }));
db.prepare("INSERT INTO templates (id, org_id, name, fields, table_label, table_cols, created_at) VALUES (1, 1, 'Invoice', ?, 'Line items', ?, ?)").run(JSON.stringify(fields), JSON.stringify(cols), now);
const DATA = { vendor: "ACME Supplies Ltd", invoice_number: "INV-2041", invoice_date: "2026-11-03", due_date: "2026-12-03", po_number: "PO-7781", subtotal: 245, tax: 19.6, total: 264.6, currency: null };
const ROWS = [{ description: "Widget A", quantity: 10, unit_price: 12.5, amount: 125 }, { description: "Widget B", quantity: 4, unit_price: 30, amount: 120 }];
const addDoc = (data, rows = [], status = "approved") => Number(db.prepare(
  "INSERT INTO documents (org_id, template_id, name, mime, size, stored_as, status, data, rows, created_at, reviewed_at) VALUES (1, 1, 'inv.txt', 'text/plain', 1, 'x', ?, ?, ?, ?, ?)",
).run(status, JSON.stringify(data), JSON.stringify(rows), now, Date.now()).lastInsertRowid);
const job = (provider, id) => core.jobFor(1, provider, "push_doc", id);
async function connect(p) {
  const ctx = core.ctxFor(1, p.id, "sandbox");
  const { state, verifier } = core.newOAuthState(1, p.id, "sandbox");
  assert.ok(core.takeOAuthState(state, 1, p.id));
  const r = await p.exchange(ctx, `sbx_code_${state.slice(0, 6)}`, "http://localhost:3021/integrations/x/callback", verifier, new URLSearchParams({ realmId: "9341453050071234" }));
  const c = core.saveConn(1, p.id, "sandbox", r.account, r.secret, r.settings);
  await p.afterConnect?.(c, ctx);
  return core.getConn(1, p.id);
}

// ---------- core ----------

await ok("credentials are sealed with AES-GCM: round trip, tamper detection, nothing readable at rest", () => {
  const s = core.seal({ access_token: "secret-token-123" });
  assert.ok(!s.includes("secret-token-123"));
  assert.deepEqual(core.unseal(s), { access_token: "secret-token-123" });
  const flipped = s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.at(-1);
  assert.equal(core.unseal(flipped), null);
  assert.equal(core.unseal("plain"), null);
});

await ok("http: 429 waits for Retry-After; GET retries a 503; a POST is not retried after a 500 (could duplicate) unless it's idempotent", async () => {
  const waits = [];
  const seq = (...codes) => { let i = 0; const calls = []; return { calls, fetch: async (url, init) => { calls.push(init.method); const c = codes[Math.min(i++, codes.length - 1)]; return new Response(c === 200 ? "{\"ok\":true}" : "{}", { status: c, headers: c === 429 ? { "Retry-After": "2" } : {} }); } }; };
  const ctx = (f) => ({ fetch: f.fetch, ownerId: 1, provider: "t", mode: "live", sleep: async (ms) => { waits.push(ms); } });
  const a = seq(429, 200);
  assert.deepEqual(await core.httpJson(ctx(a), "https://api.example.com/x"), { ok: true });
  assert.equal(waits[0], 2000);
  const b = seq(503, 503, 200);
  await core.httpJson(ctx(b), "https://api.example.com/x");
  assert.equal(b.calls.length, 3);
  const c = seq(500, 200);
  await assert.rejects(core.httpJson(ctx(c), "https://api.example.com/x", { method: "POST", json: {} }), (e) => e instanceof core.ApiError && e.status === 500);
  assert.equal(c.calls.length, 1);
  const d = seq(500, 200);
  await core.httpJson(ctx(d), "https://api.example.com/x", { method: "POST", json: {}, idempotent: true });
  assert.equal(d.calls.length, 2);
  const e = seq(429, 200);
  await core.httpJson(ctx(e), "https://api.example.com/x", { method: "POST", json: {} });
  assert.equal(e.calls.length, 2, "a 429 means the server did nothing, so even a plain POST is safe to repeat");
  const f = seq(400);
  await assert.rejects(core.httpJson(ctx(f), "https://api.example.com/x"), (err) => err.status === 400 && !err.retryable);
  assert.equal(f.calls.length, 1);
});

await ok("tokens: refreshed before expiry; parallel callers share one refresh (rotating refresh tokens); revoked → reconnect needed", async () => {
  const c = core.saveConn(1, "demo", "live", "acct", { access_token: "old", refresh_token: "r1", expires_at: Date.now() + 10_000 });
  let refreshes = 0;
  const refresh = async (t) => { refreshes++; await new Promise((r) => setTimeout(r, 20)); return { ...t, access_token: `new${refreshes}`, refresh_token: `r${refreshes + 1}`, expires_at: Date.now() + 3_600_000 }; };
  const tokens = await Promise.all([core.accessToken(c, refresh), core.accessToken(c, refresh), core.accessToken(c, refresh)]);
  assert.deepEqual(tokens, ["new1", "new1", "new1"]);
  assert.equal(refreshes, 1);
  assert.equal(core.unseal(core.getConn(1, "demo").secret).refresh_token, "r2");
  const c2 = core.getConn(1, "demo");
  await assert.rejects(core.accessToken(c2, async () => { throw new core.ApiError(400, "invalid_grant", "https://x"); }, true), core.NeedsReauth);
  assert.equal(core.getConn(1, "demo").status, "reauth");
  core.disconnect(1, "demo");
});

await ok("OAuth state: single use, bound to the owner and provider", () => {
  const a = core.newOAuthState(1, QBO_ID(), "live");
  assert.equal(core.takeOAuthState(a.state, 2, QBO_ID()), null, "another owner can't use it");
  assert.equal(core.takeOAuthState(a.state, 1, QBO_ID()), null, "and it's gone after one try");
  const b = core.newOAuthState(1, QBO_ID(), "live");
  assert.equal(core.takeOAuthState(b.state, 1, "excel"), null);
  const c = core.newOAuthState(1, QBO_ID(), "sandbox");
  assert.deepEqual(core.takeOAuthState(c.state, 1, QBO_ID()), { mode: "sandbox", verifier: c.verifier });
});
function QBO_ID() { return "quickbooks"; }

// ---------- QuickBooks mapping ----------

await ok("bill mapping: line items + tax line when they add up; one line for the total when they don't; data errors are explicit", () => {
  const a = mapBill(7, DATA, ROWS, "20");
  assert.equal(a.vendor, "ACME Supplies Ltd");
  assert.deepEqual(a.bill.Line.map((l) => [l.Description, l.Amount]), [["Widget A (10 × 12.50)", 125], ["Widget B (4 × 30.00)", 120], ["Tax", 19.6]]);
  assert.equal(a.bill.DocNumber, "INV-2041");
  assert.equal(a.bill.TxnDate, "2026-11-03");
  assert.equal(a.bill.DueDate, "2026-12-03");
  assert.match(a.bill.PrivateNote, /From Fieldwise document #7\. PO PO-7781/);
  assert.equal(a.bill.CurrencyRef, undefined);
  const b = mapBill(7, { ...DATA, total: 300 }, ROWS, "20");
  assert.deepEqual(b.bill.Line.map((l) => l.Amount), [300]);
  assert.match(b.note, /don't add up/);
  const c = mapBill(7, { ...DATA, currency: "eur", invoice_number: "X".repeat(30) }, [], "20");
  assert.deepEqual(c.bill.CurrencyRef, { value: "EUR" });
  assert.equal(c.bill.DocNumber.length, 21);
  assert.throws(() => mapBill(7, { ...DATA, vendor: null }, [], "20"), /no vendor/);
  assert.throws(() => mapBill(7, { ...DATA, total: null }, [], "20"), /no positive total/);
  assert.throws(() => mapBill(7, DATA, [], ""), /expense account/);
  assert.equal(qstr("O'Brien \\ Co"), "'O\\'Brien \\\\ Co'");
});

// ---------- QuickBooks end to end (simulator) ----------

await ok("QuickBooks: connect (code → tokens → company → expense accounts), approve → vendor + bill created", async () => {
  const c = await connect(quickbooks);
  assert.equal(c.account, "Sandbox Company_US_1");
  const s = core.settingsOf(c);
  assert.equal(s.realmId, "9341453050071234");
  assert.ok(s.accounts.length >= 3 && s.accountId, "expense accounts loaded and one chosen");
  const id = addDoc(DATA, ROWS);
  await I.documentApproved(1, id);
  assert.equal(job("quickbooks", id).status, "done", job("quickbooks", id).last_error ?? "");
  const [bill] = simBills(1);
  assert.equal(bill.VendorRef.name, "ACME Supplies Ltd");
  assert.equal(bill.TotalAmt, 264.6);
  assert.equal(bill.DocNumber, "INV-2041");
  assert.equal(core.getLink(1, "quickbooks", "document", id).remote_id, bill.Id);
  globalThis.DOC1 = id;
});

await ok("QuickBooks: re-approval after a correction updates the same bill (SyncToken), an unchanged one is a no-op", async () => {
  const id = globalThis.DOC1;
  db.prepare("UPDATE documents SET data = ?, rows = '[]' WHERE id = ?").run(JSON.stringify({ ...DATA, total: 270 }), id);
  await I.documentApproved(1, id);
  const bills = simBills(1);
  assert.equal(bills.length, 1);
  assert.equal(bills[0].TotalAmt, 270);
  assert.equal(bills[0].SyncToken, "1");
  assert.match(job("quickbooks", id).result, /updated/);
  await I.documentApproved(1, id);
  assert.match(job("quickbooks", id).result, /unchanged/);
});

await ok("QuickBooks: same vendor + invoice number already there → linked, not duplicated; vendor reused", async () => {
  const id = addDoc({ ...DATA, total: 270 }, []);
  await I.documentApproved(1, id);
  assert.match(job("quickbooks", id).result, /already in QuickBooks/);
  assert.equal(simBills(1).length, 1);
  const other = addDoc({ ...DATA, invoice_number: "INV-2042", total: 50 }, []);
  await I.documentApproved(1, other);
  assert.equal(simBills(1).length, 2);
  assert.equal(new Set(simBills(1).map((b) => b.VendorRef.value)).size, 1);
});

await ok("QuickBooks: expired access token → 401 → refresh (rotated) → call repeated; rate limits retried", async () => {
  sbExpireTokens("quickbooks", 1);
  const before = core.unseal(core.getConn(1, "quickbooks").secret).refresh_token;
  const id = addDoc({ ...DATA, invoice_number: "INV-3000", vendor: "Northside Print Co.", total: 187.2 }, []);
  await I.documentApproved(1, id);
  assert.equal(job("quickbooks", id).status, "done", job("quickbooks", id).last_error ?? "");
  assert.notEqual(core.unseal(core.getConn(1, "quickbooks").secret).refresh_token, before, "the refresh token rotated");
  const warned = db.prepare("SELECT COUNT(*) AS n FROM integration_log WHERE provider = 'quickbooks' AND message LIKE '429%'").get().n;
  assert.ok(warned > 0, "the simulator's 429s were retried");
});

await ok("QuickBooks: a document that can't map fails at once with the reason; the connection stays healthy; other templates skipped", async () => {
  const id = addDoc({ ...DATA, vendor: null, invoice_number: "INV-4000" }, []);
  await I.documentApproved(1, id);
  assert.equal(job("quickbooks", id).status, "failed");
  assert.match(job("quickbooks", id).last_error, /no vendor/);
  assert.equal(job("quickbooks", id).attempts, 1);
  assert.equal(core.getConn(1, "quickbooks").status, "connected");
  db.prepare("INSERT INTO templates (id, org_id, name, fields, created_at) VALUES (2, 1, 'Receipt', ?, ?)").run(JSON.stringify(fields), now);
  const r = Number(db.prepare("INSERT INTO documents (org_id, template_id, name, mime, size, stored_as, status, data, created_at, reviewed_at) VALUES (1, 2, 'r.txt', 'text/plain', 1, 'x', 'approved', ?, ?, ?)").run(JSON.stringify(DATA), now, now).lastInsertRowid);
  await I.documentApproved(1, r);
  assert.match(job("quickbooks", r).result, /skipped/);
});

// ---------- Excel ----------

await ok("Excel cells: formulas defused, numbers stay numbers; row lookup by document number survives sorting", () => {
  assert.equal(safeCell("=HYPERLINK(\"http://evil\")"), "'=HYPERLINK(\"http://evil\")");
  assert.equal(safeCell(-12.5), -12.5);
  assert.equal(safeCell("+1 555"), "'+1 555");
  const row = rowFor({ id: 9, name: "a.pdf", reviewed_at: Date.UTC(2026, 10, 3, 12), data: JSON.stringify({ vendor: "=cmd", total: 12.5, paid: true }) }, [{ key: "vendor" }, { key: "total" }, { key: "paid" }], "UTC");
  assert.deepEqual(row, [9, "a.pdf", "2026-11-03", "'=cmd", 12.5, "yes"]);
  assert.equal(findRow({ address: "Invoice!A1:L4", values: [["Document #"], [12], [9], [3]] }, 9), 3);
  assert.equal(findRow({ address: "Invoice!A1:L2", values: [["Document #"], [1]] }, 9), null);
});

await ok("Excel: connect (PKCE) creates the workbook; approvals add rows, corrections update the same row, retries don't duplicate", async () => {
  const c = await connect(excel);
  assert.equal(c.account, "sandbox.user@contoso.onmicrosoft.com");
  assert.ok(core.settingsOf(c).itemId);
  const n0 = I.backfill(1, "excel");
  assert.ok(n0 >= 4);
  await core.drain(1, { provider: "excel" });
  const wb = simWorkbooks(1)[0];
  const sheet = wb.sheets.Invoice;
  assert.deepEqual(sheet[0].slice(0, 5), ["Document #", "File", "Approved", "Vendor", "Invoice number"]);
  const before = sheet.length;
  const id = globalThis.DOC1;
  db.prepare("UPDATE documents SET data = ? WHERE id = ?").run(JSON.stringify({ ...DATA, total: 275 }), id);
  await I.documentApproved(1, id);
  const after = simWorkbooks(1)[0].sheets.Invoice;
  assert.equal(after.length, before, "updated in place, not appended");
  const r = after.find((x) => x[0] === id);
  assert.equal(r[after[0].indexOf("Total")], 275);
  core.enqueue(1, "excel", "push_doc", id, { docId: id });
  db.prepare("DELETE FROM integration_links WHERE provider = 'excel' AND local_id = ?").run(String(id)); // lost our record of it
  await core.drain(1, { provider: "excel" });
  assert.equal(simWorkbooks(1)[0].sheets.Invoice.filter((x) => x[0] === id).length, 1, "found by document number instead of appended twice");
});

await ok("xlsx writer: a valid zip with matching CRCs, numeric cells, inline strings (never formulas), a bold header", () => {
  const buf = buildXlsx([{ name: "Invoices: Q4/2026", rows: [["Doc", "Total"], [1, 264.6], [2, "=1+1"]] }]);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const data = buf.subarray(off + 30 + buf.readUInt16LE(off + 26), off + 30 + buf.readUInt16LE(off + 26) + size);
    assert.equal(zlib.crc32(data), crc, name);
    files[name] = data.toString();
    p += 46 + nameLen;
  }
  assert.ok(files["[Content_Types].xml"] && files["xl/workbook.xml"].includes('name="Invoices  Q4 2026"'));
  const sheet = files["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="B2"><v>264.6<\/v><\/c>/);
  assert.match(sheet, /<c r="B3" t="inlineStr"><is><t xml:space="preserve">=1\+1<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr">/);
});

await ok("disconnect forgets tokens, links and pending jobs; nothing is queued for a disconnected provider", async () => {
  core.disconnect(1, "excel");
  assert.equal(core.getConn(1, "excel"), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM integration_links WHERE provider = 'excel'").get().n, 0);
  const id = addDoc({ ...DATA, invoice_number: "INV-5000" }, []);
  await I.documentApproved(1, id);
  assert.equal(job("excel", id), undefined);
  assert.equal(job("quickbooks", id).status, "done");
});

console.log(`\n${n} checks passed`);
