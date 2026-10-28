import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildUniverseWorkbook, editedBaseName, editedVersionOf, editedFileName } from "../server/universe-export";

describe("edited universe names", () => {
  it("takes the original name, without extension or an earlier edit suffix", () => {
    expect(editedBaseName("Lebanon_Combined.csv")).toBe("Lebanon_Combined");
    expect(editedBaseName("Damascus Outlets Sept 2026.xlsx")).toBe("Damascus Outlets Sept 2026");
    expect(editedBaseName("Lebanon_Combined Universe Edited v.3.xlsx")).toBe("Lebanon_Combined");
    expect(editedBaseName("erbil universe edited v2.xlsx")).toBe("erbil");
    expect(editedBaseName(null)).toBe("RouteOptima");
  });
  it("carries on from the version an uploaded edited file already has", () => {
    expect(editedVersionOf("Lebanon_Combined.csv")).toBe(0);
    expect(editedVersionOf("Lebanon_Combined Universe Edited v.3.xlsx")).toBe(3);
    expect(editedVersionOf("x Universe Edited v.12.csv")).toBe(12);
  });
  it("names the file '<name> Universe Edited v.N.xlsx', safe for any file system", () => {
    expect(editedFileName("Lebanon_Combined", 1)).toBe("Lebanon_Combined Universe Edited v.1.xlsx");
    expect(editedFileName('Baghdad: "east" / west', 2)).toBe("Baghdad east west Universe Edited v.2.xlsx");
    expect(editedFileName("بغداد", 4)).toBe("بغداد Universe Edited v.4.xlsx");
  });
});

describe("edited universe workbook", () => {
  const outlets = [
    { name: "Al Salam Market", code: "C1", address: "Hamra", latitude: 33.89, longitude: 35.48, visitFrequency: 2, timePerVisit: 12, channel: "Grocery", repId: "r1", territory: "Territory 1" },
    { name: "Cedar Pharmacy", code: "C2", address: "", latitude: 33.9, longitude: 35.5, visitFrequency: 4, timePerVisit: 15, channel: null, repId: null, territory: "Excluded" },
    { name: "Far Kiosk", code: null, address: null, latitude: 34.4, longitude: 35.8, visitFrequency: 1, timePerVisit: 8, channel: "Kiosk", repId: null, territory: "Needs Review", geoStatus: "offset" },
  ];
  const buf = buildUniverseWorkbook({
    outlets, reps: [{ id: "r1", name: "Rep 1", code: "REP001", territory: "Territory 1" }],
    sourceFile: "beirut.csv", fileName: "beirut Universe Edited v.1.xlsx", version: 1, editsSinceSave: 5, savedAt: new Date("2026-10-28T10:00:00Z"),
  });
  const wb = XLSX.read(buf, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Universe"]);

  it("keeps the uploader's own column names, so the file uploads again as it is", () => {
    expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(["Outlet Code", "Outlet Name", "Latitude", "Longitude", "VF", "Channel", "Time Per Visit"]));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ "Outlet Name": "Al Salam Market", Latitude: 33.89, VF: 2, "Assigned Rep": "Rep 1", "Rep Code": "REP001", "Plan Status": "Active" });
  });
  it("marks excluded and held outlets instead of dropping them", () => {
    expect(rows[1]["Plan Status"]).toBe("Excluded");
    expect(rows[2]["Plan Status"]).toBe("Held for review");
  });
  it("does not use a column the uploader would read as a territory", () => {
    // The uploader takes District / Territory / Zone / Region as the territory.
    for (const k of Object.keys(rows[0])) expect(["district", "territory", "zone", "region"]).not.toContain(k.toLowerCase().replace(/[_\s]+/g, ""));
  });
  it("says what the file is on an About sheet", () => {
    const about = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["About"], { header: 1 });
    expect(about.find(r => r[0] === "Version")?.[1]).toBe("v.1");
    expect(about.find(r => r[0] === "Based on")?.[1]).toBe("beirut.csv");
    expect(about.find(r => r[0] === "Edits since the last save")?.[1]).toBe(5);
  });
});
