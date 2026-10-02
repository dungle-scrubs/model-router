import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./helpers.js";

const WORKFLOW_PATH = join(repoRoot, ".github", "workflows", "ci.yml");

/** Split the workflow into its step blocks: keys at two levels of job nesting. */
function stepBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^ {6}- /.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  return blocks;
}

describe("the CI workflow", () => {
  const text = readFileSync(WORKFLOW_PATH, "utf8");

  test("every job's token step runs under bash on every runner", () => {
    const tokenSteps = stepBlocks(text).filter((block) =>
      block.join("\n").includes("MODEL_REGISTRY_READ_TOKEN"),
    );
    expect(tokenSteps.length).toBe(2);
    for (const block of tokenSteps) {
      const step = block.join("\n");
      expect(step, step).toContain("shell: bash");
    }
  });
});
