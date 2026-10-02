// The public entry point re-exports the types and functions a downstream
// caller needs. A package test asserts the surface through the same import
// path an external consumer would use, so an accidental rename in src/
// breaks this test rather than breaking the published types.
import { describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import type { AnswerRoute, PinReport, RankOptions, RouterConfig } from "../src/index.js";
import {
  defaultConfig,
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
});
