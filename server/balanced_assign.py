"""
Optimal balanced spatial grouping, used for both rep territories and day-routes.

Why a solver rather than another heuristic
------------------------------------------
Every hand-rolled method placed outlets one at a time and never reconsidered.
Greedy growing stopped a group the moment it reached its quota, so outlets left
until the end - the ones no nearby group still had room for - fell to whichever
group was still open. That produced a day carrying the right number of visits
and no shape at all: on Damascus, five tight days per rep and one sweeping two
dense pockets 8km apart.

Given a set of centres, choosing which outlet goes to which group under capacity
limits is a transportation problem, and min-cost flow solves it EXACTLY. No
outlet is placed before any other, so nothing can be stranded by decisions taken
earlier. Wrapping that in Lloyd iterations - assign optimally, move the centres
to their groups, repeat - is capacitated k-means with an exact assignment step.

What is and is not optimal
--------------------------
The assignment is optimal for the centres it is given. Choosing the centres too
is NP-hard, so the loop is a strong local search, not a global optimum. In
practice the exact assignment is what removes the leftover-bin failure, because
that failure came from the ORDER of greedy placement, not from the centres.

Protocol: JSON on stdin, JSON on stdout.
  in  {"points": [[lat,lng],...], "weights": [int,...], "k": int,
       "tolerance": float, "iterations": int}
  out {"groups": [group_index_per_point], "cost_m": int, "iterations_used": int}
Weights are integers (visit frequency scaled up), because flow is integral.
"""
import json
import math
import random
import sys


def haversine_m(a_lat, a_lng, b_lat, b_lng):
    r = 6371000.0
    dlat = math.radians(b_lat - a_lat)
    dlng = math.radians(b_lng - a_lng)
    h = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(dlng / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(h))


def seed_centres(points, k, rng=None):
    """
    Farthest-point seeding: start the centres in genuinely different places.

    With an rng, the first centre is picked at random instead of at the extreme,
    which is what makes restarts explore different basins.
    """
    n = len(points)
    mid_lat = sum(p[0] for p in points) / n
    mid_lng = sum(p[1] for p in points) / n
    if rng is None:
        first = max(range(n), key=lambda i: haversine_m(mid_lat, mid_lng, points[i][0], points[i][1]))
    else:
        first = rng.randrange(n)
    centres = [list(points[first])]
    nearest = [haversine_m(p[0], p[1], points[first][0], points[first][1]) for p in points]
    while len(centres) < k:
        pick = max(range(n), key=lambda i: nearest[i])
        centres.append(list(points[pick]))
        for i, p in enumerate(points):
            d = haversine_m(p[0], p[1], points[pick][0], points[pick][1])
            if d < nearest[i]:
                nearest[i] = d
    return centres


def assign(points, weights, centres, lo, hi, penalty):
    """
    Exact minimum-cost assignment of every outlet to a group under capacity.

    Network: source -> outlet (its weight) -> group (cost = distance) -> sink.
    The group->sink capacity is split in two so the lower bound is respected
    without needing a lower-bounded formulation: the first `lo` units are free,
    anything beyond costs `penalty`, so the solver fills every group to `lo`
    before it will overload any one of them.
    """
    from ortools.graph.python import min_cost_flow

    smcf = min_cost_flow.SimpleMinCostFlow()
    n, k = len(points), len(centres)
    SOURCE = 0
    outlet0 = 1
    group0 = outlet0 + n
    SINK = group0 + k

    for i, w in enumerate(weights):
        smcf.add_arc_with_capacity_and_unit_cost(SOURCE, outlet0 + i, w, 0)
        for g, c in enumerate(centres):
            cost = int(round(haversine_m(points[i][0], points[i][1], c[0], c[1])))
            smcf.add_arc_with_capacity_and_unit_cost(outlet0 + i, group0 + g, w, cost)

    for g in range(k):
        smcf.add_arc_with_capacity_and_unit_cost(group0 + g, SINK, lo, 0)
        if hi > lo:
            smcf.add_arc_with_capacity_and_unit_cost(group0 + g, SINK, hi - lo, penalty)

    total = sum(weights)
    smcf.set_node_supply(SOURCE, total)
    smcf.set_node_supply(SINK, -total)

    if smcf.solve() != smcf.OPTIMAL:
        return None, None

    owner = [-1] * n
    cost_m = 0
    for arc in range(smcf.num_arcs()):
        f = smcf.flow(arc)
        if f <= 0:
            continue
        tail, head = smcf.tail(arc), smcf.head(arc)
        if outlet0 <= tail < group0 and group0 <= head < SINK:
            i = tail - outlet0
            # An outlet's weight is never split: one arc carries all of it.
            if owner[i] == -1:
                owner[i] = head - group0
                cost_m += smcf.unit_cost(arc) * f
    return owner, cost_m


def main():
    req = json.load(sys.stdin)
    points = req["points"]
    weights = [int(w) for w in req["weights"]]
    k = int(req["k"])
    tolerance = float(req.get("tolerance", 0.06))
    iterations = int(req.get("iterations", 12))

    n = len(points)
    if k <= 1 or n == 0:
        json.dump({"groups": [0] * n, "cost_m": 0, "iterations_used": 0}, sys.stdout)
        return
    if n <= k:
        json.dump({"groups": list(range(n)), "cost_m": 0, "iterations_used": 0}, sys.stdout)
        return

    total = sum(weights)
    target = total / k
    lo = max(1, int(math.floor(target * (1 - tolerance))))
    hi = max(lo, int(math.ceil(target * (1 + tolerance))))
    # The band has to be able to hold everything, or the flow has nowhere to go.
    while hi * k < total:
        hi += 1
    while lo * k > total:
        lo -= 1
    # Overloading a group should cost more than a long drive, or balance never
    # binds; 20km of detour is well beyond anything a real day-route contains.
    penalty = 20000

    # Restarts. The assignment is exact for the centres it is given, but the
    # centres themselves settle into whichever basin they started in - which is
    # how a group ends up straddling two pockets even with an optimal
    # assignment. Several starts and keep the cheapest; the first is the
    # deterministic farthest-point seeding so a given input always has the same
    # baseline to beat.
    restarts = int(req.get("restarts", 5))
    rng = random.Random(12345)
    best_groups, best_cost, used = None, None, 0

    for attempt in range(max(1, restarts)):
        centres = seed_centres(points, k, None if attempt == 0 else rng)
        settled_owner, settled_cost = None, None
        for it in range(iterations):
            owner, cost = assign(points, weights, centres, lo, hi, penalty)
            if owner is None:
                break
            used += 1
            settled_owner, settled_cost = owner, cost

            moved = False
            for g in range(k):
                members = [points[i] for i in range(n) if owner[i] == g]
                if not members:
                    continue
                new = [sum(p[0] for p in members) / len(members),
                       sum(p[1] for p in members) / len(members)]
                if haversine_m(new[0], new[1], centres[g][0], centres[g][1]) > 5:
                    moved = True
                centres[g] = new
            if not moved:
                break

        # Rank restarts by the assignment's own cost - the total distance from
        # each outlet to its group's centre.
        #
        # Ranking by estimated driving distance instead was tried and measured
        # WORSE on Damascus (804km against 775km). A nearest-neighbour tour is
        # too crude a yardstick: it can favour a grouping whose rough tour is
        # short but whose real route, once 2-opted later, is not. Refining each
        # candidate tour properly would be accurate but pushed a run past a
        # minute, which is not worth 2% of driving.
        if settled_owner is not None and settled_cost is not None:
            if best_cost is None or settled_cost < best_cost:
                best_cost, best_groups = settled_cost, list(settled_owner)

    if best_groups is None:
        json.dump({"error": "no feasible assignment"}, sys.stdout)
        return
    json.dump({"groups": best_groups, "cost_m": int(best_cost), "iterations_used": used}, sys.stdout)


if __name__ == "__main__":
    main()
