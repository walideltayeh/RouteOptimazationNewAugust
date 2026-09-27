import * as fs from "fs";
import * as path from "path";

/**
 * Durable key/value blobs for the app's state: the storage snapshot, the plan
 * settings, the scenario index and each scenario's snapshot.
 *
 * Why this exists: the published site runs on a Replit Autoscale deployment,
 * whose filesystem is rebuilt from the workspace at each deploy and wiped
 * whenever an instance restarts. Everything the app kept under data/ - every
 * uploaded file, every plan - was silently lost on the next restart, and the
 * site came back up with whatever data/ held at deploy time: an Erbil file
 * from months ago. When a DATABASE_URL is present the blobs live in Postgres;
 * without one (local development, this sandbox) they stay on disk exactly as
 * before.
 */
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DATABASE_URL = process.env.DATABASE_URL;

type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;
let sqlClient: Sql | null | undefined;
let tableReady: Promise<void> | null = null;

async function sql(): Promise<Sql | null> {
  if (sqlClient !== undefined) return sqlClient;
  if (!DATABASE_URL) { sqlClient = null; return null; }
  try {
    const { neon } = await import("@neondatabase/serverless");
    sqlClient = neon(DATABASE_URL) as unknown as Sql;
    tableReady = (async () => {
      await sqlClient!`CREATE TABLE IF NOT EXISTS app_blobs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    })();
    await tableReady;
    console.log("[persist] Using Postgres for app state");
    return sqlClient;
  } catch (err) {
    console.error("[persist] Postgres unavailable, falling back to disk:", (err as Error).message);
    sqlClient = null;
    return null;
  }
}

export function usingDatabase(): boolean {
  return !!DATABASE_URL;
}

const fileFor = (key: string) => path.join(DATA_DIR, key.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json");

export async function loadBlob(key: string): Promise<string | null> {
  const db = await sql();
  if (db) {
    try {
      const rows = await db`SELECT value FROM app_blobs WHERE key = ${key}`;
      return rows.length > 0 ? String(rows[0].value) : null;
    } catch (err) {
      console.error(`[persist] read ${key} failed:`, (err as Error).message);
      return null;
    }
  }
  try {
    const p = fileFor(key);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
  } catch {
    return null;
  }
}

export async function saveBlob(key: string, value: string): Promise<void> {
  const db = await sql();
  if (db) {
    try {
      await db`INSERT INTO app_blobs (key, value, updated_at) VALUES (${key}, ${value}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      return;
    } catch (err) {
      console.error(`[persist] write ${key} failed (keeping a disk copy):`, (err as Error).message);
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const p = fileFor(key);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, p);
}

export async function deleteBlob(key: string): Promise<void> {
  const db = await sql();
  if (db) {
    try { await db`DELETE FROM app_blobs WHERE key = ${key}`; return; } catch { /* fall through */ }
  }
  try { fs.unlinkSync(fileFor(key)); } catch { /* already gone */ }
}
