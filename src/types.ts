import type { EffortLevel, LoadedRegistry, RegistryDigest } from "@dungle-scrubs/model-registry";
import type { RouterConfig } from "./config.js";

export type { EffortLevel } from "@dungle-scrubs/model-registry";
export type { LoadedConfig, RouterConfig } from "./config.js";

export type Stakes = "low" | "normal" | "high";
export type Prefer = "cost" | "speed";
export type Privacy = "normal" | "secret";
export type Spec = "open" | "settled";
export type PlacedBy = "pin" | "policy" | "rank";
export type Floor = "clears" | "below" | "skipped";
export type AvailabilityValue = "ok" | "projected" | "exhausted" | "unknown" | "unmetered";

/** The three statuses an availability entry can carry. An entry whose
 * status is not one of these three is ignored by the engine: it does not
 * cover the meter it names. "unknown" and "unmetered" describe a route,
 * not an entry. */
export type AvailabilityEntryStatus = "ok" | "projected" | "exhausted";

/**
 * A contract 1 query. Input is strict: a field the contract does not define
 * is query-invalid. `profile` selects registry membership before ranking.
 */
export interface Query {
  readonly excludeFamilies?: readonly string[];
  readonly effort?: string;
  readonly minimums?: Readonly<Record<string, number>>;
  readonly needs?: readonly string[];
  readonly pin?: string;
  readonly prefer?: Prefer;
  readonly profile?: string;
  readonly privacy?: Privacy;
  readonly spec?: Spec;
  readonly stakes?: Stakes;
  readonly task?: string;
}

/** The query as the answer reports it: defaults applied, fields deduplicated. */
export interface AppliedQuery {
  readonly excludeFamilies: readonly string[];
  readonly effort?: string;
  readonly minimums: Readonly<Record<string, number>>;
  readonly needs: readonly string[];
  readonly pin?: string;
  readonly prefer: Prefer;
  readonly profile: string;
  readonly privacy: Privacy;
  readonly spec: Spec;
  readonly stakes: Stakes;
  readonly task?: string;
}

/** A coded object: every warning, removal reason and route reason is one. */
export type Coded = {
  readonly code: string;
  readonly fix?: string;
  readonly field?: string;
  readonly message: string;
};

/** One route's reason for being removed by a hard limit. */
export type Removed = {
  readonly label: string;
  readonly reason: Coded;
};

/** The pin placement report, or null when the query has no pin. */
export type PinReport = {
  readonly label: string;
  readonly reason: string;
  readonly used: boolean;
};

/** One ranked route in the answer: identity, run facts and placement. A
 * policy-placed route names its policy in `policy`; every other placement
 * omits the field. */
export type AnswerRoute = {
  readonly availability: AvailabilityValue;
  readonly effort?: EffortLevel;
  readonly family: string;
  readonly floor: Floor;
  readonly harness: string;
  readonly hosted: boolean;
  readonly label: string;
  readonly meter?: string;
  readonly model: string;
  readonly modelId: string;
  readonly placedBy: PlacedBy;
  readonly policy?: string;
  readonly provider?: string;
  readonly reasons: readonly Coded[];
};

/** Contract 1 answer shape. */
export type Answer = {
  readonly availabilityNote: Coded | null;
  readonly contract: 1;
  readonly describe: DescribeBlock | null;
  readonly pin: PinReport | null;
  readonly query: AppliedQuery;
  readonly registryDigest: RegistryDigest;
  readonly removed: readonly Removed[];
  readonly routerVersion: string;
  readonly routes: readonly AnswerRoute[];
  readonly warnings: readonly Coded[];
};

/** One candidate task from Jev's choice distribution. */
export interface DescribeTaskCandidate {
  readonly task: string;
  readonly probability: number;
}

/** Where the query's task came from, what Jev thought, and the candidates.
 * `confidence` and `candidates` are null and empty when no task question was
 * asked: the caller named a task or stated minimums. */
export interface DescribeTaskReport {
  readonly source: "caller" | "jev" | "inline-need";
  readonly confidence: number | null;
  readonly candidates: readonly DescribeTaskCandidate[];
}

/** One capability the describe step added to the query's needs, with the
 * probability that carried it over the threshold. */
export interface DescribeNeedAdded {
  readonly capability: string;
  readonly probability: number;
}

/** The describe block: what answered, the gates applied, the task decision,
 * the added capabilities and Jev's token counts. `model` and `usage` are
 * null when Jev gave no answer. */
export interface DescribeBlock {
  readonly model: string | null;
  readonly taskGate: number;
  readonly capabilityThreshold: number;
  readonly task: DescribeTaskReport;
  readonly needsAdded: readonly DescribeNeedAdded[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number } | null;
}

export type RouterErrorCode =
  | "query-invalid"
  | "profile-unknown"
  | "profile-gap-unrecorded"
  | "registry-sections-invalid"
  | "config-invalid"
  | "describe-private"
  | "describe-failed";

export interface RouterProblem {
  readonly code: string;
  readonly field: string;
  readonly fix: string;
  readonly message: string;
}

export interface RouterErrorDetails {
  readonly code: RouterErrorCode;
  readonly field: string;
  readonly fix: string;
  readonly message: string;
  readonly problems: readonly RouterProblem[];
}

/** A single reading from an availability document. `meter` names the
 * meter the entry covers; `status` is the worst-case state the reading
 * reports; `resetsAt` (when present) drops the entry once that time
 * passes (callers pass the clock); `note` is free-form, also for the user.
 * `percentRemaining` decides ties among same-status entries on one meter.
 * The status is one of three values; the engine ignores any other. */
export interface AvailabilityEntry {
  readonly meter: string;
  readonly note?: string;
  readonly percentRemaining?: number;
  readonly resetsAt?: string;
  readonly status: AvailabilityEntryStatus;
}

/** The availability document the engine accepts. `format` is the contract
 * version, `generatedAt` is checked against `maxAgeSeconds`, and `entries`
 * is the list of meter readings. The CLI ranks without availability on a
 * broken top level (not JSON, missing fields, unknown format), and skips
 * a single bad entry with a warning. */
export interface AvailabilityDocument {
  readonly entries: readonly AvailabilityEntry[];
  readonly format: number;
  readonly generatedAt: string;
}

/** The result of `applyAvailability`: the reordered routes (with their
 * `availability` set and any reason appended), the routes removed by
 * `exhausted`, and warnings raised during the call (the
 * `availability-exhausted-all` case). The result routes carry the same shape the input routes carried, plus the `availability` and (when
 * present) the `reasons` fields the function filled in. */
export interface AvailabilityResult<R extends { readonly label: string; readonly meter?: string }> {
  readonly removed: readonly { readonly label: string; readonly reason: Coded }[];
  readonly routes: readonly (R & {
    readonly availability: AvailabilityValue;
    readonly reasons?: readonly Coded[];
  })[];
  readonly warnings: readonly Coded[];
}

/** Options the rank entry point accepts. `registry` is a path or a loaded
 * registry. `config` is a path string or a plain settings object. The
 * library accepts validated settings from callers that already ran the
 * config loader, avoiding a second file read. `availability` passes
 * entries the caller has already gathered (and `dropExpired`'d); the
 * library reads the spend-to-zero meter names from the registry, so
 * nothing about the spend-to-zero list is taken from the option. The
 * library never reads the clock: a caller that wants stale entries
 * dropped must run `dropExpired` first. */
export interface RankOptions {
  readonly availability?: readonly AvailabilityEntry[];
  readonly config?: string | RouterConfigInput;
  readonly registry?: string | LoadedRegistry;
}

/** Either shape the library accepts for `config`. An object passes through
 * `validateConfigObjectInput`; a path uses `loadConfig`. The library's
 * `RouterConfigInput` is the same `unknown`: the runtime validates it. */
export type RouterConfigInput = unknown;

/** The library's `RouterConfigInput` is `unknown` at the type level; once
 * validated, the result is a `RouterConfig`. The map below keeps the
 * contract reachable from `RankOptions`. */
export type _RouterConfigLink = RouterConfig;

/** A task entry validated from the registry's tasks section. */
export interface TaskEntry {
  readonly description: string;
  readonly effort?: string;
  readonly minimums: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly needs: readonly string[];
  readonly rank: readonly string[];
}

/** One policy route validated from the registry's policy section. */
export interface PolicyRoute {
  readonly effort?: string;
  readonly route: string;
}

/** A policy's spec condition. Only "settled" is valid: it applies solely to
 * settled queries. A policy without `spec` applies to every query. */
export type PolicySpec = "settled";

/** A policy entry validated from the registry's policy section. A policy
 * without `spec` applies to every query; one with `spec: "settled"` applies
 * only to settled queries and beats a specless policy for those. */
export interface PolicyEntry {
  readonly name: string;
  readonly routes: readonly PolicyRoute[];
  readonly spec?: PolicySpec;
  readonly stakes: readonly Stakes[];
  readonly task: string;
}

/** One task summary returned by listTasks. */
export interface TaskSummary {
  readonly description: string;
  readonly name: string;
}

/** The router section shape from the registry file, after validation. */
export interface RouterSections {
  readonly policies: Readonly<Record<string, PolicyEntry>>;
  readonly questions: Readonly<Record<string, string>>;
  readonly rank: readonly string[];
  readonly tasks: Readonly<Record<string, TaskEntry>>;
}

/** Options the describe entry point accepts: the same registry and config
 * forms rank accepts. */
export interface DescribeOptions {
  readonly config?: string | RouterConfigInput;
  readonly registry?: string | LoadedRegistry;
}

/** The describe step's result: the filled query, the describe block, and
 * the warnings the caller must merge into the answer's warnings list. */
export interface DescribeResult {
  readonly query: Query;
  readonly describe: DescribeBlock;
  readonly warnings: readonly Coded[];
}
