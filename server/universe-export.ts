/**
 * The edited outlet universe as a file: what is left after lasso deletes,
 * with each outlet's rep after lasso moves, named "<file> Universe Edited
 * v.N". Column headers are the uploader's own (Outlet Code, Outlet Name,
 * Latitude, Longitude, VF, Channel, Time Per Visit...), so the saved file
 * can be uploaded again as it is; the assignment columns use names the
 * uploader does not read, so they inform without changing a re-upload.
 */
import * as XLSX from "xlsx";

const EDITED = /\s*Universe Edited v\.?\s*(\d+)\s*$/i;

/** The original name behind an upload: no extension, no " Universe Edited v.N". */
export function editedBaseName(fileName: string | null | undefined): string {
  const stem = String(fileName ?? "").replace(/\.(xlsx|xls|csv)$/i, "").trim();
  return stem.replace(EDITED, "").trim() || "RouteOptima";
}

/** The version an uploaded file already carries: 3 for "X Universe Edited v.3.xlsx", else 0. */
export function editedVersionOf(fileName: string | null | undefined): number {
  const m = EDITED.exec(String(fileName ?? "").replace(/\.(xlsx|xls|csv)$/i, ""));
  return m ? parseInt(m[1], 10) : 0;
}

export function editedFileName(base: string, version: number): string {
  // Characters a file system or a header would choke on become spaces.
  const safe = base.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "RouteOptima";
  return `${safe} Universe Edited v.${version}.xlsx`;
}

export interface UniverseOutlet {
  name: string; code?: string | null; address?: string | null; latitude: number; longitude: number;
  visitFrequency: number; timePerVisit?: number | null; channel?: string | null; value?: number | null;
  territory?: string | null; geoStatus?: string | null; repId?: string | null;
}

export function buildUniverseWorkbook(inp: {
  outlets: UniverseOutlet[];
  reps: { id: string; name: string; code?: string | null; territory?: string | null }[];
  sourceFile: string | null;
  fileName: string;
  version: number;
  editsSinceSave: number;
  savedAt: Date;
}): Buffer {
  const repById = new Map(inp.reps.map(r => [r.id, r]));
  const hasValue = inp.outlets.some(o => o.value != null);
  const header = ["Outlet Code", "Outlet Name", "Address", "Latitude", "Longitude", "VF", "Channel", "Time Per Visit",
    ...(hasValue ? ["Value"] : []), "Assigned Rep", "Rep Code", "Assigned Territory", "Plan Status"];
  let active = 0, excluded = 0, held = 0;
  const rows = inp.outlets.map(o => {
    const rep = o.repId ? repById.get(o.repId) : undefined;
    const status = o.territory === "Excluded" ? "Excluded"
      : (o.geoStatus === "offset" || o.territory === "Needs Review") ? "Held for review" : "Active";
    if (status === "Active") active++; else if (status === "Excluded") excluded++; else held++;
    return [o.code ?? "", o.name, o.address ?? "", o.latitude, o.longitude, o.visitFrequency, o.channel ?? "", o.timePerVisit ?? "",
      ...(hasValue ? [o.value ?? ""] : []), rep?.name ?? "", rep?.code ?? "", rep ? (rep.territory || "") : "", status];
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map(h => ({ wch: h === "Outlet Name" ? 34 : h === "Address" ? 30 : h.length < 8 ? 9 : 14 }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, "Universe");

  const about = XLSX.utils.aoa_to_sheet([
    ["RouteOptima outlet universe"],
    [],
    ["File", inp.fileName],
    ["Version", `v.${inp.version}`],
    ["Saved", inp.savedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC"],
    ["Based on", inp.sourceFile ?? "—"],
    ["Outlets", inp.outlets.length],
    ["Active", active],
    ["Held for review", held],
    ["Excluded from the plan", excluded],
    ["Edits since the last save", inp.editsSinceSave],
    [],
    ["Upload this file again to plan from the edited universe. The Assigned Rep, Rep Code, Assigned Territory and Plan Status columns are for reference; a new plan assigns reps afresh."],
  ]);
  about["!cols"] = [{ wch: 26 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, about, "About");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}
