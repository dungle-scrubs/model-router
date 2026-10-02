import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./helpers.js";

const SRC_DIR = join(repoRoot, "src");

function sourceCodes(): readonly string[] {
  const seen = new Set<string>();
  for (const file of readdirSync(SRC_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(SRC_DIR, file), "utf8");
    for (const match of source.matchAll(/\bcode: ?"([a-z][a-z0-9-]+)"/g)) {
      seen.add(match[1] as string);
    }
    // First argument of `note(...)`, with the opening paren followed by
    // whitespace and a string literal (the multiline form has the string
    // on the next line, indented).
    for (const match of source.matchAll(/\bnote\([\s\n]+"([a-z][a-z0-9-]+)"/g)) {
      seen.add(match[1] as string);
    }
  }
  seen.add("meter-exhausted");
  return [...seen].sort();
}

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

  test("documents every code emitted across src/*.ts plus the pin reason", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = sourceCodes();
    expect(emitted.length).toBeGreaterThanOrEqual(20);
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
