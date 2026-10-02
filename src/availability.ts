import type { AvailabilityEntry, AvailabilityResult, AvailabilityValue, Coded } from "./types.js";

/** The order from worst to least: a meter reading's `status` is reduced
 * to one of these so two entries on the same meter can be compared.
 * `unknown` is a no-op and never the worst status, because an entry with
 * status "unknown" cannot move a route. */
const WORST_STATUS: Readonly<Record<AvailabilityValue, number>> = {
  ok: 0,
  unmetered: -1,
  unknown: -1,
  projected: 1,
  exhausted: 2,
};

const REASON_PROJECTED: Coded = {
  code: "meter-projected",
  fix: "Top the meter back up before the work runs, or remove the meter from the route.",
  message: "the route's meter is projected to exhaust",
};

const REASON_PROJECTED_SPEND_TO_ZERO: Coded = {
  code: "meter-projected-spend-to-zero",
  fix: "The route is on a spend-to-zero meter and keeps its place; top the meter back up to clear it.",
  message:
    "the route's meter is projected to exhaust on a spend-to-zero meter; the route keeps its place",
};

const REASON_EXHAUSTED: Coded = {
  code: "meter-exhausted",
  fix: "Top the meter back up, or remove the meter from the route.",
  message: "the route's meter is exhausted",
};

const WARNING_EXHAUSTED_ALL: Coded = {
  code: "availability-exhausted-all",
  fix: "Top at least one meter's quota back up so a route can run.",
  message: "exhaustion would remove every route; none was removed and each carries exhausted",
};

/** Combine several entries on one meter into one effective state. The
 * worst status decides, then the lowest `percentRemaining` ties it. The
 * function returns the per-meter state; routes use it to decide their
 * final value. */
function combineMeterEntries(entries: readonly AvailabilityEntry[]): {
  percentRemaining: number | undefined;
  status: AvailabilityValue;
} {
  let worstStatus: AvailabilityValue = "ok";
  let worstRank = WORST_STATUS.ok;
  let lowestPercent: number | undefined;
  let seen = false;
  for (const entry of entries) {
    const entryRank = WORST_STATUS[entry.status];
    if (entryRank === undefined) continue;
    seen = true;
    if (entryRank > worstRank) {
      worstStatus = entry.status;
      worstRank = entryRank;
      // The lowest percent that came with the worst status still decides
      // a same-status tie; an entry that did not set the worst keeps
      // its percent in reserve only if its status still matches. We
      // record it below.
      lowestPercent =
        typeof entry.percentRemaining === "number" && Number.isFinite(entry.percentRemaining)
          ? entry.percentRemaining
          : undefined;
    } else if (entryRank === worstRank) {
      if (
        typeof entry.percentRemaining === "number" &&
        Number.isFinite(entry.percentRemaining) &&
        (lowestPercent === undefined || entry.percentRemaining < lowestPercent)
      ) {
        lowestPercent = entry.percentRemaining;
      }
    }
  }
  if (!seen) {
    return { percentRemaining: undefined, status: "unknown" };
  }
  return { percentRemaining: lowestPercent, status: worstStatus };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Group the input entries by meter. Several entries on one meter reduce
 * to one combined state via `combineMeterEntries`. An entry with a status
 * outside `ok`/`projected`/`exhausted` is treated as unknown for that
 * meter (and skipped with no warning - the CLI's reader handles that,
 * and graybox and the engine are expected to filter before calling). */
function groupByMeter(
  entries: readonly AvailabilityEntry[],
): Map<string, { percentRemaining: number | undefined; status: AvailabilityValue }> {
  const map = new Map<string, AvailabilityEntry[]>();
  for (const entry of entries) {
    if (typeof entry.meter !== "string" || entry.meter.length === 0) continue;
    const list = map.get(entry.meter) ?? [];
    list.push(entry);
    map.set(entry.meter, list);
  }
  const out = new Map<
    string,
    { percentRemaining: number | undefined; status: AvailabilityValue }
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
function routeState<
  R extends {
    readonly availability: AvailabilityValue;
    readonly label: string;
    readonly meter?: string;
    readonly reasons?: readonly Coded[];
  },
>(
  route: R,
  meterStates: ReadonlyMap<
    string,
    { percentRemaining: number | undefined; status: AvailabilityValue }
  >,
  spendToZero: ReadonlySet<string>,
): {
  availability: AvailabilityValue | "preserve";
  group: "kept" | "demoted" | "removed";
  reason: Coded | undefined;
} {
  if (route.meter === undefined) {
    return { availability: "unmetered", group: "kept", reason: undefined };
  }
  const meterState = meterStates.get(route.meter);
  if (meterState === undefined) {
    // Only an entry moves a route: no covering entry, preserve value and
    // place. The caller passes routes with the engine's first-pass
    // availability ("unknown" for metered routes); keeping it here
    // means the route stays in its group and keeps "unknown".
    return { availability: "preserve", group: "kept", reason: undefined };
  }
  if (meterState.status === "exhausted") {
    return { availability: "exhausted", group: "removed", reason: REASON_EXHAUSTED };
  }
  if (meterState.status === "projected") {
    if (spendToZero.has(route.meter)) {
      return {
        availability: "projected",
        group: "kept",
        reason: REASON_PROJECTED_SPEND_TO_ZERO,
      };
    }
    return { availability: "projected", group: "demoted", reason: REASON_PROJECTED };
  }
  return { availability: "ok", group: "kept", reason: undefined };
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
 * observe in the result.
 */
export function applyAvailability<
  R extends {
    readonly availability: AvailabilityValue;
    readonly label: string;
    readonly meter?: string;
    readonly reasons?: readonly Coded[];
  },
>(
  routes: readonly R[],
  entries: readonly AvailabilityEntry[],
  options?: { readonly spendToZero?: readonly string[] },
): AvailabilityResult<R> {
  const spendToZero = new Set(options?.spendToZero ?? []);
  const meterStates = groupByMeter(entries);

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
  // The all-exhausted case: nothing is removed, every route keeps
  // `exhausted` (with the meter-exhausted reason it would have carried),
  // and the engine-level warning is added.
  const allExhausted = removedCount > 0 && removedCount === routes.length;
  if (allExhausted) {
    warnings.push(WARNING_EXHAUSTED_ALL);
  }

  const newRoutes: R[] = [];
  const removedList: { label: string; reason: Coded }[] = [];

  // Two passes in input order: kept first (preserving input order among
  // themselves), then demoted (also preserving input order). The all-
  // exhausted case rewrites the demoted/removed routes into the kept
  // bucket with "exhausted" availability, so this same loop still
  // produces the right answer.
  const finalize = (
    decision: (typeof decisions)[number],
    newAvailability: AvailabilityValue,
  ): void => {
    const { route, reason, group } = decision;
    if (group === "removed" && !allExhausted) {
      removedList.push({ label: route.label, reason: reason ?? REASON_EXHAUSTED });
      return;
    }
    const reasons = reason === undefined ? undefined : [...(route.reasons ?? []), reason];
    const availabilityChanged = route.availability !== newAvailability;
    // Preserve the caller's object when nothing changes: returning the
    // same reference is part of the "only an entry moves a route"
    // contract.
    if (!availabilityChanged && reasons === undefined) {
      newRoutes.push(route);
      return;
    }
    const out = isPlainObject(route)
      ? ({
          ...route,
          availability: newAvailability,
          ...(reasons === undefined ? {} : { reasons }),
        } as R)
      : route;
    newRoutes.push(out);
  };

  for (const decision of decisions) {
    if (decision.group !== "kept") continue;
    const availability =
      decision.availability === "preserve" ? decision.route.availability : decision.availability;
    finalize(decision, availability);
  }
  for (const decision of decisions) {
    if (decision.group !== "demoted") continue;
    finalize(decision, "projected");
  }
  if (allExhausted) {
    for (const decision of decisions) {
      if (decision.group === "removed") finalize(decision, "exhausted");
    }
  } else {
    for (const decision of decisions) {
      if (decision.group === "removed") {
        removedList.push({
          label: decision.route.label,
          reason: decision.reason ?? REASON_EXHAUSTED,
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
 * warning, but the engine treats the document as best-effort data). */
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
