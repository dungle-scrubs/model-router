import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { repoRoot, withTempDir } from "./helpers.js";

const SRC_DIR = join(repoRoot, "src");

function codesInSource(source: string): readonly string[] {
  const seen = new Set<string>();
  function collect(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^[a-z][a-z0-9-]+$/.test(node.text)
    )
      seen.add(node.text);
    ts.forEachChild(node, collect);
  }
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      ["code", "reason"].includes(node.name.text)
    )
      collect(node.initializer);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["note", "buildReason"].includes(node.expression.text) &&
      node.arguments[0] !== undefined
    )
      collect(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return [...seen].sort();
}

function typeCodesInSource(source: string, name: string): readonly string[] {
  const file = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const alias = file.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === name,
  );
  if (alias === undefined || !ts.isTypeAliasDeclaration(alias)) return [];
  const members = ts.isUnionTypeNode(alias.type) ? alias.type.types : [alias.type];
  return members.flatMap((node) =>
    ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? [node.literal.text] : [],
  );
}

function sourceCodes(dir = SRC_DIR): readonly string[] {
  const seen = new Set<string>();
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, file.name);
    if (file.isDirectory()) {
      for (const code of sourceCodes(path)) seen.add(code);
      continue;
    }
    if (!file.name.endsWith(".ts")) continue;
    const source = readFileSync(path, "utf8");
    for (const code of codesInSource(source)) seen.add(code);
  }
  return [...seen].sort();
}

describe("README problem codes", () => {
  test("documents every problem code the sections module emits", () => {
    const source = readFileSync(join(repoRoot, "src", "sections.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = codesInSource(source).filter((code) => /^(router|tasks|policy)-/.test(code));
    expect(emitted.length).toBeGreaterThanOrEqual(10);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("documents every config code the config module emits", () => {
    const source = readFileSync(join(repoRoot, "src", "config.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = codesInSource(source).filter((code) => code.startsWith("config-"));
    expect(emitted.length).toBeGreaterThanOrEqual(5);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("collects literal codes, reasons and builder calls recursively", async () => {
    await withTempDir(async (dir) => {
      const nested = join(dir, "nested");
      mkdirSync(nested);
      writeFileSync(
        join(nested, "example.ts"),
        'buildReason("reason-a");\nbuildReason(\n "reason-b");\nnote("note-a");\nconst value = { reason: "reason-c", code: "code-a" };\n',
      );
      expect(sourceCodes(dir)).toEqual(["code-a", "note-a", "reason-a", "reason-b", "reason-c"]);
    });
  });

  test("collects codes wrapped in instrumentation expressions", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(
        join(dir, "example.ts"),
        'const value = { code: choose("12") ? "" : (cover("12"), "code-a"), reason: choose("13") ? "" : "reason-a" };\nnote(choose("14") ? "" : (cover("14"), "note-a"));\nbuildReason(choose("15") ? "" : "reason-b");\nconst unrelated = "not-a-code";\n',
      );
      expect(sourceCodes(dir)).toEqual(["code-a", "note-a", "reason-a", "reason-b"]);
    });
  });

  test("collects every union member with or without a leading bar", () => {
    for (const source of [
      'export type Code = "CODE_A" | "CODE_B";',
      'export type Code =\n | "CODE_A"\n | "CODE_B";',
    ])
      expect(typeCodesInSource(source, "Code")).toEqual(["CODE_A", "CODE_B"]);
  });

  test("documents every code emitted across src recursively", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = sourceCodes();
    expect(emitted.length).toBeGreaterThanOrEqual(20);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
      if (code.startsWith("meter-")) {
        expect(
          readme.split("\n").some((line) => line.startsWith(`| \`${code}\` |`)),
          `${code} is missing its README row`,
        ).toBe(true);
      }
    }
  });

  test("documents every RouterError code the types union allows", () => {
    const source = readFileSync(join(repoRoot, "src", "types.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = typeCodesInSource(source, "RouterErrorCode");
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("documents every warning and error code the describe module emits", () => {
    const source = readFileSync(join(repoRoot, "src", "describe.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = codesInSource(source);
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const code of emitted) {
      expect(readme, `${code} is missing from README.md`).toContain(code);
    }
  });

  test("documents every JevError code the Jev client defines", () => {
    const source = readFileSync(join(repoRoot, "src", "jev.ts"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const emitted = typeCodesInSource(source, "JevErrorCode");
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
