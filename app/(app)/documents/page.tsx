import Link from "next/link";
import { myOrg } from "@/lib/access";
import { loadDemo, upload } from "@/lib/actions";
import { db, type DocRow, type DocStatus, type TemplateRow } from "@/lib/db";
import type { Check, Field, Value } from "@/lib/fields";
import { show } from "@/lib/fields";
import { aiStatus } from "@/lib/process";
import { fmtStamp } from "@/lib/time";

const VIEWS: [string, string][] = [["needs_review", "To review"], ["approved", "Approved"], ["problem", "Couldn't read"], ["rejected", "Rejected"], ["all", "All"]];
const STATUS_PILL: Record<DocStatus, [string, string]> = {
  needs_review: ["pill-warn", "To review"], approved: ["pill-ok", "Approved"], rejected: ["pill-muted", "Rejected"], needs_ai: ["pill-err", "Needs AI"], failed: ["pill-err", "Failed"],
};

type SP = { view?: string; tpl?: string; error?: string; welcome?: string; uploaded?: string; approved?: string; rejected?: string };

export default async function Documents({ searchParams }: { searchParams: Promise<SP> }) {
  const org = await myOrg();
  const sp = await searchParams;
  const view = VIEWS.some(([k]) => k === sp.view) ? sp.view! : "needs_review";
  const templates = db.prepare("SELECT * FROM templates WHERE org_id = ? ORDER BY name").all(org.id) as TemplateRow[];
  const tplOf = new Map(templates.map((t) => [t.id, t]));
  const all = db.prepare("SELECT * FROM documents WHERE org_id = ? ORDER BY id DESC LIMIT 500").all(org.id) as DocRow[];
  const inView = (d: DocRow, v: string) => v === "all" || (v === "problem" ? d.status === "needs_ai" || d.status === "failed" : d.status === v);
  const list = all.filter((d) => inView(d, view) && (!sp.tpl || String(d.template_id) === sp.tpl));
  const ai = aiStatus(org);

  return (
    <main className="container">
      <h1>Documents</h1>
      {sp.welcome && all.length === 0 && <p className="ok-text card">Welcome! You have Invoice and Receipt templates ready. Load the sample documents to see extraction and the checks, or upload your own.</p>}
      {sp.uploaded && <p className="ok-text small">{sp.uploaded === "demo" ? "Sample documents" : `${sp.uploaded} document${sp.uploaded === "1" ? "" : "s"}`} extracted. Review them below.</p>}
      {sp.approved && <p className="ok-text small">Approved document #{sp.approved}. Nothing else is waiting for review.</p>}
      {sp.error && <p className="error">{sp.error}</p>}
      <p className="small muted" style={{ marginTop: 0 }}>
        Extraction: {ai.mode === "claude" ? <span className="status-ok">Claude (reads PDFs, scans and photos)</span> : <><span className="status-warn">label matching only</span> ({ai.reason}; text files and simple PDFs work, photos and scans need ANTHROPIC_API_KEY)</>}
      </p>

      <div className="filters">
        {VIEWS.map(([k, label]) => <Link key={k} href={`/documents?view=${k}${sp.tpl ? `&tpl=${sp.tpl}` : ""}`} className={k === view ? "on" : ""}>{label} ({all.filter((d) => inView(d, k)).length})</Link>)}
        <form style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <input type="hidden" name="view" value={view} />
          <select name="tpl" defaultValue={sp.tpl ?? ""} aria-label="Template" style={{ padding: "4px 6px", width: "auto" }}><option value="">All templates</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <button type="submit" className="secondary" style={{ padding: "4px 10px" }}>Filter</button>
        </form>
      </div>

      <div className="card table-wrap">
        {list.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{all.length === 0 ? "No documents yet." : "Nothing here."}</p> : (
          <table className="list">
            <thead><tr><th>Document</th><th>Template</th><th>Key values</th><th>Checks</th><th>Status</th></tr></thead>
            <tbody>
              {list.map((d) => {
                const tpl = tplOf.get(d.template_id);
                const fields = tpl ? (JSON.parse(tpl.fields) as Field[]) : [];
                const data = JSON.parse(d.data) as Record<string, Value>;
                const checks = JSON.parse(d.checks) as Check[];
                const errs = checks.filter((c) => c.level === "error").length;
                const key = fields.filter((f) => f.required || f.id).slice(0, 3).map((f) => show(f.type, data[f.key] ?? null)).filter(Boolean).join(" · ");
                const [cls, label] = STATUS_PILL[d.status];
                return (
                  <tr key={d.id}>
                    <td><Link href={`/documents/${d.id}`}><strong>{d.name}</strong></Link><div className="small muted">#{d.id} · {fmtStamp(d.created_at, org.timezone)}</div></td>
                    <td className="small">{tpl?.name}</td>
                    <td className="small">{key || <span className="muted">{d.error ? d.error.slice(0, 70) : "—"}</span>}</td>
                    <td className="small">{errs ? <span className="chk-error">{errs} missing</span> : null}{errs && checks.length > errs ? " · " : ""}{checks.length > errs ? <span className="chk-warn">{checks.length - errs} to check</span> : null}{!checks.length && d.status !== "needs_ai" && d.status !== "failed" ? <span className="status-ok">all clear</span> : null}</td>
                    <td><span className={cls}>{label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Upload documents</h2>
          <form action={upload}>
            <div className="field"><label htmlFor="tpl">Template</label><select id="tpl" name="template_id" required>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
            <div className="field"><label htmlFor="files">Files (PDF, PNG, JPG, WebP, or text; up to 20 files, 10 MB each)</label><input id="files" name="files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.md,.eml" /></div>
            <details>
              <summary className="small" style={{ cursor: "pointer" }}>…or paste the text of a document</summary>
              <div className="field" style={{ marginTop: 6 }}><input name="text_name" placeholder="Name (e.g. Invoice 881)" aria-label="Name" /></div>
              <div className="field"><textarea name="text" rows={6} aria-label="Document text" /></div>
            </details>
            <button type="submit" style={{ marginTop: 8 }}>Upload &amp; extract</button>
          </form>
        </div>
        <div className="card">
          <h2>Export</h2>
          {templates.map((t) => (
            <p key={t.id} className="small" style={{ margin: "4px 0" }}>
              <strong>{t.name}</strong>: approved documents (<a href={`/export/${t.id}`}>CSV</a> · <a href={`/export/${t.id}?format=xlsx`}>Excel</a>){JSON.parse(t.table_cols).length ? <> · {t.table_label.toLowerCase() || "rows"} (<a href={`/export/${t.id}?what=rows`}>CSV</a> · <a href={`/export/${t.id}?what=rows&format=xlsx`}>Excel</a>)</> : null}
            </p>
          ))}
          <p className="small muted">Only approved documents are exported, so nothing unreviewed reaches your books.</p>
          <form action={loadDemo}><button className="secondary">Load 4 sample documents</button></form>
        </div>
      </div>
    </main>
  );
}
