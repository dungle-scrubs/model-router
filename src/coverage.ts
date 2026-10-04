import type { LoadedRegistry, Profile, ProfileGap, Route } from "@dungle-scrubs/model-registry";
import type { Coded, RouterProblem, RouterSections, Stakes, TaskEntry } from "./types.js";

type Item =
  | { readonly capability: string; readonly field: string }
  | { readonly rating: string; readonly minimum: number; readonly field: string };
interface Member {
  readonly label: string;
  readonly route: Route;
  readonly ratings: Readonly<Record<string, number>>;
}
const STAKES: readonly Stakes[] = ["low", "normal", "high"];

function pathJoin(parent: string, child: string): string {
  return `${parent}[${JSON.stringify(child)}]`;
}
function gapField(profile: string, index: number): string {
  return `${pathJoin('$["profiles"]', profile)}["gaps"][${index}]`;
}
function value(member: Member, rating: string): number | undefined {
  return Object.hasOwn(member.ratings, rating) ? member.ratings[rating] : undefined;
}
function satisfies(member: Member, item: Item): boolean {
  if ("capability" in item) return (member.route.capabilities ?? []).includes(item.capability);
  const rating = value(member, item.rating);
  return rating !== undefined && rating >= item.minimum;
}
function clears(member: Member, items: readonly Item[]): boolean {
  return items.every((item) => satisfies(member, item));
}
function best(members: readonly Member[], rating: string): number | undefined {
  const values = members.flatMap((member) => {
    const ratingValue = value(member, rating);
    return ratingValue === undefined ? [] : [ratingValue];
  });
  return values.length === 0 ? undefined : Math.max(...values);
}
function requirements(task: TaskEntry, name: string, stakes: Stakes, profile: Profile): Item[] {
  const gaps = profile.gaps ?? [];
  const field = pathJoin('$["tasks"]', name);
  const items: Item[] = [];
  task.needs.forEach((capability, index) => {
    if (!gaps.some((gap) => "capability" in gap && gap.capability === capability)) {
      items.push({ capability, field: `${field}["needs"][${index}]` });
    }
  });
  for (const [rating, minimum] of Object.entries(task.minimums[stakes] ?? {})) {
    const gap = gaps.find((gap) => "rating" in gap && gap.rating === rating);
    items.push({
      rating,
      minimum: gap !== undefined && "rating" in gap ? Math.min(minimum, gap.accepts) : minimum,
      field: pathJoin(`${field}["minimums"][${JSON.stringify(stakes)}]`, rating),
    });
  }
  return items;
}
function record(item: Item, members: readonly Member[]): string | undefined {
  if ("capability" in item) return JSON.stringify({ capability: item.capability, reason: "<why>" });
  const accepts = best(members, item.rating);
  return accepts === undefined
    ? undefined
    : JSON.stringify({ rating: item.rating, accepts, reason: "<why>" });
}
function fixFor(
  item: Item,
  candidates: readonly Member[],
  outside: readonly Member[],
  profile: string,
  implicit: boolean,
): string {
  const gap = record(item, candidates);
  const routes = outside.map((member) => JSON.stringify(member.label)).join(", ");
  const routeFix =
    routes.length > 0
      ? `add a filling route (${routes}) to profile "${profile}"`
      : "add a route that fills it";
  if (gap === undefined) {
    return `Add a filling route${routes.length > 0 ? ` (${routes})` : ""} to profile "${profile}", or rate a member model for "${"rating" in item ? item.rating : ""}".`;
  }
  return implicit
    ? `Declare "default" in profiles with gap record ${gap}, or ${routeFix}.`
    : `Add gap record ${gap} to profile "${profile}", or ${routeFix}.`;
}
function finding(item: Item, context: string, message: string, fix: string): RouterProblem {
  return {
    code: "profile-gap-unrecorded",
    field: item.field,
    message: `${context}: ${message}.`,
    fix,
  };
}
function uncovered(
  items: readonly Item[],
  members: readonly Member[],
  outside: readonly Member[],
  profile: string,
  context: string,
  implicit: boolean,
): RouterProblem[] {
  if (members.some((member) => clears(member, items))) return [];
  const problems: RouterProblem[] = [];
  const remaining: Item[] = [];
  for (const item of items) {
    if (members.some((member) => satisfies(member, item))) {
      remaining.push(item);
      continue;
    }
    const maximum = "rating" in item ? best(members, item.rating) : undefined;
    const message =
      "capability" in item
        ? `no route in profile "${profile}" has capability ${item.capability}`
        : `no route in profile "${profile}" reaches ${item.rating} ${item.minimum} (best ${maximum ?? "unrated"})`;
    problems.push(
      finding(
        item,
        context,
        message,
        fixFor(
          item,
          members,
          outside.filter((member) => satisfies(member, item)),
          profile,
          implicit,
        ),
      ),
    );
    if ("rating" in item && maximum !== undefined) remaining.push({ ...item, minimum: maximum });
  }
  if (members.some((member) => clears(member, remaining))) return problems;
  const candidates = remaining.map((item) => ({
    item,
    members: members.filter((member) =>
      clears(
        member,
        remaining.filter((other) => other !== item),
      ),
    ),
  }));
  const reachable = candidates.filter((candidate) => candidate.members.length > 0);
  const filling = outside.filter((member) => clears(member, items));
  if (reachable.length > 0) {
    for (const candidate of reachable) {
      problems.push(
        finding(
          candidate.item,
          context,
          "the requirements are reachable only through different routes; no single route clears them together",
          fixFor(candidate.item, candidate.members, filling, profile, implicit),
        ),
      );
    }
  } else {
    for (const item of remaining) {
      problems.push(
        finding(
          item,
          context,
          "no single route clears them together and no single record covers it",
          `Add a route that clears them together${filling.length > 0 ? ` (${filling.map((member) => JSON.stringify(member.label)).join(", ")})` : ""} to profile "${profile}", or record more than one ceiling${implicit ? ' by declaring "default" in profiles' : ""}.`,
        ),
      );
    }
  }
  return problems;
}
function fillsRecord(member: Member, gap: ProfileGap): boolean {
  if ("capability" in gap) return (member.route.capabilities ?? []).includes(gap.capability);
  const rating = value(member, gap.rating);
  return rating !== undefined && rating > gap.accepts;
}

/** Check task coverage only, independently of runtime hard limits and placement. */
export function checkProfileCoverage(
  loaded: LoadedRegistry,
  sections: RouterSections,
): { readonly problems: readonly RouterProblem[]; readonly warnings: readonly Coded[] } {
  const all: Member[] = Object.entries(loaded.routes).map(([label, route]) => ({
    label,
    route,
    ratings: loaded.registry.models[route.model]?.ratings ?? {},
  }));
  const problems: RouterProblem[] = [];
  const warnings: Coded[] = [];
  for (const [name, profile] of Object.entries(loaded.profiles)) {
    const labels = new Set(profile.routes);
    const members = all.filter((member) => labels.has(member.label));
    const outside = all.filter((member) => !labels.has(member.label));
    const implicit = loaded.profileProvenance[name] === "implicit";
    for (const [taskName, task] of Object.entries(sections.tasks)) {
      for (const stakes of STAKES) {
        const context = `profile "${name}", task "${taskName}", stakes "${stakes}"`;
        const findings = uncovered(
          requirements(task, taskName, stakes, profile),
          members,
          outside,
          name,
          context,
          implicit,
        );
        if (implicit) warnings.push(...findings);
        else problems.push(...findings);
      }
    }
    if (implicit) continue;
    for (const [index, gap] of (profile.gaps ?? []).entries()) {
      for (const [taskName, task] of Object.entries(sections.tasks)) {
        for (const stakes of STAKES) {
          const original = task.minimums[stakes] ?? {};
          if ("capability" in gap) {
            if (!task.needs.includes(gap.capability)) continue;
          } else if (
            !Object.hasOwn(original, gap.rating) ||
            (original[gap.rating] as number) <= gap.accepts
          ) {
            continue;
          }
          const others = requirements(task, taskName, stakes, profile).filter(
            (item) => !("rating" in gap && "rating" in item && item.rating === gap.rating),
          );
          const filling = members.find(
            (member) => clears(member, others) && fillsRecord(member, gap),
          );
          if (filling === undefined) continue;
          warnings.push({
            code: "profile-gap-stale",
            field: gapField(name, index),
            message: `profile "${name}", task "${taskName}", stakes "${stakes}": record ${JSON.stringify(gap)} is filled by route "${filling.label}".`,
            fix: `Review gap record ${index} in profile "${name}" against the filling route "${filling.label}".`,
          });
        }
      }
    }
  }
  return { problems, warnings };
}
