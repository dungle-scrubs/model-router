import { readFileSync } from "node:fs";
import { type LoadedRegistry, loadRegistry } from "@dungle-scrubs/model-registry";
import { describe, expect, test } from "vitest";
import { checkProfileCoverage } from "../src/coverage.js";
import { validateRouterSections } from "../src/sections.js";
import { expectActionable, fixturePath, withTempDir, writeJson } from "./helpers.js";

const A = "model-a@harness-x";
const B = "model-a@harness-y/provider-1";
function example() {
  return JSON.parse(readFileSync(fixturePath("example-profile.json"), "utf8"));
}
function coverage(loaded: LoadedRegistry) {
  const result = checkProfileCoverage(loaded, validateRouterSections(loaded));
  for (const finding of [...result.problems, ...result.warnings]) expectActionable(finding);
  return result;
}
async function variant(
  edit: (raw: ReturnType<typeof example>) => void,
  assert: (loaded: LoadedRegistry) => void,
) {
  await withTempDir((dir) => {
    const raw = example();
    edit(raw);
    assert(loadRegistry({ path: writeJson(dir, "registry.json", raw) }));
  });
}
function oneTask(raw: ReturnType<typeof example>, needs: string[], floors: Record<string, number>) {
  raw.tasks = {
    "task-a": {
      description: "Placeholder task.",
      rank: ["coding"],
      needs,
      minimums: { low: floors, normal: {}, high: {} },
    },
  };
}

describe("pure profile coverage", () => {
  test("two accepted records cover the combined need and implicit default warns in task and stakes order", () => {
    const result = coverage(loadRegistry({ path: fixturePath("example-profile.json") }));
    expect(result.problems).toEqual([]);
    expect(result.warnings.map((warning) => warning.field)).toEqual([
      '$["tasks"]["task-a"]["minimums"]["low"]["coding"]',
      '$["tasks"]["task-a"]["minimums"]["normal"]["coding"]',
      '$["tasks"]["task-a"]["minimums"]["high"]["coding"]',
      '$["tasks"]["task-b"]["minimums"]["normal"]["coding"]',
      '$["tasks"]["task-b"]["minimums"]["high"]["coding"]',
    ]);
  });

  test("combined unrecorded rating and capability produce two ordered actionable findings at low stakes", async () => {
    await variant(
      (raw) => {
        delete raw.profiles.budget.gaps;
        oneTask(raw, ["browser"], { coding: 8 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(result.problems).toHaveLength(4);
        expect(result.problems[0]).toEqual({
          code: "profile-gap-unrecorded",
          field: '$["tasks"]["task-a"]["needs"][0]',
          message:
            'profile "budget", task "task-a", stakes "low": no route in profile "budget" has capability browser.',
          fix: `Add gap record {"capability":"browser","reason":"<why>"} to profile "budget", or add a filling route ("${A}") to profile "budget".`,
        });
        expect(result.problems[1]?.message).toContain("coding 8 (best 7)");
        expect(result.problems[1]?.fix).toContain('"accepts":7');
        expect(result.warnings).toHaveLength(1);
      },
    );
  });

  test("joint failure uses compatible ceilings instead of independent maxima", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-a"].ratings = { coding: 9, taste: 6 };
        raw.models["model-b"] = {
          family: "family-b",
          ratings: { coding: 6, taste: 9 },
          routes: [{ harness: "harness-x", modelId: "model-b", hosted: false }],
        };
        raw.profiles.budget.routes = ["model-b@harness-x", B];
        raw.profiles.budget.gaps = [];
        oneTask(raw, [], { coding: 8, taste: 8 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(result.problems).toHaveLength(2);
        expect(result.problems.map((problem) => problem.fix)).toEqual([
          'Add gap record {"rating":"coding","accepts":6,"reason":"<why>"} to profile "budget", or add a route that fills it.',
          'Add gap record {"rating":"taste","accepts":6,"reason":"<why>"} to profile "budget", or add a route that fills it.',
        ]);
        expect(
          result.problems.every((problem) =>
            problem.message.includes("no single route clears them together"),
          ),
        ).toBe(true);
      },
    );
  });

  test("stale records use first registry route, not profile route order, and only capped stakes", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-a"].ratings.coding = 8;
        raw.models["model-a"].routes[1].capabilities = ["browser"];
        raw.profiles.budget.routes = [B, A];
        oneTask(raw, ["browser"], { coding: 8 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(result.problems).toEqual([]);
        expect(result.warnings).toHaveLength(4);
        expect(result.warnings.map((warning) => warning.field)).toEqual([
          '$["profiles"]["budget"]["gaps"][0]',
          '$["profiles"]["budget"]["gaps"][0]',
          '$["profiles"]["budget"]["gaps"][0]',
          '$["profiles"]["budget"]["gaps"][1]',
        ]);
        for (const warning of result.warnings) {
          expect(warning.code).toBe("profile-gap-stale");
          expect(warning.message).toContain(`route "${A}"`);
        }
      },
    );
  });

  test("best member ceiling is the maximum, not the first member or minimum", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-b"] = {
          family: "family-b",
          ratings: { coding: 9 },
          routes: [{ harness: "harness-x", modelId: "model-b", hosted: false }],
        };
        raw.profiles.budget.routes.push("model-b@harness-x");
        raw.profiles.budget.gaps = [];
        oneTask(raw, [], { coding: 10 });
      },
      (loaded) => {
        expect(coverage(loaded).problems[0]?.fix).toContain('"accepts":9');
      },
    );
  });

  test("a recorded gap waives only its own capability and caps only its own rating", async () => {
    await variant(
      (raw) => {
        raw.capabilities["capability-b"] = "Another capability.";
        oneTask(raw, ["browser", "capability-b"], { coding: 8, taste: 8 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(result.problems).toHaveLength(4);
        expect(result.problems[0]?.field).toBe('$["tasks"]["task-a"]["needs"][1]');
        expect(result.problems[1]?.field).toBe('$["tasks"]["task-a"]["minimums"]["low"]["taste"]');
      },
    );
  });

  test("relaxing an independently missing rating retains its best ceiling for joint diagnosis", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-b"] = {
          family: "family-b",
          ratings: { coding: 9, taste: 6 },
          routes: [{ harness: "harness-x", modelId: "model-b", hosted: false }],
        };
        raw.profiles.budget.routes = [A, "model-b@harness-x"];
        raw.profiles.budget.gaps = [];
        oneTask(raw, ["browser"], { coding: 10 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(result.problems).toHaveLength(3);
        expect(result.problems[0]?.fix).toContain('"accepts":9');
        expect(result.problems[1]?.fix).toContain('"capability":"browser"');
        expect(result.problems[2]?.fix).toContain('"accepts":7');
      },
    );
  });

  test("no tasks returns empty problems and warnings", async () => {
    await variant(
      (raw) => {
        delete raw.tasks;
      },
      (loaded) => {
        expect(coverage(loaded)).toEqual({ problems: [], warnings: [] });
      },
    );
  });

  test.each(["__proto__", "constructor"])(
    "own profile and task named %s keep ordering and fields",
    async (name) => {
      await variant(
        (raw) => {
          raw.profiles = JSON.parse(`{"${name}":${JSON.stringify(raw.profiles.budget)}}`);
          delete raw.profiles[name].gaps;
          raw.tasks = JSON.parse(`{"${name}":${JSON.stringify(raw.tasks["task-a"])}}`);
        },
        (loaded) => {
          const result = coverage(loaded);
          expect(result.problems).toHaveLength(6);
          expect(result.problems[0]?.message).toContain(`profile "${name}", task "${name}"`);
          expect(result.problems[0]?.field).toBe(`$["tasks"]["${name}"]["needs"][0]`);
        },
      );
    },
  );

  test("absent rating is not a ceiling, including inherited rating values", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        delete raw.models["model-a"].ratings.coding;
        raw.profiles.budget.gaps = [];
        oneTask(raw, [], { coding: 1 });
      },
      (loaded) => {
        const model = loaded.registry.models["model-a"];
        if (model === undefined) throw new Error("missing fixture model");
        const changed = {
          ...loaded,
          registry: {
            ...loaded.registry,
            models: {
              ...loaded.registry.models,
              "model-a": {
                ...model,
                ratings: Object.assign(Object.create({ coding: 10 }), model?.ratings),
              },
            },
          },
        };
        const result = coverage(changed);
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]?.message).toContain("best unrated");
        expect(result.problems[0]?.fix).not.toContain('"accepts"');
        expect(result.problems[0]?.fix).toContain('rate a member model for "coding"');
      },
    );
  });

  test("empty profile reports missing items without inventing a rating ceiling", async () => {
    await variant(
      (raw) => {
        raw.profiles.budget.routes = [];
        raw.profiles.budget.gaps = [];
        oneTask(raw, ["browser"], { coding: 7 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(result.problems).toHaveLength(4);
        expect(result.problems[1]?.fix).toContain(A);
        expect(result.problems[1]?.fix).not.toContain('"accepts"');
      },
    );
  });

  test("lower floors stay as written and do not mark a rating record stale", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-a"].ratings.coding = 6;
        oneTask(raw, [], { coding: 6 });
      },
      (loaded) => {
        expect(coverage(loaded)).toEqual({ problems: [], warnings: [] });
      },
    );
  });

  test("a rating record is not stale at a floor equal to accepts", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-a"].ratings.coding = 8;
        oneTask(raw, [], { coding: 7 });
      },
      (loaded) => {
        expect(coverage(loaded)).toEqual({ problems: [], warnings: [] });
      },
    );
  });

  test("profiles follow loader key order while task items follow declared order", async () => {
    await variant(
      (raw) => {
        delete raw.profiles.budget.gaps;
        raw.profiles.constructor = { ...raw.profiles.budget, description: "Another profile." };
        oneTask(raw, ["browser"], { taste: 8, coding: 8 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(
          result.problems.map((problem) => problem.message.match(/profile "([^"]+)"/)?.[1]),
        ).toEqual([
          "budget",
          "budget",
          "budget",
          "budget",
          "budget",
          "constructor",
          "constructor",
          "constructor",
          "constructor",
          "constructor",
        ]);
        expect(result.problems.slice(0, 3).map((problem) => problem.field)).toEqual([
          '$["tasks"]["task-a"]["needs"][0]',
          '$["tasks"]["task-a"]["minimums"]["low"]["taste"]',
          '$["tasks"]["task-a"]["minimums"]["low"]["coding"]',
        ]);
      },
    );
  });

  test("stale record requires a route compatible with every other capped requirement", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-a"].ratings.coding = 9;
        raw.models["model-a"].routes[1].capabilities = ["browser"];
        oneTask(raw, ["browser"], { coding: 9, taste: 7 });
      },
      (loaded) => {
        expect(
          coverage(loaded).warnings.some(
            (warning) =>
              warning.code === "profile-gap-stale" && warning.message.includes('stakes "low"'),
          ),
        ).toBe(false);
      },
    );
  });

  test("joint capability and rating can suggest a capability record or a compatible rating ceiling", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-b"] = {
          family: "family-b",
          ratings: { coding: 9 },
          routes: [{ harness: "harness-x", modelId: "model-b", hosted: false }],
        };
        raw.profiles.budget.routes = [A, "model-b@harness-x"];
        raw.profiles.budget.gaps = [];
        oneTask(raw, ["browser"], { coding: 8 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(result.problems).toHaveLength(2);
        expect(result.problems[0]?.fix).toContain('"capability":"browser"');
        expect(result.problems[1]?.fix).toContain('"accepts":7');
      },
    );
  });

  test("three-way incompatibility with no one-record repair reports each remaining item", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.models["model-a"].ratings = { coding: 9, taste: 6 };
        raw.models["model-a"].routes[0].capabilities = [];
        raw.models["model-b"] = {
          family: "family-b",
          ratings: { coding: 6, taste: 9 },
          routes: [{ harness: "harness-x", modelId: "model-b", hosted: false }],
        };
        raw.profiles.budget.routes = [A, "model-b@harness-x"];
        raw.profiles.budget.gaps = [];
        oneTask(raw, ["browser"], { coding: 8, taste: 8 });
      },
      (loaded) => {
        // The independently missing capability is waived before diagnosing the rating intersection.
        const result = coverage(loaded);
        expect(result.problems).toHaveLength(5);
        expect(result.problems[0]?.message).toContain("has capability browser");
        expect(result.problems[1]?.fix).toContain('"accepts":6');
      },
    );
  });

  test("a capable member does not make an unused capability record stale", async () => {
    await variant(
      (raw) => {
        raw.models["model-a"].routes[1].capabilities = ["browser"];
        oneTask(raw, [], { coding: 7 });
      },
      (loaded) => {
        expect(coverage(loaded)).toEqual({ problems: [], warnings: [] });
      },
    );
  });

  test("no single record can fix disjoint capabilities and ratings", async () => {
    await variant(
      (raw) => {
        delete raw.calibration;
        raw.capabilities["capability-b"] = "Placeholder capability.";
        raw.models["model-a"].routes[0].capabilities = ["browser", "capability-b"];
        raw.models["model-b"] = {
          family: "family-b",
          ratings: { coding: 9, taste: 9 },
          routes: [{ harness: "harness-x", modelId: "model-b", hosted: false }],
        };
        raw.profiles.budget.routes = [A, "model-b@harness-x"];
        raw.profiles.budget.gaps = [];
        oneTask(raw, ["browser", "capability-b"], { coding: 8, taste: 8 });
      },
      (loaded) => {
        const result = coverage(loaded);
        expect(result.problems).toHaveLength(4);
        for (const problem of result.problems) {
          expect(problem.message).toContain("no single record covers it");
          expect(problem.fix).toContain("record more than one ceiling");
        }
      },
    );
  });
});
