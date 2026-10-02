import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { runCli } from "../src/cli-run.js";
import { RouterError, rank } from "../src/index.js";
import {
  captureStream,
  expectValidAnswer,
  fixturePath,
  runBuiltCli,
  withTempDir,
  writeJson,
} from "./helpers.js";

const FULL = fixturePath("full.json");
const MINIMAL = fixturePath("minimal.json");
const TASKS = fixturePath("tasks.json");
const EMPTY = fixturePath("empty-models.json");
const POLICY_BROKEN = fixturePath("policy-broken.json");

interface RunResult {
  exitCode: number;
  stdout: () => string;
  stderr: () => string;
}

function run(args: string[], stdin?: string): RunResult {
  const out = captureStream();
  const err = captureStream();
  const exitCode = runCli(args, {
    stdout: out.stream,
    stderr: err.stream,
    readStdin: () => {
      if (stdin === undefined) throw new Error("unexpected stdin read");
      return stdin;
    },
  });
  return { exitCode, stdout: out.text, stderr: err.text };
}

function errorEnvelope(text: () => string): { error: Record<string, unknown> } {
  const parsed = JSON.parse(text()) as { error: Record<string, unknown> };
  expect(Object.keys(parsed)).toEqual(["error"]);
  return parsed;
}

describe("the ranking call", () => {
  test("exits 0 and prints one JSON answer line on stdout", () => {
    const result = run(['{"minimums":{"coding":5}}', "--registry", FULL]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr()).toBe("");
    const lines = result.stdout().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const answer = JSON.parse(lines[0] ?? "");
    expectValidAnswer(answer);
    expect(answer.contract).toBe(1);
    expect(answer.routerVersion).toBe(packageJson.version);
  });

  test("the answer carries the sha256 of the registry file", () => {
    const result = run(['{"minimums":{"coding":5}}', "--registry", FULL]);
    const answer = JSON.parse(result.stdout());
    expectValidAnswer(answer);
    expect(answer.registryDigest).toBe(
      `sha256:${createHash("sha256").update(readFileSync(FULL)).digest("hex")}`,
    );
  });

  test("reads the query from stdin with '-'", () => {
    const result = run(["-", "--registry", FULL], '{"minimums":{"coding":5}}');
    expect(result.exitCode).toBe(0);
    const answer = JSON.parse(result.stdout());
    expectValidAnswer(answer);
    expect(answer.routes.length).toBeGreaterThan(0);
  });

  test("exits 3 and still prints the answer when every route is removed", () => {
    const result = run(['{"minimums":{"coding":5},"needs":["telepathy"]}', "--registry", FULL]);
    expect(result.exitCode).toBe(3);
    const answer = JSON.parse(result.stdout());
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.removed.length).toBe(6);
  });

  test("privacy: secret with nothing left exits 3 with the local-or-nothing warning", () => {
    const result = run(['{"minimums":{"coding":5},"privacy":"secret"}', "--registry", MINIMAL]);
    expect(result.exitCode).toBe(3);
    const answer = JSON.parse(result.stdout());
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.warnings.map((warning: { code: string }) => warning.code)).toEqual([
      "local-or-nothing",
    ]);
  });
});

describe("usage failures exit 2 with query-invalid", () => {
  test("no query argument", () => {
    const result = run(["--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout()).toBe("");
    expect(errorEnvelope(result.stderr).error).toEqual({
      code: "query-invalid",
      field: "query",
      fix: "Run model-router '<query>' with a JSON query object, or pass - to read the query from stdin.",
      message: "no query argument was given.",
      problems: [],
    });
  });

  test("an unknown word names itself and points at the ranking call", () => {
    const result = run(["frobnicate", "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(errorEnvelope(result.stderr).error).toEqual({
      code: "query-invalid",
      field: "query",
      fix: "Run model-router tasks to print the registry's task list, or model-router '<query>' to rank.",
      message: 'unknown command "frobnicate".',
      problems: [],
    });
  });

  test("an unknown flag is routed through the same envelope", () => {
    const result = run(['{"minimums":{}}', "--registry", FULL, "--matrix"]);
    expect(result.exitCode).toBe(2);
    const error = errorEnvelope(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.fix).toBe("Run model-router --help for the ranking call and its options.");
    expect(error.message).toContain("--matrix");
  });

  test("two positional arguments", () => {
    const result = run(['{"minimums":{}}', "extra", "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(errorEnvelope(result.stderr).error.code).toBe("query-invalid");
  });

  test("--registry given twice", () => {
    const result = run(["--registry", FULL, "--registry", MINIMAL, '{"minimums":{}}']);
    expect(result.exitCode).toBe(2);
    const error = errorEnvelope(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("registry");
    expect(error.message).toBe("the --registry option was given more than once.");
  });

  test("--registry given an empty path", () => {
    const result = run(["--registry", "", '{"minimums":{}}']);
    expect(result.exitCode).toBe(2);
    const error = errorEnvelope(result.stderr).error;
    expect(error.message).toBe("the --registry option was given an empty path.");
    expect(error.fix).toBe("Give --registry a non-empty path to a registry file.");
  });
});

describe("query failures exit 2 with query-invalid", () => {
  test("an undefined field", () => {
    const result = run(['{"minimums":{},"tasl":"implement"}', "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout()).toBe("");
    expect(errorEnvelope(result.stderr).error).toEqual({
      code: "query-invalid",
      field: "tasl",
      fix: 'Remove "tasl", or correct its name; the query accepts task, minimums, needs, effort, pin, stakes, prefer, privacy, excludeFamilies and spec.',
      message: 'the field "tasl" is not defined by the query contract',
      problems: [],
    });
  });

  test("a query with neither task nor minimums", () => {
    const result = run(['{"privacy":"secret"}', "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(errorEnvelope(result.stderr).error).toEqual({
      code: "query-invalid",
      field: "query",
      fix: 'Add "task": "<name>" or "minimums": { ... } to the query.',
      message: 'a query must carry "task" or "minimums"',
      problems: [],
    });
  });

  test("a query that is not valid JSON", () => {
    const result = run(["{oops", "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    const error = errorEnvelope(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.message).toBe("the query is not valid JSON: {oops");
  });
});

describe("registry failures exit 4", () => {
  test("a registry without router.rank reports registry-sections-invalid with the line to add", () => {
    const result = run(['{"minimums":{"coding":5}}', "--registry", fixturePath("no-router.json")]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout()).toBe("");
    expect(errorEnvelope(result.stderr).error).toEqual({
      code: "registry-sections-invalid",
      field: '$["router"]',
      fix: 'Add the line "router": { "rank": ["coding"] } to the registry file, with the ratings that order routes.',
      message: "the registry file has no router section, which model-router requires",
      problems: [
        {
          code: "router-section-missing",
          field: '$["router"]',
          fix: 'Add the line "router": { "rank": ["coding"] } to the registry file, with the ratings that order routes.',
          message: "the registry file has no router section, which model-router requires",
        },
      ],
    });
  });

  test("a registry whose router section has no rank", () => {
    const result = run([
      '{"minimums":{"coding":5}}',
      "--registry",
      fixturePath("missing-rank.json"),
    ]);
    expect(result.exitCode).toBe(4);
    const error = errorEnvelope(result.stderr).error;
    expect(error.code).toBe("registry-sections-invalid");
    expect((error.problems as { code: string }[])[0]?.code).toBe("router-rank-missing");
    expect(error.fix).toContain('"rank"');
  });

  test("a missing registry file prints the loader's own envelope unchanged", async () => {
    await withTempDir(async (dir) => {
      const missing = resolve(dir, "nonexistent", "nope.json");
      const result = run([`{"minimums":{"coding":5}}`, "--registry", missing]);
      expect(result.exitCode).toBe(4);
      expect(result.stdout()).toBe("");
      const error = errorEnvelope(result.stderr).error;
      expect(error).toEqual({
        code: "registry-missing",
        fix: "Create the file, or check an example by running model-registry check --registry examples/registry.json.",
        message: `no registry file exists at "${missing}"`,
        path: missing,
        problems: [],
      });
    });
  });

  test("a registry file that is not JSON prints the loader's own envelope", () => {
    const result = run(['{"minimums":{"coding":5}}', "--registry", fixturePath("not-json.json")]);
    expect(result.exitCode).toBe(4);
    const error = errorEnvelope(result.stderr).error;
    expect(error.code).toBe("registry-unreadable");
    expect(error.message).toContain("not valid JSON");
  });

  test("with no registry anywhere the loader's registry-missing exits 4", async () => {
    await withTempDir(async (dir) => {
      const savedFile = process.env.MODEL_REGISTRY_FILE;
      const savedXdg = process.env.XDG_CONFIG_HOME;
      delete process.env.MODEL_REGISTRY_FILE;
      process.env.XDG_CONFIG_HOME = dir;
      try {
        const result = run(['{"minimums":{"coding":5}}']);
        expect(result.exitCode).toBe(4);
        expect(errorEnvelope(result.stderr).error.code).toBe("registry-missing");
      } finally {
        if (savedFile === undefined) {
          delete process.env.MODEL_REGISTRY_FILE;
        } else {
          process.env.MODEL_REGISTRY_FILE = savedFile;
        }
        if (savedXdg === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = savedXdg;
        }
      }
    });
  });
});

describe("help, version and environment", () => {
  test("--help exits 0 and documents the exit codes", () => {
    const result = run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr()).toBe("");
    expect(result.stdout()).toContain("model-router");
    expect(result.stdout()).toContain("Exit codes:");
    expect(result.stdout()).toContain("0  an answer with at least one route");
    expect(result.stdout()).toContain("2  invalid query, flag or subcommand (query-invalid)");
    expect(result.stdout()).toContain("3  an answer with no route; the answer is still printed");
    expect(result.stdout()).toContain("4  the registry or its router section failed to load");
    expect(result.stdout()).toContain("1  an internal fault (internal-error)");
    expect(result.stdout()).toContain("--registry <path>");
  });

  test("--version prints the package version", () => {
    const result = run(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr()).toBe("");
    expect(result.stdout()).toBe(`${packageJson.version}\n`);
  });

  test("a broken stdin read reports an internal fault and exits 1", () => {
    const out = captureStream();
    const err = captureStream();
    const exitCode = runCli(["-", "--registry", FULL], {
      stdout: out.stream,
      stderr: err.stream,
      readStdin: () => {
        throw new Error("stdin exploded");
      },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(err.text())).toEqual({
      error: {
        code: "internal-error",
        fix: "Report this failure together with the command you ran.",
        message: "stdin exploded",
      },
    });
  });
});

describe("the tasks subcommand", () => {
  test("prints the task list as one JSON line on stdout and exits 0", () => {
    const result = run(["tasks", "--registry", TASKS]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr()).toBe("");
    const lines = result.stdout().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const tasks = JSON.parse(lines[0] ?? "");
    expect(tasks).toEqual([
      { name: "task-a", description: "Write or change code to a stated spec." },
      { name: "task-b", description: "Browse the web and gather references." },
    ]);
  });

  test("prints [] when the registry has no tasks section", () => {
    const result = run(["tasks", "--registry", EMPTY]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout())).toEqual([]);
  });

  test("exits 4 with registry-sections-invalid on the same problems as rank", () => {
    let rankProblems: readonly unknown[] = [];
    try {
      rank({ task: "task-a" }, { registry: POLICY_BROKEN });
      throw new Error("expected rank to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      rankProblems = (error as RouterError).problems;
    }
    expect(rankProblems.length).toBeGreaterThanOrEqual(5);
    const result = run(["tasks", "--registry", POLICY_BROKEN]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout()).toBe("");
    const error = errorEnvelope(result.stderr).error;
    expect(error.code).toBe("registry-sections-invalid");
    expect(error.problems).toEqual(rankProblems);
  });

  test("exits 4 with registry-sections-invalid when router is missing", () => {
    const result = run(["tasks", "--registry", fixturePath("no-router.json")]);
    expect(result.exitCode).toBe(4);
    expect(errorEnvelope(result.stderr).error.code).toBe("registry-sections-invalid");
  });

  test("a tasks subcommand parser failure returns 2 with the envelope instead of exiting", () => {
    // runCli must return, not process.exit: an embedding process keeps
    // control when the child command rejects an option.
    const result = run(["tasks", "--matrix"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout()).toBe("");
    expect(errorEnvelope(result.stderr).error).toEqual({
      code: "query-invalid",
      field: "query",
      fix: "Run model-router --help for the ranking call and its options.",
      message: "unknown option '--matrix'",
      problems: [],
    });
  });
});

describe("the built CLI", () => {
  test("a malformed policy route label exits 4 with both section problems", async () => {
    // The malformed label must surface as registry-sections-invalid, not
    // as an internal fault from formatting the effort diagnostic.
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "policy-malformed-label.json", {
        format: 1,
        ratings: { coding: "Code." },
        router: { rank: ["coding"] },
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: {}, normal: {}, high: {} },
            rank: ["coding"],
          },
        },
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["normal"],
            routes: [{ route: { toString: 7 }, effort: "warp-nine" }],
            reason: "r",
          },
        },
        models: {},
      });
      const result = runBuiltCli(['{"task":"task-a"}', "--registry", path]);
      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr).error;
      expect(error.code).toBe("registry-sections-invalid");
      expect(error.problems.map((problem: { code: string }) => problem.code)).toEqual([
        "policy-route-label-missing",
        "policy-route-effort-invalid",
      ]);
    });
  });

  test("a rank call exits 0 through node dist/cli.js", () => {
    const result = runBuiltCli(['{"minimums":{"coding":5}}', "--registry", FULL]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expectValidAnswer(JSON.parse(result.stdout));
  });

  test("an answer with no route exits 3 through node dist/cli.js", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5},"privacy":"secret"}',
      "--registry",
      MINIMAL,
    ]);
    expect(result.exitCode).toBe(3);
    expectValidAnswer(JSON.parse(result.stdout));
  });

  test("a usage failure exits 2 through node dist/cli.js", () => {
    const result = runBuiltCli(["--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe("query-invalid");
  });

  test("stdin reaches the built CLI", () => {
    const result = runBuiltCli(["-", "--registry", FULL], {}, '{"minimums":{"coding":5}}');
    expect(result.exitCode).toBe(0);
    expectValidAnswer(JSON.parse(result.stdout));
  });

  test("MODEL_REGISTRY_FILE supplies the registry when --registry is absent", () => {
    const result = runBuiltCli(['{"minimums":{"coding":5}}'], {
      MODEL_REGISTRY_FILE: FULL,
    });
    expect(result.exitCode).toBe(0);
    expectValidAnswer(JSON.parse(result.stdout));
  });

  test("a tasks subcommand parser failure exits 2 with the query-invalid envelope", () => {
    const result = runBuiltCli(["tasks", "--matrix", "--registry", TASKS]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("query");
    expect(error.fix).toBe("Run model-router --help for the ranking call and its options.");
    expect(error.message).toContain("--matrix");
    expect(error.problems).toEqual([]);
  });

  test("tasks --help exits 0 and prints its help on stdout", () => {
    const result = runBuiltCli(["tasks", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tasks");
    expect(result.stdout).toContain("--registry");
    expect(result.stderr).toBe("");
  });
});
