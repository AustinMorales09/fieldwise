import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const dataDir = process.env.DATA_DIR ?? (process.env.VERCEL ? demoDataDir() : path.join(process.env.APP_DIR ?? process.cwd(), "data"));

// Vercel deployments are read-only: copy the bundled demo snapshot (seed/) to /tmp once per instance and work there.
// Changes last as long as the instance does, so the public demo resets itself.
function demoDataDir(): string {
  const dir = "/tmp/data";
  const seed = path.join(process.cwd(), "seed");
  if (!fs.existsSync(path.join(dir, "app.db")) && fs.existsSync(seed)) fs.cpSync(seed, dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const filesDir = path.join(dataDir, "files");

function init(): DatabaseSync {
  fs.mkdirSync(filesDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "app.db"));
  db.exec(`
    PRAGMA busy_timeout = 5000; -- first, so parallel build workers wait instead of failing
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS orgs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL,
      ai_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    -- fields: JSON array of { key, label, type, required, id, hint }.  table_cols: JSON array of { key, label, type } or '[]'.
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      fields TEXT NOT NULL,
      table_label TEXT NOT NULL DEFAULT '',
      table_cols TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    -- status: needs_review (extracted, waiting for a person) | approved | rejected | needs_ai (can't be read without Claude) | failed
    -- data: { key: value }   meta: { key: { confidence, evidence, evidence_ok } }   rows: [{ col: value }]   checks: [{ level, field, message }]
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      stored_as TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'needs_review',
      data TEXT NOT NULL DEFAULT '{}',
      meta TEXT NOT NULL DEFAULT '{}',
      rows TEXT NOT NULL DEFAULT '[]',
      checks TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT '',
      error TEXT,
      edited INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_docs_org ON documents(org_id, template_id, status);
  `);
  return db;
}

const g = globalThis as unknown as { __db?: DatabaseSync };
export const db = g.__db ?? (g.__db = init());

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export type Org = { id: number; user_id: number; name: string; timezone: string; ai_enabled: number; created_at: number };
export type TemplateRow = { id: number; org_id: number; name: string; description: string; fields: string; table_label: string; table_cols: string; created_at: number };
export type DocStatus = "needs_review" | "approved" | "rejected" | "needs_ai" | "failed";
export type DocRow = {
  id: number; org_id: number; template_id: number; name: string; mime: string; size: number; stored_as: string; text: string; status: DocStatus;
  data: string; meta: string; rows: string; checks: string; source: string; error: string | null; edited: number; created_at: number; reviewed_at: number | null;
};
