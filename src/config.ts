import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EFFORT_LADDER, type EffortLevel } from "@dungle-scrubs/model-registry";
import { RouterError } from "./error.js";
import { DEFAULT_JEV_MODEL } from "./jev.js";
import type { RouterProblem } from "./types.js";

/** The default ceiling: a level ladder entry. */
export const DEFAULT_CEILING: EffortLevel = "xhigh";

/** The default effort level when no source names one. */
export const DEFAULT_EFFORT: EffortLevel = "medium";

/** The default task confidence gate for the describe step. */
export const DEFAULT_TASK_GATE = 0.85;

/** The default capability escalation threshold for the describe step. */
export const DEFAULT_CAPABILITY_THRESHOLD = 0.5;

/** The Jev model the package pins for the describe step. Versioned, not an
 * alias: the gates above were chosen against a model that must not move
 * underneath them. The constant lives in the Jev client; the response's
 * `model` field reports what answered. */
export { DEFAULT_JEV_MODEL } from "./jev.js";

/** A precise problem the config file had, or a single-finding RouterError. */
export interface ConfigProblem {
  readonly code: string;
  readonly field: string;
  readonly fix: string;
  readonly message: string;
}

interface ConfigEnv {
  readonly MODEL_ROUTER_CONFIG?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly [key: string]: string | undefined;
}

const KNOWN_KEYS = new Set(["availability", "describe", "effort"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function pathJoin(parent: string, child: string): string {
  return `${parent}[${JSON.stringify(child)}]`;
}

function exceedsLadder(value: string, top: string): boolean {
  const ladder = EFFORT_LADDER as readonly string[];
  const valueIndex = ladder.indexOf(value);
  const topIndex = ladder.indexOf(top);
  if (valueIndex === -1 || topIndex === -1) return false;
  return valueIndex > topIndex;
}

const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_MAX_AGE_SECONDS = 300;

function validateAvailability(
  raw: unknown,
  problems: ConfigProblem[],
): RouterConfigAvailability | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    problems.push({
      code: "config-availability-not-object",
      field: pathJoin("$", "availability"),
      fix: 'Replace "availability" with an object such as "availability": { "command": ["availability-to-neutral", "--json"] }.',
      message: 'the "availability" section must be a JSON object',
    });
    return undefined;
  }
  let command: readonly string[] | undefined;
  if (hasOwn(raw, "command")) {
    const cmdRaw = raw.command;
    if (!Array.isArray(cmdRaw)) {
      problems.push({
        code: "config-availability-command-not-array",
        field: pathJoin(pathJoin("$", "availability"), "command"),
        fix: 'Replace "availability"."command" with an argv array such as ["availability-to-neutral", "--json"].',
        message: '"availability"."command" must be an array of strings',
      });
    } else if (cmdRaw.length === 0) {
      problems.push({
        code: "config-availability-command-empty",
        field: pathJoin(pathJoin("$", "availability"), "command"),
        fix: 'Pass at least one argv string in "availability"."command", or remove the field to disable the source.',
        message: '"availability"."command" must be a non-empty array',
      });
    } else if (!cmdRaw.every((entry): entry is string => typeof entry === "string")) {
      problems.push({
        code: "config-availability-command-entry-not-string",
        field: pathJoin(pathJoin("$", "availability"), "command"),
        fix: 'Set every entry of "availability"."command" to a string; argv runs without a shell.',
        message: 'every entry of "availability"."command" must be a string',
      });
    } else {
      command = cmdRaw as readonly string[];
    }
  }
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (hasOwn(raw, "timeoutSeconds")) {
    const timeoutRaw = raw.timeoutSeconds;
    if (typeof timeoutRaw !== "number" || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
      problems.push({
        code: "config-availability-timeout-invalid",
        field: pathJoin(pathJoin("$", "availability"), "timeoutSeconds"),
        fix: `Set "availability"."timeoutSeconds" to a positive number of seconds; the default is ${DEFAULT_TIMEOUT_SECONDS}.`,
        message: '"availability"."timeoutSeconds" must be a positive number',
      });
    } else {
      timeoutSeconds = timeoutRaw;
    }
  }
  let maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS;
  if (hasOwn(raw, "maxAgeSeconds")) {
    const ageRaw = raw.maxAgeSeconds;
    if (typeof ageRaw !== "number" || !Number.isFinite(ageRaw) || ageRaw <= 0) {
      problems.push({
        code: "config-availability-max-age-invalid",
        field: pathJoin(pathJoin("$", "availability"), "maxAgeSeconds"),
        fix: `Set "availability"."maxAgeSeconds" to a positive number of seconds; the default is ${DEFAULT_MAX_AGE_SECONDS}.`,
        message: '"availability"."maxAgeSeconds" must be a positive number',
      });
    } else {
      maxAgeSeconds = ageRaw;
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== "command" && key !== "timeoutSeconds" && key !== "maxAgeSeconds") {
      problems.push({
        code: "config-availability-key-unknown",
        field: pathJoin(pathJoin("$", "availability"), key),
        fix: `Remove the field "availability"."${key}"; "availability" accepts only "command", "timeoutSeconds" and "maxAgeSeconds".`,
        message: `the field "availability"."${key}" is not defined by the config schema`,
      });
    }
  }
  return command === undefined
    ? { maxAgeSeconds, timeoutSeconds }
    : { command, maxAgeSeconds, timeoutSeconds };
}

/** Build the default config: every key to its documented default. */
export function defaultConfig(): RouterConfig {
  return {
    describe: {
      capabilityThreshold: DEFAULT_CAPABILITY_THRESHOLD,
      jevModel: DEFAULT_JEV_MODEL,
      taskGate: DEFAULT_TASK_GATE,
    },
    effort: {
      ceiling: DEFAULT_CEILING,
      default: DEFAULT_EFFORT,
    },
  };
}

/** Validate a parsed config object (the library form). The path order does
 * not run; the caller already has the JSON text. */
export function validateConfigObjectInput(raw: unknown): RouterConfig {
  const { problems, config } = validateConfigObject(raw);
  if (problems.length > 0) {
    const [first, ...rest] = problems as [ConfigProblem, ...ConfigProblem[]];
    throw configError(first, rest);
  }
  return config;
}

function validateConfigObject(raw: unknown): {
  problems: ConfigProblem[];
  config: RouterConfig;
} {
  const problems: ConfigProblem[] = [];
  // An empty object is valid: every default applies.
  if (raw === undefined || (isPlainObject(raw) && Object.keys(raw).length === 0)) {
    return { problems, config: defaultConfig() };
  }
  if (!isPlainObject(raw)) {
    problems.push({
      code: "config-not-object",
      field: "$",
      fix: "Replace the file with a JSON object such as {}; every key is OPTIONAL.",
      message: "the config file must be a JSON object",
    });
    return { problems, config: defaultConfig() };
  }
  // The closed-schema check: every top-level key beyond effort is a problem,
  // and $schema is allowed for editor support. Own-property reads only:
  // an inherited name such as "constructor" is not a problem here.
  for (const key of Object.keys(raw)) {
    if (key === "$schema" || KNOWN_KEYS.has(key)) continue;
    problems.push({
      code: "config-key-unknown",
      field: pathJoin("$", key),
      fix: `Remove the field "${key}"; the config accepts only "effort", "describe" and "$schema".`,
      message: `the field "${key}" is not defined by the config schema`,
    });
  }
  const effortRaw = hasOwn(raw, "effort") ? raw.effort : undefined;
  // Track whether the relationship check has all-valid values. Independent
  // problems with effort (not-object, off-ladder ceiling, off-ladder default)
  // are reported, but the default-above-ceiling check still fires beside
  // them: an unrelated unknown key does not hide it.
  let effortValid = true;
  let ceiling: EffortLevel = DEFAULT_CEILING;
  let defaultLevel: EffortLevel = DEFAULT_EFFORT;
  if (effortRaw === undefined) {
    // No effort section: both defaults apply.
  } else if (!isPlainObject(effortRaw)) {
    effortValid = false;
    problems.push({
      code: "config-effort-not-object",
      field: pathJoin("$", "effort"),
      fix: 'Replace "effort" with an object such as "effort": { "ceiling": "xhigh", "default": "medium" }.',
      message: 'the "effort" section must be a JSON object',
    });
  } else {
    // Own-property reads: an inherited ceiling or default is treated as
    // absent, so the defaults apply and the relationship check uses them.
    const ceilingRaw = hasOwn(effortRaw, "ceiling") ? effortRaw.ceiling : undefined;
    if (ceilingRaw !== undefined) {
      if (
        typeof ceilingRaw !== "string" ||
        !(EFFORT_LADDER as readonly string[]).includes(ceilingRaw)
      ) {
        effortValid = false;
        problems.push({
          code: "config-effort-ceiling-invalid",
          field: pathJoin(pathJoin("$", "effort"), "ceiling"),
          fix: `Set "effort"."ceiling" to one of ${EFFORT_LADDER.join(", ")}.`,
          message: `"effort"."ceiling" must be one of ${EFFORT_LADDER.join(", ")}`,
        });
      } else {
        ceiling = ceilingRaw as EffortLevel;
      }
    }
    const defaultRaw = hasOwn(effortRaw, "default") ? effortRaw.default : undefined;
    if (defaultRaw !== undefined) {
      if (
        typeof defaultRaw !== "string" ||
        !(EFFORT_LADDER as readonly string[]).includes(defaultRaw)
      ) {
        effortValid = false;
        problems.push({
          code: "config-effort-default-invalid",
          field: pathJoin(pathJoin("$", "effort"), "default"),
          fix: `Set "effort"."default" to one of ${EFFORT_LADDER.join(", ")}.`,
          message: `"effort"."default" must be one of ${EFFORT_LADDER.join(", ")}`,
        });
      } else {
        defaultLevel = defaultRaw as EffortLevel;
      }
    }
    for (const key of Object.keys(effortRaw)) {
      if (key !== "ceiling" && key !== "default") {
        problems.push({
          code: "config-effort-key-unknown",
          field: pathJoin(pathJoin("$", "effort"), key),
          fix: `Remove the field "effort"."${key}"; "effort" accepts only "ceiling" and "default".`,
          message: `the field "effort"."${key}" is not defined by the config schema`,
        });
      }
    }
  }
  // The relationship check fires whenever both parsed levels are valid
  // ladder entries, regardless of unrelated findings like an unknown key.
  // An invalid operand (off-ladder) suppresses the check, so the caller
  // sees the precise reason a level is bad before the relationship.
  if (effortValid && exceedsLadder(defaultLevel, ceiling)) {
    problems.push({
      code: "config-effort-default-above-ceiling",
      field: pathJoin(pathJoin("$", "effort"), "default"),
      fix: `Lower "effort"."default" to "${ceiling}" or below, or raise "effort"."ceiling" to "${defaultLevel}" or above.`,
      message: `"effort"."default" "${defaultLevel}" is above "effort"."ceiling" "${ceiling}"`,
    });
  }
  const availabilityRaw = hasOwn(raw, "availability") ? raw.availability : undefined;
  const availability = validateAvailability(availabilityRaw, problems);
  const describeSection = validateDescribeSection(raw, problems);
  return {
    problems,
    config: {
      ...(availability === undefined ? {} : { availability }),
      describe: describeSection,
      effort: { ceiling, default: defaultLevel },
    },
  };
}

/** A probability: a finite number in [0, 1]. */
function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validate the describe section with own-property reads. Inherited values
 * are absent, so the defaults apply. */
function validateDescribeSection(
  raw: Record<string, unknown>,
  problems: ConfigProblem[],
): RouterConfig["describe"] {
  const describeRaw = hasOwn(raw, "describe") ? raw.describe : undefined;
  if (describeRaw === undefined) {
    return defaultConfig().describe;
  }
  if (!isPlainObject(describeRaw)) {
    problems.push({
      code: "config-describe-not-object",
      field: pathJoin("$", "describe"),
      fix: 'Replace "describe" with an object such as "describe": { "taskGate": 0.85, "capabilityThreshold": 0.5 }.',
      message: 'the "describe" section must be a JSON object',
    });
    return defaultConfig().describe;
  }
  let taskGate = DEFAULT_TASK_GATE;
  let capabilityThreshold = DEFAULT_CAPABILITY_THRESHOLD;
  let jevModel: string = DEFAULT_JEV_MODEL;
  const taskGateRaw = hasOwn(describeRaw, "taskGate") ? describeRaw.taskGate : undefined;
  if (taskGateRaw !== undefined) {
    if (!isProbability(taskGateRaw)) {
      problems.push({
        code: "config-describe-task-gate-invalid",
        field: pathJoin(pathJoin("$", "describe"), "taskGate"),
        fix: 'Set "describe"."taskGate" to a probability between 0 and 1, such as 0.85.',
        message: '"describe"."taskGate" must be a probability between 0 and 1',
      });
    } else {
      taskGate = taskGateRaw;
    }
  }
  const thresholdRaw = hasOwn(describeRaw, "capabilityThreshold")
    ? describeRaw.capabilityThreshold
    : undefined;
  if (thresholdRaw !== undefined) {
    if (!isProbability(thresholdRaw)) {
      problems.push({
        code: "config-describe-capability-threshold-invalid",
        field: pathJoin(pathJoin("$", "describe"), "capabilityThreshold"),
        fix: 'Set "describe"."capabilityThreshold" to a probability between 0 and 1, such as 0.5.',
        message: '"describe"."capabilityThreshold" must be a probability between 0 and 1',
      });
    } else {
      capabilityThreshold = thresholdRaw;
    }
  }
  const modelRaw = hasOwn(describeRaw, "jevModel") ? describeRaw.jevModel : undefined;
  if (modelRaw !== undefined) {
    if (typeof modelRaw !== "string" || modelRaw.trim().length === 0) {
      problems.push({
        code: "config-describe-jev-model-invalid",
        field: pathJoin(pathJoin("$", "describe"), "jevModel"),
        fix: 'Set "describe"."jevModel" to a Jev model name, or remove it to use the pinned default.',
        message: '"describe"."jevModel" must be a non-empty Jev model name',
      });
    } else {
      jevModel = modelRaw;
    }
  }
  for (const key of Object.keys(describeRaw)) {
    if (key !== "taskGate" && key !== "capabilityThreshold" && key !== "jevModel") {
      problems.push({
        code: "config-describe-key-unknown",
        field: pathJoin(pathJoin("$", "describe"), key),
        fix: `Remove the field "describe"."${key}"; "describe" accepts only "taskGate", "capabilityThreshold" and "jevModel".`,
        message: `the field "describe"."${key}" is not defined by the config schema`,
      });
    }
  }
  return { capabilityThreshold, jevModel, taskGate };
}

/** A loaded config plus the path it came from. `configPath` is null when
 * defaults applied because no file was found at the XDG path. */
export interface LoadedConfig {
  readonly config: RouterConfig;
  readonly configPath: string | null;
}

/** The availability config: how the CLI gathers a document (none of these
 * are required for `applyAvailability` itself - the library caller
 * supplies entries directly). `command` is the argv the `--availability`
 * flag runs; an absent value triggers the "command-missing" note and a
 * graceful no-op. `timeoutSeconds` is the per-run kill timeout; a value
 * that isn't a positive finite number is invalid. `maxAgeSeconds` is the
 * staleness bound applied to both command output and a saved file. */
export interface RouterConfigAvailability {
  readonly command?: readonly string[];
  readonly maxAgeSeconds: number;
  readonly timeoutSeconds: number;
}

/** The router's configuration: effort defaults, the describe step's
 * gates, and the optional availability source. */
export interface RouterConfig {
  readonly availability?: RouterConfigAvailability;
  readonly describe: {
    readonly capabilityThreshold: number;
    readonly jevModel: string;
    readonly taskGate: number;
  };
  readonly effort: {
    readonly ceiling: EffortLevel;
    readonly default: EffortLevel;
  };
}

function configError(first: ConfigProblem, rest: readonly ConfigProblem[]): RouterError {
  // Every problem is reported: the first names the field and fix for the
  // envelope's top level, and every problem lives in the `problems` array
  // so the caller can walk the file's findings in order.
  const all = [first, ...rest];
  return new RouterError({
    code: "config-invalid",
    field: first.field,
    fix:
      rest.length === 0
        ? first.fix
        : "Fix each problem listed in problems, then run model-router again.",
    message: rest.length === 0 ? first.message : `the config file has ${all.length} problems`,
    problems: all.map(toRouterProblem),
  });
}

function toRouterProblem(problem: ConfigProblem): RouterProblem {
  return {
    code: problem.code,
    field: problem.field,
    fix: problem.fix,
    message: problem.message,
  };
}

function readJsonFromPath(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    // Any filesystem failure between the existence check and the read -
    // directory at the path, permission denied, the file removed by
    // another process - is a router failure of the config-invalid class.
    // The shape code is not permitted here: the caller's envelope is
    // exit 4, not 1.
    const reason = error instanceof Error ? error.message : String(error);
    throw new RouterError({
      code: "config-invalid",
      field: "$",
      fix: `Make the file "${filePath}" readable as a regular file, or pass a different --config path.`,
      message: `the config file at "${filePath}" could not be read: ${reason}`,
      problems: [],
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RouterError({
      code: "config-invalid",
      field: "$",
      fix: "Replace the file with valid JSON such as {} or an empty file.",
      message: `the config file at "${filePath}" is not valid JSON`,
      problems: [],
    });
  }
}

/** Load a config from one explicit path. The file MUST exist. The XDG
 * default does not apply; absent means config-invalid. */
export function loadConfigFromPath(path: string): LoadedConfig {
  if (!existsSync(path)) {
    throw new RouterError({
      code: "config-invalid",
      field: "$",
      fix: `Create the file "${path}", or pass a path that does exist.`,
      message: `no config file exists at "${path}"`,
      problems: [],
    });
  }
  const raw = readJsonFromPath(path);
  const { problems, config } = validateConfigObject(raw);
  if (problems.length > 0) {
    const [first, ...rest] = problems as [ConfigProblem, ...ConfigProblem[]];
    throw configError(first, rest);
  }
  return { config, configPath: path };
}

/** The XDG path: `$XDG_CONFIG_HOME/model-router/config.json`, with the
 * platform default of `~/.config`. The function never touches the disk. */
export function xdgConfigPath(env: ConfigEnv = {}): string {
  const xdg = env.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "model-router", "config.json");
}

/** Resolve a config in the documented path order: the explicit option,
 * MODEL_ROUTER_CONFIG, then the XDG path. When the XDG path has no file,
 * the function returns `{ config: defaults, configPath: null }` with no
 * warning. An explicit path that is missing or invalid is config-invalid. */
export function loadConfig(
  options: { explicitPath?: string | undefined; env?: ConfigEnv } = {},
): LoadedConfig {
  const env = options.env ?? process.env;
  const explicit = options.explicitPath ?? env.MODEL_ROUTER_CONFIG;
  if (explicit !== undefined && explicit.length > 0) {
    return loadConfigFromPath(resolveConfigPath(explicit));
  }
  const xdgPath = xdgConfigPath(env);
  if (!existsSync(xdgPath)) {
    return { config: defaultConfig(), configPath: null };
  }
  return loadConfigFromPath(xdgPath);
}

/** Resolve a path string the way `loadConfig` does: relative paths are
 * resolved against the current working directory, absolute paths pass
 * through. Used by the CLI so `--config ./cfg.json` finds the file the
 * caller expects. */
export function resolveConfigPath(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}
