import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./helpers.js";

describe("README problem codes", () => {
  test("documents every problem code the sections module emits", () => {
    const source = readFileSync(join(repoRoot, "src", "sections.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = [...new Set(source.match(/"(?:router|tasks|policy)-[a-z-]+"/g) ?? [])].map(
      (code) => code.replaceAll('"', ""),
    );
    expect(emitted.length).toBeGreaterThanOrEqual(10);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("documents every config code the config module emits", () => {
    const source = readFileSync(join(repoRoot, "src", "config.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = [...new Set(source.match(/"config-[a-z-]+"/g) ?? [])].map((code) =>
      code.replaceAll('"', ""),
    );
    expect(emitted.length).toBeGreaterThanOrEqual(5);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("documents every RouterError code the types union allows", () => {
    const source = readFileSync(join(repoRoot, "src", "types.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const union = source.match(/export type RouterErrorCode\s*=\s*([^;]+);/)?.[1] ?? "";
    const emitted = [...union.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("documents every warning and error code the describe module emits", () => {
    const source = readFileSync(join(repoRoot, "src", "describe.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = [...new Set(source.match(/code: "[a-z-]+"/g) ?? [])].map((code) =>
      code.replace(/^code: "/, "").replace(/"$/, ""),
    );
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("documents every JevError code the Jev client defines", () => {
    const source = readFileSync(join(repoRoot, "src", "jev.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = [...source.matchAll(/\| "([A-Z_]+)"/g)].map((match) => match[1]);
    expect(emitted.length).toBeGreaterThanOrEqual(5);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("states shipped features and policy-route placement accurately", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).not.toMatch(/Inline `minimums`[^.]*arrive in later issues/);
    expect(readme).toContain("The policy's routes come before the ranked routes");
  });
});
