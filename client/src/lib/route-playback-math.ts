/**
 * The arithmetic behind route playback, kept free of Mapbox and React so it
 * can be tested on its own: distances along a route, and where a marker is
 * after driving a given number of kilometres.
 */
export interface Stop { id: string; name: string; lat: number; lng: number }

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Kilometres from stop 1 to each stop, in order; [0, d01, d01+d12, ...]. */
export function cumulativeKm(stops: Stop[]): number[] {
  const cum = [0];
  for (let i = 1; i < stops.length; i++) {
    cum.push(cum[i - 1] + haversineKm(stops[i - 1].lat, stops[i - 1].lng, stops[i].lat, stops[i].lng));
  }
  return cum;
}

export interface Position {
  lng: number;
  lat: number;
  /** Index of the last stop reached (0-based); -1 before the first. */
  reached: number;
  /** Fraction of the way along the current leg (0..1). */
  legT: number;
  /** Trail coordinates: every stop reached, then the current point. */
  trail: [number, number][];
}

/** Where the marker is after `km` along the route. Clamped to the route. */
export function positionAt(stops: Stop[], cum: number[], km: number): Position {
  if (stops.length === 0) return { lng: 0, lat: 0, reached: -1, legT: 0, trail: [] };
  const total = cum[cum.length - 1];
  const at = Math.max(0, Math.min(total, km));
  if (stops.length === 1 || at >= total) {
    const last = stops[stops.length - 1];
    return { lng: last.lng, lat: last.lat, reached: stops.length - 1, legT: 1, trail: stops.map(s => [s.lng, s.lat]) };
  }
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] <= at) i++;
  const legLen = cum[i + 1] - cum[i];
  const t = legLen > 0 ? (at - cum[i]) / legLen : 1;
  const a = stops[i], b = stops[i + 1];
  const lng = a.lng + (b.lng - a.lng) * t;
  const lat = a.lat + (b.lat - a.lat) * t;
  const trail: [number, number][] = stops.slice(0, i + 1).map(s => [s.lng, s.lat]);
  trail.push([lng, lat]);
  return { lng, lat, reached: i, legT: t, trail };
}

/** Driving minutes for a distance at an urban average speed. */
export function drivingMinutes(km: number, kmh = 25): number {
  return (km / kmh) * 60;
}
