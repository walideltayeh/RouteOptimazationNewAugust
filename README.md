# RouteOptima — Sales Rep Route Optimization

Upload an outlet list, set how your reps work, and get balanced, geographically
tight day-routes for every rep — with schedule management, reassignment, and
data-quality review built in.

## Quick start

```bash
npm install
cp .env.example .env   # fill in admin credentials + Mapbox token
npm run dev            # serves app + API on http://localhost:5000
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SUPERUSER_EMAIL` / `SUPERUSER_PASSWORD` | optional | Admin login. Alternative to `npm run set-admin` - see [Admin login](#admin-login). |
| `VITE_MAPBOX_TOKEN` | for map pages | Territory Map / Rep Map rendering ([free token](https://account.mapbox.com/access-tokens/)). |
| `OSRM_URL` | optional | Self-hosted OSRM server for true road distances in road-aware mode. |

## Workflow

1. **Upload** a CSV/XLSX with `Outlet Name, Latitude, Longitude` (optional:
   `vf` 1/2/4 visit frequency, `vc`/`value` commercial weight, address,
   district). Outlets with GPS points far outside the market's core area are
   flagged for review — never silently used or removed.
2. **Set parameters**: working days/week, min/max **actual visits per day**
   (visit-frequency aware: with biweekly outlets, zones are sized so the due
   share each week hits your target), coverage weighting, and the distance
   model (straight-line, or road-aware with barrier penalties, e.g. the
   Tigris in Baghdad).
3. **Run optimization**: geographic zones (15 km tightness cap) → balanced
   rep territories (±10% monthly-visit workload) → per-day routes with
   VF1/VF2/VF4 weekly rotation and TSP ordering.
4. **Review**: territory balance report, suggested low-worth pockets for
   indirect coverage, and flagged geographic outliers — tick what to exclude
   and re-run; nothing is removed without your choice.
5. **Manage**: move outlets between reps (`POST /api/reps/reassign-outlets`
   or the map UI) — schedules for the affected reps rework automatically,
   with over-capacity warnings and suggested cascade moves.

## Key API endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/upload` | Import outlets (multipart `file`) |
| `POST /api/optimize` | Full optimization. Body: `workingDaysPerWeek`, `minVisitsPerDay`, `maxVisitsPerDay`, `weightMode`, `distanceMode`, `excludedOutletIds`, `balanceTolerancePct`, `maxZoneRadiusKm`, `geoOutlierRadiusKm` |
| `POST /api/reps/reassign-outlets` | Move outlets to another rep + auto-rework affected schedules |
| `POST /api/reoptimize` | Rebuild all schedules from current ownership |
| `GET /api/schedules`, `/api/reps`, `/api/outlets` | Current plan data |
| `GET /api/export/schedules` | Excel export |

## Admin login

Admin credentials are never stored in this repository. Set them once, on the
machine running the app, in either of two ways.

**Option A - one command (recommended):**

```bash
npm run set-admin -- you@example.com "choose-a-strong-password"
```

Then restart the app. The password is salted and hashed with scrypt into
`data/admin.json`, which is gitignored, so the plain password is never written
to disk or committed.

**Option B - environment variables** (Replit Secrets, or a local `.env`):

```
SUPERUSER_EMAIL=you@example.com
SUPERUSER_PASSWORD=choose-a-strong-password
```

Environment variables take precedence over `data/admin.json` when both exist.

If neither is configured, admin sign-in is disabled and the login dialog tells
you how to fix it rather than rejecting every attempt as a bad password.
