import { EFFORT_LADDER } from "@dungle-scrubs/model-registry";
import { RouterError } from "./error.js";
import type { Coded } from "./types.js";

/**
 * Translate a router answer into T3 Code `delegate_task` targets.
 *
 * T3 Code runs the same harnesses a registry routes through, but names them
 * by provider instance, names effort per model, and offers each model its
 * own effort values. This module reads the answer and what T3's
 * `orchestrator_capabilities` tool returned, and gives each route one of
 * three outcomes: a ready target, a model to look up with the tool's
 * `search`, or the reason T3 cannot run it. T3 lists a short set of models
 * and finds the rest by search, and a search result does not say what it
 * searched for, so a missing model is "not offered" only once the caller
 * names it as searched. The ranking never imports this
 * module, so a change in T3's format stays here.
 */

/** Harnesses whose T3 provider instance has another name. Every other
 * harness maps to the provider instance of the same name. */
const PROVIDER_FOR_HARNESS: Readonly<Record<string, string>> = { claude: "claudeAgent" };

/** The option ids T3 uses for effort, in preference order. A model can
 * carry more than one of these names, such as Cursor's Opus with an `effort`
 * level and a boolean `thinking` switch, so the effort option is the first
 * id here whose option offers ladder levels. */
const EFFORT_OPTION_IDS: readonly string[] = [
  "effort",
  "reasoningEffort",
  "reasoning_effort",
  "thinking",
];

/** The route fields the translation reads. */
export interface T3RouteInput {
  readonly effort?: string;
  readonly harness: string;
  readonly label: string;
  readonly modelId: string;
  readonly provider?: string;
}

export interface T3ModelOption {
  readonly id: string;
  readonly values: readonly (string | boolean)[];
}

export interface T3Model {
  readonly id: string;
  readonly options: readonly T3ModelOption[];
}

export interface T3Provider {
  readonly canRunChildTask: boolean;
  readonly constraints: readonly string[];
  readonly models: readonly T3Model[];
  readonly providerInstanceId: string;
}

/** What `orchestrator_capabilities` returned, merged across calls. */
export interface T3Capabilities {
  readonly providers: readonly T3Provider[];
}

/** The `target` argument of `delegate_task`. `options` is always present:
 * an empty object clears options the child would otherwise inherit. */
export interface T3Target {
  readonly model: string;
  readonly options: Readonly<Record<string, string>>;
  readonly providerInstanceId: string;
}

export type T3Route =
  | {
      readonly label: string;
      readonly notes: readonly Coded[];
      readonly status: "ready";
      readonly target: T3Target;
    }
  | {
      readonly label: string;
      readonly providerInstanceId: string;
      /** Pass to `orchestrator_capabilities` as `search`, then translate again
       * with the result merged in. */
      readonly search: string;
      readonly status: "lookup";
    }
  | {
      readonly label: string;
      readonly reason: Coded;
      readonly status: "unavailable";
    };

export interface T3Translation {
  readonly routes: readonly T3Route[];
}

function inputInvalid(field: string, message: string): RouterError {
  return new RouterError({
    code: "t3-input-invalid",
    field,
    fix: "Pass a model-router answer and the unchanged output of orchestrator_capabilities.",
    message,
    problems: [],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw inputInvalid(field, `${field} must be a string`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw inputInvalid(field, `${field} must be a non-empty string`);
  }
  return value;
}

function arrayAt(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw inputInvalid(field, `${field} must be an array`);
  return value;
}

/** Parse the routes of a contract 1 answer. Fields the translation does not
 * read are ignored. */
export function parseT3Answer(input: unknown): readonly T3RouteInput[] {
  if (!isRecord(input) || input.contract !== 1) {
    throw inputInvalid("answer", "the answer must be a model-router contract 1 answer");
  }
  return arrayAt(input.routes, "answer.routes").map((raw, index) => {
    const field = `answer.routes[${index}]`;
    if (!isRecord(raw)) throw inputInvalid(field, `${field} must be an object`);
    const route: {
      effort?: string;
      harness: string;
      label: string;
      modelId: string;
      provider?: string;
    } = {
      harness: requiredString(raw.harness, `${field}.harness`),
      label: requiredString(raw.label, `${field}.label`),
      modelId: requiredString(raw.modelId, `${field}.modelId`),
    };
    const effort = optionalString(raw.effort, `${field}.effort`);
    const provider = optionalString(raw.provider, `${field}.provider`);
    if (effort !== undefined) route.effort = effort;
    if (provider !== undefined) route.provider = provider;
    return route;
  });
}

function parseModel(raw: unknown, field: string): T3Model {
  if (!isRecord(raw)) throw inputInvalid(field, `${field} must be an object`);
  const options = raw.options === undefined ? [] : arrayAt(raw.options, `${field}.options`);
  return {
    id: requiredString(raw.id, `${field}.id`),
    options: options.map((option, index) => {
      const optionField = `${field}.options[${index}]`;
      if (!isRecord(option)) throw inputInvalid(optionField, `${optionField} must be an object`);
      const values = option.values === undefined ? [] : arrayAt(option.values, optionField);
      return {
        id: requiredString(option.id, `${optionField}.id`),
        values: values.filter(
          (value): value is string | boolean =>
            typeof value === "string" || typeof value === "boolean",
        ),
      };
    }),
  };
}

/** A provider as one document states it. A flag the document leaves out is
 * undefined, so a later document that omits it keeps the earlier value. */
interface StatedProvider {
  readonly canRunChildTask: boolean | undefined;
  readonly constraints: readonly string[] | undefined;
  readonly models: readonly T3Model[];
  readonly providerInstanceId: string;
}

function parseProvider(raw: unknown, field: string): StatedProvider {
  if (!isRecord(raw)) throw inputInvalid(field, `${field} must be an object`);
  const models = raw.models === undefined ? [] : arrayAt(raw.models, `${field}.models`);
  return {
    canRunChildTask: raw.canRunChildTask === undefined ? undefined : raw.canRunChildTask === true,
    constraints:
      raw.constraints === undefined
        ? undefined
        : arrayAt(raw.constraints, `${field}.constraints`).filter(
            (entry): entry is string => typeof entry === "string",
          ),
    models: models.map((model, index) => parseModel(model, `${field}.models[${index}]`)),
    providerInstanceId: requiredString(raw.providerInstanceId, `${field}.providerInstanceId`),
  };
}

/**
 * Parse one or more `orchestrator_capabilities` results and merge them. A
 * later document adds the models a `search` found; a model listed twice
 * keeps the later copy, and a flag a later document states replaces the
 * earlier one. A provider no document says can run child tasks cannot.
 */
export function parseT3Capabilities(documents: readonly unknown[]): T3Capabilities {
  const merged = new Map<string, StatedProvider>();
  for (const [docIndex, document] of documents.entries()) {
    if (!isRecord(document)) {
      throw inputInvalid(`capabilities[${docIndex}]`, "capabilities must be a JSON object");
    }
    const providers = arrayAt(document.providers, `capabilities[${docIndex}].providers`);
    for (const [index, raw] of providers.entries()) {
      const stated = parseProvider(raw, `capabilities[${docIndex}].providers[${index}]`);
      const known = merged.get(stated.providerInstanceId);
      const models = new Map((known?.models ?? []).map((model) => [model.id, model]));
      for (const model of stated.models) models.set(model.id, model);
      merged.set(stated.providerInstanceId, {
        canRunChildTask: stated.canRunChildTask ?? known?.canRunChildTask,
        constraints: stated.constraints ?? known?.constraints,
        models: [...models.values()],
        providerInstanceId: stated.providerInstanceId,
      });
    }
  }
  return {
    providers: [...merged.values()].map((provider) => ({
      canRunChildTask: provider.canRunChildTask ?? false,
      constraints: provider.constraints ?? [],
      models: provider.models,
      providerInstanceId: provider.providerInstanceId,
    })),
  };
}

/** The T3 model id for a route: pi names a provider's model `provider/modelId`. */
function t3ModelId(route: T3RouteInput): string {
  if (route.harness === "pi" && route.provider !== undefined) {
    return `${route.provider}/${route.modelId}`;
  }
  return route.modelId;
}

function ladderIndex(value: string | boolean): number {
  return typeof value === "string" ? (EFFORT_LADDER as readonly string[]).indexOf(value) : -1;
}

function effortOption(model: T3Model): T3ModelOption | undefined {
  for (const id of EFFORT_OPTION_IDS) {
    const option = model.options.find(
      (entry) => entry.id === id && entry.values.some((value) => ladderIndex(value) >= 0),
    );
    if (option !== undefined) return option;
  }
  return undefined;
}

function effortNotApplied(message: string) {
  return { notes: [{ code: "t3-effort-unsupported", message }], options: {} };
}

/**
 * Pick the effort T3 can apply: the requested level when offered, else the
 * nearest offered level below it, so a route never runs above the effort the
 * registry set, else the nearest above when the model offers nothing lower.
 * Values off the registry's ladder (T3's `ultra`, `minimal` and the like)
 * are never chosen.
 */
function resolveEffort(
  model: T3Model,
  requested: string | undefined,
): { readonly notes: readonly Coded[]; readonly options: Record<string, string> } {
  if (requested === undefined) return { notes: [], options: {} };
  const wanted = ladderIndex(requested);
  if (wanted < 0) {
    return effortNotApplied(
      `the requested effort ${requested} is not on the registry's ladder; no effort is applied`,
    );
  }
  const option = effortOption(model);
  if (option === undefined) {
    return effortNotApplied(
      `T3 offers no effort option for ${model.id}; the requested ${requested} is not applied`,
    );
  }
  // effortOption only returns an option offering at least one ladder level.
  const offered = option.values
    .map(ladderIndex)
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const below = offered.filter((index) => index <= wanted).at(-1);
  const chosen = below ?? (offered[0] as number);
  const applied = EFFORT_LADDER[chosen] as string;
  const options = { [option.id]: applied };
  if (chosen === wanted) return { notes: [], options };
  const lowered = chosen < wanted;
  return {
    notes: [
      {
        code: lowered ? "t3-effort-lowered" : "t3-effort-raised",
        message: lowered
          ? `T3 offers ${model.id} no ${requested}; ${applied} is the nearest level below`
          : `T3 offers ${model.id} nothing at or below ${requested}; ${applied} is the nearest level above`,
      },
    ],
    options,
  };
}

function translateRoute(
  route: T3RouteInput,
  capabilities: T3Capabilities,
  searched: ReadonlySet<string>,
): T3Route {
  const providerInstanceId = PROVIDER_FOR_HARNESS[route.harness] ?? route.harness;
  const provider = capabilities.providers.find(
    (entry) => entry.providerInstanceId === providerInstanceId,
  );
  if (provider === undefined) {
    return {
      label: route.label,
      reason: {
        code: "t3-provider-absent",
        message: `T3 has no provider instance "${providerInstanceId}" for the harness ${route.harness}`,
      },
      status: "unavailable",
    };
  }
  if (!provider.canRunChildTask) {
    const why = provider.constraints.length > 0 ? `: ${provider.constraints.join(" ")}` : "";
    return {
      label: route.label,
      reason: {
        code: "t3-provider-unavailable",
        message: `T3 cannot run child tasks on ${providerInstanceId}${why}`,
      },
      status: "unavailable",
    };
  }
  const modelId = t3ModelId(route);
  const model = provider.models.find((entry) => entry.id === modelId);
  if (model === undefined) {
    if (!searched.has(modelId)) {
      return { label: route.label, providerInstanceId, search: modelId, status: "lookup" };
    }
    return {
      label: route.label,
      reason: {
        code: "t3-model-not-offered",
        message: `T3's ${providerInstanceId} provider does not offer ${modelId}; a search found no such model`,
      },
      status: "unavailable",
    };
  }
  const { notes, options } = resolveEffort(model, route.effort);
  return {
    label: route.label,
    notes,
    status: "ready",
    target: { model: modelId, options, providerInstanceId },
  };
}

/** Options for `toT3Targets`. `searched` names the T3 model ids the caller
 * already passed to `orchestrator_capabilities` as `search`, with the
 * results included in the capabilities. */
export interface T3TranslateOptions {
  readonly searched?: readonly string[];
}

/**
 * Translate an answer's routes, in the answer's order. Both inputs are
 * parsed here: `answer` is a contract 1 answer, `capabilities` one or more
 * `orchestrator_capabilities` results.
 */
export function toT3Targets(
  answer: unknown,
  capabilities: readonly unknown[],
  options: T3TranslateOptions = {},
): T3Translation {
  const routes = parseT3Answer(answer);
  const parsed = parseT3Capabilities(capabilities);
  const searched = new Set(options.searched ?? []);
  return { routes: routes.map((route) => translateRoute(route, parsed, searched)) };
}
