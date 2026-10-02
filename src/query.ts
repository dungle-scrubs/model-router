import type { ErrorObject } from "ajv/dist/2020.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import querySchema from "../query.schema.json" with { type: "json" };
import { RouterError } from "./error.js";
import type { AppliedQuery, Prefer, Privacy, Query, Spec, Stakes } from "./types.js";

const AJV_OPTIONS = { allErrors: true, strictNumbers: true } as const;

const QUERY_FIELD_LIST =
  "task, minimums, needs, effort, pin, stakes, prefer, privacy, excludeFamilies and spec";

const validateQueryShape = new Ajv2020(AJV_OPTIONS).compile(querySchema);

function invalid(field: string, message: string, fix: string): RouterError {
  return new RouterError({ code: "query-invalid", field, fix, message, problems: [] });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(
      "query",
      `the query is not valid JSON: ${text.slice(0, 120)}`,
      "Pass one JSON object as the query argument, or - to read the query from stdin.",
    );
  }
}

interface AjvParams {
  readonly additionalProperty?: string;
  readonly allowedValues?: readonly string[];
  readonly type?: string;
}

function fieldName(error: ErrorObject): string {
  const name = error.instancePath.split("/").filter(Boolean).at(-1);
  return name === undefined ? "query" : name.replaceAll("~1", "/").replaceAll("~0", "~");
}

function curatedError(errors: readonly ErrorObject[]): RouterError {
  const additional = errors.find((error) => error.keyword === "additionalProperties");
  if (additional !== undefined) {
    const extra = (additional.params as AjvParams).additionalProperty ?? "";
    return invalid(
      extra,
      `the field "${extra}" is not defined by the query contract`,
      `Remove "${extra}", or correct its name; the query accepts ${QUERY_FIELD_LIST}.`,
    );
  }
  if (errors.some((error) => error.keyword === "anyOf")) {
    return invalid(
      "query",
      'a query must carry "task" or "minimums"',
      'Add "task": "<name>" or "minimums": { ... } to the query.',
    );
  }
  const first = errors[0];
  if (first === undefined) {
    return invalid(
      "query",
      "the query is invalid",
      "Fix the query so it matches query.schema.json.",
    );
  }
  const name = fieldName(first);
  const params = first.params as AjvParams;
  if (first.keyword === "type") {
    return invalid(
      name,
      `the field "${name}" must be of type ${params.type ?? "the contract type"}`,
      `Fix the field "${name}" as query.schema.json defines it.`,
    );
  }
  if (first.keyword === "enum") {
    return invalid(
      name,
      `the field "${name}" must be one of: ${(params.allowedValues ?? []).join(", ")}`,
      `Set the field "${name}" to one of the listed values.`,
    );
  }
  return invalid(
    name,
    first.message ?? "the query is invalid",
    "Fix the query so it matches query.schema.json.",
  );
}

/**
 * Parse and validate a query. A string is JSON text (the CLI argument or
 * stdin); any other value is the query object itself (the library caller).
 * The schema is strict: an undefined field is query-invalid, so a misspelled
 * `privacy` cannot silently drop `secret`, and the task-or-minimums rule and
 * the pin rule both fail here.
 */
export function parseQuery(input: unknown): Query {
  const raw = typeof input === "string" ? parseJsonText(input) : input;
  if (!isPlainObject(raw)) {
    throw invalid(
      "query",
      "the query must be a JSON object",
      "Give the query as a JSON object with at least task or minimums.",
    );
  }
  const validate = validateQueryShape;
  if (!validate(raw)) {
    throw curatedError(validate.errors ?? []);
  }
  return raw as Query;
}

function dedupe(values: readonly string[] | undefined): readonly string[] {
  return [...new Set(values ?? [])];
}

/**
 * Apply the contract defaults the answer reports: prefer cost, privacy
 * normal, spec open, stakes normal, no floors, no needs, no excluded
 * families. Lists are deduplicated; the given order is kept.
 */
export function applyQueryDefaults(query: Query): AppliedQuery {
  // A null-prototype record, like every other name-keyed map: a floor
  // named "__proto__" stays an ordinary own property, and inherited names
  // are absent. Object.assign onto the null-prototype target copies each
  // own floor as an own property.
  const minimums = Object.create(null) as Record<string, number>;
  Object.assign(minimums, query.minimums ?? {});
  const applied: {
    excludeFamilies: readonly string[];
    effort?: string;
    minimums: Readonly<Record<string, number>>;
    needs: readonly string[];
    pin?: string;
    prefer: Prefer;
    privacy: Privacy;
    spec: Spec;
    stakes: Stakes;
    task?: string;
  } = {
    excludeFamilies: dedupe(query.excludeFamilies),
    minimums,
    needs: dedupe(query.needs),
    prefer: query.prefer ?? "cost",
    privacy: query.privacy ?? "normal",
    spec: query.spec ?? "open",
    stakes: query.stakes ?? "normal",
  };
  if (query.effort !== undefined) applied.effort = query.effort;
  if (query.pin !== undefined) applied.pin = query.pin;
  if (query.task !== undefined) applied.task = query.task;
  return applied;
}
