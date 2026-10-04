import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { defaultConfig, rank } from "../src/index.js";
import {
  expectActionable,
  expectValidAnswer,
  fixturePath,
  runBuiltCli,
  withTempDir,
  writeJson,
} from "./helpers.js";

const EXAMPLE = fixturePath("example-profile.json");
const B = "model-a@harness-y/provider-1";
function example() {
  return JSON.parse(readFileSync(EXAMPLE, "utf8"));
}
function check(path = EXAMPLE, extra: string[] = []) {
  return runBuiltCli(["check", "--registry", path, ...extra], { MODEL_ROUTER_PROFILE: "nope" });
}
function ranked(query: unknown, registry = EXAMPLE) {
  const answer = rank(query, { registry, config: defaultConfig() });
  expectValidAnswer(answer);
  return answer;
}
function accepted(answer: ReturnType<typeof rank>) {
  return answer.warnings.filter((warning) => warning.code === "profile-gap-accepted");
}

// Keep the shipped facts intact; named variants below change only what each case needs.
describe("example profile coverage CLI", () => {
  test("fixture facts match the installed example through its package export", () => {
    const { router: _router, tasks: _tasks, ...facts } = example();
    const shipped = JSON.parse(
      readFileSync(
        fileURLToPath(import.meta.resolve("@dungle-scrubs/model-registry/examples/registry.json")),
        "utf8",
      ),
    );
    expect(facts).toEqual(shipped);
  });

  test("combined accepted records cover budget and implicit default warns at exit 0", () => {
    const result = check();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ configPath: null, registryPath: EXAMPLE });
    expect(output.registryDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(output.warnings).toHaveLength(5);
    for (const warning of output.warnings) {
      expect(warning.code).toBe("profile-gap-unrecorded");
      expect(warning.message).toContain('profile "default"');
      expect(warning.field).toMatch(/^\$\["tasks"\]/);
      expect(warning.fix).toContain('Declare "default"');
      expectActionable(warning);
    }
  });

  test("implicit default combined missing capability and rating remain warnings at exit 0", async () => {
    await withTempDir((dir) => {
      const raw = example();
      raw.models["model-a"].routes[0].capabilities = [];
      const result = check(writeJson(dir, "implicit-combined.json", raw));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const warnings = JSON.parse(result.stdout).warnings;
      expect(warnings).toHaveLength(8);
      expect(warnings[0].field).toBe('$["tasks"]["task-a"]["needs"][0]');
      expect(warnings[1].field).toBe('$["tasks"]["task-a"]["minimums"]["low"]["coding"]');
    });
  });

  test("unrecorded combined gap fails at exit 4 with two problems per task and stakes", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.profiles.budget.gaps;
      const result = check(writeJson(dir, "unrecorded.json", raw));
      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe("");
      const envelope = JSON.parse(result.stderr);
      expect(Object.keys(envelope)).toEqual(["error"]);
      expect(envelope.error).toMatchObject({
        code: "profile-gap-unrecorded",
        field: '$["profiles"]',
      });
      expect(envelope.error.problems).toHaveLength(8);
      expect(
        envelope.error.problems.slice(0, 2).map((problem: { field: string }) => problem.field),
      ).toEqual([
        '$["tasks"]["task-a"]["needs"][0]',
        '$["tasks"]["task-a"]["minimums"]["low"]["coding"]',
      ]);
      for (const problem of envelope.error.problems) {
        expect(problem.code).toBe("profile-gap-unrecorded");
        expect(problem.message).toContain('profile "budget"');
        expect(problem.message).toContain("stakes");
        expect(problem.fix).toMatch(/"capability":"browser"|"rating":"coding","accepts":7/);
        expectActionable(problem);
      }
    });
  });

  test.each([
    [0, 3],
    [1, 5],
  ] as const)("combined coverage requires record %i at exit 4", async (index, count) => {
    await withTempDir((dir) => {
      const raw = example();
      raw.profiles.budget.gaps.splice(index, 1);
      const result = check(writeJson(dir, "one-record.json", raw));
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stderr).error.problems).toHaveLength(count);
    });
  });

  test("declared default gaps fail rather than warn", async () => {
    await withTempDir((dir) => {
      const raw = example();
      raw.profiles.default = { description: "Default routes.", routes: [B] };
      const result = check(writeJson(dir, "declared-default.json", raw));
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stderr).error.problems[0].message).toContain('profile "default"');
    });
  });

  test("joint floors say no single route clears them together at exit 4", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      raw.models["model-a"].ratings = { coding: 9, taste: 6 };
      raw.models["model-b"] = {
        family: "family-b",
        ratings: { coding: 6, taste: 9 },
        routes: [{ harness: "harness-x", modelId: "model-b", hosted: false }],
      };
      raw.profiles.budget.routes.push("model-b@harness-x");
      raw.profiles.budget.gaps = [];
      raw.tasks = {
        "task-a": {
          description: "Both ratings.",
          rank: ["coding"],
          minimums: { low: { coding: 8, taste: 8 }, normal: {}, high: {} },
        },
      };
      const result = check(writeJson(dir, "joint.json", raw));
      expect(result.exitCode).toBe(4);
      const problems = JSON.parse(result.stderr).error.problems;
      expect(problems).toHaveLength(2);
      expect(problems[0].message).toContain("no single route clears them together");
      expect(problems[0].fix).toContain('"rating":"coding","accepts":6');
      expect(problems[1].fix).toContain('"rating":"taste","accepts":6');
    });
  });

  test("stale records warn with task, stakes and filling route at exit 0", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      raw.models["model-a"].ratings.coding = 8;
      raw.models["model-a"].routes[1].capabilities = ["browser"];
      const result = check(writeJson(dir, "stale.json", raw));
      expect(result.exitCode, result.stderr).toBe(0);
      const warnings = JSON.parse(result.stdout).warnings;
      const stale = warnings.filter(
        (warning: { code: string }) => warning.code === "profile-gap-stale",
      );
      expect(stale).toHaveLength(8);
      expect(stale[0]).toMatchObject({ field: '$["profiles"]["budget"]["gaps"][0]' });
      for (const warning of stale) {
        expect(warning.message).toContain('profile "budget"');
        expect(warning.message).toContain(B);
        expect(warning.message).toContain("task");
        expect(warning.message).toContain("stakes");
        expectActionable(warning);
      }
    });
  });

  test("successful check always includes an empty warnings array when covered", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.tasks;
      const result = check(writeJson(dir, "no-tasks.json", raw));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).warnings).toEqual([]);
    });
  });

  test("editing the suggested existing ceiling repairs check", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      raw.models["model-a"].ratings.coding = 6;
      const path = writeJson(dir, "capped.json", raw);
      const before = check(path);
      expect(before.exitCode).toBe(4);
      expect(JSON.parse(before.stderr).error.problems[0].fix).toContain(
        'Set "accepts" to 6 in gap record 1',
      );
      raw.profiles.budget.gaps[1].accepts = 6;
      expect(check(writeJson(dir, "repaired.json", raw)).exitCode).toBe(0);
    });
  });

  test("empty declared profile fails itemless tasks at every stakes", async () => {
    await withTempDir((dir) => {
      const raw = example();
      raw.profiles.budget.routes = [];
      raw.tasks = {
        "task-a": {
          description: "Placeholder task.",
          rank: ["coding"],
          minimums: { low: {}, normal: {}, high: {} },
        },
      };
      const result = check(writeJson(dir, "empty-itemless.json", raw));
      expect(result.exitCode).toBe(4);
      const problems = JSON.parse(result.stderr).error.problems;
      expect(problems).toHaveLength(3);
      for (const [index, problem] of problems.entries()) {
        expect(problem.field).toBe('$["profiles"]["budget"]["routes"]');
        expect(problem.message).toBe(
          `profile "budget", task "task-a", stakes "${["low", "normal", "high"][index]}": profile "budget" has no routes.`,
        );
        expect(problem.fix).toBe(
          'Add a route ("model-a@harness-x", "model-a@harness-y/provider-1") to profile "budget".',
        );
      }
    });
  });

  test("one unrecorded gap uses singular top-level wording", async () => {
    await withTempDir((dir) => {
      const raw = example();
      raw.profiles.budget.gaps = [];
      raw.tasks = {
        "task-a": {
          description: "Placeholder task.",
          rank: ["coding"],
          minimums: { low: {}, normal: {}, high: { coding: 9 } },
        },
      };
      const result = check(writeJson(dir, "singular.json", raw));
      expect(result.exitCode).toBe(4);
      const error = JSON.parse(result.stderr).error;
      expect(error.problems).toHaveLength(1);
      expect(error.message).toBe("declared profile coverage has 1 unrecorded gap.");
    });
  });

  test("config and sections failures precede coverage", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.profiles.budget.gaps;
      const path = writeJson(dir, "gap.json", raw);
      const config = writeJson(dir, "config.json", { unknown: true });
      expect(JSON.parse(check(path, ["--config", config]).stderr).error.code).toBe(
        "config-invalid",
      );
      delete raw.router;
      expect(
        JSON.parse(check(writeJson(dir, "sections.json", raw), ["--config", config]).stderr).error
          .code,
      ).toBe("registry-sections-invalid");
    });
  });
});

describe("accepted gaps at runtime", () => {
  test("library warns for combined records in record order without granting capabilities", () => {
    const answer = ranked({ task: "task-a", stakes: "high", profile: "budget", pin: B });
    expect(answer.routes).toEqual([]);
    expect(answer.removed[0]?.reason.code).toBe("needs-not-satisfied");
    expect(answer.query.needs).toEqual([]);
    expect(accepted(answer)).toHaveLength(2);
    expect(accepted(answer).map((warning) => warning.field)).toEqual([
      '$["profiles"]["budget"]["gaps"][0]',
      '$["profiles"]["budget"]["gaps"][1]',
    ]);
    expect(accepted(answer).map((warning) => warning.message)).toEqual([
      'profile "budget" hits accepted capability gap "browser": This set has no browser route.',
      'profile "budget" hits accepted rating gap "coding" (accepts 7): This set reaches coding 7 at most.',
    ]);
    for (const [index, warning] of accepted(answer).entries()) {
      expect(warning.message).toContain('profile "budget"');
      expect(warning.message).toContain(example().profiles.budget.gaps[index].reason);
    }
    expect(answer.warnings.findIndex((warning) => warning.code === "pin-unused")).toBeGreaterThan(
      answer.warnings.findIndex((warning) => warning.code === "profile-gap-accepted"),
    );
  });

  test.each([
    ["task-a", 3, 2],
    ["task-b", 0, 1],
  ] as const)("built CLI %s warns at exit %i", (task, exit, count) => {
    const result = runBuiltCli([
      JSON.stringify({ task, stakes: "high", profile: "budget" }),
      "--registry",
      EXAMPLE,
    ]);
    expect(result.exitCode, result.stderr).toBe(exit);
    expect(result.stderr).toBe("");
    const answer = JSON.parse(result.stdout);
    expectValidAnswer(answer);
    expect(accepted(answer)).toHaveLength(count);
    if (exit === 0) {
      expect(answer.routes[0]?.floor).toBe("below");
      expect(answer.routes[0]?.reasons[0]?.code).toBe("floor-not-met");
    }
  });

  test("library rating warning retains original floor and below route", () => {
    const answer = ranked({
      task: "task-b",
      stakes: "high",
      profile: "budget",
      minimums: { coding: 10 },
    });
    expect(accepted(answer)).toHaveLength(1);
    expect(answer.query.minimums).toEqual({ coding: 10 });
    expect(answer.routes[0]?.floor).toBe("below");
    expect(answer.routes[0]?.reasons[0]?.message).toContain("floor 10");
  });

  test("a floor equal to accepts does not apply the rating record even below the floor", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      raw.models["model-a"].ratings.coding = 6;
      const path = writeJson(dir, "below-accepts.json", raw);
      const answer = ranked({ minimums: { coding: 7 }, profile: "budget" }, path);
      expect(accepted(answer)).toEqual([]);
      expect(answer.routes[0]?.floor).toBe("below");
      const control = accepted(ranked({ minimums: { coding: 8 }, profile: "budget" }, path));
      expect(control).toHaveLength(1);
      expect(control[0]?.field).toBe('$["profiles"]["budget"]["gaps"][1]');
    });
  });

  test("a floor set without the recorded rating does not apply the record or throw", async () => {
    expect(accepted(ranked({ minimums: { taste: 5 }, profile: "budget" }))).toEqual([]);
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      raw.models["model-a"].ratings.taste = 9;
      expect(
        accepted(
          ranked(
            { minimums: { taste: 8 }, profile: "budget" },
            writeJson(dir, "other-rating.json", raw),
          ),
        ),
      ).toEqual([]);
    });
  });

  test.each<readonly [unknown]>(
    [
      { task: "task-b", stakes: "low" },
      { minimums: { coding: 7 } },
      { minimums: { coding: 6 } },
      { minimums: { coding: 8, constructor: 1 } },
      { minimums: { coding: 8 }, privacy: "secret" },
      { minimums: { coding: 8 }, excludeFamilies: ["family-a"] },
      { minimums: { coding: 8 }, needs: ["capability-b"] },
      { minimums: { coding: 8, taste: 7 } },
    ].map((query) => [query] as const),
  )("does not warn when a record is unused or another limit blocks compatibility: %j", (query) => {
    expect(accepted(ranked({ ...(query as object), profile: "budget" }))).toEqual([]);
  });

  test("inline needs and floors hit records even without a known task", () => {
    const answer = ranked({
      task: "task-b",
      stakes: "low",
      minimums: { coding: 8 },
      needs: ["browser"],
      profile: "budget",
    });
    expect(accepted(answer)).toHaveLength(2);
    expect(
      accepted(
        ranked({ task: "task-a", stakes: "high", minimums: { coding: 7 }, profile: "budget" }),
      ),
    ).toHaveLength(1);
    expect(accepted(ranked({ task: "task-b", minimums: { coding: 8 } }))).toEqual([]);
    expect(
      accepted(ranked({ task: "task-b", minimums: { coding: 8 }, profile: "budget", needs: [] })),
    ).toHaveLength(1);
  });

  test("a filling route with incompatible other floors does not suppress accepted warnings", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      raw.models["model-b"] = {
        family: "family-b",
        ratings: { coding: 9, taste: 5 },
        routes: [
          { harness: "harness-x", modelId: "model-b", hosted: false, capabilities: ["browser"] },
        ],
      };
      raw.profiles.budget.routes.push("model-b@harness-x");
      const path = writeJson(dir, "incompatible.json", raw);
      const answer = ranked(
        { minimums: { coding: 9, taste: 6 }, needs: ["browser"], profile: "budget" },
        path,
      );
      expect(accepted(answer)).toHaveLength(2);
      expect(answer.routes[0]?.floor).toBe("below");
      expect(answer.removed[0]?.reason.code).toBe("needs-not-satisfied");
      expect(
        accepted(
          ranked(
            { minimums: { coding: 9, taste: 5 }, needs: ["browser"], profile: "budget" },
            path,
          ),
        ),
      ).toEqual([]);
    });
  });

  test("privacy and family limits on a filling member affect gap warnings", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      raw.models["model-a"].routes[1].privacyEligible = true;
      raw.models["model-b"] = {
        family: "family-b",
        ratings: { coding: 9, taste: 6 },
        routes: [
          { harness: "harness-x", modelId: "model-b", hosted: true, capabilities: ["browser"] },
        ],
      };
      raw.profiles.budget.routes.push("model-b@harness-x");
      const path = writeJson(dir, "limits.json", raw);
      const query = { task: "task-a", stakes: "high", profile: "budget" };
      expect(accepted(ranked(query, path))).toEqual([]);
      expect(accepted(ranked({ ...query, privacy: "secret" }, path))).toHaveLength(2);
      expect(accepted(ranked({ ...query, excludeFamilies: ["family-b"] }, path))).toHaveLength(2);
    });
  });

  test("absent own rating still warns at runtime", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      delete raw.models["model-a"].ratings.coding;
      const path = writeJson(dir, "unrated.json", raw);
      const answer = ranked({ minimums: { coding: 9 }, profile: "budget" }, path);
      expect(accepted(answer)).toHaveLength(1);
      expect(answer.routes[0]?.floor).toBe("below");
    });
  });

  test.each(["__proto__", "constructor"])(
    "runtime gap warning field uses own selected profile %s",
    async (name) => {
      await withTempDir((dir) => {
        const raw = example();
        raw.profiles = JSON.parse(`{"${name}":${JSON.stringify(raw.profiles.budget)}}`);
        const answer = ranked({ task: "task-a", profile: name }, writeJson(dir, "names.json", raw));
        expect(accepted(answer)).toHaveLength(2);
        expect(accepted(answer)[0]?.field).toBe(`$["profiles"]["${name}"]["gaps"][0]`);
      });
    },
  );

  test("an empty profile has no compatible member and warns for no gap", async () => {
    await withTempDir((dir) => {
      const raw = example();
      raw.profiles.budget.routes = [];
      const answer = ranked(
        { task: "task-a", profile: "budget" },
        writeJson(dir, "empty.json", raw),
      );
      expect(answer.routes).toEqual([]);
      expect(accepted(answer)).toEqual([]);
    });
  });

  test("now-capable compatible member suppresses both warnings and ranks", async () => {
    await withTempDir((dir) => {
      const raw = example();
      delete raw.calibration;
      raw.models["model-a"].ratings.coding = 9;
      raw.models["model-a"].routes[1].capabilities = ["browser"];
      const answer = ranked(
        { task: "task-a", stakes: "high", profile: "budget" },
        writeJson(dir, "filled.json", raw),
      );
      expect(accepted(answer)).toEqual([]);
      expect(answer.routes[0]?.floor).toBe("clears");
    });
  });
});
