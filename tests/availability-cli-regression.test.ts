import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadAvailabilityForCli, runAvailabilityCommand } from "../src/availability-cli.js";
import { runCli } from "../src/cli-run.js";
import {
  captureStream,
  expectValidAnswer,
  fixturePath,
  runBuiltCli,
  withEnv,
  withTempDir,
  writeJson,
} from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

afterEach(() => vi.restoreAllMocks());

const FULL = fixturePath("full.json");
const QUERY = '{"minimums":{"coding":5}}';

async function run(args: string[]) {
  const out = captureStream();
  const err = captureStream();
  const exitCode = await runCli(args, { stdout: out.stream, stderr: err.stream });
  return { exitCode, stdout: out.text(), stderr: err.text() };
}

function answerOf(result: { stdout: string; stderr: string; exitCode: number }) {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const answer: unknown = JSON.parse(result.stdout);
  expectValidAnswer(answer);
  return answer;
}

describe("availability answer assembly", () => {
  test.each(["command", "file"])(
    "a failed %s source ranks without availability",
    async (source) => {
      await withTempDir(async (dir) => {
        const config = writeJson(dir, "config.json", {});
        const flags =
          source === "command"
            ? ["--availability"]
            : ["--availability-file", join(dir, "missing.json")];
        const answer = answerOf(
          await run([QUERY, "--registry", FULL, "--config", config, ...flags]),
        );
        expect(answer.availabilityNote?.code).toBe(
          source === "command" ? "availability-command-missing" : "availability-file-unreadable",
        );
        expect(answer.warnings.map((w) => w.code)).not.toContain("meter-no-reading");
      });
    },
  );

  test.each(["missing", "mixed"])("describe merges a %s availability load", async (source) => {
    await withEnv({ TYPESAFE_API_KEY: "key-a" }, async () =>
      withTempDir(async (dir) => {
        const registry = JSON.parse(readFileSync(fixturePath("describe.json"), "utf8"));
        registry.meters = { "meter-a": {} };
        registry.models["model-a"].routes[0].meter = "meter-a";
        const registryPath = writeJson(dir, "registry.json", registry);
        const config = writeJson(dir, "config.json", {});
        const description = join(dir, "work.txt");
        writeFileSync(description, "implement the change");
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: {
                task: {
                  type: "choice",
                  choice: "task-b",
                  confidence: 0.6,
                  probabilities: { "task-a": 0.4, "task-b": 0.6 },
                },
                needs_browser: { type: "noul", noul: 0.1 },
                "needs_repo-access": { type: "noul", noul: 0.1 },
              },
              usage: { input_tokens: 500, output_tokens: 30 },
            }),
            { status: 200 },
          ),
        );
        const file =
          source === "missing"
            ? join(dir, "missing.json")
            : writeJson(dir, "avail.json", {
                format: 1,
                generatedAt: new Date().toISOString(),
                entries: [
                  { meter: "meter-a", status: "ok" },
                  { meter: "meter-b", status: "bogus" },
                ],
              });
        const answer = answerOf(
          await run([
            '{"privacy":"normal","excludeFamilies":["family-c"]}',
            "--registry",
            registryPath,
            "--config",
            config,
            "--describe",
            description,
            "--availability-file",
            file,
          ]),
        );
        expect(answer.warnings.map((w) => w.code)).toEqual(
          source === "missing"
            ? ["task-uncertain", "family-unknown"]
            : ["task-uncertain", "family-unknown", "availability-entry-invalid"],
        );
        if (source === "missing") {
          expect(answer.availabilityNote?.code).toBe("availability-file-unreadable");
        } else {
          expect(answer.availabilityNote).toBeNull();
          expect(answer.warnings[2]?.field).toBe("$.entries[1]");
          expect(answer.routes.find((r) => r.label === "model-a@harness-x")?.availability).toBe(
            "ok",
          );
        }
      }),
    );
  });
});

describe("repeated availability files", () => {
  test.each(["in-process", "built"])("%s CLI rejects two paths", async (mode) => {
    await withTempDir(async (dir) => {
      const file = writeJson(dir, "avail.json", {
        format: 1,
        generatedAt: new Date().toISOString(),
        entries: [],
      });
      const args = [
        QUERY,
        "--registry",
        FULL,
        "--availability-file",
        file,
        "--availability-file",
        file,
      ];
      const result = mode === "built" ? runBuiltCli(args) : await run(args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toEqual({
        code: "query-invalid",
        field: "availability",
        message: "the --availability-file option was given more than once.",
        fix: "Give model-router exactly one --availability-file path.",
        problems: [],
      });
    });
  });
});

describe("availability file boundary", () => {
  test("a file load applies readings without starting a subprocess", async () => {
    await withTempDir(async (dir) => {
      const file = writeJson(dir, "avail.json", {
        format: 1,
        generatedAt: new Date().toISOString(),
        entries: [{ meter: "meter-a", status: "ok" }],
      });
      vi.mocked(spawnSync).mockClear();
      const answer = answerOf(await run([QUERY, "--registry", FULL, "--availability-file", file]));
      expect(spawnSync).not.toHaveBeenCalled();
      expect(answer.availabilityNote).toBeNull();
      expect(answer.routes.find((r) => r.label === "model-a@harness-x")?.availability).toBe("ok");
    });
  });

  test("other spawn errors report their actual cause", () => {
    const error = Object.assign(new Error("blocked command"), { code: "EACCES" });
    vi.mocked(spawnSync).mockReturnValueOnce({
      error,
      status: null,
      signal: null,
      output: [],
      stdout: "",
      stderr: "",
      pid: 0,
    });
    const load = runAvailabilityCommand(["command-a"], { maxAgeSeconds: 300, timeoutSeconds: 1 });
    expect(load.entries).toEqual([]);
    expect(load.note?.code).toBe("availability-command-failed");
    expect(load.note?.message).toBe("the availability command failed to run: blocked command");
  });

  test("the built CLI skips invalid entries and applies the good one", async () => {
    await withTempDir(async (dir) => {
      const file = writeJson(dir, "avail.json", {
        format: 1,
        generatedAt: new Date().toISOString(),
        entries: [
          { meter: "meter-a", status: "ok" },
          { meter: "meter-b" },
          { meter: "meter-c", status: "bogus" },
          { meter: "meter-d", status: "ok", percentRemaining: "12" },
        ],
      });
      const answer = answerOf(
        runBuiltCli([QUERY, "--registry", FULL, "--availability-file", file]),
      );
      expect(answer.availabilityNote).toBeNull();
      expect(answer.routes.find((r) => r.label === "model-a@harness-x")?.availability).toBe("ok");
      expect(answer.warnings.map((w) => ({ code: w.code, field: w.field }))).toEqual(
        [1, 2, 3].map((index) => ({
          code: "availability-entry-invalid",
          field: `$.entries[${index}]`,
        })),
      );
    });
  });
});

describe("ranking config snapshot", () => {
  test("describe and rank share the settings loaded before the request", async () => {
    await withEnv({ TYPESAFE_API_KEY: "key-a" }, async () =>
      withTempDir(async (dir) => {
        const config = writeJson(dir, "config.json", {
          effort: { default: "low", ceiling: "high" },
        });
        const description = join(dir, "work.txt");
        writeFileSync(description, "implement the change");
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          writeFileSync(config, "{not json");
          return new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: {
                task: {
                  type: "choice",
                  choice: "task-a",
                  confidence: 0.9,
                  probabilities: { "task-a": 0.9, "task-b": 0.1 },
                },
                needs_browser: { type: "noul", noul: 0.1 },
                "needs_repo-access": { type: "noul", noul: 0.1 },
              },
              usage: { input_tokens: 500, output_tokens: 30 },
            }),
            { status: 200 },
          );
        });
        vi.mocked(readFileSync).mockClear();
        const answer = answerOf(
          await run([
            '{"privacy":"normal"}',
            "--registry",
            fixturePath("describe.json"),
            "--config",
            config,
            "--describe",
            description,
          ]),
        );
        expect(answer.routes.map((r) => r.effort)).toEqual(["low", "low", "low"]);
        expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === config)).toHaveLength(
          1,
        );
      }),
    );
  });
});

describe("availability source clock", () => {
  test.each(["command", "file"])(
    "%s uses one post-source instant for staleness and expiry",
    async (source) => {
      await withTempDir(async (dir) => {
        const file = writeJson(dir, "avail.json", {});
        const RealDate = Date;
        const before = RealDate.parse("2026-10-01T12:00:00Z");
        const after = RealDate.parse("2026-10-01T12:00:01Z");
        const document = JSON.stringify({
          format: 1,
          generatedAt: "2026-10-01T12:00:01Z",
          entries: [{ meter: "meter-a", status: "ok", resetsAt: "2026-10-01T12:00:01.100Z" }],
        });
        let returned = false;
        let reads = 0;
        const ClockDate = new Proxy(RealDate, {
          construct(target, args) {
            if (args.length !== 0) return Reflect.construct(target, args);
            reads += 1;
            return new RealDate(returned ? after + (reads - 1) * 200 : before);
          },
        });
        const markReturned = () => {
          returned = true;
          return document;
        };
        if (source === "command") {
          vi.mocked(spawnSync).mockImplementationOnce(() => ({
            status: 0,
            signal: null,
            output: [],
            stdout: markReturned(),
            stderr: "",
            pid: 0,
          }));
        } else {
          vi.mocked(readFileSync).mockImplementationOnce(markReturned);
        }
        vi.stubGlobal("Date", ClockDate);
        try {
          const load = loadAvailabilityForCli({
            command: source === "command",
            config: { command: ["command-a"], maxAgeSeconds: 300, timeoutSeconds: 1 },
            file: source === "file" ? file : undefined,
          });
          expect(load.note).toBeNull();
          expect(load.entries).toEqual([
            { meter: "meter-a", status: "ok", resetsAt: "2026-10-01T12:00:01.100Z" },
          ]);
          expect(reads).toBe(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    },
  );
});

describe("availability command result", () => {
  test("an absent signal is not reported as a killed command", () => {
    const result = {
      status: 0,
      signal: undefined,
      output: [],
      stdout: JSON.stringify({
        format: 1,
        generatedAt: "2026-10-01T12:00:00Z",
        entries: [{ meter: "meter-a", status: "ok" }],
      }),
      stderr: "",
      pid: 0,
    };
    vi.mocked(spawnSync).mockReturnValueOnce(result as unknown as ReturnType<typeof spawnSync>);
    const load = runAvailabilityCommand(["command-a"], {
      maxAgeSeconds: 300,
      timeoutSeconds: 1,
      now: new Date("2026-10-01T12:00:00Z"),
    });
    expect(load.note).toBeNull();
    expect(load.entries).toEqual([{ meter: "meter-a", status: "ok" }]);
  });
});
