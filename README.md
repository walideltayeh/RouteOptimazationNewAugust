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
| `DATABASE_URL` | production | Postgres connection for all app state (outlets, plans, accounts, sessions). Without it the state lives in `data/` on disk, which an Autoscale deployment wipes on restart. |
| `SUPERUSER_EMAIL` / `SUPERUSER_PASSWORD` | optional | Seeds the first admin account on a fresh install - see [Accounts](#accounts). |
| `VITE_MAPBOX_TOKEN` | for map pages | Territory Map / Rep Map rendering ([free token](https://account.mapbox.com/access-tokens/)). |
| `OSRM_URL` | for road distances | An OSRM routing server, e.g. `https://router.project-osrm.org` (public demo: fine for trials, not for production) or a self-hosted one with the country's map extract. With it, the "Road distances" mode prices every pair of a rep's outlets by road: day cuts, hop limit, stop order, kilometres, and the playback follows real streets. |
| `OSRM_MAX_TABLE` | optional | Coordinates per table request (default 100, the demo server's cap). Raise it on a self-hosted server started with `--max-table-size` to fetch a rep's matrix in one request. |

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
3. **Run optimization**: geographic zones → balanced rep territories → per-rep
   day routes. A territory pocket that sits inside a neighbour's area is handed
   to that neighbour, paid for with adjoining outlets, so no rep drives through
   another rep's streets. Each rep's territory is then cut into day-groups and
   improved as a periodic vehicle-routing problem: outlets and runs of outlets
   are relocated and exchanged between days by what the day tours cost to
   drive (road distances when `OSRM_URL` is set), within the visits-per-day
   band and the hop limit, then each day is ordered as a tour. Visit
   frequencies rotate across the cycle's repeats.
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
| `POST /api/optimize` | Full optimization, run as a background job: answers `202 {jobId}`; poll `GET /api/jobs/:id`. Body: `workingDays`, `minVisitsPerDay`, `maxVisitsPerDay`, `cycleMode`, `planMonth`, `monthEdges`, `maxHopKm`, `weightMode`, `distanceMode`, `excludedOutletIds`, `maxZoneRadiusKm` |
| `POST /api/reoptimize` | Rebuild every rep's routes with the saved settings (background job) |
| `GET /api/jobs/active` | The running job, if any; `GET /api/jobs/:id` for one job |
| `POST /api/reps/reassign-outlets` | Move outlets to another rep + auto-rework affected schedules |
| `POST /api/outlets/:id/move-to-route` | Put one outlet on a chosen day route and pin it there |
| `GET /api/schedules`, `/api/reps`, `/api/outlets`, `/api/plan-settings` | Current plan data |
| `GET /api/export/territories`, `/api/export/schedules` | Excel exports |
| `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id` | Accounts (admin only) |

Every `/api` route needs a signed-in user except sign-in, `/api/health` and the
map token. Planners and admins may change data; viewers may only read.

## Accounts

Three roles: **admin** (everything, including accounts), **planner** (upload,
optimize, edit plans, export) and **viewer** (read-only). Accounts and sessions
live in the app's state store, so they survive restarts and work on every
instance once `DATABASE_URL` is set.

On a fresh install the first visitor is asked to create the admin account in
the app. If `SUPERUSER_EMAIL` / `SUPERUSER_PASSWORD` are set (Replit Secrets or
`.env`), or `data/admin.json` exists from `npm run set-admin`, that admin is
imported as the first account instead; afterwards those values are not
consulted. Admins add further accounts on the Accounts page with a temporary
password the person must replace at first sign-in. No credential is ever
stored in this repository.

## Development

```bash
npm run check   # typecheck (client, server, shared, tests)
npm test        # vitest: unit tests plus an end-to-end API test on a temp data dir
npm run build   # client bundle + server bundle into dist/
```

The tests cover the cycle math (`server/cycle.ts`), the day balancer, the
accounts store, background jobs, the blob store, and the app end to end:
first-run setup, roles, upload, a background optimization, exports, and a
pinned route move. GitHub Actions runs typecheck, tests and build on every
push to `main` and every pull request (`.github/workflows/ci.yml`).
