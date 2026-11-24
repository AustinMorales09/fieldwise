"use server";

import { redirect } from "next/navigation";
import { myOrg } from "./access";
import { db } from "./db";
import { QBO, backfill, providerById } from "./integrations";
import { disconnect, drain, getConn, retryFailed, settingsOf, updateConn, ctxFor } from "./integrations/core";
import { connectSimulator, startUrl } from "./integrations/connect";
import { loadAccounts, type QboSettings } from "./integrations/quickbooks";
import { sbExpireTokens } from "./integrations/sandbox";

const q = (m: string) => encodeURIComponent(m);
const back = (extra = "") => `/integrations${extra ? `?${extra}` : ""}`;

async function target(form: FormData) {
  const org = await myOrg();
  const p = providerById(String(form.get("provider")));
  if (!p) redirect(back(`error=${q("Unknown integration")}`));
  return { org, p };
}

export async function connectProvider(form: FormData) {
  const { org, p } = await target(form);
  if (form.get("mode") !== "live") {
    const r = await connectSimulator(p, org.id);
    redirect(back("error" in r ? `error=${q(r.error)}#${p.id}` : `done=${q(`Connected ${p.name} (simulator)`)}#${p.id}`));
  }
  let url: string;
  try {
    url = await startUrl(p, org.id);
  } catch (err) {
    redirect(back(`error=${q(err instanceof Error ? err.message : "Can't connect")}`));
  }
  redirect(url);
}

export async function disconnectProvider(form: FormData) {
  const { org, p } = await target(form);
  disconnect(org.id, p.id);
  redirect(back(`done=${q(`Disconnected ${p.name}`)}`));
}

export async function syncNow(form: FormData) {
  const { org, p } = await target(form);
  const n = await drain(org.id, { provider: p.id });
  redirect(back(`done=${q(n ? `Ran ${n} job${n > 1 ? "s" : ""} for ${p.name}` : "Nothing was waiting")}#${p.id}`));
}

export async function sendAllApproved(form: FormData) {
  const { org, p } = await target(form);
  if (!getConn(org.id, p.id)) redirect(back());
  const n = backfill(org.id, p.id);
  const ran = await drain(org.id, { provider: p.id });
  redirect(back(`done=${q(`${p.name}: queued ${n} approved document${n === 1 ? "" : "s"}; ${ran} job${ran === 1 ? "" : "s"} ran`)}#${p.id}`));
}

export async function retryFailedJobs(form: FormData) {
  const { org, p } = await target(form);
  retryFailed(org.id, p.id);
  const n = await drain(org.id, { provider: p.id });
  redirect(back(`done=${q(`${p.name}: retried, ${n} job${n === 1 ? "" : "s"} ran`)}#${p.id}`));
}

export async function saveQuickBooks(form: FormData) {
  const org = await myOrg();
  const c = getConn(org.id, QBO);
  if (!c) redirect(back());
  const s = settingsOf<QboSettings>(c);
  const accountId = String(form.get("account_id") ?? "");
  const names = new Set((db.prepare("SELECT name FROM templates WHERE org_id = ?").all(org.id) as { name: string }[]).map((t) => t.name));
  const templates = form.getAll("templates").map(String).filter((t) => names.has(t));
  if (!s.accounts.some((a) => a.id === accountId)) redirect(back(`error=${q("Choose an expense account")}#${QBO}`));
  updateConn(c, { settings: { ...s, accountId, templates } });
  redirect(back(`done=${q("QuickBooks settings saved")}#${QBO}`));
}

export async function reloadQuickBooksAccounts() {
  const org = await myOrg();
  const c = getConn(org.id, QBO);
  if (!c) redirect(back());
  try {
    await loadAccounts(c, ctxFor(org.id, QBO, c.mode));
  } catch (err) {
    redirect(back(`error=${q(err instanceof Error ? err.message : "Couldn't load accounts")}#${QBO}`));
  }
  redirect(back(`done=${q("Accounts reloaded")}#${QBO}`));
}

/** Simulator only: expire the access token so the next call shows the refresh-on-401 path. */
export async function expireSandboxToken(form: FormData) {
  const { org, p } = await target(form);
  const c = getConn(org.id, p.id);
  if (c?.mode === "sandbox") sbExpireTokens(p.id, org.id);
  redirect(back(`done=${q("Access token expired in the simulator. The next sync will get a 401 and refresh it.")}#${p.id}`));
}

