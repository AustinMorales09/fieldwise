import Link from "next/link";
import { myOrg } from "@/lib/access";
import { db, type TemplateRow } from "@/lib/db";
import type { Column, Field } from "@/lib/fields";

export default async function Templates() {
  const org = await myOrg();
  const rows = db.prepare("SELECT t.*, (SELECT COUNT(*) FROM documents d WHERE d.template_id = t.id) AS docs FROM templates t WHERE org_id = ? ORDER BY name").all(org.id) as (TemplateRow & { docs: number })[];
  return (
    <main className="container" style={{ maxWidth: 860 }}>
      <h1 style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>Templates <Link className="small" href="/templates/new">+ New template</Link></h1>
      <p className="muted" style={{ marginTop: 0 }}>A template is the list of fields to pull out of one kind of document. Each upload is read against the template you pick.</p>
      {rows.map((t) => {
        const fields = JSON.parse(t.fields) as Field[];
        const cols = JSON.parse(t.table_cols) as Column[];
        return (
          <div key={t.id} className="card">
            <h2 style={{ display: "flex", justifyContent: "space-between" }}><Link href={`/templates/${t.id}`}>{t.name}</Link><span className="small muted">{t.docs} document{t.docs === 1 ? "" : "s"}</span></h2>
            <p className="small muted" style={{ marginTop: 0 }}>{t.description}</p>
            <p className="small" style={{ margin: 0 }}>{fields.map((f) => `${f.label}${f.required ? "*" : ""}`).join(" · ")}{cols.length ? ` · + ${t.table_label.toLowerCase() || "rows"} (${cols.map((c) => c.label.toLowerCase()).join(", ")})` : ""}</p>
          </div>
        );
      })}
    </main>
  );
}
