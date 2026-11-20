import { myOrg } from "@/lib/access";
import { saveSettings } from "@/lib/actions";
import { MODEL } from "@/lib/claude";
import { aiStatus } from "@/lib/process";
import TimezoneSelect from "@/components/TimezoneSelect";

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const org = await myOrg();
  const sp = await searchParams;
  const ai = aiStatus(org);
  return (
    <main className="container narrow">
      <div className="card">
        <h1>Settings</h1>
        {sp.error && <p className="error">{sp.error}</p>}
        {sp.saved && <p className="ok-text small">Saved.</p>}
        <form action={saveSettings} key={`${org.name}${org.timezone}${org.ai_enabled}`}>
          <div className="field"><label htmlFor="name">Company name</label><input id="name" name="name" defaultValue={org.name} required /></div>
          <div className="field"><label htmlFor="timezone">Time zone</label><TimezoneSelect value={org.timezone} /></div>
          <label className="choice-row"><input type="checkbox" name="ai_enabled" defaultChecked={!!org.ai_enabled} /> Use Claude to read documents</label>
          <p className="small muted" style={{ margin: "4px 0 8px" }}>
            Right now: {ai.mode === "claude" ? <>Claude (<code>{MODEL}</code>). Uploaded documents are sent to Anthropic&apos;s API to be read.</> : <>label matching only. {ai.reason}.</>} Extracted values always wait for a person to approve them before export.
          </p>
          <button type="submit">Save</button>
        </form>
      </div>
    </main>
  );
}
