import { randomBytes, randomUUID } from "crypto";
import { loadBlob, saveBlob } from "./persist";
import { hashPassword, safeEquals, readStoredAdmin } from "./admin-credentials";

/**
 * Accounts, roles and sessions.
 *
 * Roles:
 *   admin   - everything, including managing accounts
 *   planner - upload, optimize, edit plans, export
 *   viewer  - read-only: maps, schedules, exports
 *
 * Users and sessions live in the app's blob store (Postgres on the published
 * site, a JSON file in development), so a sign-in survives a restart and is
 * valid on every instance. The old single admin - SUPERUSER_* secrets or
 * data/admin.json - is imported as the first admin account the first time
 * this runs with no users, so nobody is locked out by the upgrade.
 */
export type Role = "admin" | "planner" | "viewer";
export const ROLES: Role[] = ["admin", "planner", "viewer"];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  salt: string;
  hash: string;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

export type PublicUser = Omit<User, "salt" | "hash">;

interface Session {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

const BLOB_KEY = "auth";
const SESSION_DAYS = 30;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

export const toPublic = (u: User): PublicUser => {
  const { salt: _s, hash: _h, ...rest } = u;
  return rest;
};

export const canEdit = (role: Role | undefined) => role === "admin" || role === "planner";

class AuthStore {
  private users = new Map<string, User>();
  private sessions = new Map<string, Session>();
  private failures = new Map<string, { count: number; until: number }>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> | null = null;
  private dirty = false;

  load(): Promise<void> {
    if (!this.loaded) this.loaded = this.doLoad();
    return this.loaded;
  }

  private async doLoad() {
    try {
      const text = await loadBlob(BLOB_KEY);
      if (text) {
        const raw = JSON.parse(text);
        for (const u of raw.users || []) this.users.set(u.id, u);
        for (const s of raw.sessions || []) this.sessions.set(s.token, s);
      }
    } catch (err) {
      console.error("[auth] Could not read accounts, starting empty:", (err as Error).message);
    }
    this.pruneSessions();
    if (this.users.size === 0) await this.bootstrapFromLegacyAdmin();
    console.log(`[auth] ${this.users.size} account(s), ${this.sessions.size} session(s)`);
  }

  /** The first run after the upgrade: turn the old single admin into an account. */
  private async bootstrapFromLegacyAdmin() {
    const envEmail = process.env.SUPERUSER_EMAIL;
    const envPassword = process.env.SUPERUSER_PASSWORD;
    if (envEmail && envPassword) {
      this.createUser({ email: envEmail, name: "Admin", role: "admin", password: envPassword });
      console.log("[auth] Imported the SUPERUSER_* admin as the first account");
      return;
    }
    const stored = readStoredAdmin();
    if (stored) {
      const id = randomUUID();
      this.users.set(id, {
        id, email: stored.email, name: "Admin", role: "admin", salt: stored.salt, hash: stored.hash,
        isActive: true, createdAt: new Date().toISOString(), lastLoginAt: null, mustChangePassword: false,
      });
      this.dirty = true;
      await this.save();
      console.log("[auth] Imported data/admin.json as the first account");
    }
  }

  private async save() {
    if (this.saving) { await this.saving; if (!this.dirty) return; }
    this.dirty = false;
    this.saving = saveBlob(BLOB_KEY, JSON.stringify({
      users: Array.from(this.users.values()),
      sessions: Array.from(this.sessions.values()),
    })).catch(err => console.error("[auth] save failed:", (err as Error).message)).finally(() => { this.saving = null; });
    await this.saving;
  }

  private touch() { this.dirty = true; void this.save(); }

  // ---- users ----
  setupRequired(): boolean { return this.users.size === 0; }
  listUsers(): PublicUser[] {
    return Array.from(this.users.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toPublic);
  }
  getUser(id: string): User | undefined { return this.users.get(id); }
  findByEmail(email: string): User | undefined {
    const e = email.trim().toLowerCase();
    return Array.from(this.users.values()).find(u => u.email === e);
  }

  createUser(input: { email: string; name: string; role: Role; password: string; mustChangePassword?: boolean }): PublicUser {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError(400, "That does not look like an email address");
    if (this.findByEmail(email)) throw new AuthError(409, "An account with that email already exists");
    if (!ROLES.includes(input.role)) throw new AuthError(400, "Role must be admin, planner or viewer");
    checkPassword(input.password);
    const salt = randomBytes(16).toString("hex");
    const user: User = {
      id: randomUUID(), email, name: (input.name || "").trim() || email.split("@")[0], role: input.role,
      salt, hash: hashPassword(input.password, salt), isActive: true,
      createdAt: new Date().toISOString(), lastLoginAt: null, mustChangePassword: !!input.mustChangePassword,
    };
    this.users.set(user.id, user);
    this.touch();
    return toPublic(user);
  }

  updateUser(id: string, patch: { name?: string; role?: Role; isActive?: boolean; password?: string }, actor: User): PublicUser {
    const user = this.users.get(id);
    if (!user) throw new AuthError(404, "No such account");
    if (patch.role !== undefined && !ROLES.includes(patch.role)) throw new AuthError(400, "Role must be admin, planner or viewer");
    const losesAdmin = user.role === "admin" && ((patch.role !== undefined && patch.role !== "admin") || patch.isActive === false);
    if (losesAdmin && this.activeAdmins().length <= 1) throw new AuthError(400, "That is the only active admin; make someone else an admin first");
    if (id === actor.id && (patch.isActive === false || (patch.role !== undefined && patch.role !== "admin"))) {
      throw new AuthError(400, "You cannot deactivate or demote your own account");
    }
    if (patch.name !== undefined) user.name = patch.name.trim() || user.name;
    if (patch.role !== undefined) user.role = patch.role;
    if (patch.isActive !== undefined) {
      user.isActive = patch.isActive;
      if (!patch.isActive) this.destroySessionsForUser(id);
    }
    if (patch.password !== undefined) {
      checkPassword(patch.password);
      user.salt = randomBytes(16).toString("hex");
      user.hash = hashPassword(patch.password, user.salt);
      user.mustChangePassword = id !== actor.id; // a reset by an admin has to be changed on first sign-in
      if (id !== actor.id) this.destroySessionsForUser(id);
    }
    this.touch();
    return toPublic(user);
  }

  deleteUser(id: string, actor: User): void {
    const user = this.users.get(id);
    if (!user) throw new AuthError(404, "No such account");
    if (id === actor.id) throw new AuthError(400, "You cannot delete your own account");
    if (user.role === "admin" && user.isActive && this.activeAdmins().length <= 1) throw new AuthError(400, "That is the only active admin");
    this.users.delete(id);
    this.destroySessionsForUser(id);
    this.touch();
  }

  changeOwnPassword(user: User, current: string, next: string): void {
    if (!safeEquals(hashPassword(current, user.salt), user.hash)) throw new AuthError(400, "The current password is wrong");
    checkPassword(next);
    user.salt = randomBytes(16).toString("hex");
    user.hash = hashPassword(next, user.salt);
    user.mustChangePassword = false;
    this.touch();
  }

  private activeAdmins(): User[] { return Array.from(this.users.values()).filter(u => u.role === "admin" && u.isActive); }

  // ---- sign in ----
  verifyLogin(email: unknown, password: unknown): User {
    if (typeof email !== "string" || typeof password !== "string") throw new AuthError(400, "Email and password are required");
    const key = email.trim().toLowerCase();
    const lock = this.failures.get(key);
    if (lock && lock.until > Date.now()) {
      throw new AuthError(429, `Too many failed attempts. Try again in ${Math.ceil((lock.until - Date.now()) / 60000)} minute(s).`);
    }
    const user = this.findByEmail(key);
    const ok = !!user && user.isActive && safeEquals(hashPassword(password, user.salt), user.hash);
    if (!ok) {
      const f = this.failures.get(key) ?? { count: 0, until: 0 };
      f.count++;
      if (f.count >= LOCK_AFTER) { f.until = Date.now() + LOCK_MINUTES * 60000; f.count = 0; }
      this.failures.set(key, f);
      throw new AuthError(401, user && !user.isActive ? "This account has been deactivated" : "Wrong email or password");
    }
    this.failures.delete(key);
    user!.lastLoginAt = new Date().toISOString();
    this.touch();
    return user!;
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    this.sessions.set(token, {
      token, userId, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_DAYS * 86400000).toISOString(), lastSeenAt: new Date(now).toISOString(),
    });
    this.touch();
    return token;
  }

  resolveSession(token: string | undefined | null): User | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() < Date.now()) { this.sessions.delete(token); this.touch(); return null; }
    const user = this.users.get(s.userId);
    if (!user || !user.isActive) return null;
    // Sliding expiry, written at most every ten minutes.
    if (Date.now() - new Date(s.lastSeenAt).getTime() > 10 * 60000) {
      s.lastSeenAt = new Date().toISOString();
      s.expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
      this.touch();
    }
    return user;
  }

  destroySession(token: string | undefined | null): void {
    if (token && this.sessions.delete(token)) this.touch();
  }

  destroySessionsForUser(userId: string): void {
    let n = 0;
    for (const [t, s] of Array.from(this.sessions.entries())) if (s.userId === userId) { this.sessions.delete(t); n++; }
    if (n) this.touch();
  }

  private pruneSessions() {
    const now = Date.now();
    for (const [t, s] of Array.from(this.sessions.entries())) if (new Date(s.expiresAt).getTime() < now) this.sessions.delete(t);
  }
}

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function checkPassword(p: string) {
  if (typeof p !== "string" || p.length < 8) throw new AuthError(400, "Passwords need at least 8 characters");
}

export const authStore = new AuthStore();
