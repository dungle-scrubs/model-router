import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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
