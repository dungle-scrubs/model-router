import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./helpers.js";

describe("README problem codes", () => {
  test("documents every router problem code the sections module emits", () => {
    const source = readFileSync(join(repoRoot, "src", "sections.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = [...new Set(source.match(/"router-[a-z-]+"/g) ?? [])].map((code) =>
      code.replaceAll('"', ""),
    );
    expect(emitted.length).toBeGreaterThanOrEqual(10);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });
});
