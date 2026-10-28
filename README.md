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

## RTM Studio: the plan in two clicks

The dashboard opens on **RTM Studio**.

1. **Drop the outlet list.** The upload runs at once and the *blueprint*
   appears: where the market is and how dense, the channels it holds and
   their call times, the data checks to fix first (wrong-country GPS points,
   missing frequencies, duplicates), and the recommended setup - working
   week (from the country), visits a day (from a workload model: call time
   plus travel time against an 8-hour shift), how days are balanced (by
   visit count, or by working time when calls differ), and team-size options
   with the visits and hours each gives. Anything can be changed; the team
   options recompute as you type.
2. **Build my RTM.** The whole engine runs as one background job and returns
   a graded plan (A-D) with its KPIs - coverage, visits and km a day, workday
   hours against the shift, route and territory overlap, rep balance, long
   drives - plain-language checks, a per-rep table, and the **journey plan**
   workbook (summary, every stop with date and map link, a sheet per rep, each
   rep-day's load, the outlet master).

The detailed, step-by-step controls are still on the dashboard under
*Detailed planning controls*: plan settings on the file already loaded (no
second upload), duplicate and outlier exclusions, the role hierarchy, and
the results tabs.

**Edited universe.** After deleting or moving outlets with the lasso on the
Territory Map, *Save edited universe* downloads the list as it stands now as
`<file> Universe Edited v.N.xlsx`, with each outlet's rep and status. The
button counts the edits not yet saved; the version goes up with each save,
and uploading an edited file carries on from its version.

| Endpoint | Purpose |
|---|---|
| `GET /api/rtm/blueprint` | The blueprint for the outlets loaded; `?days=6,7,1&min=25&max=30&balanceBy=time&hop=4` recomputes it with the planner's edits |
| `POST /api/rtm/autopilot` | Plan with the blueprint's setup (background job); `{ overrides: {...} }` replaces any field, `reps` fixes the team size |
| `GET /api/plan/scorecard` | Grade, KPIs, checks and per-rep figures of the plan loaded |
| `GET /api/export/pjp` | The journey-plan workbook |
| `GET /api/universe` | The working file, edits since the last save, and the next "Universe Edited" file name |
| `POST /api/universe/save` | Save the edited universe as `<file> Universe Edited v.N.xlsx` (planners and admins) |

## How the engine plans

Each stage keeps the best of several methods, judged by driving distance
inside the visits band; nothing is kept that breaks the band to save a
kilometre.

- **Data.** Geographic outliers by the real gap between outlets, with towns
  allowed to connect to the market through each other. Channels recognised
  in English and Arabic; call time from the file, else by channel.
- **Team size.** Workload model (calls x call time + travel between calls,
  from local outlet density) against the shift; when no whole number of reps
  fits the band, the nearest one, with an overload weighed more than a light day.
- **Balancing.** By visit count, or by working time: each outlet weighs its
  call minutes plus the driving to reach it, scaled so the average outlet is
  one visit.
- **Territories.** Capacitated assignment solved exactly as a min-cost flow
  (OR-Tools) inside Lloyd iterations with restarts, then compactness swaps,
  cohesion and tour-length polishing and load repair; against it, a
  recursive straight-line partition (36 directions a level, ranked by a
  Beardwood-Halton-Hammersley tour estimate) whose territories cannot
  overlap. Then pocket exchange between reps and a feedback pass from the
  day cuts.
- **Days.** Pieces reachable within the hop limit get their fair share of
  days; each piece is cut by the flow solver (Hilbert curve as fallback),
  village-aware where villages dominate, improved by swaps, recuts and a
  periodic-VRP local search (segment relocation and CROSS exchange priced by
  re-toured days), and compared with a straight-line cut. Days are then
  sequenced so consecutive working days are neighbours (exact up to eight
  days, nearest neighbour plus 2-opt beyond).
- **Weeks.** A day's outlets are shared between alternating weeks by a
  straight cut wherever that keeps both weeks in band and drives no more
  than 4% further, so the two routes never cross.
- **Route order.** Nearest neighbour, 2-opt, Or-opt and 3-opt; on real road
  distances from OSRM when `OSRM_URL` is set.

## Workflow

1. **Upload** a CSV/XLSX with `Outlet Name, Latitude, Longitude` (optional:
   `vf` 1/2/4 visit frequency, `vc`/`value` commercial weight, address,
   district). In a workbook, the first sheet with coordinate columns is read
   and the others are named in the upload report; a file without a `vf`
   column is reported as assumed biweekly. Outlets separated from every other
   outlet by more than 30 km (a "Tripoli" geocoded to Libya, a warehouse in
   another city) are flagged for review — never silently used or removed.
   Distant towns that connect to the market through other towns are kept.
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
   band and the hop limit, then each day is ordered as a tour. Days, and
   the alternating weeks within a day, are cut by straight lines wherever
   that drives no more than four percent further, so routes do not overlap.
   Visit frequencies rotate across the cycle's repeats. When the visits band
   cannot be met with a whole number of reps, days are held within ten
   percent of the achievable average and the plan says so.
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
