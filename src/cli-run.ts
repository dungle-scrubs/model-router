import { readFileSync } from "node:fs";
import { loadRegistry, RegistryError } from "@dungle-scrubs/model-registry";
import { Command, CommanderError } from "commander";
import { type AvailabilityLoad, loadAvailabilityForCli } from "./availability-cli.js";
import { type LoadedConfig, loadConfig } from "./config.js";
import { checkDescribeText, describe as describeStep, parseDescribeQuery } from "./describe.js";
import { RouterError } from "./error.js";
import { listTasks, rank } from "./rank.js";
import { validateRouterSections } from "./sections.js";
import type { Answer, Coded, RouterErrorCode } from "./types.js";
import { ROUTER_VERSION } from "./version.js";

const EXIT_SUCCESS = 0;
const EXIT_INTERNAL_FAULT = 1;
const EXIT_QUERY_INVALID = 2;
const EXIT_NO_ROUTE = 3;
const EXIT_REGISTRY_FAILURE = 4;
const EXIT_DESCRIBE_FAILED = 5;

const EXIT_HELP = `

Exit codes:
  0  an answer with at least one route (rank call); or tasks printed
  2  invalid query, flag or subcommand (query-invalid), or the describe step refusing secret work (describe-private)
  3  an answer with no route; the answer is still printed
  4  the registry or its router section, or the config file, failed to load
  5  the describe step needed a Jev answer and the call failed (describe-failed)
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
  if (code === "query-invalid" || code === "describe-private") return EXIT_QUERY_INVALID;
  if (code === "describe-failed") return EXIT_DESCRIBE_FAILED;
  return EXIT_REGISTRY_FAILURE;
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
    .option(
      "--availability-file <path>",
      "read an availability document from <path>",
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    );
  return command;
}

function readAvailabilityOptionState(
  options: { readonly availability?: unknown; readonly availabilityFile?: unknown },
  field: string,
): AvailabilityOptionState {
  const fromCommand = options.availability === true;
  const files = options.availabilityFile as readonly string[] | undefined;
  if (files !== undefined && files.length > 1) {
    throw queryInvalid(
      field,
      "the --availability-file option was given more than once.",
      "Give model-router exactly one --availability-file path.",
    );
  }
  const fileRaw = files?.[0];
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

function resolveDescribeOption(describeValues: readonly string[]): string | undefined {
  if (describeValues.length > 1) {
    throw queryInvalid(
      "describe",
      "the --describe option was given more than once.",
      "Give model-router exactly one --describe path.",
    );
  }
  const explicit = describeValues[0];
  if (explicit === "") {
    throw queryInvalid(
      "describe",
      "the --describe option was given an empty path.",
      "Give --describe a non-empty path to a work description file.",
    );
  }
  return explicit;
}

function addDescribeOption(command: Command): Command {
  return command.option(
    "--describe <file>",
    "read the work description from <file> and fill the query's task and needs with a Jev call",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  );
}

function readDescribeFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw queryInvalid(
      "describe",
      `the --describe file "${path}" could not be read: ${reason}`,
      "Give --describe a path to a readable text file holding the work description.",
    );
  }
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

/** Both ranking paths merge describe, engine and reader warnings in that order. */
function assembleAnswer(
  answer: Answer,
  load: AvailabilityLoad,
  described?: { readonly describe: Answer["describe"]; readonly warnings: readonly Coded[] },
): Answer {
  return {
    ...answer,
    availabilityNote: load.note,
    describe: described?.describe ?? answer.describe,
    warnings: [...(described?.warnings ?? []), ...answer.warnings, ...load.warnings],
  };
}

/** Run the model-router CLI. Returns the exit code instead of exiting, so
 * an embedding process keeps control; async because the describe step
 * awaits a Jev call. */
export async function runCli(argv: readonly string[], io: Partial<CliIo> = {}): Promise<number> {
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
  addDescribeOption(program);

  const tasksCommand = addRegistryOption(
    addConfigOption(
      new Command("tasks").description("Print the registry's task list as one JSON line."),
    ),
  );
  // Commander 15 does not inherit the root's exitOverride or output sinks
  // through addCommand: configure the child the same way, so its parser
  // errors throw back to the shared catch instead of calling process.exit,
  // and its help reaches stdout through the same sink.
  tasksCommand.exitOverride().configureOutput({
    writeOut: (text) => {
      stdout.write(text);
    },
    writeErr: () => {},
  });
  tasksCommand.action(function (this: Command) {
    const options = this.optsWithGlobals() as {
      registry?: string[];
      config?: string[];
      describe?: string[];
      availability?: unknown;
      availabilityFile?: unknown;
    };
    const explicitRegistry = resolveRegistryOption(options.registry ?? []);
    const configValues = options.config ?? [];
    // The command --config takes no value: tasks prints the registry's
    // task list and never reads the config, so a config flag here is
    // exit 2 with the query-invalid envelope.
    if (configValues.length > 0) {
      throw queryInvalid(
        "config",
        "the --config option does not apply to the tasks subcommand.",
        "Run model-router check or model-router '<query>' to use --config.",
      );
    }
    // The --describe flag is the same: it belongs to the ranking call, and
    // tasks never makes a Jev call.
    if ((options.describe ?? []).length > 0) {
      throw queryInvalid(
        "describe",
        "the --describe option does not apply to the tasks subcommand.",
        "Run model-router '<query>' --describe <file> to use --describe.",
      );
    }
    if (options.availability === true || options.availabilityFile !== undefined) {
      throw queryInvalid(
        "availability",
        options.availability === true
          ? "the --availability option does not apply to the tasks subcommand."
          : "the --availability-file option does not apply to the tasks subcommand.",
        "Run model-router '<query>' to use --availability.",
      );
    }
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
  // Commander 15 does not inherit the root's exitOverride or output sinks
  // through addCommand: configure the child the same way, so its parser
  // errors throw back to the shared catch instead of calling process.exit,
  // and its help reaches stdout through the same sink.
  checkCommand.exitOverride().configureOutput({
    writeOut: (text) => {
      stdout.write(text);
    },
    writeErr: () => {},
  });
  checkCommand.action(function (this: Command) {
    const options = this.optsWithGlobals() as {
      registry?: string[];
      config?: string[];
      describe?: string[];
      availability?: unknown;
      availabilityFile?: unknown;
    };
    const explicitRegistry = resolveRegistryOption(options.registry ?? []);
    const explicitConfig = resolveConfigOption(options.config ?? []);
    // The check command runs no availability source and makes no Jev call:
    // it loads the registry (path resolution and digest), validates the
    // router sections the same way rank and listTasks do, then loads the
    // config. Any of those failures is exit 4. The --describe flag belongs
    // to the ranking call and is exit 2 here.
    if ((options.describe ?? []).length > 0) {
      throw queryInvalid(
        "describe",
        "the --describe option does not apply to the check subcommand.",
        "Run model-router '<query>' --describe <file> to use --describe.",
      );
    }
    if (options.availability === true || options.availabilityFile !== undefined) {
      throw queryInvalid(
        "availability",
        options.availability === true
          ? "the --availability option does not apply to the check subcommand."
          : "the --availability-file option does not apply to the check subcommand.",
        "Run model-router '<query>' to use --availability.",
      );
    }
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
  program.action(
    async (
      query: string | undefined,
      options: {
        registry?: string[];
        config?: string[];
        describe?: string[];
        availability?: unknown;
        availabilityFile?: unknown;
      },
    ) => {
      const explicitRegistry = resolveRegistryOption(options.registry ?? []);
      const explicitConfig = resolveConfigOption(options.config ?? []);
      const describeFile = resolveDescribeOption(options.describe ?? []);
      const availabilityState = readAvailabilityOptionState(options, "availability");
      if (query === undefined) {
        throw queryInvalid("query", "no query argument was given.", NO_QUERY_FIX);
      }
      if (query !== "-" && !query.startsWith("{")) {
        throw queryInvalid("query", `unknown command ${JSON.stringify(query)}.`, TASKS_FIX);
      }
      const raw = query === "-" ? readStdin() : query;
      // The describe step gates run before any load so a secret or empty
      // description is rejected ahead of every file read. The privacy gate
      // is the first: it parses the query and refuses `secret`. The text
      // gate is the second: it reads the description file (only with a
      // valid privacy) and refuses an empty description. Only after both
      // gates does the CLI load the registry and config.
      let describeText: string | undefined;
      if (describeFile !== undefined) {
        parseDescribeQuery(raw);
        describeText = readDescribeFile(describeFile);
        checkDescribeText(describeText);
      }
      // Load config once. Describe, availability and rank use the same
      // validated settings, not a path that rank would read again.
      const config = loadConfigOption(explicitConfig);
      const availabilityLoad = loadAvailabilityForCli({
        command: availabilityState.fromCommand,
        config: config.config.availability,
        file: availabilityState.file,
      });
      const availabilityOption =
        availabilityLoad.note === null &&
        (availabilityState.file !== undefined || availabilityState.fromCommand)
          ? availabilityLoad.entries
          : undefined;
      if (describeText !== undefined) {
        // Load the registry once and hand the loaded result to both the
        // describe step and rank: the task set offered to Jev and the
        // digest in the answer come from the same bytes.
        const loadedRegistry = loadRegistryOption(explicitRegistry);
        const rankOptions: Parameters<typeof rank>[1] =
          availabilityOption === undefined
            ? { registry: loadedRegistry, config: config.config }
            : {
                registry: loadedRegistry,
                config: config.config,
                availability: availabilityOption,
              };
        // The describe step fills the query's task and needs through a Jev
        // call, then ranks the filled query and merges the describe block
        // into the answer. The describe step's warnings lead the answer's
        // warnings list: they happened first.
        const described = await describeStep(describeText, raw, rankOptions);
        const answer = rank(described.query, rankOptions);
        const merged = assembleAnswer(answer, availabilityLoad, described);
        stdout.write(`${JSON.stringify(merged)}\n`);
        answerExit = merged.routes.length === 0 ? EXIT_NO_ROUTE : EXIT_SUCCESS;
        return;
      }
      const rankOptions: Parameters<typeof rank>[1] =
        explicitRegistry === ""
          ? availabilityOption === undefined
            ? { config: config.config }
            : { availability: availabilityOption, config: config.config }
          : availabilityOption === undefined
            ? { registry: explicitRegistry, config: config.config }
            : {
                registry: explicitRegistry,
                availability: availabilityOption,
                config: config.config,
              };
      const answer = assembleAnswer(rank(raw, rankOptions), availabilityLoad);
      stdout.write(`${JSON.stringify(answer)}\n`);
      answerExit = answer.routes.length === 0 ? EXIT_NO_ROUTE : EXIT_SUCCESS;
    },
  );

  try {
    await program.parseAsync(argv, { from: "user" });
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
