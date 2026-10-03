import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryErrorCode } from "@dungle-scrubs/model-registry";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli-run.js";
import { RouterError, rank } from "../src/index.js";
import type { RouterErrorCode } from "../src/types.js";
import { captureStream, expectValidError, expectValidRouterError, repoRoot } from "./helpers.js";

const errorSchemaPath = join(repoRoot, "error.schema.json");
const errorSchema = JSON.parse(readFileSync(errorSchemaPath, "utf8")) as object;
const validateError = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(errorSchema);

function parseEnvelope(stderr: () => string): { error: Record<string, unknown> } {
  const parsed = JSON.parse(stderr()) as { error: Record<string, unknown> };
  expectValidError(parsed);
  expect(Object.keys(parsed)).toEqual(["error"]);
  return parsed;
}

async function runCliCapture(
  args: readonly string[],
  stdin?: string,
): Promise<{ exitCode: number; stderr: () => string; stdout: () => string }> {
  const out = captureStream();
  const err = captureStream();
  const exitCode = await runCli(args, {
    stdout: out.stream,
    stderr: err.stream,
    readStdin: () => {
      if (stdin === undefined) throw new Error("unexpected stdin read");
      return stdin;
    },
  });
  return { exitCode, stderr: err.text, stdout: out.text };
}

describe("error.schema.json", () => {
  test("RouterError envelopes require field and problems", () => {
    const envelope = {
      code: "query-invalid",
      message: "Invalid.",
      fix: "Fix it.",
      field: "$",
      problems: [],
    };
    for (const key of ["code", "field", "message", "fix", "problems"]) {
      const incomplete: Record<string, unknown> = { ...envelope };
      delete incomplete[key];
      expect(validateError({ error: incomplete }), key).toBe(false);
    }
  });

  test("RegistryError envelopes require path and problems", () => {
    const envelope = {
      code: "registry-missing",
      message: "Missing.",
      fix: "Create it.",
      path: "registry-a.json",
      problems: [],
    };
    for (const key of ["path", "problems"]) {
      const incomplete: Record<string, unknown> = { ...envelope };
      delete incomplete[key];
      expect(validateError({ error: incomplete }), key).toBe(false);
    }
  });

  test("an internal Error with an empty message produces a valid envelope", async () => {
    const out = captureStream();
    const err = captureStream();
    const exit = await runCli(["-"], {
      stdout: out.stream,
      stderr: err.stream,
      readStdin: () => {
        throw new Error("");
      },
    });
    expect(exit).toBe(1);
    const envelope = parseEnvelope(err.text);
    expect(envelope.error.message).toBe("");
  });
  test("every RouterError code listed in the schema is allowed by the package", () => {
    const emittedCodes = {
      "backup-exists": true,
      "config-invalid": true,
      "describe-failed": true,
      "describe-private": true,
      "format-missing": true,
      "format-unsupported": true,
      "internal-error": true,
      "label-duplicate": true,
      "query-invalid": true,
      "rating-mismatch": true,
      "reference-unknown": true,
      "registry-invalid": true,
      "registry-missing": true,
      "registry-sections-invalid": true,
      "registry-unreadable": true,
    } satisfies Record<RouterErrorCode | RegistryErrorCode | "internal-error", true>;
    const codes = (
      errorSchema as { properties: { error: { properties: { code: { examples: string[] } } } } }
    ).properties.error.properties.code.examples;
    expect([...codes].sort()).toEqual(Object.keys(emittedCodes).sort());
  });

  test("accepts a code added in a later version and rejects an empty code", () => {
    const envelope = (code: string) => ({
      error: {
        code,
        field: "query",
        fix: "Upgrade the consumer to read the new code.",
        message: "a code this schema version does not list.",
        problems: [],
      },
    });
    expect(validateError(envelope("future-code"))).toBe(true);
    expect(validateError(envelope(""))).toBe(false);
  });

  test("accepts a query-invalid envelope with no problems", () => {
    const envelope = {
      error: {
        code: "query-invalid",
        field: "query",
        fix: "Run model-router '<query>' with a JSON query object, or pass - to read the query from stdin.",
        message: "no query argument was given.",
        problems: [],
      },
    };
    expect(validateError(envelope)).toBe(true);
  });

  test("accepts a config-invalid envelope with a populated problems array", () => {
    const envelope = {
      error: {
        code: "config-invalid",
        field: '$["effort"]',
        fix: "Fix each problem listed in problems, then run model-router again.",
        message: "the config file has 2 problems",
        problems: [
          {
            code: "config-effort-ceiling-invalid",
            field: '$["effort"]["ceiling"]',
            fix: 'Set "effort"."ceiling" to one of low, medium, high, xhigh, max.',
            message: '"effort"."ceiling" must be one of low, medium, high, xhigh, max',
          },
          {
            code: "config-key-unknown",
            field: '["mystery"]',
            fix: 'Remove the field "mystery"; the config accepts only "effort", "availability", "describe" and "$schema".',
            message: 'the field "mystery" is not defined by the config schema',
          },
        ],
      },
    };
    expect(validateError(envelope)).toBe(true);
  });

  test("accepts a registry-sections-invalid envelope", () => {
    const envelope = {
      error: {
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
      },
    };
    expect(validateError(envelope)).toBe(true);
  });

  test("accepts a registry-missing envelope (path, not field)", () => {
    const envelope = {
      error: {
        code: "registry-missing",
        fix: "Create the file.",
        message: "no registry file exists.",
        path: "/some/path.json",
        problems: [],
      },
    };
    expect(validateError(envelope)).toBe(true);
  });

  test("accepts the internal-error envelope the CLI emits on unhandled failures", () => {
    const envelope = {
      error: {
        code: "internal-error",
        fix: "Report this failure together with the command you ran.",
        message: "an unexpected error",
      },
    };
    expect(validateError(envelope)).toBe(true);
  });

  test("rejects an envelope missing the required fix or message", () => {
    const noFix = {
      error: {
        code: "query-invalid",
        field: "query",
        message: "x",
        problems: [],
      },
    };
    expect(validateError(noFix)).toBe(false);
    const noMessage = {
      error: {
        code: "query-invalid",
        field: "query",
        fix: "Fix.",
        problems: [],
      },
    };
    expect(validateError(noMessage)).toBe(false);
  });

  test("rejects an envelope whose fix is empty (the contract requires a one-sentence fix)", () => {
    const envelope = {
      error: {
        code: "query-invalid",
        field: "query",
        fix: "",
        message: "x",
        problems: [],
      },
    };
    expect(validateError(envelope)).toBe(false);
  });

  test("rejects an envelope whose problem is missing a code, field, fix or message", () => {
    const envelope = {
      error: {
        code: "config-invalid",
        field: "$",
        fix: "Fix the problems.",
        message: "two problems",
        problems: [{ code: "config-effort-ceiling-invalid", field: "$", message: "x" }],
      },
    };
    expect(validateError(envelope)).toBe(false);
  });

  test("the CLI's query-invalid envelope validates against the schema", async () => {
    const result = await runCliCapture(["--registry", "tests/fixtures/full.json"]);
    expect(result.exitCode).toBe(2);
    const envelope = parseEnvelope(result.stderr);
    expect(validateError(envelope), JSON.stringify(validateError.errors ?? null, null, 2)).toBe(
      true,
    );
  });

  test("the CLI's registry-sections-invalid envelope validates against the schema", async () => {
    const result = await runCliCapture([
      '{"minimums":{"coding":5}}',
      "--registry",
      "tests/fixtures/no-router.json",
    ]);
    expect(result.exitCode).toBe(4);
    const envelope = parseEnvelope(result.stderr);
    expect(validateError(envelope), JSON.stringify(validateError.errors ?? null, null, 2)).toBe(
      true,
    );
  });

  test("the CLI's config-invalid envelope validates against the schema", async () => {
    // A missing --config path is config-invalid; the envelope still has
    // every field the schema requires. The path is computed with
    // mkdtempSync so the test is portable across Windows/macOS/Linux.
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-error-"));
    try {
      const missing = path.join(dir, "config.json");
      const result = await runCliCapture([
        '{"minimums":{"coding":5}}',
        "--registry",
        "tests/fixtures/full.json",
        "--config",
        missing,
      ]);
      expect(result.exitCode).toBe(4);
      const envelope = parseEnvelope(result.stderr);
      expect(validateError(envelope), JSON.stringify(validateError.errors ?? null, null, 2)).toBe(
        true,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI's unknown-flag envelope (Commander) validates against the schema", async () => {
    const result = await runCliCapture(['{"minimums":{}}', "--matrix"]);
    expect(result.exitCode).toBe(2);
    const envelope = parseEnvelope(result.stderr);
    expect(validateError(envelope), JSON.stringify(validateError.errors ?? null, null, 2)).toBe(
      true,
    );
  });

  test("the CLI's registry-missing envelope (loader) validates against the schema", async () => {
    // A missing registry file is registry-missing. The envelope carries a
    // `path` rather than a `field`; the schema accepts both.
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-reg-"));
    try {
      const missing = path.join(dir, "registry.json");
      const result = await runCliCapture(['{"minimums":{"coding":5}}', "--registry", missing]);
      expect(result.exitCode).toBe(4);
      const envelope = parseEnvelope(result.stderr);
      expect(validateError(envelope), JSON.stringify(validateError.errors ?? null, null, 2)).toBe(
        true,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the library's RouterError.toJSON() output validates against the schema", () => {
    // query-invalid path: simplest single-problem envelope
    try {
      rank({ privacy: "secret" }, { registry: "tests/fixtures/full.json" });
      throw new Error("expected rank to throw");
    } catch (error) {
      if (error instanceof RouterError) expectValidRouterError(error);
      expect(error).toBeInstanceOf(RouterError);
      const envelope = { error: (error as RouterError).toJSON() };
      expect(validateError(envelope), JSON.stringify(validateError.errors ?? null, null, 2)).toBe(
        true,
      );
    }
  });

  test("the library's RouterError with multiple problems validates against the schema", () => {
    // The config validator collects every problem; the resulting envelope
    // has a multi-problem array. Build one directly so the test does not
    // depend on a fixture file.
    try {
      rank(
        { minimums: { coding: 5 } },
        {
          registry: "tests/fixtures/full.json",
          config: { effort: { ceiling: "low", default: "high" }, mystery: true },
        },
      );
      throw new Error("expected rank to throw");
    } catch (error) {
      if (error instanceof RouterError) expectValidRouterError(error);
      expect(error).toBeInstanceOf(RouterError);
      const envelope = { error: (error as RouterError).toJSON() };
      expect(validateError(envelope), JSON.stringify(validateError.errors ?? null, null, 2)).toBe(
        true,
      );
      expect(envelope.error.problems).toBeInstanceOf(Array);
    }
  });
});
