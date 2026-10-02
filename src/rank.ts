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
  Query,
  RankOptions,
  Removed,
  RouterSections,
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
  if (needs.length > 0) {
    const routeCapabilities = new Set(route.capabilities ?? []);
    const missing = needs.filter((capability) => !routeCapabilities.has(capability));
    if (missing.length > 0) {
      return removalReason(
        REMOVAL_NEEDS,
        `$.needs[${JSON.stringify(missing[0] ?? "")}]`,
        `the route does not list every capability the query needs: ${missing.join(", ")}`,
      );
    }
  }
  return null;
}

function floorOf(
  ratings: Readonly<Record<string, number>>,
  floors: readonly Floor[],
  everyRouteBelow: boolean,
): "clears" | "below" {
  if (everyRouteBelow) return "below";
  for (const { rating, minimum } of floors) {
    const value = ratings[rating];
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
    const value = ratings[rating];
    if (value === undefined || value < minimum) {
      reasons.push(floorReason(rating, minimum, value));
    }
  }
  return reasons;
}

function byRankRatings(a: FlatRoute, b: FlatRoute, rank: readonly string[]): number {
  for (const rating of rank) {
    const aValue = a.ratings[rating];
    const bValue = b.ratings[rating];
    if (aValue === undefined && bValue === undefined) continue;
    if (aValue === undefined) return 1;
    if (bValue === undefined) return -1;
    if (aValue !== bValue) return bValue - aValue;
  }
  return a.order - b.order;
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

function compareCapabilityFirst(a: FlatRoute, b: FlatRoute, rank: readonly string[]): number {
  const byRank = byRankRatings(a, b, rank);
  if (byRank !== 0) return byRank;
  const byCost = byCostDescending(a, b);
  if (byCost !== 0) return byCost;
  return a.order - b.order;
}

function compareCostFirst(a: FlatRoute, b: FlatRoute, rank: readonly string[]): number {
  const byCost = byCostDescending(a, b);
  if (byCost !== 0) return byCost;
  const byRank = byRankRatings(a, b, rank);
  if (byRank !== 0) return byRank;
  return a.order - b.order;
}

function availabilityOf(route: Route): AvailabilityValue {
  return route.meter === undefined ? "unmetered" : "unknown";
}

function buildAnswerRoute(
  entry: FlatRoute,
  floor: "clears" | "below",
  reasons: readonly Coded[],
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
    placedBy: "rank",
    reasons,
    ...(entry.meter === undefined ? {} : { meter: entry.meter }),
    ...(entry.provider === undefined ? {} : { provider: entry.provider }),
  };
}

/**
 * Rank routes for a query. The steps run in the contract's order: load the
 * registry, validate the router section, validate the query, apply the hard
 * limits, then sort. The function is synchronous and pure over its inputs:
 * the same registry and the same query give the same answer.
 */
export function rank(query: unknown, options: RankOptions = {}): Answer {
  const loaded = resolveRegistry(options.registry);
  const sections: RouterSections = validateRouterSections(loaded);
  const parsed: Query = parseQuery(query);
  const applied = applyQueryDefaults(parsed);

  const warnings: Coded[] = [];
  const removed: Removed[] = [];

  if (applied.task !== undefined) {
    warnings.push({
      code: "task-unranked",
      message: `the task "${applied.task}" was not ranked; this release ranks by router.rank only`,
      fix: "State minimums for inline floors; ranking by task arrives in a later release.",
    });
  }

  const declaredRatings = new Set(Object.keys(loaded.registry.ratings ?? {}));
  const floors: Floor[] = [];
  let everyRouteBelow = false;
  for (const [rating, minimum] of Object.entries(applied.minimums)) {
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

  const declaredCapabilities = new Set(Object.keys(loaded.registry.capabilities ?? {}));
  for (const need of applied.needs) {
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

  if (applied.effort !== undefined) {
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

  if (applied.spec === "settled") {
    warnings.push({
      code: "policy-none",
      message: 'the spec "settled" matched no policy; normal ranking was used',
      fix: "Remove spec from the query, or add a matching policy when policies ship.",
    });
  }

  const surviving: FlatRoute[] = [];
  let order = 0;
  for (const [modelKey, model] of Object.entries(loaded.registry.models)) {
    for (const route of model.routes) {
      const label = buildRouteLabel(modelKey, route);
      const rejection = rejectByHardLimit(
        route,
        model.family,
        applied.privacy,
        applied.excludeFamilies,
        applied.needs,
      );
      if (rejection !== null) {
        removed.push({ label, reason: rejection });
        continue;
      }
      surviving.push({
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
      });
    }
  }

  if (applied.privacy === "secret" && surviving.length === 0) {
    warnings.push(WARNING_LOCAL_OR_NOTHING);
  }

  const floorsPresent = floors.length > 0 || everyRouteBelow;
  const baseComparator = floorsPresent ? compareCostFirst : compareCapabilityFirst;
  const compareClearing = (a: FlatRoute, b: FlatRoute): number => {
    if (applied.prefer === "speed") {
      const bySpeed = byResponseTime(a, b);
      if (bySpeed !== 0) return bySpeed;
    }
    return baseComparator(a, b, sections.rank);
  };

  const clearing: FlatRoute[] = [];
  const below: FlatRoute[] = [];
  for (const entry of surviving) {
    if (floorOf(entry.ratings, floors, everyRouteBelow) === "clears") {
      clearing.push(entry);
    } else {
      below.push(entry);
    }
  }
  clearing.sort(compareClearing);
  below.sort((a, b) => compareCapabilityFirst(a, b, sections.rank));

  const routes: AnswerRoute[] = [
    ...clearing.map((entry) => buildAnswerRoute(entry, "clears", [])),
    ...below.map((entry) => buildAnswerRoute(entry, "below", belowReasons(entry.ratings, floors))),
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
