import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { RouterError } from "./error.js";
import { toT3Targets } from "./t3.js";

const EXIT_SUCCESS = 0;
const EXIT_INTERNAL_FAULT = 1;
const EXIT_INPUT_INVALID = 2;
const EXIT_NO_ROUTE = 3;

export const T3_USAGE = `Usage: model-router '<query>' | model-router-t3 --capabilities <file> [--capabilities <file> ...] [--searched <model> ...]

Reads a model-router answer on stdin and prints one JSON line: each route as
a delegate_task target T3 Code can run ("ready"), a model to look up with
orchestrator_capabilities' search ("lookup"), or the reason T3 cannot run it
("unavailable"). Each --capabilities file holds one orchestrator_capabilities
result; later files add the models a search found. Name each model you
searched for with --searched, so a model the search did not find counts as
not offered instead of asking for another lookup.

Exit codes:
  0  at least one route is ready or needs a lookup
  2  invalid input (t3-input-invalid)
  3  no route T3 can run; the translation is still printed
  1  an internal fault (internal-error)`;

export interface T3CliSink {
  write(chunk: string): boolean;
}

export interface T3CliIo {
  readFile(path: string): string;
  readStdin(): string;
  stderr: T3CliSink;
  stdout: T3CliSink;
}

const defaultIo = {
  readFile: (path: string) => readFileSync(path, "utf8"),
  readStdin: () => readFileSync(0, "utf8"),
};

function invalid(field: string, message: string, fix: string): RouterError {
  return new RouterError({ code: "t3-input-invalid", field, fix, message, problems: [] });
}

function parseJson(text: string, field: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(field, `${source} is not valid JSON`, `Pass ${source} as one JSON document.`);
  }
}

function readCapabilities(paths: readonly string[], io: T3CliIo["readFile"]): unknown[] {
  return paths.map((path) => {
    let text: string;
    try {
      text = io(path);
    } catch {
      throw invalid(
        "capabilities",
        `the capabilities file ${path} cannot be read`,
        "Pass a readable file holding one orchestrator_capabilities result.",
      );
    }
    return parseJson(text, "capabilities", `the capabilities file ${path}`);
  });
}

function parseOptions(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        capabilities: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
        searched: { type: "string", multiple: true },
      },
      strict: true,
    });
  } catch (error) {
    throw invalid("argv", (error as Error).message, "Run model-router-t3 --help for usage.");
  }
}

/** Run model-router-t3 with `argv` (no node or script path) and return the exit code. */
export function runT3Cli(
  argv: readonly string[],
  io: Partial<T3CliIo> & Pick<T3CliIo, "stderr" | "stdout">,
): number {
  const readFile = io.readFile ?? defaultIo.readFile;
  const readStdin = io.readStdin ?? defaultIo.readStdin;
  try {
    const parsed = parseOptions(argv);
    if (parsed.values.help === true) {
      io.stdout.write(`${T3_USAGE}\n`);
      return EXIT_SUCCESS;
    }
    const paths = parsed.values.capabilities ?? [];
    if (paths.length === 0) {
      throw invalid(
        "capabilities",
        "no --capabilities file was given",
        "Save the orchestrator_capabilities result to a file and pass it with --capabilities.",
      );
    }
    const capabilities = readCapabilities(paths, readFile);
    const answer = parseJson(readStdin(), "answer", "the answer on stdin");
    const translation = toT3Targets(answer, capabilities, {
      searched: parsed.values.searched ?? [],
    });
    io.stdout.write(`${JSON.stringify(translation)}\n`);
    const runnable = translation.routes.some((route) => route.status !== "unavailable");
    return runnable ? EXIT_SUCCESS : EXIT_NO_ROUTE;
  } catch (error) {
    if (error instanceof RouterError) {
      io.stderr.write(`${JSON.stringify({ error: error.toJSON() })}\n`);
      return EXIT_INPUT_INVALID;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(
      `${JSON.stringify({
        error: {
          code: "internal-error",
          fix: "Report this failure together with the command you ran.",
          message,
        },
      })}\n`,
    );
    return EXIT_INTERNAL_FAULT;
  }
}
