import {
  buildRouteLabel,
  type LoadedRegistry,
  loadRegistry,
  type Model,
  type Route,
} from "@dungle-scrubs/model-registry";
import { applyQueryDefaults, parseQuery } from "./query.js";
import { validateRouterSections } from "./sections.js";
import type {
  Answer,
  AnswerRoute,
  AvailabilityValue,
  Coded,
  PlacedBy,
  Query,
  RankOptions,
  Removed,
  RouterSections,
  TaskEntry,
  TaskSummary,
} from "./types.js";
import { ROUTER_VERSION } from "./version.js";

const REMOVAL_PRIVACY: Coded = {
  code: "privacy-secret-not-eligible",
  fix: "Mark the route's privacyEligible field true, or run the work without privacy: secret.",
  message: "privacy: secret material never goes to a route that is not privacyEligible",
};

const REMOVAL_FAMILY: Coded = {
  code: "family-excluded-by-query",
  fix: "Remove the family from excludeFamilies, or change the route's family.",
  message: "the route's family is in the query's excludeFamilies",
};

const REMOVAL_NEEDS: Coded = {
  code: "needs-not-satisfied",
  fix: "Add the missing capabilities to the route, or remove them from needs.",
  message: "the route does not list every capability the query needs",
};

const WARNING_LOCAL_OR_NOTHING: Coded = {
  code: "local-or-nothing",
  fix: "Either run the work locally, or do not do this work on this machine.",
  message:
    "privacy: secret keeps only privacyEligible routes and none survived the hard limits; the work runs locally or not at all",
};

function removalReason(base: Coded, field: string, message?: string): Coded {
  return { ...base, field, ...(message === undefined ? {} : { message }) };
}

function floorReason(rating: string, minimum: number, value: number | undefined): Coded {
  return {
    code: "floor-not-met",
    field: `$.minimums[${JSON.stringify(rating)}]`,
    message:
      value === undefined
        ? `the model has no value for rating "${rating}" (floor ${minimum})`
        : `the model's rating for "${rating}" is ${value}, below the floor ${minimum}`,
  };
}

interface FlatRoute {
  readonly cost: number | undefined;
  readonly family: string;
  readonly harness: string;
  readonly hosted: boolean;
  readonly label: string;
  readonly meter: string | undefined;
  readonly model: Model;
  readonly modelKey: string;
  readonly order: number;
  readonly provider: string | undefined;
  readonly ratings: Readonly<Record<string, number>>;
  readonly route: Route;
  readonly routeIndex: number;
  readonly responseSeconds: number | undefined;
}

interface Floor {
  readonly minimum: number;
  readonly rating: string;
}

function resolveRegistry(option: RankOptions["registry"]): LoadedRegistry {
  if (typeof option === "string") return loadRegistry({ path: option });
  if (option !== undefined) return option;
  return loadRegistry();
}

function rejectByHardLimit(
  route: Route,
  family: string,
  privacy: Query["privacy"],
  excludeFamilies: readonly string[],
  needs: readonly string[],
): Coded | null {
  if (privacy === "secret" && route.privacyEligible !== true) {
    return REMOVAL_PRIVACY;
  }
  if (excludeFamilies.includes(family)) {
    return removalReason(REMOVAL_FAMILY, `$.excludeFamilies[${JSON.stringify(family)}]`);
  }
  const needsCapabilities = new Set(route.capabilities ?? []);
  const missing = needs.filter((capability) => !needsCapabilities.has(capability));
  if (missing.length > 0) {
    return removalReason(
      REMOVAL_NEEDS,
      `$.needs[${JSON.stringify(missing[0] ?? "")}]`,
      `the route does not list every capability the query needs: ${missing.join(", ")}`,
    );
  }
  return null;
}

/** An own-property rating lookup: inherited names such as "constructor" are absent. */
function ratingValue(
  ratings: Readonly<Record<string, number>>,
  rating: string,
): number | undefined {
  return Object.hasOwn(ratings, rating) ? ratings[rating] : undefined;
}

function floorOf(
  ratings: Readonly<Record<string, number>>,
  floors: readonly Floor[],
  everyRouteBelow: boolean,
): "clears" | "below" {
  if (everyRouteBelow) return "below";
  for (const { rating, minimum } of floors) {
    const value = ratingValue(ratings, rating);
    if (value === undefined || value < minimum) {
      return "below";
    }
  }
  return "clears";
}

function belowReasons(
  ratings: Readonly<Record<string, number>>,
  floors: readonly Floor[],
): readonly Coded[] {
  const reasons: Coded[] = [];
  for (const { rating, minimum } of floors) {
    const value = ratingValue(ratings, rating);
    if (value === undefined || value < minimum) {
      reasons.push(floorReason(rating, minimum, value));
    }
  }
  return reasons;
}

function byRankRatings(a: FlatRoute, b: FlatRoute, rank: readonly string[]): number {
  for (const rating of rank) {
    const aValue = ratingValue(a.ratings, rating);
    const bValue = ratingValue(b.ratings, rating);
    if (aValue === undefined && bValue === undefined) continue;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;
    if (aValue !== bValue) return bValue - aValue;
  }
  return 0;
}

function byCostDescending(a: FlatRoute, b: FlatRoute): number {
  if (a.cost === undefined && b.cost === undefined) return 0;
  if (a.cost === undefined) return 1;
  if (b.cost === undefined) return -1;
  if (a.cost !== b.cost) return b.cost - a.cost;
  return 0;
}

function byResponseTime(a: FlatRoute, b: FlatRoute): number {
  if (a.responseSeconds === undefined && b.responseSeconds === undefined) return 0;
  if (a.responseSeconds === undefined) return 1;
  if (b.responseSeconds === undefined) return -1;
  if (a.responseSeconds !== b.responseSeconds) return a.responseSeconds - b.responseSeconds;
  return 0;
}

/** The final tie-breaks: the route's place in its model, then file order. */
function byRouteOrder(a: FlatRoute, b: FlatRoute): number {
  if (a.routeIndex !== b.routeIndex) return a.routeIndex - b.routeIndex;
  return a.order - b.order;
}

function compareCapabilityFirst(a: FlatRoute, b: FlatRoute, rank: readonly string[]): number {
  const byRank = byRankRatings(a, b, rank);
  if (byRank !== 0) return byRank;
  const byCost = byCostDescending(a, b);
  if (byCost !== 0) return byCost;
  return byRouteOrder(a, b);
}

function compareCostFirst(a: FlatRoute, b: FlatRoute, rank: readonly string[]): number {
  const byCost = byCostDescending(a, b);
  if (byCost !== 0) return byCost;
  const byRank = byRankRatings(a, b, rank);
  if (byRank !== 0) return byRank;
  return byRouteOrder(a, b);
}

function availabilityOf(route: Route): AvailabilityValue {
  return route.meter === undefined ? "unmetered" : "unknown";
}

function buildAnswerRoute(
  entry: FlatRoute,
  floor: "clears" | "below" | "skipped",
  reasons: readonly Coded[],
  placedBy: PlacedBy,
): AnswerRoute {
  return {
    availability: availabilityOf(entry.route),
    family: entry.family,
    floor,
    harness: entry.harness,
    hosted: entry.hosted,
    label: entry.label,
    model: entry.modelKey,
    modelId: entry.route.modelId,
    placedBy,
    reasons,
    ...(entry.meter === undefined ? {} : { meter: entry.meter }),
    ...(entry.provider === undefined ? {} : { provider: entry.provider }),
  };
}

interface PolicyEntry {
  readonly name: string;
  readonly spec: string;
  readonly stakes: readonly string[];
  readonly task: string;
  readonly routes: readonly { readonly effort?: string; readonly route: string }[];
}

interface PolicyMatch {
  readonly name: string;
  readonly routes: readonly { readonly effort?: string; readonly route: string }[];
  readonly spec: string;
}

interface TaskResolution {
  readonly effort?: string;
  readonly needs: readonly string[];
  readonly rank: readonly string[];
  readonly task: TaskEntry | undefined;
  readonly unknown: boolean;
}

function resolveTask(
  sections: RouterSections,
  applied: ReturnType<typeof applyQueryDefaults>,
): TaskResolution | undefined {
  if (applied.task === undefined) return undefined;
  const task = sections.tasks[applied.task];
  if (task === undefined) {
    return {
      needs: applied.needs,
      rank: sections.rank,
      task: undefined,
      unknown: true,
    };
  }
  const inlineEffort = applied.effort;
  const effectiveEffort =
    inlineEffort !== undefined && inlineEffort !== "" ? inlineEffort : task.effort;
  return {
    ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
    needs: dedupe([...task.needs, ...applied.needs]),
    rank: task.rank,
    task,
    unknown: false,
  };
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function resolveFloors(
  applied: ReturnType<typeof applyQueryDefaults>,
  resolvedTask: TaskResolution | undefined,
  declaredRatings: ReadonlySet<string>,
  warnings: Coded[],
): { floors: Floor[]; everyRouteBelow: boolean } {
  const taskFloors = new Map<string, number>();
  if (resolvedTask !== undefined && resolvedTask.task !== undefined) {
    const stakeFloors = resolvedTask.task.minimums[applied.stakes] ?? {};
    for (const [rating, value] of Object.entries(stakeFloors)) {
      taskFloors.set(rating, value);
    }
  }
  // Inline minimums replace per rating at the query's stakes.
  for (const [rating, value] of Object.entries(applied.minimums)) {
    taskFloors.set(rating, value);
  }

  const floors: Floor[] = [];
  let everyRouteBelow = false;
  for (const [rating, minimum] of taskFloors) {
    if (!declaredRatings.has(rating)) {
      warnings.push({
        code: "rating-unknown",
        field: `$.minimums[${JSON.stringify(rating)}]`,
        message: `the minimum "${rating}" names a rating the registry does not declare; every route counts as below that floor`,
        fix: `Declare "${rating}" in the registry's ratings section, or remove it from minimums.`,
      });
      everyRouteBelow = true;
      continue;
    }
    floors.push({ rating, minimum });
  }
  return { floors, everyRouteBelow };
}

function loadPolicies(loaded: LoadedRegistry): readonly PolicyEntry[] {
  const raw = loaded.sections.policy;
  if (!isPlainObject(raw)) return [];
  const out: PolicyEntry[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    const routes = Array.isArray(value.routes) ? value.routes : [];
    const routesEntries: { effort?: string; route: string }[] = [];
    for (const entry of routes) {
      if (isPlainObject(entry) && typeof entry.route === "string") {
        routesEntries.push({
          route: entry.route,
          ...(typeof entry.effort === "string" ? { effort: entry.effort } : {}),
        });
      }
    }
    const stakes = Array.isArray(value.stakes)
      ? value.stakes.filter((entry): entry is string => typeof entry === "string")
      : [];
    const spec = typeof value.spec === "string" ? value.spec : "open";
    const task = typeof value.task === "string" ? value.task : "";
    out.push({ name, routes, stakes, spec, task });
  }
  return out;
}

function matchPolicy(
  policies: readonly PolicyEntry[],
  applied: ReturnType<typeof applyQueryDefaults>,
): PolicyMatch | undefined {
  const candidates: PolicyMatch[] = [];
  for (const policy of policies) {
    if (policy.task !== applied.task) continue;
    if (!policy.stakes.includes(applied.stakes)) continue;
    if (policy.spec === "settled" && applied.spec !== "settled") continue;
    if (policy.spec === "open" && applied.spec !== "open") continue;
    candidates.push({ name: policy.name, routes: policy.routes, spec: policy.spec });
  }
  if (candidates.length === 0) return undefined;
  // spec: settled beats unconditional (no spec). spec: open and
  // spec: settled never both match because spec and open are mutually exclusive.
  candidates.sort((a, b) => policySpecRank(b.spec) - policySpecRank(a.spec));
  return candidates[0];
}

function policySpecRank(spec: string): number {
  if (spec === "settled") return 2;
  if (spec === "open") return 1;
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * List the registry's tasks in file order. Each entry has the task name
 * and its one-line description. Returns `[]` when the registry has no
 * tasks. Validates the router's sections, so a caller never sees a task
 * list `rank` then refuses.
 */
export function listTasks(options: RankOptions = {}): readonly TaskSummary[] {
  const loaded = resolveRegistry(options.registry);
  const sections: RouterSections = validateRouterSections(loaded);
  const out: TaskSummary[] = [];
  const seen = new Set<string>();
  const tasksSection = loaded.sections.tasks;
  if (isPlainObject(tasksSection)) {
    for (const name of Object.keys(tasksSection)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description: sections.tasks[name]?.description ?? "" });
    }
  }
  return out;
}

/**
 * Rank routes for a query. The steps run in the contract's order: load the
 * registry, validate the router section, validate the query, resolve the
 * task and policy, apply the hard limits, place the policy routes, then sort.
 * The function is synchronous and pure over its inputs.
 */
export function rank(query: unknown, options: RankOptions = {}): Answer {
  const loaded = resolveRegistry(options.registry);
  const sections: RouterSections = validateRouterSections(loaded);
  const parsed: Query = parseQuery(query);
  const applied = applyQueryDefaults(parsed);

  const warnings: Coded[] = [];
  const removed: Removed[] = [];

  const resolvedTask = resolveTask(sections, applied);

  if (resolvedTask !== undefined && resolvedTask.unknown) {
    warnings.push({
      code: "task-unranked",
      message: `the task "${applied.task}" was not ranked; this release ranks by router.rank only`,
      fix: "State minimums for inline floors; ranking by task arrives in a later release.",
    });
  }

  const declaredRatings = new Set(Object.keys(loaded.registry.ratings ?? {}));
  const { floors, everyRouteBelow } = resolveFloors(
    applied,
    resolvedTask,
    declaredRatings,
    warnings,
  );

  const effectiveNeeds = resolvedTask?.needs ?? applied.needs;

  const declaredCapabilities = new Set(Object.keys(loaded.registry.capabilities ?? {}));
  for (const need of effectiveNeeds) {
    if (!declaredCapabilities.has(need)) {
      warnings.push({
        code: "capability-unknown",
        field: `$.needs[${JSON.stringify(need)}]`,
        message: `the need "${need}" names a capability the registry does not declare; every route lacking it is removed`,
        fix: `Declare "${need}" in the registry's capabilities section, or remove it from needs.`,
      });
    }
  }

  const knownFamilies = new Set(Object.values(loaded.registry.models).map((model) => model.family));
  for (const family of applied.excludeFamilies) {
    if (!knownFamilies.has(family)) {
      warnings.push({
        code: "family-unknown",
        field: `$.excludeFamilies[${JSON.stringify(family)}]`,
        message: `the family "${family}" is not in the registry; it excludes nothing`,
        fix: "Name a family the registry declares, or remove it from excludeFamilies.",
      });
    }
  }

  // Effort resolution is out of scope: when the query names an effort and no
  // task is named, the value is parsed but unapplied. A task's effort is
  // always applied; an inline effort is the level the router would resolve
  // in step 7 (effort resolution is a later release).
  if (applied.effort !== undefined && resolvedTask === undefined) {
    warnings.push({
      code: "effort-unapplied",
      message: `the query effort "${applied.effort}" was not applied; this release does not resolve effort levels`,
      fix: "Remove effort from the query; effort resolution arrives in a later release.",
    });
  }

  if (applied.pin !== undefined) {
    warnings.push({
      code: "pin-unapplied",
      message: `the pin "${applied.pin}" was not used; this release does not place pins`,
      fix: "Remove pin from the query; pins arrive in a later release.",
    });
  }

  const policies = loadPolicies(loaded);
  const policyMatch = matchPolicy(policies, applied);
  if (applied.spec === "settled" && policyMatch === undefined) {
    warnings.push({
      code: "policy-none",
      message: 'the spec "settled" matched no policy; normal ranking was used',
      fix: "Remove spec from the query, or add a matching policy when policies ship.",
    });
  }

  const surviving: FlatRoute[] = [];
  const flatByLabel = new Map<string, FlatRoute>();
  let order = 0;
  for (const [modelKey, model] of Object.entries(loaded.registry.models)) {
    for (const [routeIndex, route] of model.routes.entries()) {
      const label = buildRouteLabel(modelKey, route);
      const rejection = rejectByHardLimit(
        route,
        model.family,
        applied.privacy,
        applied.excludeFamilies,
        effectiveNeeds,
      );
      if (rejection !== null) {
        removed.push({ label, reason: rejection });
        continue;
      }
      const entry: FlatRoute = {
        cost: route.cost,
        family: model.family,
        harness: route.harness,
        hosted: route.hosted,
        label,
        meter: route.meter,
        model,
        modelKey,
        order: order++,
        provider: route.provider,
        ratings: (model.ratings ?? {}) as Readonly<Record<string, number>>,
        responseSeconds: route.responseSeconds,
        route,
        routeIndex,
      };
      surviving.push(entry);
      flatByLabel.set(label, entry);
    }
  }

  if (applied.privacy === "secret" && surviving.length === 0) {
    warnings.push(WARNING_LOCAL_OR_NOTHING);
  }

  const policyPlaced: AnswerRoute[] = [];
  const placedLabels = new Set<string>();
  if (policyMatch !== undefined) {
    for (const policyRoute of policyMatch.routes) {
      const label = policyRoute.route;
      const entry = flatByLabel.get(label);
      if (entry === undefined) {
        removed.push({
          label,
          reason: {
            code: "policy-route-removed",
            field: `$.policy[${JSON.stringify(policyMatch.name)}].routes`,
            message: `the policy "${policyMatch.name}" named a route "${label}" a hard limit removed`,
            fix: `Adjust the policy "${policyMatch.name}" to a route that survives the hard limits, or relax them.`,
          },
        });
        continue;
      }
      if (placedLabels.has(label)) continue;
      policyPlaced.push(buildAnswerRoute(entry, "skipped", [], "policy"));
      placedLabels.add(label);
    }
  }

  const remaining = surviving.filter((entry) => !placedLabels.has(entry.label));

  const floorsPresent = floors.length > 0 || everyRouteBelow;
  // An unknown task ranks most capable first, never cheapest first; an
  // explicitly empty floor set is "no floor" and clears by cost. A known
  // task's floors use the normal clearing and below-floor orders.
  const rankByCapability =
    resolvedTask !== undefined && resolvedTask.unknown === true && !floorsPresent;
  const effectiveRank = resolvedTask?.rank ?? sections.rank;
  const baseComparator = rankByCapability ? compareCapabilityFirst : compareCostFirst;
  const compareClearing = (a: FlatRoute, b: FlatRoute): number => {
    if (applied.prefer === "speed") {
      const bySpeed = byResponseTime(a, b);
      if (bySpeed !== 0) return bySpeed;
    }
    return baseComparator(a, b, effectiveRank);
  };

  const clearing: FlatRoute[] = [];
  const below: FlatRoute[] = [];
  for (const entry of remaining) {
    if (floorOf(entry.ratings, floors, everyRouteBelow) === "clears") {
      clearing.push(entry);
    } else {
      below.push(entry);
    }
  }
  clearing.sort(compareClearing);
  below.sort((a, b) => compareCapabilityFirst(a, b, effectiveRank));

  const routes: AnswerRoute[] = [
    ...policyPlaced,
    ...clearing.map((entry) => buildAnswerRoute(entry, "clears", [], "rank")),
    ...below.map((entry) =>
      buildAnswerRoute(entry, "below", belowReasons(entry.ratings, floors), "rank"),
    ),
  ];

  return {
    availabilityNote: null,
    contract: 1,
    describe: null,
    pin: null,
    query: applied,
    registryDigest: loaded.digest,
    removed,
    routerVersion: ROUTER_VERSION,
    routes,
    warnings,
  };
}
