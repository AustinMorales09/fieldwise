// Fieldwise's integrations. Importing this module registers the job handlers and the simulators.
import { db } from "../db";
import { enqueue, getConn, kick, type Conn } from "./core";
import { EXCEL, excel } from "./excel";
import type { Provider } from "./provider";
import { QBO, quickbooks } from "./quickbooks";
import "./sim-excel";
import "./sim-quickbooks";

export const PROVIDERS: Provider[] = [quickbooks, excel];
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

export function connections(ownerId: number): Conn[] {
  return PROVIDERS.map((p) => getConn(ownerId, p.id)).filter((c): c is Conn => !!c);
}

/** Called when a document is approved (or re-approved after edits): queue it for every connected destination. */
export async function documentApproved(ownerId: number, docId: number) {
  const conns = connections(ownerId);
  for (const c of conns) enqueue(ownerId, c.provider, "push_doc", docId, { docId });
  if (conns.length) await kick(ownerId);
}

/** Queue every approved document (first connect, or after changing which templates are sent). */
export function backfill(ownerId: number, provider: string): number {
  const ids = db.prepare("SELECT id FROM documents WHERE org_id = ? AND status = 'approved' ORDER BY id").all(ownerId) as { id: number }[];
  for (const { id } of ids) enqueue(ownerId, provider, "push_doc", id, { docId: id });
  return ids.length;
}

export { EXCEL, QBO };
