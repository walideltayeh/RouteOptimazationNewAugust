import fs from "fs";
import path from "path";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * Admin credentials for the app.
 *
 * This repository is public, so credentials must never live in the source. They
 * come from one of two places, checked in this order:
 *
 *   1. SUPERUSER_EMAIL + SUPERUSER_PASSWORD environment variables
 *      (Replit Secrets, or a local .env file - both are gitignored).
 *   2. data/admin.json, written by `npm run set-admin`. The password is stored
 *      as a salted scrypt hash, never in plain text, and data/ is gitignored.
 *
 * If neither is present, admin login is disabled and the UI says so instead of
 * silently rejecting every attempt.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");

interface StoredAdmin {
  email: string;
  salt: string;
  hash: string;
  updatedAt: string;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

/** Constant-time comparison so a wrong password can't be found by timing. */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function readStoredAdmin(): StoredAdmin | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf-8"));
    if (parsed?.email && parsed?.salt && parsed?.hash) return parsed as StoredAdmin;
    return null;
  } catch {
    return null;
  }
}

/** Writes (or replaces) the stored admin. Used by `npm run set-admin`. */
export function setAdminCredentials(email: string, password: string): void {
  const salt = randomBytes(16).toString("hex");
  const record: StoredAdmin = {
    email: email.trim().toLowerCase(),
    salt,
    hash: hashPassword(password, salt),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ADMIN_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ADMIN_FILE);
}

export function isAdminConfigured(): boolean {
  const envEmail = process.env.SUPERUSER_EMAIL;
  const envPassword = process.env.SUPERUSER_PASSWORD;
  if (envEmail && envPassword) return true;
  return readStoredAdmin() !== null;
}

/** Where the active credentials came from - for the startup log only. */
export function adminCredentialSource(): "env" | "file" | "none" {
  if (process.env.SUPERUSER_EMAIL && process.env.SUPERUSER_PASSWORD) return "env";
  return readStoredAdmin() ? "file" : "none";
}

export function verifyAdmin(email: unknown, password: unknown): boolean {
  if (typeof email !== "string" || typeof password !== "string") return false;
  const candidate = email.trim().toLowerCase();

  const envEmail = process.env.SUPERUSER_EMAIL;
  const envPassword = process.env.SUPERUSER_PASSWORD;
  if (envEmail && envPassword) {
    return safeEquals(candidate, envEmail.trim().toLowerCase())
      && safeEquals(password, envPassword);
  }

  const stored = readStoredAdmin();
  if (!stored) return false;
  if (!safeEquals(candidate, stored.email)) return false;
  return safeEquals(hashPassword(password, stored.salt), stored.hash);
}
