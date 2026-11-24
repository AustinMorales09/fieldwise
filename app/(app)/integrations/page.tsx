import Link from "next/link";
import IntegrationCard from "@/components/IntegrationCard";
import { myOrg } from "@/lib/access";
import { db } from "@/lib/db";
import { reloadQuickBooksAccounts, saveQuickBooks, sendAllApproved } from "@/lib/integration-actions";
import { EXCEL, QBO } from "@/lib/integrations";
import { getConn, settingsOf } from "@/lib/integrations/core";
import { excel, type ExcelSettings } from "@/lib/integrations/excel";
import { quickbooks, type QboSettings } from "@/lib/integrations/quickbooks";
import { simWorkbooks } from "@/lib/integrations/sim-excel";
import { simBills } from "@/lib/integrations/sim-quickbooks";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string }> }) {
  const org = await myOrg();
  const sp = await searchParams;
  const qbo = getConn(org.id, QBO);
  const xl = getConn(org.id, EXCEL);
  const templates = db.prepare("SELECT name FROM templates WHERE org_id = ? ORDER BY id").all(org.id) as { name: string }[];
  const approved = (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND status = 'approved'").get(org.id) as { n: number }).n;
  const docName = (ref: string) => (db.prepare("SELECT name FROM documents WHERE id = ? AND org_id = ?").get(Number(ref), org.id) as { name: string } | undefined)?.name;
  const describe = (_kind: string, ref: string) => <Link href={`/documents/${ref}`}>#{ref} {docName(ref) ?? "(deleted)"}</Link>;
  const qs = qbo ? settingsOf<QboSettings>(qbo) : null;
  const xs = xl ? settingsOf<ExcelSettings>(xl) : null;
  const sendAll = (provider: string) => (
    <form action={sendAllApproved} style={{ display: "inline" }}>
      <input type="hidden" name="provider" value={provider} />
      <button type="submit" className="secondary" disabled={!approved}>Send all {approved} approved document{approved === 1 ? "" : "s"}</button>
    </form>
  );

  return (
    <main className="container" style={{ maxWidth: 980 }}>
      <h1>Integrations</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Approved documents are sent automatically. Nothing leaves Fieldwise until a person approves it, and a correction after approval updates what was sent instead of sending it twice.
      </p>
      {sp.error && <p className="error card">{sp.error}</p>}
      {sp.done && <p className="ok-text small">{sp.done}</p>}

      <IntegrationCard p={quickbooks} c={qbo} ownerId={org.id} describeJob={describe}>
        {qbo && qs && (
          <>
            <form action={saveQuickBooks} className="card" style={{ background: "transparent", margin: "4px 0" }}>
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="grow">
                  <label htmlFor="account_id">Expense account for bill lines</label>
                  <select id="account_id" name="account_id" defaultValue={qs.accountId}>
                    {qs.accounts.length === 0 && <option value="">(no expense accounts loaded)</option>}
                    {qs.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label>Send these templates as bills</label>
                  <div className="row">{templates.map((t) => <label key={t.name} className="choice-row" style={{ margin: 0 }}><input type="checkbox" name="templates" value={t.name} defaultChecked={qs.templates.includes(t.name)} /> {t.name}</label>)}</div>
                </div>
              </div>
              <button type="submit" style={{ marginTop: 8 }}>Save</button>
              <p className="small muted" style={{ margin: "8px 0 0" }}>
                Vendors are matched by name and created if missing. A bill already in QuickBooks with the same vendor and invoice number is linked, not duplicated.
                Line items are used when they add up to the approved total; otherwise the bill gets one line for the total.
              </p>
            </form>
            <div className="row" style={{ alignItems: "center" }}>
              {sendAll(QBO)}
              <form action={reloadQuickBooksAccounts}><button type="submit" className="link small">Reload accounts from QuickBooks</button></form>
            </div>
            {qbo.mode === "sandbox" && <SimBills ownerId={org.id} />}
          </>
        )}
      </IntegrationCard>

      <IntegrationCard p={excel} c={xl} ownerId={org.id} describeJob={describe}>
        {xl && xs && (
          <>
            <p className="small" style={{ margin: "0 0 6px" }}>
              Workbook: <code>{xs.path}</code>{xs.webUrl ? <> · <a href={xs.webUrl} target="_blank" rel="noopener">Open in Excel</a></> : null}
              {Object.values(xs.tables).length ? ` · sheets: ${Object.values(xs.tables).map((t) => t.sheet).join(", ")}` : " · sheets are added when their first document is sent"}
            </p>
            <div className="row">
              {sendAll(EXCEL)}
              {xl.mode === "sandbox" && <a className="small" href="/integrations/sandbox/workbook">Download the simulated workbook (.xlsx)</a>}
            </div>
            {xl.mode === "sandbox" && <SimSheets ownerId={org.id} />}
          </>
        )}
      </IntegrationCard>

      <div className="card small muted">
        <strong>Without connecting anything:</strong> every template&apos;s approved documents can be downloaded as CSV or Excel (.xlsx) from the Documents page.
        Credentials are stored encrypted (AES-256-GCM). Disconnecting deletes the stored tokens.
      </div>
    </main>
  );
}

function SimBills({ ownerId }: { ownerId: number }) {
  const bills = simBills(ownerId);
  return (
    <details open style={{ marginTop: 8 }}>
      <summary className="small"><strong>What the simulated QuickBooks company holds</strong> ({bills.length} bill{bills.length === 1 ? "" : "s"})</summary>
      {bills.length > 0 && (
        <div className="table-wrap">
          <table className="list">
            <thead><tr className="small muted"><th>Bill</th><th>Vendor</th><th>Invoice #</th><th>Date / due</th><th style={{ textAlign: "right" }}>Total</th><th>Lines</th><th>Version</th></tr></thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.Id} className="small">
                  <td>{b.Id}</td><td>{b.VendorRef.name}</td><td>{b.DocNumber ?? "—"}</td><td>{b.TxnDate ?? "—"} / {b.DueDate ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>{b.TotalAmt.toFixed(2)}</td><td>{b.Line.map((l) => `${l.Description ?? ""} ${l.Amount.toFixed(2)}`).join(" · ")}</td><td>SyncToken {b.SyncToken}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function SimSheets({ ownerId }: { ownerId: number }) {
  const wb = simWorkbooks(ownerId)[0];
  if (!wb) return null;
  return (
    <details open style={{ marginTop: 8 }}>
      <summary className="small"><strong>What the simulated workbook holds</strong> ({wb.path})</summary>
      {Object.entries(wb.sheets).filter(([, rows]) => rows.length).map(([name, rows]) => (
        <div key={name} className="table-wrap" style={{ marginTop: 6 }}>
          <div className="small muted">{name}</div>
          <table className="list">
            <thead><tr className="small muted">{rows[0].map((h, i) => <th key={i}>{String(h)}</th>)}</tr></thead>
            <tbody>{rows.slice(1).map((r, i) => <tr key={i} className="small">{r.map((v, j) => <td key={j}>{String(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ))}
    </details>
  );
}
