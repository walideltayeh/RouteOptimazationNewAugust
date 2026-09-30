import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let persist: typeof import("../server/persist");

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ro-persist-"));
  delete process.env.DATABASE_URL;
  persist = await import("../server/persist");
});

describe("blob store on disk", () => {
  it("round-trips a blob and reports disk mode", async () => {
    expect(persist.usingDatabase()).toBe(false);
    expect(persist.persistenceMode()).toBe("disk");
    await persist.saveBlob("thing", JSON.stringify({ a: 1 }));
    expect(JSON.parse((await persist.loadBlob("thing"))!)).toEqual({ a: 1 });
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, "thing.json"))).toBe(true);
  });
  it("returns null for a missing key and deletes cleanly", async () => {
    expect(await persist.loadBlob("nope")).toBeNull();
    await persist.saveBlob("gone", "x");
    await persist.deleteBlob("gone");
    expect(await persist.loadBlob("gone")).toBeNull();
    await persist.deleteBlob("gone"); // idempotent
  });
  it("sanitises keys into file names", async () => {
    await persist.saveBlob("scenario:abc/def", "1");
    expect(await persist.loadBlob("scenario:abc/def")).toBe("1");
    const files = fs.readdirSync(process.env.DATA_DIR!);
    expect(files.some(f => f.includes("/"))).toBe(false);
  });
});
