import { describe, it, expect } from "vitest";
import { buildBlueprint, type BlueprintOutlet } from "../server/blueprint";

// A market around Beirut: `n` outlets on a grid `stepKm` apart.
const market = (n: number, stepKm: number): BlueprintOutlet[] => {
  const side = Math.ceil(Math.sqrt(n));
  return Array.from({ length: n }, (_, i) => ({
    id: `o${i}`, name: `Outlet ${i}`, territory: null, visitFrequency: 2, callMinutes: null, channel: null,
    latitude: 33.88 + (Math.floor(i / side) * stepKm) / 111, longitude: 35.5 + ((i % side) * stepKm) / 92.5,
  } as unknown as BlueprintOutlet));
};

describe("blueprint: the last plan's settings", () => {
  const city = market(400, 0.15), country = market(400, 2.5);
  const cityBand = buildBlueprint({ outlets: city }).setup;
  const countryBand = buildBlueprint({ outlets: country }).setup;

  it("suggests fewer visits a day where outlets are far apart", () => {
    expect(cityBand.bandSource).toBe("workload");
    expect(countryBand.maxVisitsPerDay).toBeLessThan(cityBand.maxVisitsPerDay);
  });

  it("keeps a band the planner typed for the next file of the same market", () => {
    const bp = buildBlueprint({ outlets: country, saved: { minVisitsPerDay: 26, maxVisitsPerDay: 30, country: buildBlueprint({ outlets: city }).market.country } });
    expect([bp.setup.minVisitsPerDay, bp.setup.maxVisitsPerDay]).toEqual([26, 30]);
    expect(bp.setup.bandSource).toBe("your last plan");
  });

  it("works out again a band the last file suggested for itself", () => {
    // One-click plan of the city, then the whole country is uploaded.
    const saved = { minVisitsPerDay: cityBand.minVisitsPerDay, maxVisitsPerDay: cityBand.maxVisitsPerDay, maxHopKm: cityBand.maxHopKm, bandAuto: true, hopAuto: true };
    const bp = buildBlueprint({ outlets: country, saved });
    expect(bp.setup.bandSource).toBe("workload");
    expect([bp.setup.minVisitsPerDay, bp.setup.maxVisitsPerDay]).toEqual([countryBand.minVisitsPerDay, countryBand.maxVisitsPerDay]);
    expect(bp.setup.maxHopKm).toBe(countryBand.maxHopKm);
    // And the same file planned twice gets the same suggestion.
    expect(buildBlueprint({ outlets: city, saved }).setup).toEqual(cityBand);
  });
});
