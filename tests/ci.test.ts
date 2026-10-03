import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./helpers.js";

const WORKFLOWS = ["ci.yml", "release.yml"].map((name) =>
  join(repoRoot, ".github", "workflows", name),
);

describe("the model-registry dependency", () => {
  test("comes from npm with a caret range", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["@dungle-scrubs/model-registry"]).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  test.each(WORKFLOWS)("%s needs no git access to install it", (path) => {
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("MODEL_REGISTRY_DEPLOY_KEY");
    expect(text).not.toContain("insteadOf");
  });
});
