import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "@dungle-scrubs/model-registry";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";
import answerSchema from "../answer.schema.json" with { type: "json" };
import errorSchema from "../error.schema.json" with { type: "json" };
import { type Answer, RouterError } from "../src/index.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cliPath = join(repoRoot, "dist", "cli.js");
export const fixturesDir = join(repoRoot, "tests", "fixtures");
export const querySchemaPath = join(repoRoot, "query.schema.json");
export const answerSchemaPath = join(repoRoot, "answer.schema.json");

export function requireBuild(): void {
  if (!existsSync(cliPath)) {
    throw new Error("dist/cli.js is missing; run pnpm build before the tests.");
  }
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runBuiltCli(
  args: string[],
  env: Record<string, string | undefined> = {},
  input?: string,
): CliResult {
  requireBuild();
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    env: merged,
    input,
  });
  const stderr = result.stderr ?? "";
  if (stderr.length > 0) expectValidError(JSON.parse(stderr));
  return {
    stdout: result.stdout ?? "",
    stderr,
    exitCode: result.status ?? -1,
  };
}

export function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

export function loadLoaded(path: string) {
  return loadRegistry({ path });
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const ajv = new Ajv2020({ allErrors: true, strictNumbers: true });
const validateAnswer = ajv.compile(answerSchema);
const validateError = ajv.compile(errorSchema);

export function expectValidError(envelope: unknown): void {
  expect(validateError(envelope), JSON.stringify(validateError.errors ?? [], null, 2)).toBe(true);
}

export function expectValidRouterError(error: unknown): asserts error is RouterError {
  expect(error).toBeInstanceOf(RouterError);
  expectValidError({ error: (error as RouterError).toJSON() });
}

export function errorMatching(details: Record<string, unknown>) {
  return {
    asymmetricMatch(error: unknown): boolean {
      expectValidRouterError(error);
      return expect.objectContaining(details).asymmetricMatch(error);
    },
  };
}

/** Every answer the tests produce must validate against answer.schema.json. */
export function expectValidAnswer(answer: unknown): asserts answer is Answer {
  const valid = validateAnswer(answer);
  expect(valid, JSON.stringify(validateAnswer.errors ?? [], null, 2)).toBe(true);
}

export async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "model-router-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeJson(dir: string, name: string, data: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

export async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Every coded object the availability feature emits must carry a
 * non-empty message and a one-sentence fix: capitalised and ending in
 * a period, the RFC's "the next action, one sentence" (RFC 246). The
 * helper accepts an optional and fails the test if the value is
 * missing, so the call site does not need its own non-null assertion. */
export function expectActionable(
  coded: { readonly message: string; readonly fix?: string } | null | undefined,
): void {
  expect(coded, "expectActionable received a missing coded value").toBeDefined();
  const value = coded as { readonly message: string; readonly fix?: string };
  expect(
    value.message.trim().length,
    `message was ${JSON.stringify(value.message)}`,
  ).toBeGreaterThan(0);
  expect(typeof value.fix, `fix was ${JSON.stringify(value.fix)}`).toBe("string");
  expect(value.fix, `fix was ${JSON.stringify(value.fix)}`).toMatch(/^[A-Z][\s\S]*\.$/);
}

export function captureStream(): {
  stream: { write(chunk: string | Uint8Array): boolean };
  text: () => string;
} {
  let buffer = "";
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    },
    text: () => {
      if (buffer.startsWith('{"error":')) expectValidError(JSON.parse(buffer));
      return buffer;
    },
  };
}
