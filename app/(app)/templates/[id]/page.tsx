import Link from "next/link";
import { myOrg, ownTemplate } from "@/lib/access";
import { deleteTemplate, saveTemplate } from "@/lib/actions";
import { FIELD_TYPES, fieldLines, type Column, type Field } from "@/lib/fields";

export default async function TemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const tpl = id === "new" ? (await myOrg(), null) : (await ownTemplate(Number(id))).tpl;
  const fields = tpl ? fieldLines(JSON.parse(tpl.fields) as Field[]) : "";
  const cols = tpl ? fieldLines((JSON.parse(tpl.table_cols) as Column[]).map((c) => ({ ...c, required: false, id: false, hint: "" }))) : "";

  return (
    <main className="container" style={{ maxWidth: 860 }}>
      <p className="small" style={{ margin: 0 }}><Link href="/templates">← Templates</Link></p>
      <h1 style={{ margin: "8px 0" }}>{tpl ? tpl.name : "New template"}</h1>
      {sp.error && <p className="error card">{sp.error}</p>}
      {sp.saved && <p className="ok-text small">Saved. New uploads (and &quot;Extract again&quot;) use the updated fields.</p>}
      <form action={saveTemplate} className="card" key={tpl ? `${tpl.fields}${tpl.table_cols}${tpl.name}${tpl.description}${tpl.table_label}` : "new"}>
        {tpl && <input type="hidden" name="template_id" value={tpl.id} />}
        <div className="row">
          <div className="grow"><label htmlFor="name">Name</label><input id="name" name="name" defaultValue={tpl?.name} required placeholder="Purchase order" /></div>
          <div className="grow"><label htmlFor="desc">What kind of document is it?</label><input id="desc" name="description" defaultValue={tpl?.description} placeholder="POs we send to suppliers" /></div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="fields">Fields, one per line: <code>Label | type | flags | hint</code></label>
          <textarea id="fields" name="fields" rows={10} defaultValue={fields} required style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} placeholder={"PO number | text | required id\nOrder date | date | required\nTotal | money | required | The grand total including tax"} />
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            Types: {FIELD_TYPES.join(", ")} (default text). Flags: <code>required</code> blocks approval when missing; <code>id</code> marks what identifies the document, used to spot duplicates.
            The hint tells the extraction which value you mean when several look alike.
          </p>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ width: 220 }}><label htmlFor="tl">Table name (optional)</label><input id="tl" name="table_label" defaultValue={tpl?.table_label} placeholder="Line items" /></div>
        </div>
        <div className="field" style={{ marginTop: 6 }}>
          <label htmlFor="cols">Table columns, one per line: <code>Label | type</code> (leave empty for no table)</label>
          <textarea id="cols" name="columns" rows={4} defaultValue={cols} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} placeholder={"Description | text\nQuantity | number\nUnit price | money\nAmount | money"} />
          <p className="small muted" style={{ margin: "4px 0 0" }}>Built-in arithmetic checks use fields named Subtotal, Tax and Total, and columns named Quantity, Unit price and Amount.</p>
        </div>
        <button type="submit">{tpl ? "Save template" : "Create template"}</button>
      </form>
      {tpl && <form action={deleteTemplate}><input type="hidden" name="template_id" value={tpl.id} /><button className="danger">Delete template</button></form>}
    </main>
  );
}
