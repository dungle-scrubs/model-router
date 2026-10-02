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

  test("every table's delimiter row has as many cells as its header", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const lines = readme.split("\n");
    const cellCount = (row: string): number => (row.match(/\|/g) ?? []).length;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!line.trimStart().startsWith("|")) continue;
      const previous = index > 0 ? (lines[index - 1] ?? "") : "";
      if (previous.trimStart().startsWith("|")) continue;
      // A new table block: the next line must be the delimiter row, and it
      // must carry one cell per header cell or GFM renders plain text.
      const header = line;
      const delimiter = lines[index + 1] ?? "";
      expect(delimiter, `table starting at line ${index + 1}: ${header}`).toMatch(
        /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/,
      );
      expect(cellCount(delimiter), `table starting at line ${index + 1}: ${header}`).toBe(
        cellCount(header),
      );
    }
  });
});

describe("availability documentation", () => {
  test("describes the CLI merge and every config key and invalid-entry cause", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain(
      "`describe: null` (the describe block arrives only through the describe step, which the CLI merges)",
    );
    expect(readme).toContain("the CLI fills `availabilityNote`");
    expect(readme).toContain("other than `effort`, `availability`, `describe` and `$schema`");
    expect(readme).toContain(
      "any entry the shipped schema rejects, or a `resetsAt` that does not parse",
    );
    expect(readme).toContain("keeps its place. A re-applying");
  });

  test("generatedAt documents stale and invalid separately", () => {
    const schema = JSON.parse(readFileSync(join(repoRoot, "availability.schema.json"), "utf8"));
    expect(schema.properties.generatedAt.description).toBe(
      "When the document was produced. Older than `maxAgeSeconds` or later than the read is `availability-reading-stale`; unparseable is `availability-reading-invalid`. The CLI fills `availabilityNote`.",
    );
  });
});
