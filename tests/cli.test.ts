import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { runCli } from "../src/cli-run.js";
import {
  captureStream,
  expectValidAnswer,
  fixturePath,
  runBuiltCli,
  withTempDir,
} from "./helpers.js";

const FULL = fixturePath("full.json");
const MINIMAL = fixturePath("minimal.json");

describe("the built CLI", () => {
  test("a rank call with inline minimums exits 0 and prints one JSON answer line", () => {
    const result = runBuiltCli(['{"minimums":{"coding":5}}', "--registry", FULL]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const answer = JSON.parse(lines[0] ?? "");
    expectValidAnswer(answer);
    expect(answer.contract).toBe(1);
    expect(answer.routerVersion).toBe(packageJson.version);
    expect(answer.routes.length).toBeGreaterThan(0);
  });

  test("the answer carries the sha256 of the registry file", () => {
    const result = runBuiltCli(['{"minimums":{"coding":5}}', "--registry", FULL]);
    const answer = JSON.parse(result.stdout) as { registryDigest: string };
    expect(answer.registryDigest).toBe(
      `sha256:${createHash("sha256").update(readFileSync(FULL)).digest("hex")}`,
    );
  });

  test("a rank call whose routes are all removed exits 3 and still prints the answer", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5},"needs":["telepathy"]}',
      "--registry",
      FULL,
    ]);
    expect(result.exitCode).toBe(3);
    const answer = JSON.parse(result.stdout);
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.removed.length).toBe(6);
  });

  test("privacy: secret with nothing left exits 3 with the local-or-nothing warning", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5},"privacy":"secret"}',
      "--registry",
      MINIMAL,
    ]);
    expect(result.exitCode).toBe(3);
    const answer = JSON.parse(result.stdout);
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.warnings.map((warning: { code: string }) => warning.code)).toEqual([
      "local-or-nothing",
    ]);
  });

  test("reads the query from stdin with '-'", () => {
    const result = runBuiltCli(["-", "--registry", FULL], {}, '{"minimums":{"coding":5}}');
    expect(result.exitCode).toBe(0);
    const answer = JSON.parse(result.stdout);
    expectValidAnswer(answer);
    expect(answer.routes.length).toBeGreaterThan(0);
  });

  test("--help exits 0 and documents the exit codes", () => {
    const result = runBuiltCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("model-router");
    expect(result.stdout).toContain("Exit codes:");
    expect(result.stdout).toContain("0  an answer with at least one route");
    expect(result.stdout).toContain("3  an answer with no route; the answer is still printed");
    expect(result.stdout).toContain("--registry <path>");
  });

  test("--version prints the package version", () => {
    const result = runBuiltCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${packageJson.version}\n`);
  });

  test("no query argument exits 2 with query-invalid", () => {
    const result = runBuiltCli(["--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("query-invalid");
    expect(envelope.error.message).toBe("no query argument was given.");
  });

  test("a query with an undefined field exits 2 with query-invalid", () => {
    const result = runBuiltCli(['{"minimums":{},"tasl":"implement"}', "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr) as { error: { code: string; field: string } };
    expect(envelope.error.code).toBe("query-invalid");
    expect(envelope.error.field).toBe("tasl");
  });

  test("a query with neither task nor minimums exits 2 with query-invalid", () => {
    const result = runBuiltCli(['{"privacy":"secret"}', "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe("query-invalid");
  });

  test("a query that is not valid JSON exits 2 with query-invalid", () => {
    const result = runBuiltCli(["{oops", "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe("query-invalid");
  });

  test("an unknown word exits 2 with query-invalid and a fix naming the ranking call", () => {
    const result = runBuiltCli(["tasks", "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as { error: { code: string; fix: string } };
    expect(envelope.error.code).toBe("query-invalid");
    expect(envelope.error.fix).toContain("model-router '<query>'");
  });

  test("an unknown flag exits 2 with query-invalid", () => {
    const result = runBuiltCli(['{"minimums":{}}', "--registry", FULL, "--matrix"]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe("query-invalid");
  });

  test("two positional arguments exit 2", () => {
    const result = runBuiltCli(['{"minimums":{}}', "extra", "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe("query-invalid");
  });

  test("--registry given twice exits 2", () => {
    const result = runBuiltCli(["--registry", FULL, "--registry", MINIMAL, '{"minimums":{}}']);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe("query-invalid");
    expect(JSON.parse(result.stderr).error.message).toContain("--registry");
  });

  test("--registry given an empty path exits 2", () => {
    const result = runBuiltCli(["--registry", "", '{"minimums":{}}']);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe("query-invalid");
  });

  test("a registry without router.rank exits 4 with registry-sections-invalid and the line to add", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5}}',
      "--registry",
      fixturePath("no-router.json"),
    ]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr) as {
      error: { code: string; fix: string; problems: Array<{ code: string }> };
    };
    expect(envelope.error.code).toBe("registry-sections-invalid");
    expect(envelope.error.problems[0]?.code).toBe("router-section-missing");
    expect(envelope.error.fix).toContain('"router": { "rank": ["coding"] }');
  });

  test("a registry whose router section has no rank exits 4", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5}}',
      "--registry",
      fixturePath("missing-rank.json"),
    ]);
    expect(result.exitCode).toBe(4);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe("registry-sections-invalid");
  });

  test("a missing registry file exits 4 with the loader's own envelope", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5}}',
      "--registry",
      "/nonexistent/nope.json",
    ]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr) as { error: { code: string; path: string } };
    expect(envelope.error.code).toBe("registry-missing");
    expect(envelope.error.path).toBe("/nonexistent/nope.json");
  });

  test("a registry file that is not JSON exits 4 with the loader's own envelope", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5}}',
      "--registry",
      fixturePath("not-json.json"),
    ]);
    expect(result.exitCode).toBe(4);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe("registry-unreadable");
  });

  test("MODEL_REGISTRY_FILE supplies the registry when --registry is absent", () => {
    const result = runBuiltCli(['{"minimums":{"coding":5}}'], {
      MODEL_REGISTRY_FILE: FULL,
    });
    expect(result.exitCode).toBe(0);
    const answer = JSON.parse(result.stdout);
    expectValidAnswer(answer);
  });

  test("with no registry anywhere the loader's registry-missing exits 4", async () => {
    await withTempDir(async (dir) => {
      const result = runBuiltCli(['{"minimums":{"coding":5}}'], {
        MODEL_REGISTRY_FILE: undefined,
        XDG_CONFIG_HOME: dir,
      });
      expect(result.exitCode).toBe(4);
      const envelope = JSON.parse(result.stderr) as { error: { code: string } };
      expect(envelope.error.code).toBe("registry-missing");
    });
  });
});

describe("runCli in process", () => {
  test("prints the answer and returns 0, or 3 when no route survives", () => {
    const out = captureStream();
    const err = captureStream();
    expect(
      runCli(['{"minimums":{"coding":5}}', "--registry", FULL], {
        stdout: out.stream,
        stderr: err.stream,
      }),
    ).toBe(0);
    expectValidAnswer(JSON.parse(out.text()));
    expect(err.text()).toBe("");

    const out3 = captureStream();
    expect(
      runCli(['{"minimums":{"coding":5},"privacy":"secret"}', "--registry", MINIMAL], {
        stdout: out3.stream,
        stderr: captureStream().stream,
      }),
    ).toBe(3);
    expectValidAnswer(JSON.parse(out3.text()));
  });

  test("a query-invalid error prints its envelope on stderr and returns 2", () => {
    const out = captureStream();
    const err = captureStream();
    const code = runCli(['{"privacy":"secret"}', "--registry", FULL], {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(2);
    const envelope = JSON.parse(err.text()) as { error: { code: string } };
    expect(envelope.error.code).toBe("query-invalid");
    expect(out.text()).toBe("");
  });

  test("a broken stdin read reports an internal fault and returns 1", () => {
    const err = captureStream();
    const code = runCli(["-", "--registry", FULL], {
      stdout: captureStream().stream,
      stderr: err.stream,
      readStdin: () => {
        throw new Error("stdin exploded");
      },
    });
    expect(code).toBe(1);
    const envelope = JSON.parse(err.text()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("internal-error");
    expect(envelope.error.message).toBe("stdin exploded");
  });
});
