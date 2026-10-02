// The public entry point re-exports the types and functions a downstream
// caller needs. A package test asserts the surface through the same import
// path an external consumer would use, so an accidental rename in src/
// breaks this test rather than breaking the published types.
import { describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import type {
  AnswerRoute,
  DescribeBlock,
  JevAnswer,
  JevQuestion,
  JevResponse,
  PinReport,
  RankOptions,
  RouterConfig,
} from "../src/index.js";
import {
  askJev,
  defaultConfig,
  describe as describeStep,
  JevError,
  listTasks,
  loadConfig,
  RouterError,
  rank,
  validateConfigObjectInput,
} from "../src/index.js";

describe("public entry point", () => {
  test("re-exports RouterConfig and the value imports keep working", () => {
    // The type-only import compiles only when index.ts names the export.
    // Round-tripping through the type keeps the reference used.
    const effort: RouterConfig["effort"] = defaultConfig().effort;
    expect(effort.ceiling).toBe("xhigh");
    expect(effort.default).toBe("medium");
    expect(defaultConfig).toBeTypeOf("function");
    expect(validateConfigObjectInput).toBeTypeOf("function");
    expect(loadConfig).toBeTypeOf("function");
    expect(rank).toBeTypeOf("function");
    expect(listTasks).toBeTypeOf("function");
    expect(RouterError).toBeTypeOf("function");
  });

  test("a downstream caller can compose the named exports together", () => {
    // Pin the import of the AnswerRoute and PinReport types so a missing
    // export in src/index.ts breaks compilation here.
    const options: RankOptions = {
      config: defaultConfig(),
    };
    expect(options.config).toBeDefined();
    const pinReport: PinReport = { label: "model-a@harness-x", reason: "", used: true };
    expect(pinReport.label).toBe("model-a@harness-x");
    const route: AnswerRoute = {
      availability: "unmetered",
      effort: "medium",
      family: "family-a",
      floor: "clears",
      harness: "harness-x",
      hosted: true,
      label: "model-a@harness-x",
      model: "model-a",
      modelId: "model-id-a1",
      placedBy: "rank",
      reasons: [],
    };
    expect(route.label).toBe("model-a@harness-x");
    expect(packageJson.version).toBeDefined();
  });

  test("exports the Jev client and keeps its key and retry helpers private", async () => {
    expect(askJev).toBeTypeOf("function");
    expect(JevError).toBeTypeOf("function");
    // The key and retry helpers stay private: a caller reaching for them
    // through the public entry gets undefined, not a function.
    const entry = (await import("../src/index.js")) as Record<string, unknown>;
    expect(entry.requireKey).toBeUndefined();
    expect(entry.retryDelay).toBeUndefined();
  });

  test("exports describe and the Jev types a caller composes", () => {
    expect(describeStep).toBeTypeOf("function");
    // The type-only imports compile only when index.ts names the exports.
    // Round-tripping through the types keeps the references used.
    const question: JevQuestion = {
      type: "noul",
      instructions: "Does the work read secret material?",
    };
    const answer: JevAnswer = { type: "noul", noul: 0.5 };
    const response: JevResponse = {
      model: "jev-1.13.0",
      answers: { q: answer },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const block: DescribeBlock = {
      model: response.model,
      taskGate: 0.85,
      capabilityThreshold: 0.5,
      task: { source: "jev", confidence: 0.9, candidates: [{ task: "task-a", probability: 0.9 }] },
      needsAdded: [{ capability: "browser", probability: 0.8 }],
      usage: response.usage,
    };
    expect(block.task.source).toBe("jev");
    expect(question.type).toBe("noul");
  });
});
