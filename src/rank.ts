import {
  buildRouteLabel,
  EFFORT_LADDER,
  type EffortLevel,
  type LoadedRegistry,
  loadRegistry,
  type Model,
  type Route,
} from "@dungle-scrubs/model-registry";
import { applyAvailability } from "./availability.js";
import {
  defaultConfig as defaultRouterConfig,
  type LoadedConfig,
  loadConfig as loadConfigImpl,
  type RouterConfig,
  resolveConfigPath,
  validateConfigObjectInput,
} from "./config.js";
import { applyQueryDefaults, parseQuery } from "./query.js";
import { validateRouterSections } from "./sections.js";
import type {
  Answer,
  AnswerRoute,
  AvailabilityEntry,
  AvailabilityValue,
  Coded,
  PinReport,
  PlacedBy,
  PolicyEntry,
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

/** The result of effort resolution: the final level (omitted when no level
 * is known), and any reason the level was lowered (maxEffort, ceiling).
 * The router never emits `max` under the default ceiling, so a value
 * above the ceiling is dropped to the ceiling with a warning. */
interface EffortResolution {
  readonly level: EffortLevel | undefined;
  readonly lowered: { readonly field: string; readonly message: string } | undefined;
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

/** Resolve the rank call's `config` option: a string is a path, a plain
 * object is the settings form, an absent option falls through to the
 * documented path order. The settings form goes through one validator;
 * the path form goes through the same loader the CLI uses. The library
 * accepts no pre-loaded config shortcut: callers that already ran the
 * loader must pass the path string it consumed, not the LoadedConfig
 * envelope, so the validator is the one source of truth. */
function resolveConfig(
  option: RankOptions["config"],
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  if (option === undefined) return loadConfigImpl({ env });
  if (typeof option === "string") {
    return loadConfigImpl({ explicitPath: resolveConfigPath(option), env });
  }
  const config = validateConfigObjectInput(option);
  return { config, configPath: null };
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
  effort: EffortLevel | undefined,
  policy?: string,
): AnswerRoute {
  return {
    availability: availabilityOf(entry.route),
    ...(effort === undefined ? {} : { effort }),
    family: entry.family,
    floor,
    harness: entry.harness,
    hosted: entry.hosted,
    label: entry.label,
    model: entry.modelKey,
    modelId: entry.route.modelId,
    placedBy,
    ...(policy === undefined ? {} : { policy }),
    ...(entry.meter === undefined ? {} : { meter: entry.meter }),
    ...(entry.provider === undefined ? {} : { provider: entry.provider }),
    reasons,
  };
}

function matchPolicy(
  sections: RouterSections,
  applied: ReturnType<typeof applyQueryDefaults>,
): PolicyEntry | undefined {
  let fallback: PolicyEntry | undefined;
  for (const policy of Object.values(sections.policies)) {
    if (policy.task !== applied.task) continue;
    if (!policy.stakes.includes(applied.stakes)) continue;
    // A policy without spec applies whatever the query's spec is. Only
    // "settled" is a valid policy spec, and it matches only settled
    // queries. A settled policy beats the specless fallback, so the first
    // explicit-spec candidate is the winner.
    if (policy.spec !== undefined && policy.spec !== applied.spec) continue;
    if (policy.spec !== undefined) return policy;
    fallback = policy;
  }
  return fallback;
}

/** Decide whether the named pin survives the hard limits. The pin report is
 * null when the query has no pin at all; a non-surviving pin keeps the
 * fallback ranking and a reason. The reason names a removed cause only when
 * one is on file for that label; otherwise the label is unknown. */
function resolvePin(
  pin: string | undefined,
  flatByLabel: ReadonlyMap<string, FlatRoute>,
  removed: readonly Removed[],
  warnings: Coded[],
): PinReport | null {
  if (pin === undefined) return null;
  if (flatByLabel.has(pin)) {
    return { label: pin, reason: "", used: true };
  }
  const rejection = removed.find((entry) => entry.label === pin);
  if (rejection !== undefined) {
    // The hard-limit code is the cause: the same code the loader wrote when
    // it removed the route.
    const code = rejection.reason.code;
    warnings.push({
      code: "pin-unused",
      field: "$.pin",
      fix: `Adjust the pin "${pin}" to a route that survives the hard limits, or relax them.`,
      message: `the pin "${pin}" was not used; a hard limit removed it (${code})`,
    });
    return { label: pin, reason: code, used: false };
  }
  warnings.push({
    code: "pin-unknown",
    field: "$.pin",
    fix: `Name a route the registry declares as the pin.`,
    message: `the pin "${pin}" was not used; the label is not in the registry`,
  });
  return { label: pin, reason: "unknown-label", used: false };
}

/** A non-route effort value the policy route, query, task, or config named.
 * Empty when every source is absent (a query that never names effort and a
 * task that has no effort, against the default config). */
interface RequestedEffort {
  readonly requested: EffortLevel | undefined;
}

/** Resolve the requested effort for the share route at once, by the RFC's
 * order: policy route > query > task > config default. An off-ladder query
 * effort is ignored with a warning; the task's effort is already validated
 * against the ladder in `sections`, so it is always on the ladder. The
 * config default is always on the ladder (config validation rejects a
 * default above the ceiling). The warning names the actual fallback
 * source so the caller can tell whether the task effort or the
 * configured default supplied the request. */
function resolveRequestedEffort(
  applied: ReturnType<typeof applyQueryDefaults>,
  resolvedTask: TaskResolution | undefined,
  policyMatch: PolicyEntry | undefined,
  config: RouterConfig,
  warnings: Coded[],
): RequestedEffort {
  // The shared requested effort is what every rank-placed route receives
  // unless its policy route entry names one. We collect them in priority:
  //   1. policy route's effort when present (rare; resolved per-route)
  //   2. query effort (with the off-ladder warning)
  //   3. task effort (validated by sections.ts)
  //   4. config default
  if (applied.effort !== undefined) {
    if ((EFFORT_LADDER as readonly string[]).includes(applied.effort)) {
      return { requested: applied.effort as EffortLevel };
    }
    // The fallback that follows the warning may be either the task's
    // effort (when one is named and on the ladder) or the configured
    // default. Resolve the fallback first, then describe it accurately
    // in the diagnostic.
    const taskEffort = resolvedTask?.task?.effort;
    const fallbackLevel: EffortLevel =
      taskEffort !== undefined && (EFFORT_LADDER as readonly string[]).includes(taskEffort)
        ? (taskEffort as EffortLevel)
        : config.effort.default;
    const fallbackSource =
      taskEffort !== undefined && (EFFORT_LADDER as readonly string[]).includes(taskEffort)
        ? `the task effort "${fallbackLevel}"`
        : `the configured default "${fallbackLevel}"`;
    warnings.push({
      code: "effort-off-ladder",
      field: "$.effort",
      fix: `Set "effort" to one of ${EFFORT_LADDER.join(", ")}; ${fallbackSource} was used.`,
      message: `the query effort "${applied.effort}" is not on the ladder; ${fallbackSource} was used`,
    });
    return { requested: fallbackLevel };
  }
  if (resolvedTask?.task?.effort !== undefined) {
    return { requested: resolvedTask.task.effort as EffortLevel };
  }
  void policyMatch; // The policy route effort is per-route; the shared request falls through.
  return { requested: config.effort.default };
}

/** Resolve effort for one route. The order: requested level, then the
 * model's fixedEffort (replaces), then the model's maxEffort (caps with a
 * warning), then the configured ceiling (caps with a warning). Each cap
 * adds its own warning so a stacked lowering tells the caller which rule
 * lowered the level. The router never emits `max` under the default
 * ceiling, so any value at or above `max` is dropped to the ceiling. */
function resolveRouteEffort(
  requested: EffortLevel | undefined,
  model: Model,
  config: RouterConfig,
  warnings: Coded[],
  ownerLabel: string | null,
): EffortResolution {
  if (requested === undefined) return { level: undefined, lowered: undefined };
  const ladder = EFFORT_LADDER as readonly string[];
  let current = requested;
  let loweredWarn: { field: string; message: string } | undefined;
  const prefix = ownerLabel ?? "model";
  if (model.fixedEffort !== undefined && model.fixedEffort !== current) {
    const next = model.fixedEffort;
    if (exceedsLadderIndex(current, next)) {
      // fixedEffort lowered the request: warn. Raising or matching does not.
      warnings.push({
        code: "effort-fixed-lowering",
        field: `$.fixedEffort[${JSON.stringify(next)}]`,
        fix: `Lower the request to "${next}" or below, or raise the model's fixedEffort.`,
        message: `the ${prefix} effort was lowered from "${current}" to "${next}" by the model's fixedEffort`,
      });
      loweredWarn = { field: "fixedEffort", message: "model fixedEffort" };
    }
    current = next;
  }
  if (model.maxEffort !== undefined && exceedsLadderIndex(current, model.maxEffort)) {
    const next = model.maxEffort;
    warnings.push({
      code: "effort-above-max",
      field: `$.maxEffort[${JSON.stringify(model.maxEffort)}]`,
      fix: `Lower the request to "${next}" or below, or raise the model's maxEffort.`,
      message: `the ${prefix} effort was lowered from "${current}" to "${next}" by the model's maxEffort`,
    });
    current = next;
    loweredWarn = { field: "maxEffort", message: "model maxEffort" };
  }
  if (exceedsLadderIndex(current, config.effort.ceiling)) {
    const next = config.effort.ceiling;
    warnings.push({
      code: "effort-ceiling",
      field: `$.effort.ceiling[${JSON.stringify(config.effort.ceiling)}]`,
      fix: `Lower the request to "${next}" or below, or raise "effort"."ceiling" in config.json.`,
      message: `the ${prefix} effort was lowered from "${current}" to "${next}" by effort.ceiling`,
    });
    current = next;
    loweredWarn = { field: "ceiling", message: "effort.ceiling" };
  }
  void ladder;
  return { level: current, lowered: loweredWarn };
}

function exceedsLadderIndex(value: string, top: string): boolean {
  const ladder = EFFORT_LADDER as readonly string[];
  const valueIndex = ladder.indexOf(value);
  const topIndex = ladder.indexOf(top);
  if (valueIndex === -1 || topIndex === -1) return false;
  return valueIndex > topIndex;
}

/** The package default config: exposed for callers and tests. */
export const defaultRouterConfigExported = defaultRouterConfig;
interface TaskResolution {
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
  // Own-property read: a name such as "toString" is not a declared task.
  const task = Object.hasOwn(sections.tasks, applied.task)
    ? sections.tasks[applied.task]
    : undefined;
  if (task === undefined) {
    return {
      needs: applied.needs,
      rank: sections.rank,
      task: undefined,
      unknown: true,
    };
  }
  return {
    needs: dedupe([...task.needs, ...applied.needs]),
    rank: task.rank,
    task,
    unknown: false,
  };
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Walk the registry's meters section and collect the names that the
 * loader declared as `spendToZero: true`. The names are read with
 * `Object.hasOwn` so an inherited name such as `constructor` is treated
 * as absent. The result feeds `applyAvailability`'s `spendToZero`
 * option: a projected reading on one of these meters keeps the route
 * in place. */
function collectSpendToZeroMeters(loaded: LoadedRegistry): readonly string[] {
  const meters = loaded.registry.meters ?? {};
  const out: string[] = [];
  for (const [name, meter] of Object.entries(meters)) {
    if (Object.hasOwn(meter, "spendToZero") && meter.spendToZero === true) {
      out.push(name);
    }
  }
  return out;
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
 * task and policy, apply the hard limits, place the pin and policy,
 * resolve effort, then sort. The function is synchronous and pure over
 * its inputs.
 */
export function rank(query: unknown, options: RankOptions = {}): Answer {
  const loaded = resolveRegistry(options.registry);
  const sections: RouterSections = validateRouterSections(loaded);
  const parsed: Query = parseQuery(query);
  const applied = applyQueryDefaults(parsed);

  // Load the config: the path order applies when the option is absent.
  // The router never reads the clock or runs a subprocess here, so the
  // result is pure over its inputs (path, env, or object).
  const loadedConfig = resolveConfig(options.config);
  const config = loadedConfig.config;

  const warnings: Coded[] = [];
  const removed: Removed[] = [];

  const resolvedTask = resolveTask(sections, applied);

  if (resolvedTask?.unknown) {
    warnings.push({
      code: "task-unranked",
      message: `the task "${applied.task}" is not declared in the registry's tasks section; ranking by router.rank`,
      fix: "Correct the task name, or add the task to the registry's tasks section.",
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

  const policyMatch = matchPolicy(sections, applied);
  // The warning fires only when the caller stated a spec: an unstated spec
  // defaults to open without asking for a policy, so it stays silent.
  if (parsed.spec !== undefined && policyMatch === undefined) {
    warnings.push({
      code: "policy-none",
      message: `the spec "${applied.spec}" matched no policy; normal ranking was used`,
      fix: "Remove spec from the query, or add a policy matching the task, stakes and spec.",
    });
  }

  // Effort resolution runs at the route level, but the requested level is
  // shared: the policy route's `effort` first, then the query's, then the
  // task's, then the config default. An off-ladder value in the query is
  // ignored with a warning; the schema accepts any string for effort.
  const requestedEffort = resolveRequestedEffort(
    applied,
    resolvedTask,
    policyMatch,
    config,
    warnings,
  );

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

  // Pin placement: the pin is used only when the label is in the surviving
  // set. A used pin goes first with placedBy=pin and floor=skipped; the
  // fallback ranking follows without it. A non-surviving pin keeps the
  // fallback ranking with pin.used=false and a reason.
  const pinReport = resolvePin(applied.pin, flatByLabel, removed, warnings);

  // The pin's effort, when the pin label is also a matching policy route,
  // comes from the policy route entry: per RFC, the policy route's
  // effort sits first in the effort precedence. Build the lookup up
  // front so the pin placement can apply it without re-walking the
  // policy's written order.
  const policyRouteEffortByLabel = new Map<string, EffortLevel>();
  if (policyMatch !== undefined) {
    for (const policyRoute of policyMatch.routes) {
      if (typeof policyRoute.effort === "string") {
        policyRouteEffortByLabel.set(policyRoute.route, policyRoute.effort as EffortLevel);
      }
    }
  }

  const policyPlaced: AnswerRoute[] = [];
  const placedLabels = new Set<string>();
  if (pinReport?.used === true) {
    placedLabels.add(pinReport.label);
  }
  if (policyMatch !== undefined) {
    for (const policyRoute of policyMatch.routes) {
      const label = policyRoute.route;
      const entry = flatByLabel.get(label);
      if (entry === undefined) {
        // Validation guarantees the label exists, so a hard limit removed it:
        // the removal keeps its hard-limit reason, and a warning names the
        // policy that wanted the route.
        warnings.push({
          code: "policy-route-removed",
          field: `$.policy[${JSON.stringify(policyMatch.name)}].routes`,
          message: `the policy "${policyMatch.name}" names the route "${label}", which a hard limit removed`,
          fix: `Adjust the policy "${policyMatch.name}" to a route that survives the hard limits, or relax them.`,
        });
        continue;
      }
      if (placedLabels.has(label)) continue;
      // Per-route effort: a policy route may name its own effort in the
      // registry, which overrides the shared request for that route alone.
      // Validation rejects an off-ladder value at sections.ts and would
      // have raised policy-route-effort-invalid, so when the value is a
      // string it is on the ladder.
      const policyRouteEffort = policyRoute.effort;
      const policyRequested =
        typeof policyRouteEffort === "string"
          ? (policyRouteEffort as EffortLevel)
          : requestedEffort.requested;
      const policyResolved = resolveRouteEffort(
        policyRequested,
        entry.model,
        config,
        warnings,
        policyRouteEffort !== undefined ? `policy "${policyMatch.name}" route "${label}"` : null,
      );
      policyPlaced.push(
        buildAnswerRoute(entry, "skipped", [], "policy", policyResolved.level, policyMatch.name),
      );
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

  // Resolve effort for each ranked route. Below-floor routes still receive
  // an effort: the request is independent of floor outcome.
  const clearingRoutes = clearing.map((entry) => {
    const resolved = resolveRouteEffort(
      requestedEffort.requested,
      entry.model,
      config,
      warnings,
      null,
    );
    return buildAnswerRoute(entry, "clears", [], "rank", resolved.level);
  });
  const belowRoutes = below.map((entry) => {
    const reasons = belowReasons(entry.ratings, floors);
    const resolved = resolveRouteEffort(
      requestedEffort.requested,
      entry.model,
      config,
      warnings,
      null,
    );
    return buildAnswerRoute(entry, "below", reasons, "rank", resolved.level);
  });

  const routes: AnswerRoute[] = [];
  if (pinReport?.used === true) {
    const pinEntry = flatByLabel.get(pinReport.label);
    if (pinEntry !== undefined) {
      // The pin's effort comes from the policy route's effort when one
      // names the pin label: the policy route effort sits first in the RFC's
      // precedence, even for the route the pin places. When no policy names
      // the label, the shared request applies.
      const pinRequested =
        policyRouteEffortByLabel.get(pinEntry.label) ?? requestedEffort.requested;
      const resolved = resolveRouteEffort(pinRequested, pinEntry.model, config, warnings, null);
      routes.push(buildAnswerRoute(pinEntry, "skipped", [], "pin", resolved.level));
    }
  }
  routes.push(...policyPlaced, ...clearingRoutes, ...belowRoutes);

  // Apply the availability rule after the pin and the policy have placed
  // their routes. The function reads only `label` and `meter`, so the
  // order is preserved for any route whose meter has no covering entry.
  // Two warnings the engine emits on top of applyAvailability's own
  // warnings: an entry whose meter the registry does not declare, and a
  // reading that was applied while a meter the routes use has none.
  // meter-no-reading fires once per undeclared meter (not per entry).
  // meter-undeclared fires once per undeclared meter name, deduped over
  // the entries. The pin report is rewritten when the pin label lands in
  // the result's removed list: the route's meter was exhausted.
  if (options.availability !== undefined) {
    const entries = options.availability;
    const filtered: AvailabilityEntry[] = [];
    const declaredMeters = new Set(Object.keys(loaded.registry.meters ?? {}));
    const metersUsedByRoutes = new Set<string>();
    for (const route of routes) {
      if (route.meter !== undefined) metersUsedByRoutes.add(route.meter);
    }
    const seenUndeclared = new Set<string>();
    for (const entry of entries) {
      if (typeof entry.meter !== "string" || entry.meter.length === 0) continue;
      if (!declaredMeters.has(entry.meter)) {
        if (!seenUndeclared.has(entry.meter)) {
          seenUndeclared.add(entry.meter);
          warnings.push({
            code: "meter-undeclared",
            field: `$.entries[${JSON.stringify(entry.meter)}]`,
            message: `the meter "${entry.meter}" is not declared in the registry's meters section`,
            fix: `Declare "${entry.meter}" in the registry's meters section, or remove the entry from the availability document.`,
          });
        }
        continue;
      }
      filtered.push(entry);
    }
    if (metersUsedByRoutes.size > 0) {
      // meter-no-reading fires whenever the option is passed,  even with an
      // empty array: the caller's empty `entries` means no meter is
      // covered. The undeclared-meter filter above is irrelevant: the
      // loop over metersUsedByRoutes already only includes declared meters.
      for (const meter of metersUsedByRoutes) {
        const covered = filtered.some((entry) => entry.meter === meter);
        if (!covered) {
          warnings.push({
            code: "meter-no-reading",
            field: `$.entries`,
            message: `the meter "${meter}" is used by routes but has no availability entry`,
            fix: `Add an entry for "${meter}" to the availability document, or remove the meter from the routes that use it.`,
          });
        }
      }
    }
    const spendToZero = collectSpendToZeroMeters(loaded);
    const result = applyAvailability(routes, filtered, { spendToZero });
    routes.length = 0;
    routes.push(...result.routes);
    for (const removedRoute of result.removed) {
      removed.push(removedRoute);
    }
    for (const warn of result.warnings) {
      warnings.push(warn);
    }
    // Pin update: the pin label was removed by an exhausted entry.
    // The all-exhausted case is the exception: nothing was removed, so the
    // pin stays used.The warning field names `$.pin` per the contract.
    if (
      pinReport !== null &&
      pinReport.used === true &&
      pinReport.reason === "" &&
      result.removed.some((entry) => entry.label === pinReport.label)
    ) {
      const updatedPin: PinReport = {
        label: pinReport.label,
        reason: "meter-exhausted",
        used: false,
      };
      warnings.push({
        code: "pin-unused",
        field: "$.pin",
        fix: `Adjust the pin "${pinReport.label}" to a route whose meter is not exhausted, ortop the meter's quota back up.`,
        message: `the pin "${pinReport.label}" was not used; its meter is exhausted`,
      });
      return {
        availabilityNote: null,
        contract: 1,
        describe: null,
        pin: updatedPin,
        query: applied,
        registryDigest: loaded.digest,
        removed,
        routerVersion: ROUTER_VERSION,
        routes,
        warnings,
      };
    }
  }

  return {
    availabilityNote: null,
    contract: 1,
    describe: null,
    pin: pinReport,
    query: applied,
    registryDigest: loaded.digest,
    removed,
    routerVersion: ROUTER_VERSION,
    routes,
    warnings,
  };
}
