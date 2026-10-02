import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EFFORT_LADDER, type EffortLevel } from "@dungle-scrubs/model-registry";
import { RouterError } from "./error.js";
import type { RouterProblem } from "./types.js";

/** The default ceiling: a level ladder entry. */
export const DEFAULT_CEILING: EffortLevel = "xhigh";

/** The default effort level when no source names one. */
export const DEFAULT_EFFORT: EffortLevel = "medium";

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

const KNOWN_KEYS = new Set(["effort"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Build the default config: every key to its documented default. */
export function defaultConfig(): RouterConfig {
  return {
    effort: {
      ceiling: DEFAULT_CEILING,
      default: DEFAULT_EFFORT,
    },
  };
}

function validateConfigObject(
  raw: unknown,
  env: ConfigEnv,
): {
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
  // and $schema is allowed for editor support.
  for (const key of Object.keys(raw)) {
    if (key === "$schema" || KNOWN_KEYS.has(key)) continue;
    problems.push({
      code: "config-key-unknown",
      field: pathJoin("$", key),
      fix: `Remove the field "${key}"; the config accepts only "effort" and "$schema".`,
      message: `the field "${key}" is not defined by the config schema`,
    });
  }
  const effortRaw = raw.effort;
  let ceiling: EffortLevel = DEFAULT_CEILING;
  let defaultLevel: EffortLevel = DEFAULT_EFFORT;
  if (effortRaw === undefined) {
    // No effort section: both defaults apply.
  } else if (!isPlainObject(effortRaw)) {
    problems.push({
      code: "config-effort-not-object",
      field: pathJoin("$", "effort"),
      fix: 'Replace "effort" with an object such as "effort": { "ceiling": "xhigh", "default": "medium" }.',
      message: 'the "effort" section must be a JSON object',
    });
  } else {
    const ceilingRaw = effortRaw.ceiling;
    if (ceilingRaw !== undefined) {
      if (
        typeof ceilingRaw !== "string" ||
        !(EFFORT_LADDER as readonly string[]).includes(ceilingRaw)
      ) {
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
    const defaultRaw = effortRaw.default;
    if (defaultRaw !== undefined) {
      if (
        typeof defaultRaw !== "string" ||
        !(EFFORT_LADDER as readonly string[]).includes(defaultRaw)
      ) {
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
  // Validate the default-above-ceiling rule regardless of which fields
  // named the levels: an explicit default on a missing ceiling still has to
  // clear the default ceiling.
  if (problems.length === 0 && exceedsLadder(defaultLevel, ceiling)) {
    problems.push({
      code: "config-effort-default-above-ceiling",
      field: pathJoin(pathJoin("$", "effort"), "default"),
      fix: `Lower "effort"."default" to "${ceiling}" or below, or raise "effort"."ceiling" to "${defaultLevel}" or above.`,
      message: `"effort"."default" "${defaultLevel}" is above "effort"."ceiling" "${ceiling}"`,
    });
  }
  void env; // The env is recorded on the loaded path; validation uses only the parsed object.
  return {
    problems,
    config: {
      effort: { ceiling, default: defaultLevel },
    },
  };
}

/** Validate a parsed config object (the library form). The path order does
 * not run; the caller already has the JSON text. */
export function validateConfigObjectInput(raw: unknown): RouterConfig {
  const { problems, config } = validateConfigObject(raw, {});
  if (problems.length > 0) {
    const [first, ...rest] = problems as [ConfigProblem, ...ConfigProblem[]];
    throw configError(first, rest);
  }
  return config;
}

/** A loaded config plus the path it came from. `configPath` is null when
 * defaults applied because no file was found at the XDG path. */
export interface LoadedConfig {
  readonly config: RouterConfig;
  readonly configPath: string | null;
}

/** The router's configuration: effort defaults. Availability and describe
 * arrive in later slices (#30, #31) and stay absent here. */
export interface RouterConfig {
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
  const text = readFileSync(filePath, "utf8");
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
  const { problems, config } = validateConfigObject(raw, {});
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
