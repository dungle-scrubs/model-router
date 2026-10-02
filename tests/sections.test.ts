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
      expect(error.toJSON()).toEqual({
        code: "registry-sections-invalid",
        field: '$["router"]["rank"]',
        fix: 'Add "rank": ["coding"] inside the router section, with the ratings that order routes.',
        message: "the router section has no rank list, which model-router requires",
        problems: [
          {
            code: "router-rank-missing",
            field: '$["router"]["rank"]',
            fix: 'Add "rank": ["coding"] inside the router section, with the ratings that order routes.',
            message: "the router section has no rank list, which model-router requires",
          },
        ],
      });
    });
  });

  test("a router section that is not an object is invalid", async () => {
    await withTempDir(async (dir) => {
      const base = {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        models: {
          "model-a": {
            family: "family-a",
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      };
      for (const router of ["oops", 7, ["coding"]]) {
        const loaded = loadRegistry({ path: writeJson(dir, "registry.json", { ...base, router }) });
        const error = catchSectionsError(() => validateRouterSections(loaded));
        expect(error.toJSON()).toEqual({
          code: "registry-sections-invalid",
          field: '$["router"]',
          fix: 'Replace the router section with an object such as "router": { "rank": ["coding"] }.',
          message: "the router section must be a JSON object",
          problems: [
            {
              code: "router-section-not-object",
              field: '$["router"]',
              fix: 'Replace the router section with an object such as "router": { "rank": ["coding"] }.',
              message: "the router section must be a JSON object",
            },
          ],
        });
      }
    });
  });

  test("a registry with no ratings section still names a concrete line to add", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.fix).toBe(
        'Add the line "router": { "rank": ["rating-a"] } to the registry file, with the ratings that order routes.',
      );
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
        expect(error.toJSON()).toEqual({
          code: "registry-sections-invalid",
          field: '$["router"]["rank"]',
          fix: 'Set "rank" to a non-empty array of declared rating names, such as ["coding"].',
          message: "the router rank must be a non-empty array of rating names",
          problems: [
            {
              code: "router-rank-invalid",
              field: '$["router"]["rank"]',
              fix: 'Set "rank" to a non-empty array of declared rating names, such as ["coding"].',
              message: "the router rank must be a non-empty array of rating names",
            },
          ],
        });
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
      expect(error.message).toBe("the router rank entry at index 1 must be a string");
      expect(error.problems[0]).toEqual({
        code: "router-rank-entry-not-string",
        field: '$["router"]["rank"][1]',
        fix: "Set the rank entry at index 1 to a declared rating name.",
        message: "the router rank entry at index 1 must be a string",
      });
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
      expect(error.problems[0]).toEqual({
        code: "router-rank-unknown",
        field: '$["router"]["rank"][1]',
        fix: 'Add "vibes" to the ratings section, or remove it from "router"."rank".',
        message: 'the rating "vibes" is not declared in the ratings section',
      });
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
      expect(error.problems[0]).toEqual({
        code: "router-field-unknown",
        field: '$["router"]["matrix"]',
        fix: 'Remove the field; the router section accepts only "rank" and "questions".',
        message: 'the field "matrix" is not part of the router section',
      });
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
      expect(notObject.problems[0]).toEqual({
        code: "router-questions-not-object",
        field: '$["router"]["questions"]',
        fix: "Replace the router questions section with a JSON object, or remove it.",
        message: "the router questions section must be a JSON object",
      });

      const unknownCapability = catchSectionsError(() =>
        validateRouterSections(withQuestions({ telepathy: "Can it read minds?" })),
      );
      expect(unknownCapability.problems[0]).toEqual({
        code: "router-question-capability-unknown",
        field: '$["router"]["questions"]["telepathy"]',
        fix: 'Add "telepathy" to the capabilities section, or remove it from "router"."questions".',
        message: 'the capability "telepathy" is not declared in the capabilities section',
      });

      const notString = catchSectionsError(() =>
        validateRouterSections(withQuestions({ browser: 7 })),
      );
      expect(notString.problems[0]).toEqual({
        code: "router-question-not-string",
        field: '$["router"]["questions"]["browser"]',
        fix: 'Set the question for "browser" to a yes/no question sentence.',
        message: 'the question for "browser" must be a string',
      });
    });
  });

  test("inherited property names are not declared ratings or capabilities", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          capabilities: { browser: "Can drive a web browser." },
          router: {
            rank: ["coding", "toString"],
            questions: { toString: "Is this question inherited?" },
          },
          models: {
            "model-a": {
              family: "family-a",
              routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
            },
          },
        }),
      });
      const error = catchSectionsError(() => validateRouterSections(loaded));
      expect(error.problems.map((problem) => problem.code)).toEqual([
        "router-rank-unknown",
        "router-question-capability-unknown",
      ]);
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
