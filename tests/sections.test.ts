import { loadRegistry } from "@dungle-scrubs/model-registry";
import { describe, expect, test } from "vitest";
import { RouterError } from "../src/error.js";
import { validateRouterSections } from "../src/sections.js";
import { fixturePath, withTempDir, writeJson } from "./helpers.js";

const FULL = fixturePath("full.json");

function catchSectionsError(fn: () => unknown): RouterError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RouterError) return error;
    throw error;
  }
  throw new Error("expected validateRouterSections to throw a RouterError");
}

describe("validateRouterSections", () => {
  test("a valid router section returns its rank list", () => {
    const loaded = loadRegistry({ path: FULL });
    expect(validateRouterSections(loaded)).toEqual({ rank: ["coding", "intelligence"] });
  });

  test("a registry without a router section fails with the line to add", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.toJSON()).toEqual({
        code: "registry-sections-invalid",
        field: '$["router"]',
        fix: 'Add the line "router": { "rank": ["coding"] } to the registry file, with the ratings that order routes.',
        message: "the registry file has no router section, which model-router requires",
        problems: [
          {
            code: "router-section-missing",
            field: '$["router"]',
            fix: 'Add the line "router": { "rank": ["coding"] } to the registry file, with the ratings that order routes.',
            message: "the registry file has no router section, which model-router requires",
          },
        ],
      });
    });
  });

  test("a router section without rank names the missing field", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          router: {},
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.code).toBe("registry-sections-invalid");
      expect(error.problems[0]?.code).toBe("router-rank-missing");
      expect(error.problems[0]?.field).toBe('$["router"]["rank"]');
      expect(error.fix).toContain('"rank"');
      expect(error.fix).toContain('"coding"');
    });
  });

  test("an empty or non-array rank list is invalid", async () => {
    await withTempDir(async (dir) => {
      for (const rank of [[], "coding", 7]) {
        const loaded = loadRegistry({
          path: writeJson(dir, "registry.json", {
            format: 1,
            ratings: { coding: "Writes and changes code to a spec." },
            router: { rank },
            models: {
              "model-a": {
                family: "family-a",
                routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
              },
            },
          }),
        });
        const error = catchSectionsError(() => validateRouterSections(loaded));
        expect(error.code).toBe("registry-sections-invalid");
        expect(error.problems[0]?.code).toBe("router-rank-invalid");
      }
    });
  });

  test("a rank entry that is not a string is a problem", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          router: { rank: ["coding", 7] },
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.problems[0]?.code).toBe("router-rank-entry-not-string");
      expect(error.problems[0]?.field).toBe('$["router"]["rank"][1]');
    });
  });

  test("a rank entry naming an undeclared rating is a problem", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          router: { rank: ["coding", "vibes"] },
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.problems[0]?.code).toBe("router-rank-unknown");
      expect(error.problems[0]?.message).toContain("vibes");
    });
  });

  test("the router section is closed: an unknown field is a problem", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          router: { rank: ["coding"], matrix: true },
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.problems[0]?.code).toBe("router-field-unknown");
      expect(error.problems[0]?.field).toBe('$["router"]["matrix"]');
    });
  });

  test("questions must map declared capabilities to strings", async () => {
    await withTempDir(async (dir) => {
      const base = {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        capabilities: { browser: "Can drive a web browser." },
        models: {
          "model-a": {
            family: "family-a",
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      };
      const withQuestions = (questions: unknown) =>
        loadRegistry({
          path: writeJson(dir, "registry.json", {
            ...base,
            router: { rank: ["coding"], questions },
          }),
        });

      expect(
        validateRouterSections(withQuestions({ browser: "Does the work need a browser?" })),
      ).toEqual({
        rank: ["coding"],
      });

      const notObject = catchSectionsError(() => validateRouterSections(withQuestions("browser")));
      expect(notObject.problems[0]?.code).toBe("router-questions-not-object");

      const unknownCapability = catchSectionsError(() =>
        validateRouterSections(withQuestions({ telepathy: "Can it read minds?" })),
      );
      expect(unknownCapability.problems[0]?.code).toBe("router-question-capability-unknown");

      const notString = catchSectionsError(() =>
        validateRouterSections(withQuestions({ browser: 7 })),
      );
      expect(notString.problems[0]?.code).toBe("router-question-not-string");
    });
  });

  test("several problems are collected into one error", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          router: { rank: [7], matrix: true },
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.code).toBe("registry-sections-invalid");
      expect(error.problems.map((problem) => problem.code)).toEqual([
        "router-rank-entry-not-string",
        "router-field-unknown",
      ]);
      expect(error.message).toBe("the router section has 2 problems");
      expect(error.fix).toBe("Fix each problem listed in problems, then run model-router again.");
    });
  });

  test("a rank list of only undeclared ratings has no usable rank", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          router: { rank: ["vibes"] },
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.code).toBe("registry-sections-invalid");
      expect(error.problems.map((problem) => problem.code)).toEqual(["router-rank-unknown"]);
    });
  });
});
