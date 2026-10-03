import type { AvailabilityEntry, AvailabilityResult, AvailabilityValue, Coded } from "./types.js";

const VALID_AVAILABILITY = new Set<AvailabilityValue>([
  "ok",
  "projected",
  "exhausted",
  "unknown",
  "unmetered",
]);

const KNOWN_STATUSES = new Set<AvailabilityValue>(["ok", "projected", "exhausted"]);

/** The shared engine usability rule, before grouping or warning about a meter. */
export function isUsableAvailabilityEntry(entry: AvailabilityEntry): boolean {
  return (
    typeof entry.meter === "string" &&
    entry.meter.length > 0 &&
    Object.hasOwn(entry, "status") &&
    KNOWN_STATUSES.has(entry.status)
  );
}

/** The order from worst to least: a meter reading's `status` is reduced
 * to one of these so two entries on the same meter can be compared.
 * `unknown` and `unmetered` are no-ops and never the worst status,
 * because they do not cover the meter. */
const WORST_STATUS: Readonly<Record<AvailabilityValue, number>> = {
  ok: 0,
  unmetered: -1,
  unknown: -1,
  projected: 1,
  exhausted: 2,
};

function reasonMessage(
  code: string,
  meter: string,
  percent: number | undefined,
  resetsAt: string | undefined,
): string {
  const tail =
    percent !== undefined && resetsAt !== undefined
      ? ` (${percent}% remaining, resets at ${resetsAt})`
      : percent !== undefined
        ? ` (${percent}% remaining)`
        : resetsAt !== undefined
          ? ` (resets at ${resetsAt})`
          : "";
  if (code === "meter-exhausted") {
    return `the route's meter "${meter}" is exhausted${tail}`;
  }
  if (code === "meter-projected-spend-to-zero") {
    return `the route's meter "${meter}" is projected to exhaust on a spend-to-zero meter; the route keeps its place${tail}`;
  }
  return `the route's meter "${meter}" is projected to exhaust${tail}`;
}

function buildReason(
  code: string,
  fix: string,
  meter: string,
  percent: number | undefined,
  resetsAt: string | undefined,
): Coded {
  return { code, fix, message: reasonMessage(code, meter, percent, resetsAt) };
}

const FIX_EXHAUSTED = "Top the meter back up, or remove the meter from the route.";
const FIX_PROJECTED =
  "Top the meter back up before the work runs, or remove the meter from the route.";
const FIX_PROJECTED_SPEND_TO_ZERO =
  "The route is on a spend-to-zero meter and keeps its place; top the meter back up to clear it.";

const REASON_PROJECTED = (
  meter: string,
  percent: number | undefined,
  resetsAt: string | undefined,
): Coded => buildReason("meter-projected", FIX_PROJECTED, meter, percent, resetsAt);

const REASON_PROJECTED_SPEND_TO_ZERO = (
  meter: string,
  percent: number | undefined,
  resetsAt: string | undefined,
): Coded =>
  buildReason(
    "meter-projected-spend-to-zero",
    FIX_PROJECTED_SPEND_TO_ZERO,
    meter,
    percent,
    resetsAt,
  );

const REASON_EXHAUSTED = (
  meter: string,
  percent: number | undefined,
  resetsAt: string | undefined,
): Coded => buildReason("meter-exhausted", FIX_EXHAUSTED, meter, percent, resetsAt);

const WARNING_EXHAUSTED_ALL: Coded = {
  code: "availability-exhausted-all",
  fix: "Top at least one meter's quota back up so a route can run.",
  message: "exhaustion would remove every route; none was removed and each carries exhausted",
};

/** Combine several entries on one meter into one effective state. The worst
 * status decides, then the lowest `percentRemaining` ties it. An entry
 * without a percent settles behind an entry with a percent: a partial
 * reading loses the tie to a complete one when the statuses match. The
 * deciding entry's percent and resetsAt surface on the reason so the
 * consumer can see why the route moved. */
function combineMeterEntries(entries: readonly AvailabilityEntry[]): {
  percentRemaining: number | undefined;
  resetsAt: string | undefined;
  status: AvailabilityValue;
} {
  let worstStatus: AvailabilityValue = "ok";
  let worstRank = WORST_STATUS.ok;
  let winningResetsAt: string | undefined;
  let winningPercent: number | undefined;
  let seen = false;
  for (const entry of entries) {
    const entryRank = WORST_STATUS[entry.status];
    if (entryRank === undefined) continue;
    seen = true;
    const entryPercent =
      typeof entry.percentRemaining === "number" && Number.isFinite(entry.percentRemaining)
        ? entry.percentRemaining
        : undefined;
    if (entryRank > worstRank) {
      worstStatus = entry.status;
      worstRank = entryRank;
      winningPercent = entryPercent;
      winningResetsAt = typeof entry.resetsAt === "string" ? entry.resetsAt : undefined;
    } else if (entryRank === worstRank) {
      if (entryPercent !== undefined) {
        if (winningPercent === undefined || entryPercent < winningPercent) {
          winningPercent = entryPercent;
          winningResetsAt = typeof entry.resetsAt === "string" ? entry.resetsAt : undefined;
        }
      }
    }
  }
  if (!seen) {
    return { percentRemaining: undefined, resetsAt: undefined, status: "unknown" };
  }
  return {
    percentRemaining: winningPercent,
    resetsAt: winningResetsAt,
    status: worstStatus,
  };
}

/** Group the input entries by meter. Several entries on one meter reduce
 * to one combined state via `combineMeterEntries`. An entry whose status
 * is not one of the three known statuses does not cover the meter: the
 * route the entry names keeps its first-pass availability. */
function groupByMeter(entries: readonly AvailabilityEntry[]): Map<
  string,
  {
    percentRemaining: number | undefined;
    resetsAt: string | undefined;
    status: AvailabilityValue;
  }
> {
  const map = new Map<string, AvailabilityEntry[]>();
  for (const entry of entries) {
    if (!isUsableAvailabilityEntry(entry)) continue;
    const list = map.get(entry.meter) ?? [];
    list.push(entry);
    map.set(entry.meter, list);
  }
  const out = new Map<
    string,
    {
      percentRemaining: number | undefined;
      resetsAt: string | undefined;
      status: AvailabilityValue;
    }
  >();
  for (const [meter, list] of map) {
    out.set(meter, combineMeterEntries(list));
  }
  return out;
}

/** Decide the route's final availability, the reason to append (if any),
 * and the group it lands in: `kept` (in input order, at the top),
 * `demoted` (projected, off the spend-to-zero list, at the bottom of
 * the kept group), or `removed` (exhausted). The function reads only
 * `label` and `meter` on the route, but the caller passes the whole
 * object so the returned routes carry the new `availability` and
 * reasons. The original route's `availability` field is honored only
 * when no entry covers the meter (the "only an entry moves a route"
 * rule). */
function routeState<R extends { readonly label: string; readonly meter?: string }>(
  route: R,
  meterStates: ReadonlyMap<
    string,
    {
      percentRemaining: number | undefined;
      resetsAt: string | undefined;
      status: AvailabilityValue;
    }
  >,
  spendToZero: ReadonlySet<string>,
): {
  availability: AvailabilityValue | "preserve";
  group: "kept" | "demoted" | "removed";
  reason: Coded | undefined;
} {
  if (route.meter === undefined) {
    return { availability: "preserve", group: "kept", reason: undefined };
  }
  const meterState = meterStates.get(route.meter);
  if (meterState === undefined) {
    // Only an entry moves a route: no covering entry, preserve value and place.
    return { availability: "preserve", group: "kept", reason: undefined };
  }
  if (meterState.status === "exhausted") {
    return {
      availability: "exhausted",
      group: "removed",
      reason: REASON_EXHAUSTED(route.meter, meterState.percentRemaining, meterState.resetsAt),
    };
  }
  if (meterState.status === "projected") {
    if (spendToZero.has(route.meter)) {
      return {
        availability: "projected",
        group: "kept",
        reason: REASON_PROJECTED_SPEND_TO_ZERO(
          route.meter,
          meterState.percentRemaining,
          meterState.resetsAt,
        ),
      };
    }
    return {
      availability: "projected",
      group: "demoted",
      reason: REASON_PROJECTED(route.meter, meterState.percentRemaining, meterState.resetsAt),
    };
  }
  return { availability: "ok", group: "kept", reason: undefined };
}

/** Filter the route's existing meter reasons: a re-applying call that
 * covers the route's meter replaces the old meter reason with this call's one. Other reasons (such as `floor-not-met`) survive. The function
 * is pure and reads each reason's `code`. */
function replaceMeterReasons<R extends { readonly reasons?: readonly Coded[] }>(
  route: R,
  next: Coded | undefined,
): readonly Coded[] | undefined {
  const existing = route.reasons;
  const filtered = (existing ?? []).filter(
    (reason) =>
      reason.code !== "meter-projected" &&
      reason.code !== "meter-projected-spend-to-zero" &&
      reason.code !== "meter-exhausted",
  );
  if (next === undefined) {
    if (existing === undefined && filtered.length === 0) return undefined;
    return filtered.length === existing?.length ? existing : filtered;
  }
  const replacement = [...filtered, next];
  if (
    existing?.length === replacement.length &&
    existing.every((reason, index) => {
      const other = replacement[index];
      return (
        other !== undefined &&
        reason.code === other.code &&
        reason.message === other.message &&
        reason.fix === other.fix &&
        reason.field === other.field
      );
    })
  )
    return existing;
  return replacement;
}

/**
 * Apply the availability rule: each route gets its final `availability`
 * value, with any reason appended to its `reasons`. Healthy routes keep
 * their input order; demoted routes (projected, off the spend-to-zero
 * list) move below the healthy routes, in their input order among
 * themselves; exhausted routes are removed. The function reads only
 * `label` and `meter` on each route. The caller passes the engine's
 * first-pass availability (unmetered for unmetered routes, unknown for
 * metered routes without a covering entry), which the function
 * preserves when no entry covers the route's meter.
 *
 * Exhaustion that would empty the route list is a special case: nothing
 * is removed, every route keeps `exhausted`, and the
 * `availability-exhausted-all` warning is added. The function never
 * throws; a malformed input shape degrades to a no-op the caller can
 * observe in the result. Re-applying replaces a route's existing
 * meter reason with this call's one: only one meter reason per route
 * survives a walk, and other reasons (such as `floor-not-met`) are
 * kept.
 */
export function applyAvailability<R extends { readonly label: string; readonly meter?: string }>(
  routes: readonly R[],
  entries: readonly AvailabilityEntry[],
  options?: { readonly spendToZero?: readonly string[] },
): AvailabilityResult<R> {
  const spendToZero = new Set(options?.spendToZero ?? []);
  const meterStates = groupByMeter(entries);

  // First pass: decide each route's fate in input order.  The route's
  // first-pass availability is preserved on a "preserve" verdict so the
  // final route carries the engine's "unknown" or "unmetered". A
  // shallow copy is made only when the final route differs from the
  // input.
  const decisions: Array<{
    availability: AvailabilityValue | "preserve";
    group: "kept" | "demoted" | "removed";
    reason: Coded | undefined;
    route: R;
  }> = [];
  let removedCount = 0;
  for (const route of routes) {
    const decision = routeState(route, meterStates, spendToZero);
    decisions.push({
      availability: decision.availability,
      group: decision.group,
      reason: decision.reason,
      route,
    });
    if (decision.group === "removed") removedCount += 1;
  }

  const warnings: Coded[] = [];
  const allExhausted = removedCount > 0 && removedCount === routes.length;
  if (allExhausted) {
    warnings.push(WARNING_EXHAUSTED_ALL);
  }

  const newRoutes: Array<
    R & { readonly availability: AvailabilityValue; readonly reasons?: readonly Coded[] }
  > = [];
  const removedList: { label: string; reason: Coded }[] = [];

  const finalize = (decision: (typeof decisions)[number]): void => {
    const { route, reason } = decision;
    const view = route as { readonly availability?: unknown; readonly reasons?: readonly Coded[] };
    const ownAvailability =
      Object.hasOwn(route, "availability") &&
      VALID_AVAILABILITY.has(view.availability as AvailabilityValue);
    const availability =
      decision.availability === "preserve"
        ? ownAvailability
          ? (view.availability as AvailabilityValue)
          : route.meter === undefined
            ? "unmetered"
            : "unknown"
        : decision.availability;
    const reasons =
      decision.availability === "preserve" ? view.reasons : replaceMeterReasons(view, reason);
    if (ownAvailability && view.availability === availability && reasons === view.reasons) {
      newRoutes.push(
        route as R & {
          readonly availability: AvailabilityValue;
          readonly reasons?: readonly Coded[];
        },
      );
      return;
    }
    newRoutes.push(
      reasons === undefined ? { ...route, availability } : { ...route, availability, reasons },
    );
  };

  for (const decision of decisions) {
    if (decision.group !== "kept") continue;
    finalize(decision);
  }
  for (const decision of decisions) {
    if (decision.group !== "demoted") continue;
    finalize(decision);
  }
  if (allExhausted) {
    for (const decision of decisions) {
      if (decision.group === "removed") finalize(decision);
    }
  } else {
    for (const decision of decisions) {
      if (decision.group === "removed") {
        removedList.push({
          label: decision.route.label,
          reason:
            decision.reason ?? REASON_EXHAUSTED(decision.route.meter ?? "", undefined, undefined),
        });
      }
    }
  }

  return {
    removed: allExhausted ? [] : removedList,
    routes: newRoutes,
    warnings,
  };
}

/** Drop entries whose `resetsAt` has passed by the given clock. The
 * function reads `now` from the argument; the engine and consumers pass
 * their own clock. An entry with no `resetsAt` is kept. An entry whose
 * `resetsAt` cannot be parsed is kept too (the CLI reader reports a
 * warning, but the engine treats the document as best-effort data). An
 * entry whose `resetsAt` equals `now` is dropped: the boundary is
 * inclusive of `now`. */
export function dropExpired(entries: readonly AvailabilityEntry[], now: Date): AvailabilityEntry[] {
  const out: AvailabilityEntry[] = [];
  const nowMs = now.getTime();
  for (const entry of entries) {
    if (typeof entry.resetsAt === "string") {
      const resetMs = Date.parse(entry.resetsAt);
      if (!Number.isNaN(resetMs) && resetMs <= nowMs) continue;
    }
    out.push(entry);
  }
  return out;
}
