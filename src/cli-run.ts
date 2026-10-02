import { readFileSync } from "node:fs";
import { RegistryError } from "@dungle-scrubs/model-registry";
import { Command, CommanderError } from "commander";
import { RouterError } from "./error.js";
import { listTasks, rank } from "./rank.js";
import type { RouterErrorCode } from "./types.js";
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
  4  the registry or its router section failed to load
  1  an internal fault (internal-error)`;

const USAGE_FIX = "Run model-router --help for the ranking call and its options.";
const NO_QUERY_FIX =
  "Run model-router '<query>' with a JSON query object, or pass - to read the query from stdin.";
const TASKS_FIX =
  "Run model-router tasks to print the registry's task list, or model-router '<query>' to rank.";
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

  const tasksCommand = addRegistryOption(
    new Command("tasks").description("Print the registry's task list as one JSON line."),
  );
  tasksCommand.action(function (this: Command) {
    const options = this.optsWithGlobals() as { registry?: string[] };
    const explicit = resolveRegistryOption(options.registry ?? []);
    const tasks = listTasks(explicit === "" ? {} : { registry: explicit });
    stdout.write(`${JSON.stringify(tasks)}\n`);
    answerExit = EXIT_SUCCESS;
  });
  program.addCommand(tasksCommand);

  program.argument("[query]", "the query as a JSON object, or - to read it from stdin");
  program.action((query: string | undefined, options: { registry?: string[] }) => {
    const explicit = resolveRegistryOption(options.registry ?? []);
    if (query === undefined) {
      throw queryInvalid("query", "no query argument was given.", NO_QUERY_FIX);
    }
    if (query !== "-" && !query.startsWith("{")) {
      throw queryInvalid("query", `unknown command ${JSON.stringify(query)}.`, TASKS_FIX);
    }
    const raw = query === "-" ? readStdin() : query;
    const answer = rank(raw, explicit === "" ? {} : { registry: explicit });
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
