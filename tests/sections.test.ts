import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "@dungle-scrubs/model-registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RouterError } from "../src/error.js";
import { validateRouterSections } from "../src/sections.js";
import { fixturePath, withTempDir, writeJson } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-router-sections-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

describe("validateRouterSections tasks and policy", () => {
  function validate(registry: Record<string, unknown>): RouterError {
    try {
      validateRouterSections(loadRegistry({ path: writeJson(dir, "registry.json", registry) }));
      throw new Error("expected validateRouterSections to throw a RouterError");
    } catch (error) {
      if (error instanceof RouterError) return error;
      throw error;
    }
  }

  // (Helper) runs a tasks-only fixture through validation, returning the
  // thrown RouterError. `models` defaults to an empty section: the loader
  // requires the field, and no route labels are needed.
  function withTasks(
    tasks: unknown,
    options: { models?: unknown; policy?: unknown; ratings?: unknown; router?: unknown } = {},
  ): RouterError {
    return validate({
      format: 1,
      ratings: options.ratings ?? { coding: "Writes and changes code to a spec." },
      router: options.router ?? { rank: ["coding"] },
      tasks,
      models: options.models ?? {},
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
    });
  }

  function withPolicy(
    policy: unknown,
    options: { models?: unknown; tasks?: unknown; ratings?: unknown; router?: unknown } = {},
  ): RouterError {
    return validate({
      format: 1,
      ratings: options.ratings ?? { coding: "Writes and changes code to a spec." },
      router: options.router ?? { rank: ["coding"] },
      ...(options.tasks !== undefined ? { tasks: options.tasks } : {}),
      models: options.models ?? {},
      policy,
    });
  }

  test("a non-object tasks section is invalid", () => {
    const error = withTasks("oops");
    expect(error.problems[0]).toEqual({
      code: "tasks-section-not-object",
      field: '$["tasks"]',
      fix: 'Replace the tasks section with an object such as "tasks": { "task-a": { ... } }.',
      message: "the tasks section must be a JSON object",
    });
  });

  test("a non-object task entry is invalid", async () => {
    const error = withTasks({ "task-a": "oops" });
    expect(error.problems[0]).toEqual({
      code: "tasks-entry-not-object",
      field: '$["tasks"]["task-a"]',
      fix: 'Replace the task "task-a" with an object that has description, minimums and rank.',
      message: 'the task "task-a" must be a JSON object',
    });
  });

  test("a task missing description is invalid", async () => {
    const error = withTasks({
      "task-a": {
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-description-missing",
      field: '$["tasks"]["task-a"]["description"]',
      fix: 'Add a one-line description to the task "task-a".',
      message: 'the task "task-a" has no description, which model-router requires',
    });
  });

  test("a task with a non-string description is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: 7,
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-description-not-string",
      field: '$["tasks"]["task-a"]["description"]',
      fix: 'Set the description of "task-a" to a one-line sentence.',
      message: 'the task "task-a" description must be a string',
    });
  });

  test("a task description with a line break is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "First line\nSecond line",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
      },
    });
    expect(error.problems.map((problem) => problem.code)).toEqual([
      "tasks-description-not-one-line",
    ]);
    expect(error.problems[0]).toEqual({
      code: "tasks-description-not-one-line",
      field: '$["tasks"]["task-a"]["description"]',
      fix: 'Rewrite the description of "task-a" as one line.',
      message: 'the task "task-a" description must be one line',
    });
  });

  test("a task missing minimums is invalid", async () => {
    const error = withTasks({
      "task-a": { description: "Code.", rank: ["coding"] },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-minimums-missing",
      field: '$["tasks"]["task-a"]["minimums"]',
      fix: 'Add a minimums map with low, normal and high entries to the task "task-a".',
      message: 'the task "task-a" has no minimums, which model-router requires',
    });
  });

  test("a task with non-object minimums is invalid", async () => {
    const error = withTasks({
      "task-a": { description: "Code.", minimums: "oops", rank: ["coding"] },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-minimums-not-object",
      field: '$["tasks"]["task-a"]["minimums"]',
      fix: 'Replace the minimums of "task-a" with an object mapping stakes to rating floors.',
      message: 'the task "task-a" minimums must be a JSON object',
    });
  });

  test("a task missing a stakes level in minimums is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-minimums-stake-missing",
      field: '$["tasks"]["task-a"]["minimums"]["low"]',
      fix: 'Add "low" to the minimums of "task-a".',
      message: 'the task "task-a" minimums is missing the "low" stakes',
    });
  });

  test("a task with non-object minimums stake is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: "oops", normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-minimums-stake-not-object",
      field: '$["tasks"]["task-a"]["minimums"]["low"]',
      fix: 'Replace the "low" entry of "task-a" minimums with a rating object.',
      message: 'the task "task-a" minimums["low"] must be a JSON object',
    });
  });

  test("a task minimums with an unknown stakes key is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: {
          low: { coding: 6 },
          normal: { coding: 7 },
          high: { coding: 8 },
          urgent: { coding: 9 },
        },
        rank: ["coding"],
      },
    });
    expect(error.problems.map((problem) => problem.code)).toEqual(["tasks-minimums-stake-unknown"]);
    expect(error.problems[0]).toEqual({
      code: "tasks-minimums-stake-unknown",
      field: '$["tasks"]["task-a"]["minimums"]["urgent"]',
      fix: 'Remove "urgent" from the minimums of "task-a"; the stakes are low, normal and high.',
      message: 'the task "task-a" minimums carries the unknown stakes "urgent"',
    });
  });

  test("a task minimum that names an undeclared rating is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6, vibes: 5 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-minimums-rating-unknown",
      field: '$["tasks"]["task-a"]["minimums"]["low"]["vibes"]',
      fix: 'Add "vibes" to the ratings section, or remove it from "task-a" minimums.',
      message: 'the rating "vibes" is not declared in the ratings section',
    });
  });

  test("a task minimum with a non-finite number is invalid", () => {
    // JSON cannot carry a non-finite number (it serializes to null, which the
    // loader rejects), so only an in-memory LoadedRegistry can reach this:
    // poison a loaded registry's tasks section after the loader has parsed.
    const loaded = loadRegistry({
      path: writeJson(dir, "finite.json", {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        router: { rank: ["coding"] },
        models: {},
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      }),
    });
    const tasks = loaded.sections.tasks as Record<string, Record<string, unknown>>;
    const taskA = tasks["task-a"];
    const poisoned = {
      ...loaded,
      sections: {
        ...loaded.sections,
        tasks: {
          "task-a": {
            ...taskA,
            minimums: {
              low: { coding: Number.POSITIVE_INFINITY },
              normal: { coding: 7 },
              high: { coding: 8 },
            },
          },
        },
      },
    };
    const error = catchSectionsError(() => validateRouterSections(poisoned));
    expect(error.problems[0]).toEqual({
      code: "tasks-minimums-rating-not-number",
      field: '$["tasks"]["task-a"]["minimums"]["low"]["coding"]',
      fix: 'Set the floor for "coding" in "task-a" minimums["low"] to a number.',
      message: 'the floor for "coding" in "task-a" minimums["low"] must be a finite number',
    });
  });

  test("a task missing rank is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-rank-missing",
      field: '$["tasks"]["task-a"]["rank"]',
      fix: 'Add a non-empty rank list of declared rating names to the task "task-a".',
      message: 'the task "task-a" has no rank list, which model-router requires',
    });
  });

  test("a task with an empty rank is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: [],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-rank-invalid",
      field: '$["tasks"]["task-a"]["rank"]',
      fix: 'Set the rank of "task-a" to a non-empty array of declared rating names.',
      message: 'the task "task-a" rank must be a non-empty array of rating names',
    });
  });

  test("a task rank with a non-string entry is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: [7],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-rank-entry-not-string",
      field: '$["tasks"]["task-a"]["rank"][0]',
      fix: 'Set the rank entry of "task-a" at index 0 to a declared rating name.',
      message: 'the task "task-a" rank entry at index 0 must be a string',
    });
  });

  test("a task rank naming an undeclared rating is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["vibes"],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-rank-rating-unknown",
      field: '$["tasks"]["task-a"]["rank"][0]',
      fix: 'Add "vibes" to the ratings section, or remove it from "task-a" rank.',
      message: 'the rating "vibes" is not declared in the ratings section',
    });
  });

  test("a task with non-array needs is invalid", async () => {
    const error = withTasks(
      {
        "task-a": {
          description: "Code.",
          minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
          rank: ["coding"],
          needs: "browser",
        },
      },
      {
        ratings: { coding: "Writes and changes code to a spec." },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "tasks-needs-not-array",
      field: '$["tasks"]["task-a"]["needs"]',
      fix: 'Replace the needs of "task-a" with a list of declared capability names.',
      message: 'the task "task-a" needs must be a list of declared capability names',
    });
  });

  test("a task with a non-string needs entry is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
        needs: [7],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-needs-entry-not-string",
      field: '$["tasks"]["task-a"]["needs"][0]',
      fix: 'Set the needs entry of "task-a" at index 0 to a declared capability name.',
      message: 'the task "task-a" needs entry at index 0 must be a string',
    });
  });

  test("a task needs an entry that names an undeclared capability", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
        needs: ["telepathy"],
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-needs-capability-unknown",
      field: '$["tasks"]["task-a"]["needs"][0]',
      fix: 'Add "telepathy" to the capabilities section, or remove it from "task-a" needs.',
      message: 'the capability "telepathy" is not declared in the capabilities section',
    });
  });

  test("a task with effort off the ladder is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
        effort: "warp-nine",
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-effort-invalid",
      field: '$["tasks"]["task-a"]["effort"]',
      fix: 'Set the effort of "task-a" to one of low, medium, high, xhigh, max.',
      message: 'the task "task-a" effort must be one of low, medium, high, xhigh, max',
    });
  });

  test("a task carrying an unknown field is invalid", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
        extra: true,
      },
    });
    expect(error.problems[0]).toEqual({
      code: "tasks-field-unknown",
      field: '$["tasks"]["task-a"]["extra"]',
      fix: 'Remove the field "extra" from the task "task-a".',
      message: 'the field "extra" is not part of the task "task-a"',
    });
  });

  test("wrong shapes in router, tasks and policy are reported together", () => {
    const error = validate({
      format: 1,
      ratings: { coding: "Writes and changes code to a spec." },
      router: "oops",
      tasks: 7,
      policy: false,
      models: {},
    });
    expect(error.code).toBe("registry-sections-invalid");
    expect(error.problems.map((problem) => problem.code)).toEqual([
      "router-section-not-object",
      "tasks-section-not-object",
      "policy-section-not-object",
    ]);
    expect(error.message).toBe("the router section has 3 problems");
  });

  test("a missing router section still reports problems in tasks and policy", () => {
    const error = validate({
      format: 1,
      ratings: { coding: "Writes and changes code to a spec." },
      tasks: 7,
      policy: false,
      models: {},
    });
    expect(error.problems.map((problem) => problem.code)).toEqual([
      "router-section-missing",
      "tasks-section-not-object",
      "policy-section-not-object",
    ]);
  });

  test("a floor with an undeclared rating and a non-number value reports both", async () => {
    const error = withTasks({
      "task-a": {
        description: "Code.",
        minimums: { low: { vibes: "oops" }, normal: { coding: 7 }, high: { coding: 8 } },
        rank: ["coding"],
      },
    });
    expect(error.problems.map((problem) => problem.code)).toEqual([
      "tasks-minimums-rating-unknown",
      "tasks-minimums-rating-not-number",
    ]);
    expect(error.problems.map((problem) => problem.field)).toEqual([
      '$["tasks"]["task-a"]["minimums"]["low"]["vibes"]',
      '$["tasks"]["task-a"]["minimums"]["low"]["vibes"]',
    ]);
  });

  test("an off-ladder policy effort is reported even when the label is unknown", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-missing@harness-x", effort: "warp-nine" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
    );
    expect(error.problems.map((problem) => problem.code)).toEqual([
      "policy-route-label-unknown",
      "policy-route-effort-invalid",
    ]);
  });

  test("a non-object policy section is invalid", async () => {
    const error = withPolicy("oops");
    expect(error.problems[0]).toEqual({
      code: "policy-section-not-object",
      field: '$["policy"]',
      fix: 'Replace the policy section with an object such as "policy": { "name": { ... } }.',
      message: "the policy section must be a JSON object",
    });
  });

  test("a non-object policy entry is invalid", async () => {
    const error = withPolicy({ "policy-a": "oops" });
    expect(error.problems[0]).toEqual({
      code: "policy-entry-not-object",
      field: '$["policy"]["policy-a"]',
      fix: 'Replace the policy "policy-a" with an object that has task, stakes, routes and reason.',
      message: 'the policy "policy-a" must be a JSON object',
    });
  });

  test("a policy missing task is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r",
        },
      },
      {
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-task-missing",
      field: '$["policy"]["policy-a"]["task"]',
      fix: 'Add a task name to the policy "policy-a".',
      message: 'the policy "policy-a" has no task, which model-router requires',
    });
  });

  test("a policy whose task is undeclared is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-z",
          routes: [{ route: "model-a@harness-x" }],
          stakes: ["normal"],
          reason: "r",
        },
      },
      {
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-task-unknown",
      field: '$["policy"]["policy-a"]["task"]',
      fix: 'Add "task-z" to the tasks section, or correct the policy "policy-a" task.',
      message: 'the task "task-z" is not declared in the tasks section',
    });
  });

  test("a policy missing stakes is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          routes: [{ route: "model-a@harness-x" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-stakes-missing",
      field: '$["policy"]["policy-a"]["stakes"]',
      fix: 'Add a stakes list to the policy "policy-a".',
      message: 'the policy "policy-a" has no stakes list, which model-router requires',
    });
  });

  test("a policy with empty stakes is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: [],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-stakes-invalid",
      field: '$["policy"]["policy-a"]["stakes"]',
      fix: 'Set the stakes of "policy-a" to a non-empty list of low, normal or high.',
      message: 'the policy "policy-a" stakes must be a non-empty array of stakes levels',
    });
  });

  test("a policy with a stakes entry off the vocabulary is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["urgent"],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-stakes-entry-invalid",
      field: '$["policy"]["policy-a"]["stakes"][0]',
      fix: 'Set the stakes entry of "policy-a" at index 0 to low, normal or high.',
      message: 'the policy "policy-a" stakes entry at index 0 must be low, normal or high',
    });
  });

  test("a policy missing routes is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-routes-missing",
      field: '$["policy"]["policy-a"]["routes"]',
      fix: 'Add a routes list to the policy "policy-a".',
      message: 'the policy "policy-a" has no routes list, which model-router requires',
    });
  });

  test("a policy with empty routes is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-routes-invalid",
      field: '$["policy"]["policy-a"]["routes"]',
      fix: 'Set the routes of "policy-a" to a non-empty array of route entries.',
      message: 'the policy "policy-a" routes must be a non-empty array',
    });
  });

  test("a policy route that is not an object is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: ["oops"],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-route-not-object",
      field: '$["policy"]["policy-a"]["routes"][0]',
      fix: 'Set the route at index 0 of "policy-a" to an object with "route".',
      message: 'the policy "policy-a" route at index 0 must be a JSON object',
    });
  });

  test("a policy route with no label is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{}],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-route-label-missing",
      field: '$["policy"]["policy-a"]["routes"][0]["route"]',
      fix: 'Set the "route" of the policy "policy-a" route at index 0 to a label.',
      message: 'the policy "policy-a" route at index 0 is missing a label',
    });
  });

  test("a policy route naming an undeclared route is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-missing@harness-x" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-route-label-unknown",
      field: '$["policy"]["policy-a"]["routes"][0]["route"]',
      fix: 'Add the route "model-missing@harness-x" to the models section, or remove it from "policy-a".',
      message: 'the label "model-missing@harness-x" is not declared by any route',
    });
  });

  test("a policy route with effort off the ladder is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x", effort: "warp-nine" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-route-effort-invalid",
      field: '$["policy"]["policy-a"]["routes"][0]["effort"]',
      fix: 'Set the effort of the policy "policy-a" route "model-a@harness-x" to one of low, medium, high, xhigh, max.',
      message:
        'the policy "policy-a" route "model-a@harness-x" effort must be one of low, medium, high, xhigh, max',
    });
  });

  test("a policy route whose effort differs from the model's fixedEffort is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x", effort: "low" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            fixedEffort: "high",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-route-effort-fixed-mismatch",
      field: '$["policy"]["policy-a"]["routes"][0]["effort"]',
      fix: 'Remove the policy route\'s effort, or set it to "high".',
      message:
        'the policy "policy-a" route "model-a@harness-x" effort "low" differs from the model\'s fixedEffort "high"',
    });
  });

  test("a policy route with effort above the model's maxEffort is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x", effort: "high" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            maxEffort: "low",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-route-effort-above-max",
      field: '$["policy"]["policy-a"]["routes"][0]["effort"]',
      fix: 'Lower the policy route\'s effort to "low" or below, or remove it.',
      message:
        'the policy "policy-a" route "model-a@harness-x" effort "high" is above the model\'s maxEffort "low"',
    });
  });

  test("a policy route with effort above a route whose provider is an empty string is invalid", async () => {
    // The label of a route with provider "" keeps the trailing slash
    // ("model-a@harness-x/"); validation must read it from the loaded
    // route index, not rebuild it and lose the empty provider.
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x/", effort: "high" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            maxEffort: "low",
            ratings: { coding: 7 },
            routes: [
              {
                harness: "harness-x",
                modelId: "model-id-a",
                provider: "",
                hosted: true,
              },
            ],
          },
        },
      },
    );
    expect(error.problems.map((problem) => problem.code)).toEqual([
      "policy-route-effort-above-max",
    ]);
    expect(error.problems[0]?.message).toBe(
      'the policy "policy-a" route "model-a@harness-x/" effort "high" is above the model\'s maxEffort "low"',
    );
  });

  test("a policy route carrying an unknown field is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x", note: "x" }],
          reason: "r",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-route-field-unknown",
      field: '$["policy"]["policy-a"]["routes"][0]["note"]',
      fix: 'Remove the field "note" from the policy "policy-a" route at index 0.',
      message: 'the field "note" is not part of a policy route',
    });
  });

  test("a policy missing reason is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-reason-missing",
      field: '$["policy"]["policy-a"]["reason"]',
      fix: 'Add a one-line reason to the policy "policy-a".',
      message: 'the policy "policy-a" has no reason, which model-router requires',
    });
  });

  test("a policy with non-string reason is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
          reason: 7,
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-reason-not-string",
      field: '$["policy"]["policy-a"]["reason"]',
      fix: 'Set the reason of "policy-a" to a one-line sentence.',
      message: 'the policy "policy-a" reason must be a string',
    });
  });

  test("a policy with spec off the vocabulary is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r",
          spec: "draft",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-spec-invalid",
      field: '$["policy"]["policy-a"]["spec"]',
      fix: 'Set the spec of "policy-a" to settled, or remove it.',
      message: 'the policy "policy-a" spec must be settled',
    });
  });

  test("a policy with spec open is invalid: a policy spec accepts only settled", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r",
          spec: "open",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems.map((problem) => problem.code)).toEqual(["policy-spec-invalid"]);
  });

  test("a policy with non-string since is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r",
          since: 7,
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-since-not-string",
      field: '$["policy"]["policy-a"]["since"]',
      fix: 'Set the since of "policy-a" to a date string.',
      message: 'the policy "policy-a" since must be a string',
    });
  });

  test("a policy carrying an unknown field is invalid", async () => {
    const error = withPolicy(
      {
        "policy-a": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r",
          mystery: true,
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems[0]).toEqual({
      code: "policy-field-unknown",
      field: '$["policy"]["policy-a"]["mystery"]',
      fix: 'Remove the field "mystery" from the policy "policy-a".',
      message: 'the field "mystery" is not part of the policy "policy-a"',
    });
  });

  test("two policies that overlap on task and stakes are tied", async () => {
    const error = withPolicy(
      {
        "policy-1": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r1",
        },
        "policy-2": {
          task: "task-a",
          stakes: ["normal"],
          routes: [{ route: "model-a@harness-x" }],
          reason: "r2",
        },
      },
      {
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      },
    );
    expect(error.problems.map((problem) => problem.code)).toContain("policy-tie");
    const tie = error.problems.find((problem) => problem.code === "policy-tie");
    expect(tie?.message).toContain("policy-1");
    expect(tie?.message).toContain("policy-2");
    expect(tie?.message).toContain("no spec");
  });

  // (Helper) the fixtures every tie case shares: one task, one route.
  const tieTasks = {
    "task-a": {
      description: "Code.",
      minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
      rank: ["coding"],
    },
  };
  const tieModels = {
    "model-a": {
      family: "family-a",
      ratings: { coding: 7 },
      routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
    },
  };
  const tieOptions = { tasks: tieTasks, models: tieModels };
  const tiePolicy = (extra: Record<string, unknown>) => ({
    task: "task-a",
    stakes: ["normal"],
    routes: [{ route: "model-a@harness-x" }],
    reason: "r",
    ...extra,
  });

  function expectTie(policies: Record<string, unknown>): void {
    const error = withPolicy(policies, tieOptions);
    expect(error.problems.map((problem) => problem.code)).toContain("policy-tie");
  }

  function expectNoTie(policies: Record<string, unknown>): void {
    // No tie: the whole registry validates without throwing.
    validateRouterSections(
      loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          router: { rank: ["coding"] },
          tasks: tieTasks,
          models: tieModels,
          policy: policies,
        }),
      }),
    );
  }

  test("two settled policies that overlap on task and stakes are tied", () => {
    expectTie({
      "policy-1": tiePolicy({ spec: "settled" }),
      "policy-2": tiePolicy({ spec: "settled" }),
    });
  });

  test("a specless and a settled policy are not a tie: settled beats no spec", () => {
    expectNoTie({ "policy-1": tiePolicy({}), "policy-2": tiePolicy({ spec: "settled" }) });
  });

  test("policies on disjoint stakes never tie", () => {
    expectNoTie({
      "policy-1": tiePolicy({ stakes: ["low"] }),
      "policy-2": tiePolicy({ stakes: ["high"] }),
    });
  });

  test("policies on different tasks never tie", () => {
    validateRouterSections(
      loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          router: { rank: ["coding"] },
          tasks: { ...tieTasks, "task-b": { ...tieTasks["task-a"] } },
          models: tieModels,
          policy: {
            "policy-1": tiePolicy({}),
            "policy-2": tiePolicy({ task: "task-b", stakes: ["normal"] }),
          },
        }),
      }),
    );
  });
});

describe("validateRouterSections", () => {
  test("a valid router section returns its rank list", () => {
    const loaded = loadRegistry({ path: FULL });
    expect(validateRouterSections(loaded)).toEqual({
      policies: {},
      rank: ["coding", "intelligence"],
      tasks: {},
    });
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
        policies: {},
        rank: ["coding"],
        tasks: {},
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

  test("an invalid rank still collects the independent problems", async () => {
    await withTempDir(async (dir) => {
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          capabilities: { browser: "Can drive a web browser." },
          router: { rank: [], matrix: true, questions: { telepathy: 7 } },
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
        "router-rank-invalid",
        "router-question-capability-unknown",
        "router-question-not-string",
        "router-field-unknown",
      ]);
      expect(error.message).toBe("the router section has 4 problems");
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
