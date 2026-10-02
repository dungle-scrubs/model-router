import { readFileSync } from "node:fs";
import { loadRegistry, RegistryError } from "@dungle-scrubs/model-registry";
import { Command, CommanderError } from "commander";
import { loadAvailabilityForCli } from "./availability-cli.js";
import { type LoadedConfig, loadConfig } from "./config.js";
import { RouterError } from "./error.js";
import { listTasks, rank } from "./rank.js";
import { validateRouterSections } from "./sections.js";
import type { AvailabilityEntry, RouterErrorCode } from "./types.js";
import { ROUTER_VERSION } from "./version.js";

const EXIT_SUCCESS = 0;
const EXIT_INTERNAL_FAULT = 1;
const EXIT_QUERY_INVALID = 2;
const EXIT_NO_ROUTE = 3;
const EXIT_REGISTRY_FAILURE = 4;

const EXIT_HELP = `

Exit codes:
  0  an answer with at least one route (rank call); or tasks printed
  2  invalid query, flag or subcommand (query-invalid)
  3  an answer with no route; the answer is still printed
  4  the registry or its router section, or the config file, failed to load
  1  an internal fault (internal-error)`;

const USAGE_FIX = "Run model-router --help for the ranking call and its options.";
const NO_QUERY_FIX =
  "Run model-router '<query>' with a JSON query object, or pass - to read the query from stdin.";
const TASKS_FIX =
  "Run model-router tasks to print the registry's task list, or model-router check, or model-router '<query>' to rank.";
const INTERNAL_FIX = "Report this failure together with the command you ran.";

export interface CliSink {
  write(chunk: string | Uint8Array): boolean;
}

export interface CliIo {
  stdout: CliSink;
  stderr: CliSink;
  readStdin(): string;
}

function readStdinDefault(): string {
  return readFileSync(0, "utf8");
}

type RouterEnvelope = {
  code: RouterErrorCode;
  field: string;
  fix: string;
  message: string;
  problems: readonly unknown[];
};

type InternalEnvelope = { code: "internal-error"; fix: string; message: string };

function writeEnvelope(
  io: Pick<CliIo, "stderr">,
  envelope: RouterEnvelope | InternalEnvelope | ReturnType<RegistryError["toJSON"]>,
): void {
  io.stderr.write(`${JSON.stringify({ error: envelope })}\n`);
}

function commanderMessage(error: CommanderError): string {
  return error.message.replace(/^error:\s*/, "");
}

function routerExitCode(code: RouterErrorCode): number {
  return code === "query-invalid" ? EXIT_QUERY_INVALID : EXIT_REGISTRY_FAILURE;
}

function resolveConfigOption(configValues: readonly string[]): string | undefined {
  if (configValues.length > 1) {
    throw queryInvalid(
      "config",
      "the --config option was given more than once.",
      "Give model-router exactly one --config path.",
    );
  }
  const explicit = configValues[0];
  if (explicit === "") {
    throw queryInvalid(
      "config",
      "the --config option was given an empty path.",
      "Give --config a non-empty path to a config file.",
    );
  }
  return explicit;
}

function addConfigOption(command: Command): Command {
  return command.option(
    "--config <path>",
    "path to the config.json file",
    (value: string, previous: string[]) => [...previous, value],
    [],
  );
}

interface AvailabilityOptionState {
  readonly file: string | undefined;
  readonly fromCommand: boolean;
}

function addAvailabilityOptions(command: Command): Command {
  command
    .option("--availability", "run availability.command from config.json", false)
    .option("--availability-file <path>", "read an availability document from <path>");
  return command;
}

function readAvailabilityOptionState(
  options: { readonly availability?: unknown; readonly availabilityFile?: unknown },
  field: string,
): AvailabilityOptionState {
  const fromCommand = options.availability === true;
  const fileRaw = options.availabilityFile;
  if (fromCommand && fileRaw !== undefined) {
    throw queryInvalid(
      field,
      "--availability and --availability-file cannot be used together.",
      "Pass only one of --availability or --availability-file <path>.",
    );
  }
  if (fileRaw === "") {
    throw queryInvalid(
      field,
      "the --availability-file option was given an empty path.",
      "Give --availability-file a non-empty path to an availability document.",
    );
  }
  if (typeof fileRaw === "string") {
    return { file: fileRaw, fromCommand };
  }
  return { file: undefined, fromCommand };
}

function queryInvalid(field: string, message: string, fix: string): RouterError {
  return new RouterError({ code: "query-invalid", field, fix, message, problems: [] });
}

function resolveRegistryOption(registryValues: readonly string[]): string {
  if (registryValues.length > 1) {
    throw queryInvalid(
      "registry",
      "the --registry option was given more than once.",
      "Give model-router exactly one --registry path.",
    );
  }
  const explicit = registryValues[0];
  if (explicit === "") {
    throw queryInvalid(
      "registry",
      "the --registry option was given an empty path.",
      "Give --registry a non-empty path to a registry file.",
    );
  }
  return explicit ?? "";
}

function addRegistryOption(command: Command): Command {
  return command.option(
    "--registry <path>",
    "path to the registry file",
    (value: string, previous: string[]) => [...previous, value],
    [],
  );
}

/** Resolve the registry the way the CLI does: an explicit `--registry`
 * path uses the file the caller chose, an absent path uses the loader's path
 * order. The check command needs both the digest and the resolved path,
 * so it calls the loader directly with the right options. */
function loadRegistryOption(explicit: string): ReturnType<typeof loadRegistry> {
  return explicit === "" ? loadRegistry() : loadRegistry({ path: explicit });
}

/** Resolve the config the way the CLI does: an explicit `--config` path
 * uses the file the caller chose, an absent option falls through to the
 * documented env path order. The same call works for rank and check, so
 * both go through this helper. */
function loadConfigOption(explicit: string | undefined): LoadedConfig {
  return loadConfig(
    explicit === undefined || explicit === ""
      ? { env: process.env as Record<string, string | undefined> }
      : { explicitPath: explicit },
  );
}

/** Build the answer that rank returns into the JSON line the CLI prints:
 * the rank call's availability option is filled only when the load has
 * entries (no flag or a failed load ranks without availability, per
 * RFC). The CLI sets `availabilityNote` from the load's note and appends
 * the load's warnings after the engine's, the way the describe block
 * will land later. */
function assembleAnswer(
  raw: string,
  explicitRegistry: string,
  explicitConfigOption: { explicitPath?: string },
  availabilityOption: readonly AvailabilityEntry[] | undefined,
  availabilityNote: import("./types.js").Coded | null,
  readerWarnings: readonly import("./types.js").Coded[],
): import("./types.js").Answer {
  const config = loadConfigOption(explicitConfigOption.explicitPath);
  const configOption = config.configPath ?? config.config;
  const baseOptions =
    availabilityOption === undefined
      ? { config: configOption }
      : { availability: availabilityOption, config: configOption };
  const rankOptions: Parameters<typeof rank>[1] =
    explicitRegistry === "" ? baseOptions : { ...baseOptions, registry: explicitRegistry };
  const answer = rank(raw, rankOptions);
  const warnings =
    readerWarnings.length === 0 ? answer.warnings : [...answer.warnings, ...readerWarnings];
  return { ...answer, availabilityNote, warnings };
}

export function runCli(argv: readonly string[], io: Partial<CliIo> = {}): number {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const readStdin = io.readStdin ?? readStdinDefault;

  let answerExit = EXIT_SUCCESS;

  const program = new Command();
  program
    .name("model-router")
    .description("Rank model routes for a query against a versioned model registry.")
    .version(ROUTER_VERSION)
    .exitOverride()
    .allowExcessArguments(false)
    .addHelpText("after", EXIT_HELP);
  program.configureOutput({
    writeOut: (text) => {
      stdout.write(text);
    },
    writeErr: () => {},
  });

  addRegistryOption(program);
  addConfigOption(program);
  addAvailabilityOptions(program);

  const tasksCommand = addRegistryOption(
    addConfigOption(
      new Command("tasks").description("Print the registry's task list as one JSON line."),
    ),
  );
  tasksCommand.exitOverride().configureOutput({
    writeOut: (text) => {
      stdout.write(text);
    },
    writeErr: () => {},
  });
  tasksCommand.hook("preAction", (thisCommand: Command) => {
    const options = thisCommand.optsWithGlobals() as {
      availability?: unknown;
      availabilityFile?: unknown;
      config?: string[];
    };
    if (options.availability === true || options.availabilityFile !== undefined) {
      throw queryInvalid(
        "availability",
        options.availability === true
          ? "the --availability option does not apply to the tasks subcommand."
          : "the --availability-file option does not apply to the tasks subcommand.",
        "Run model-router '<query>' to use --availability.",
      );
    }
    const configValues = options.config ?? [];
    if (configValues.length > 0) {
      throw queryInvalid(
        "config",
        "the --config option does not apply to the tasks subcommand.",
        "Run model-router check or model-router '<query>' to use --config.",
      );
    }
  });
  tasksCommand.action(function (this: Command) {
    const options = this.optsWithGlobals() as { registry?: string[] };
    const explicitRegistry = resolveRegistryOption(options.registry ?? []);
    const tasks = listTasks(explicitRegistry === "" ? {} : { registry: explicitRegistry });
    stdout.write(`${JSON.stringify(tasks)}\n`);
    answerExit = EXIT_SUCCESS;
  });
  program.addCommand(tasksCommand);

  const checkCommand = addRegistryOption(
    addConfigOption(
      new Command("check").description(
        "Load the registry and config, then print their paths and the registry digest.",
      ),
    ),
  );
  checkCommand.exitOverride().configureOutput({
    writeOut: (text) => {
      stdout.write(text);
    },
    writeErr: () => {},
  });
  checkCommand.hook("preAction", (thisCommand: Command) => {
    const options = thisCommand.optsWithGlobals() as {
      availability?: unknown;
      availabilityFile?: unknown;
    };
    if (options.availability === true || options.availabilityFile !== undefined) {
      throw queryInvalid(
        "availability",
        options.availability === true
          ? "the --availability option does not apply to the check subcommand."
          : "the --availability-file option does not apply to the check subcommand.",
        "Run model-router '<query>' to use --availability.",
      );
    }
  });
  checkCommand.action(function (this: Command) {
    const options = this.optsWithGlobals() as { registry?: string[]; config?: string[] };
    const explicitRegistry = resolveRegistryOption(options.registry ?? []);
    const explicitConfig = resolveConfigOption(options.config ?? []);
    const loaded = loadRegistryOption(explicitRegistry);
    validateRouterSections(loaded);
    const config = loadConfigOption(explicitConfig);
    stdout.write(
      `${JSON.stringify({
        configPath: config.configPath,
        registryDigest: loaded.digest,
        registryPath: loaded.path,
      })}\n`,
    );
    answerExit = EXIT_SUCCESS;
  });
  program.addCommand(checkCommand);

  program.argument("[query]", "the query as a JSON object, or - to read it from stdin");
  program.action(function (
    this: Command,
    query: string | undefined,
    options: {
      availability?: unknown;
      availabilityFile?: unknown;
      config?: string[];
      registry?: string[];
    },
  ): void {
    const explicitRegistry = resolveRegistryOption(options.registry ?? []);
    const explicitConfig = resolveConfigOption(options.config ?? []);
    const availabilityState = readAvailabilityOptionState(
      options as { availability?: unknown; availabilityFile?: unknown },
      "availability",
    );
    if (query === undefined) {
      throw queryInvalid("query", "no query argument was given.", NO_QUERY_FIX);
    }
    if (query !== "-" && !query.startsWith("{")) {
      throw queryInvalid("query", `unknown command ${JSON.stringify(query)}.`, TASKS_FIX);
    }
    const raw = query === "-" ? readStdin() : query;
    const config = loadConfigOption(explicitConfig);
    const availabilityLoad = loadAvailabilityForCli({
      command: availabilityState.fromCommand,
      config: config.config.availability,
      file: availabilityState.file,
    });
    const availabilityOption =
      availabilityState.file === undefined && !availabilityState.fromCommand
        ? undefined
        : availabilityLoad.entries;
    const answer = assembleAnswer(
      raw,
      explicitRegistry,
      explicitConfig === undefined ? {} : { explicitPath: explicitConfig },
      availabilityOption,
      availabilityLoad.note,
      availabilityLoad.warnings,
    );
    stdout.write(`${JSON.stringify(answer)}\n`);
    answerExit = answer.routes.length === 0 ? EXIT_NO_ROUTE : EXIT_SUCCESS;
  });

  try {
    program.parse(argv, { from: "user" });
    return answerExit;
  } catch (error) {
    if (error instanceof RouterError) {
      writeEnvelope({ stderr }, error.toJSON());
      return routerExitCode(error.code);
    }
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.code === "commander.versionDisplayed"
      ) {
        return EXIT_SUCCESS;
      }
      writeEnvelope(
        { stderr },
        {
          code: "query-invalid",
          field: "query",
          fix: USAGE_FIX,
          message: commanderMessage(error),
          problems: [],
        },
      );
      return EXIT_QUERY_INVALID;
    }
    if (error instanceof RegistryError) {
      writeEnvelope({ stderr }, error.toJSON());
      return EXIT_REGISTRY_FAILURE;
    }
    writeEnvelope(
      { stderr },
      {
        code: "internal-error",
        fix: INTERNAL_FIX,
        message: error instanceof Error ? error.message : String(error),
      },
    );
    return EXIT_INTERNAL_FAULT;
  }
}
