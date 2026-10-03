import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { repoRoot } from "./helpers.js";

const SCHEMAS = [
  "query.schema.json",
  "answer.schema.json",
  "availability.schema.json",
  "error.schema.json",
  "config.schema.json",
  "router-sections.schema.json",
] as const;

describe("the package's six shipped schemas", () => {
  test("every schema file exists at the package root", () => {
    for (const name of SCHEMAS) {
      const path = join(repoRoot, name);
      expect(existsSync(path), `${name} is missing at ${path}`).toBe(true);
    }
  });

  test("every schema is a valid JSON Schema (compile succeeds)", () => {
    const ajv = new Ajv2020({ allErrors: true, strictNumbers: true });
    for (const name of SCHEMAS) {
      const path = join(repoRoot, name);
      const schema = JSON.parse(readFileSync(path, "utf8")) as object;
      expect(() => ajv.compile(schema), `${name} did not compile`).not.toThrow();
    }
  });

  test("every schema carries the project's $id root and the draft 2020-12 marker", () => {
    for (const name of SCHEMAS) {
      const path = join(repoRoot, name);
      const schema = JSON.parse(readFileSync(path, "utf8")) as {
        $id: string;
        $schema: string;
      };
      expect(schema.$id, `${name} $id`).toMatch(
        /^https:\/\/dungle-scrubs\.github\.io\/model-router\//,
      );
      expect(schema.$schema, `${name} $schema`).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
    }
  });

  test("every schema is listed in package.json `exports` with a `./<name>` key", () => {
    const exports = packageJson.exports as Record<string, unknown>;
    for (const name of SCHEMAS) {
      const key = `./${name}`;
      expect(exports[key], `${name} missing from package.json exports`).toBe(`./${name}`);
    }
  });

  test("every schema is listed in package.json `files` so it ships in the tarball", () => {
    const files = packageJson.files as readonly string[];
    for (const name of SCHEMAS) {
      expect(files.includes(name), `${name} missing from package.json files`).toBe(true);
    }
  });

  test("the README lists every shipped schema by name", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    for (const name of SCHEMAS) {
      expect(readme, `${name} not mentioned in README.md`).toContain(name);
    }
  });
});
