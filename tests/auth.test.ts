import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

type AuthModule = typeof import("../server/auth");

async function freshStore(env: Record<string, string | undefined> = {}): Promise<AuthModule> {
  vi.resetModules();
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ro-auth-"));
  delete process.env.DATABASE_URL;
  delete process.env.SUPERUSER_EMAIL;
  delete process.env.SUPERUSER_PASSWORD;
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const mod = await import("../server/auth");
  await mod.authStore.load();
  return mod;
}

describe("accounts", () => {
  let auth: AuthModule;
  beforeEach(async () => { auth = await freshStore(); });

  it("starts empty and needs setup", () => {
    expect(auth.authStore.setupRequired()).toBe(true);
    expect(auth.authStore.listUsers()).toEqual([]);
  });

  it("creates accounts with validated input and never exposes the hash", () => {
    const u = auth.authStore.createUser({ email: " Boss@Co.com ", name: "Boss", role: "admin", password: "longenough" });
    expect(u.email).toBe("boss@co.com");
    expect((u as any).hash).toBeUndefined();
    expect((u as any).salt).toBeUndefined();
    expect(() => auth.authStore.createUser({ email: "boss@co.com", name: "x", role: "viewer", password: "longenough" })).toThrow(/already exists/);
    expect(() => auth.authStore.createUser({ email: "nope", name: "x", role: "viewer", password: "longenough" })).toThrow(/email/);
    expect(() => auth.authStore.createUser({ email: "a@b.co", name: "x", role: "viewer", password: "short" })).toThrow(/8 characters/);
    expect(() => auth.authStore.createUser({ email: "a@b.co", name: "x", role: "god" as any, password: "longenough" })).toThrow(/Role/);
  });

  it("signs in, locks after five failures, and unlocks the right account only", () => {
    auth.authStore.createUser({ email: "a@b.co", name: "A", role: "planner", password: "correct-horse" });
    auth.authStore.createUser({ email: "c@d.co", name: "C", role: "viewer", password: "another-one" });
    expect(auth.authStore.verifyLogin("A@B.CO", "correct-horse").role).toBe("planner");
    for (let i = 0; i < 5; i++) expect(() => auth.authStore.verifyLogin("a@b.co", "wrong")).toThrow(/Wrong email or password/);
    expect(() => auth.authStore.verifyLogin("a@b.co", "correct-horse")).toThrow(/Too many failed attempts/);
    expect(auth.authStore.verifyLogin("c@d.co", "another-one").role).toBe("viewer"); // others unaffected
  });

  it("sessions resolve to the user, expire, and are destroyed on deactivation", () => {
    const u = auth.authStore.createUser({ email: "a@b.co", name: "A", role: "planner", password: "correct-horse" });
    const token = auth.authStore.createSession(u.id);
    expect(auth.authStore.resolveSession(token)?.id).toBe(u.id);
    expect(auth.authStore.resolveSession("nonsense")).toBeNull();
    const admin = auth.authStore.createUser({ email: "z@b.co", name: "Z", role: "admin", password: "correct-horse" });
    auth.authStore.updateUser(u.id, { isActive: false }, auth.authStore.getUser(admin.id)!);
    expect(auth.authStore.resolveSession(token)).toBeNull();
    expect(() => auth.authStore.verifyLogin("a@b.co", "correct-horse")).toThrow(/deactivated/);
  });

  it("protects the last admin and the actor's own account", () => {
    const admin = auth.authStore.createUser({ email: "a@b.co", name: "A", role: "admin", password: "correct-horse" });
    const actor = auth.authStore.getUser(admin.id)!;
    expect(() => auth.authStore.updateUser(admin.id, { role: "viewer" }, actor)).toThrow(/only active admin/);
    expect(() => auth.authStore.deleteUser(admin.id, actor)).toThrow(/own account/);
    const second = auth.authStore.createUser({ email: "b@b.co", name: "B", role: "admin", password: "correct-horse" });
    expect(() => auth.authStore.updateUser(admin.id, { role: "viewer" }, actor)).toThrow(/own account/);
    auth.authStore.updateUser(second.id, { role: "planner" }, actor); // fine: admin remains
    expect(auth.authStore.getUser(second.id)!.role).toBe("planner");
  });

  it("an admin's password reset forces a change at next sign-in; own change does not", () => {
    const admin = auth.authStore.createUser({ email: "a@b.co", name: "A", role: "admin", password: "correct-horse" });
    const actor = auth.authStore.getUser(admin.id)!;
    const u = auth.authStore.createUser({ email: "u@b.co", name: "U", role: "viewer", password: "first-pass1" });
    auth.authStore.updateUser(u.id, { password: "temp-pass-99" }, actor);
    expect(auth.authStore.getUser(u.id)!.mustChangePassword).toBe(true);
    expect(() => auth.authStore.verifyLogin("u@b.co", "first-pass1")).toThrow();
    const user = auth.authStore.verifyLogin("u@b.co", "temp-pass-99");
    expect(() => auth.authStore.changeOwnPassword(user, "wrong", "brand-new-1")).toThrow(/current password/);
    auth.authStore.changeOwnPassword(user, "temp-pass-99", "brand-new-1");
    expect(auth.authStore.getUser(u.id)!.mustChangePassword).toBe(false);
    expect(auth.authStore.verifyLogin("u@b.co", "brand-new-1").id).toBe(u.id);
  });

  it("persists accounts and sessions across a reload", async () => {
    const u = auth.authStore.createUser({ email: "a@b.co", name: "A", role: "admin", password: "correct-horse" });
    const token = auth.authStore.createSession(u.id);
    await new Promise(r => setTimeout(r, 50)); // the store writes on its own tick
    const dir = process.env.DATA_DIR!;
    vi.resetModules();
    process.env.DATA_DIR = dir;
    const again = await import("../server/auth");
    await again.authStore.load();
    expect(again.authStore.listUsers().map(x => x.email)).toEqual(["a@b.co"]);
    expect(again.authStore.resolveSession(token)?.email).toBe("a@b.co");
  });

  it("imports the legacy SUPERUSER_* admin as the first account", async () => {
    const mod = await freshStore({ SUPERUSER_EMAIL: "Legacy@Co.com", SUPERUSER_PASSWORD: "legacy-pass-1" });
    expect(mod.authStore.setupRequired()).toBe(false);
    const user = mod.authStore.verifyLogin("legacy@co.com", "legacy-pass-1");
    expect(user.role).toBe("admin");
  });

  it("canEdit is true for admin and planner only", () => {
    expect(auth.canEdit("admin")).toBe(true);
    expect(auth.canEdit("planner")).toBe(true);
    expect(auth.canEdit("viewer")).toBe(false);
    expect(auth.canEdit(undefined)).toBe(false);
  });
});
