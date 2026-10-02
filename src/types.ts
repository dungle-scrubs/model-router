import type { EffortLevel, LoadedRegistry, RegistryDigest } from "@dungle-scrubs/model-registry";

export type Stakes = "low" | "normal" | "high";
export type Prefer = "cost" | "speed";
export type Privacy = "normal" | "secret";
export type Spec = "open" | "settled";
export type PlacedBy = "pin" | "policy" | "rank";
export type Floor = "clears" | "below" | "skipped";
export type AvailabilityValue = "ok" | "projected" | "exhausted" | "unknown" | "unmetered";

/**
 * A contract 1 query. Input is strict: a field the contract does not define
 * is query-invalid. `effort` and `pin` parse; this release applies neither.
 */
export interface Query {
  readonly excludeFamilies?: readonly string[];
  readonly effort?: string;
  readonly minimums?: Readonly<Record<string, number>>;
  readonly needs?: readonly string[];
  readonly pin?: string;
  readonly prefer?: Prefer;
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

/** One ranked route in the answer: identity, run facts and placement. */
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
  readonly provider?: string;
  readonly reasons: readonly Coded[];
};

/** Contract 1 answer shape. */
export type Answer = {
  readonly availabilityNote: Coded | null;
  readonly contract: 1;
  readonly describe: null;
  readonly pin: PinReport | null;
  readonly query: AppliedQuery;
  readonly registryDigest: RegistryDigest;
  readonly removed: readonly Removed[];
  readonly routerVersion: string;
  readonly routes: readonly AnswerRoute[];
  readonly warnings: readonly Coded[];
};

export type RouterErrorCode = "query-invalid" | "registry-sections-invalid";

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

/** Options the rank entry point accepts. `registry` is a path or a loaded registry. */
export interface RankOptions {
  readonly registry?: string | LoadedRegistry;
}

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
  readonly rank: readonly string[];
  readonly tasks: Readonly<Record<string, TaskEntry>>;
}
