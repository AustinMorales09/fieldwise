import Link from "next/link";
import { ownDoc } from "@/lib/access";
import { deleteDoc, reextract, review } from "@/lib/actions";
import { show, type Check, type Meta, type Row, type Value } from "@/lib/fields";
import { toTemplate } from "@/lib/process";
import { fmtStamp } from "@/lib/time";
import { connections, providerById } from "@/lib/integrations";
import { getLink, jobFor } from "@/lib/integrations/core";

type SP = { error?: string; saved?: string; approved?: string; reextracted?: string };
const INPUT: Record<string, { type: string; step?: string; inputMode?: "decimal" }> = { date: { type: "date" }, money: { type: "text", inputMode: "decimal" }, number: { type: "text", inputMode: "decimal" }, text: { type: "text" } };
const STATUS: Record<string, string> = { needs_review: "to review", approved: "approved", rejected: "rejected", needs_ai: "needs AI", failed: "failed" };

export default async function DocPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { org, doc, tpl } = await ownDoc(Number(id));
  const t = toTemplate(tpl);
  const data = JSON.parse(doc.data) as Record<string, Value>;
  const meta = JSON.parse(doc.meta) as Meta;
  const rows = JSON.parse(doc.rows) as Row[];
  const checks = JSON.parse(doc.checks) as Check[];
  const readable = doc.status !== "needs_ai" && doc.status !== "failed";
  const isImg = doc.mime.startsWith("image/");
  const blank = 2; // empty rows offered for adding line items by hand
  const allRows: Row[] = [...rows, ...Array.from({ length: blank }, () => ({}))];
  const fieldChecks = (key: string) => checks.filter((c) => c.field === key);

  return (
    <main className="container" style={{ maxWidth: 1280 }}>
      <p className="small" style={{ margin: 0 }}><Link href="/documents">← Documents</Link></p>
      <h1 style={{ margin: "8px 0 4px" }}>{doc.name} <span className="muted small" style={{ fontWeight: 400 }}>#{doc.id}</span></h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {t.name} · <strong>{STATUS[doc.status]}</strong>{doc.source ? ` · read by ${doc.source === "claude" ? "Claude" : "label matching"}` : ""}{doc.edited ? " · edited by you" : ""}{doc.reviewed_at ? ` · approved ${fmtStamp(doc.reviewed_at, org.timezone)}` : ""}
      </p>
      {sp.error && <p className="error card">{sp.error}</p>}
      {sp.approved && <p className="ok-text small">Approved #{sp.approved}. Here&apos;s the next one.</p>}
      {sp.saved && <p className="ok-text small">Saved, and the checks were re-run on your values.</p>}
      {sp.reextracted && <p className="ok-text small">Extracted again.</p>}
      {doc.error && <p className="card small status-warn">{doc.error}</p>}
      <SyncStatus orgId={org.id} docId={doc.id} approved={doc.status === "approved"} />

      <div className="review">
        <div className="card">
          <h2 style={{ display: "flex", justifyContent: "space-between" }}>Original <a className="small" href={`/files/${doc.id}`}>Download</a></h2>
          {doc.mime === "application/pdf" ? <iframe className="doc-frame" src={`/files/${doc.id}?inline=1`} title="Document" />
            /* eslint-disable-next-line @next/next/no-img-element */
            : isImg ? <img src={`/files/${doc.id}?inline=1`} alt={doc.name} style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />
            : <pre className="doc-text">{doc.text}</pre>}
        </div>

        <div>
          {checks.length > 0 && (
            <div className="card attention">
              <h2>Check before approving</h2>
              <ul>{checks.map((c, i) => <li key={i} className={`chk-${c.level}`}>{c.message}</li>)}</ul>
            </div>
          )}
          {readable ? (
            <form action={review} className="card" key={`${doc.data}${doc.rows}${doc.status}`}>
              <input type="hidden" name="doc_id" value={doc.id} />
              <h2>Extracted values</h2>
              {t.fields.map((f) => {
                const m = meta[f.key];
                const v = data[f.key] ?? null;
                const cs = fieldChecks(f.key);
                const cls = cs.some((c) => c.level === "error") ? " bad" : cs.length ? " iffy" : "";
                return (
                  <div key={f.key} className={`fld${cls}`}>
                    <label htmlFor={`f_${f.key}`}>
                      <span>{f.label}{f.required ? " *" : ""}</span>
                      {m ? <span className={m.confidence === "low" ? "status-warn" : "muted"}>{m.confidence} confidence</span> : v !== null ? <span className="muted">entered by you</span> : null}
                    </label>
                    {f.type === "yesno" ? (
                      <select id={`f_${f.key}`} name={`f_${f.key}`} defaultValue={v === null ? "" : v ? "yes" : "no"}><option value="">(not found)</option><option value="yes">Yes</option><option value="no">No</option></select>
                    ) : (
                      <input id={`f_${f.key}`} name={`f_${f.key}`} {...INPUT[f.type]} defaultValue={show(f.type, v)} placeholder={v === null ? "not found" : ""} />
                    )}
                    {m?.evidence && <div className="ev">from: &ldquo;{m.evidence}&rdquo;{m.evidence_ok === false ? <span className="status-warn"> (not found in the document text)</span> : null}</div>}
                  </div>
                );
              })}

              {t.columns.length > 0 && (
                <>
                  <h2 style={{ marginTop: 16 }}>{t.tableLabel || "Rows"} <span className="small muted">({rows.length})</span></h2>
                  <input type="hidden" name="row_count" value={allRows.length} />
                  <div className="table-wrap">
                    <table className="rows">
                      <thead><tr>{t.columns.map((c) => <th key={c.key} className="small muted" style={{ textAlign: "left" }}>{c.label}</th>)}</tr></thead>
                      <tbody>
                        {allRows.map((r, i) => (
                          <tr key={i}>{t.columns.map((c) => <td key={c.key}><input name={`r_${i}_${c.key}`} defaultValue={show(c.type, r[c.key] ?? null)} aria-label={`${c.label}, row ${i + 1}`} style={c.type === "text" ? { minWidth: 160 } : undefined} /></td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="small muted" style={{ margin: "4px 0 0" }}>Clear a row to remove it; use the blank rows to add one.</p>
                </>
              )}

              <div className="row" style={{ marginTop: 14 }}>
                <button type="submit" name="intent" value="approve">{doc.status === "approved" ? "Save & keep approved" : "Approve"}</button>
                <button type="submit" name="intent" value="save" className="secondary">Save &amp; re-check</button>
                <button type="submit" name="intent" value="reject" className="danger">Reject</button>
              </div>
            </form>
          ) : (
            <div className="card">
              <h2>Not extracted</h2>
              <p className="small">{doc.status === "needs_ai" ? "This file is a photo, scan or complex PDF. Reading it needs Claude: set ANTHROPIC_API_KEY on the server, then extract again." : "Extraction failed. You can try again."}</p>
            </div>
          )}
          <div className="row">
            <form action={reextract}><input type="hidden" name="doc_id" value={doc.id} /><button className="secondary">Extract again{doc.edited ? " (discards your edits)" : ""}</button></form>
            <form action={deleteDoc}><input type="hidden" name="doc_id" value={doc.id} /><button className="link">Delete document</button></form>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Where this document was sent, per connected integration. */
function SyncStatus({ orgId, docId, approved }: { orgId: number; docId: number; approved: boolean }) {
  const conns = connections(orgId);
  if (!conns.length) return null;
  return (
    <p className="small" style={{ margin: "0 0 10px" }}>
      {conns.map((c, i) => {
        const name = providerById(c.provider)?.name.split(" (")[0] ?? c.provider;
        const job = jobFor(orgId, c.provider, "push_doc", docId);
        const link = getLink(orgId, c.provider, "document", docId);
        const text = job?.status === "failed" ? <span className="status-err">failed: {job.last_error}</span>
          : job && job.status !== "done" ? <span className="status-warn">sending…</span>
          : job?.result?.startsWith("skipped") ? <span className="muted">{job.result.replace("skipped: ", "not sent: ")}</span>
          : link ? <span className="status-ok">{job?.result ?? "sent"}</span>
          : <span className="muted">{approved ? "not sent yet" : "sent after approval"}</span>;
        return <span key={c.provider}>{i ? " · " : ""}<Link href={`/integrations#${c.provider}`}>{name}</Link>: {text}</span>;
      })}
    </p>
  );
}
