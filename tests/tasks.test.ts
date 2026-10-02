import { loadRegistry } from "@dungle-scrubs/model-registry";
import { describe, expect, test } from "vitest";
import { listTasks, RouterError, rank } from "../src/index.js";
import { expectValidAnswer, fixturePath, loadLoaded, withTempDir, writeJson } from "./helpers.js";

const TASKS = fixturePath("tasks.json");
const EMPTY = fixturePath("empty-models.json");
const POLICY_BROKEN = fixturePath("policy-broken.json");

const tasks = () => loadLoaded(TASKS);
const policyBroken = () => loadLoaded(POLICY_BROKEN);

describe("rank with a known task", () => {
  test("a task query at each stakes level uses that level's floors", () => {
    const loaded = tasks();
    // task-b floors taste by stakes (low 3, normal 5, high 7) and needs
    // nothing, so the level's floors alone decide clearing. Ratings:
    // model-a taste 5, model-b taste 6, model-c taste 4. Clearing order is
    // cost first: model-b (cost 9), model-a (cost 8), model-c (no cost).
    // Below order is the task's rank, taste: model-b, model-a, model-c.
    const low = rank({ task: "task-b", stakes: "low" }, { registry: loaded });
    expectValidAnswer(low);
    expect(low.routes.map((entry) => [entry.label, entry.floor])).toEqual([
      ["model-b@harness-x", "clears"],
      ["model-a@harness-x", "clears"],
      ["model-c@harness-x", "clears"], // taste 4 >= 3
    ]);

    const normal = rank({ task: "task-b", stakes: "normal" }, { registry: loaded });
    expectValidAnswer(normal);
    expect(normal.routes.map((entry) => [entry.label, entry.floor])).toEqual([
      ["model-b@harness-x", "clears"],
      ["model-a@harness-x", "clears"],
      ["model-c@harness-x", "below"], // taste 4 < 5
    ]);

    const high = rank({ task: "task-b", stakes: "high" }, { registry: loaded });
    expectValidAnswer(high);
    // Below-floor order follows the task's rank (taste), not router.rank
    // (coding, taste), which would put model-c (coding 8) first.
    expect(high.routes.map((entry) => [entry.label, entry.floor])).toEqual([
      ["model-b@harness-x", "below"], // taste 6 < 7
      ["model-a@harness-x", "below"], // taste 5 < 7
      ["model-c@harness-x", "below"], // taste 4 < 7
    ]);
  });

  test("a task query with inline minimums replaces the task floor per rating", () => {
    const loaded = tasks();
    // Inline taste 3 replaces task-b's normal floor (taste 5) for that
    // rating: model-c (taste 4) now clears instead of falling below.
    const lowered = rank(
      { task: "task-b", stakes: "normal", minimums: { taste: 3 } },
      { registry: loaded },
    );
    expectValidAnswer(lowered);
    expect(lowered.routes.map((entry) => [entry.label, entry.floor])).toEqual([
      ["model-b@harness-x", "clears"],
      ["model-a@harness-x", "clears"],
      ["model-c@harness-x", "clears"],
    ]);

    // Inline coding 9 names a rating the task does not floor: the task's
    // taste 5 floor stays, and the coding floor applies alongside it, so
    // every route falls below.
    const added = rank(
      { task: "task-b", stakes: "normal", minimums: { coding: 9 } },
      { registry: loaded },
    );
    expectValidAnswer(added);
    expect(added.routes.map((entry) => [entry.label, entry.floor])).toEqual([
      ["model-b@harness-x", "below"],
      ["model-a@harness-x", "below"],
      ["model-c@harness-x", "below"],
    ]);
    // model-b fails only the coding floor; its taste 6 meets the task's
    // taste 5 floor, which the inline minimums left in place.
    expect(added.routes[0]?.reasons).toEqual([
      {
        code: "floor-not-met",
        field: '$.minimums["coding"]',
        message: 'the model\'s rating for "coding" is 7, below the floor 9',
      },
    ]);
  });

  test("inline needs add to the task's needs", async () => {
    await withTempDir(async (dir) => {
      // task-a needs repo-access. model-all lists both repo-access and
      // browser; model-browser lists only browser. Inline needs browser adds
      // to the task's needs, so only model-all satisfies both. If the inline
      // list replaced the task's needs, model-browser would survive too.
      const loaded = loadRegistry({
        path: writeJson(dir, "registry.json", {
          format: 1,
          ratings: { coding: "Writes and changes code to a spec." },
          capabilities: {
            browser: "Can drive a web browser.",
            "repo-access": "Can read and change files in the workspace.",
          },
          router: { rank: ["coding"] },
          tasks: {
            "task-a": {
              description: "Code.",
              minimums: { low: { coding: 5 }, normal: { coding: 5 }, high: { coding: 5 } },
              rank: ["coding"],
              needs: ["repo-access"],
            },
          },
          models: {
            "model-all": {
              family: "family-a",
              ratings: { coding: 7 },
              routes: [
                {
                  harness: "harness-x",
                  modelId: "model-id-all",
                  hosted: true,
                  capabilities: ["repo-access", "browser"],
                },
              ],
            },
            "model-browser": {
              family: "family-b",
              ratings: { coding: 7 },
              routes: [
                {
                  harness: "harness-x",
                  modelId: "model-id-browser",
                  hosted: true,
                  capabilities: ["browser"],
                },
              ],
            },
          },
        }),
      });
      const answer = rank(
        { task: "task-a", stakes: "normal", needs: ["browser"] },
        { registry: loaded },
      );
      expectValidAnswer(answer);
      expect(answer.routes.map((entry) => entry.label)).toEqual(["model-all@harness-x"]);
      expect(answer.removed.map((entry) => entry.label)).toEqual(["model-browser@harness-x"]);
    });
  });

  test("inline effort replaces the task's effort on the applied query", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal", effort: "low" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.query.effort).toBe("low");
    expect(answer.warnings.map((entry) => entry.code)).not.toContain("effort-unapplied");
  });

  test("an inline effort alongside a task is echoed on the applied query without a warning", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal", effort: "" }, { registry: loaded });
    expectValidAnswer(answer);
    // Effort resolution is a later release: the value parses and is echoed
    // verbatim, with no effort-unapplied warning because a task is named.
    expect(answer.query.effort).toBe("");
  });
});

describe("rank with a misspelled task", () => {
  test("an unknown task ranks by router.rank with a warning naming the task", () => {
    const loaded = tasks();
    const answer = rank({ task: "ghost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.warnings.map((entry) => entry.code)).toEqual(["task-unranked"]);
    expect(answer.warnings[0]?.message).toBe(
      'the task "ghost" is not declared in the registry\'s tasks section; ranking by router.rank',
    );
    expect(answer.routes.map((entry) => entry.label)).toEqual([
      "model-c@harness-x",
      "model-b@harness-x",
      "model-a@harness-x",
    ]);
  });
});

describe("rank under spec: settled", () => {
  test("a spec: settled query with a settled and an unconditional policy takes the settled one", () => {
    const loaded = tasks();
    const answer = rank(
      { task: "task-a", stakes: "normal", spec: "settled" },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    // policy-settled wins: routes model-a@harness-x only; model-a is rejected by repo-access.
    // rank then clears model-c with floor=clears.
    expect(answer.routes.map((entry) => entry.label)).toEqual(["model-c@harness-x"]);
    expect(answer.routes[0]?.placedBy).toBe("rank");
    expect(answer.warnings.map((entry) => entry.code)).not.toContain("policy-none");
  });

  test("a spec: settled query with no matching policy ranks normally with a policy-none warning", () => {
    const loaded = tasks();
    // Drop both policies so the spec=settled query has no match.
    const noPolicy = { ...loaded, sections: { ...loaded.sections, policy: {} } };
    const answer = rank(
      { task: "task-a", stakes: "normal", spec: "settled" },
      { registry: noPolicy },
    );
    expectValidAnswer(answer);
    expect(answer.warnings.map((entry) => entry.code)).toEqual(["policy-none"]);
    expect(answer.warnings[0]?.message).toBe(
      'the spec "settled" matched no policy; normal ranking was used',
    );
  });

  test("a spec: settled query takes a policy without spec when no settled policy matches", () => {
    const loaded = tasks();
    // Keep only the unconditional policy-a: a policy without spec applies
    // whatever the query's spec is, so the settled query still places it.
    const onlyUnconditional = {
      ...loaded,
      sections: {
        ...loaded.sections,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low", "normal", "high"],
            routes: [
              { route: "model-b@harness-x", effort: "medium" },
              { route: "model-c@harness-x" },
            ],
            reason: "Cheap code routes run first.",
          },
        },
      },
    };
    const answer = rank(
      { task: "task-a", stakes: "normal", spec: "settled" },
      { registry: onlyUnconditional },
    );
    expectValidAnswer(answer);
    expect(answer.routes[0]?.label).toBe("model-c@harness-x");
    expect(answer.routes[0]?.placedBy).toBe("policy");
    expect(answer.warnings.map((entry) => entry.code)).not.toContain("policy-none");
  });

  test("an open query takes a spec: open policy over a specless one, and the file stays valid", () => {
    const loaded = tasks();
    // Two policies on task-b, overlapping stakes, different spec conditions:
    // not a tie. A policy with spec beats one without. policy-open lists its
    // routes in written order [model-a, model-b], against the cost order
    // (model-b cost 9 before model-a cost 8), so written order is provable.
    // If the specless policy-any won instead, model-b would be placed by
    // rank, not policy, and model-a would not lead.
    const openBeatsSpecless = {
      ...loaded,
      sections: {
        ...loaded.sections,
        policy: {
          "policy-any": {
            task: "task-b",
            stakes: ["low", "normal", "high"],
            routes: [{ route: "model-a@harness-x" }],
            reason: "Any spec.",
          },
          "policy-open": {
            task: "task-b",
            stakes: ["low", "normal", "high"],
            spec: "open",
            routes: [{ route: "model-a@harness-x" }, { route: "model-b@harness-x" }],
            reason: "Open specs prefer the cheap pair.",
          },
        },
      },
    };
    const answer = rank({ task: "task-b", stakes: "normal" }, { registry: openBeatsSpecless });
    expectValidAnswer(answer);
    expect(answer.routes.map((entry) => [entry.label, entry.placedBy, entry.floor])).toEqual([
      ["model-a@harness-x", "policy", "skipped"],
      ["model-b@harness-x", "policy", "skipped"],
      ["model-c@harness-x", "rank", "below"],
    ]);
    expect(answer.warnings).toEqual([]);
  });

  test("a spec: open query never matches a spec: settled policy", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal" }, { registry: loaded });
    expectValidAnswer(answer);
    // Default spec=open. policy-settled does not match (spec mismatch).
    // policy-a matches: places model-c with floor=skipped.
    expect(answer.routes[0]?.placedBy).toBe("policy");
    expect(answer.warnings.map((entry) => entry.code)).not.toContain("policy-none");
  });
});

describe("rank places a policy's routes first", () => {
  test("a policy route removed by a hard limit keeps its removal reason and adds a warning naming the policy", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal" }, { registry: loaded });
    expectValidAnswer(answer);
    // policy-a has routes [model-b@harness-x, model-c@harness-x]. model-b
    // lacks repo-access, so the needs hard limit removed it: one removal
    // entry with that reason, plus a warning naming the policy that wanted it.
    const modelBRemovals = answer.removed.filter((entry) => entry.label === "model-b@harness-x");
    expect(modelBRemovals).toHaveLength(1);
    expect(modelBRemovals[0]?.reason.code).toBe("needs-not-satisfied");
    const warning = answer.warnings.find((entry) => entry.code === "policy-route-removed");
    expect(warning?.message).toContain("policy-a");
    expect(warning?.message).toContain("model-b@harness-x");
  });

  test("every policy route a hard limit removed gets its own warning", () => {
    const loaded = tasks();
    // Adding browser to task-a's needs removes every route, so both of
    // policy-a's routes are named, in written order.
    const answer = rank(
      { task: "task-a", stakes: "normal", needs: ["browser"] },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.removed).toHaveLength(3);
    expect(answer.removed.map((entry) => entry.reason.code)).toEqual([
      "needs-not-satisfied",
      "needs-not-satisfied",
      "needs-not-satisfied",
    ]);
    expect(
      answer.warnings
        .filter((entry) => entry.code === "policy-route-removed")
        .map((entry) => entry.message),
    ).toEqual([
      'the policy "policy-a" names the route "model-b@harness-x", which a hard limit removed',
      'the policy "policy-a" names the route "model-c@harness-x", which a hard limit removed',
    ]);
  });

  test("the policy routes appear with placedBy=policy and floor=skipped in written order", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.routes[0]?.label).toBe("model-c@harness-x");
    expect(answer.routes[0]?.placedBy).toBe("policy");
    expect(answer.routes[0]?.floor).toBe("skipped");
  });

  test("policy placement does not duplicate a route that the rank step also cleared", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal" }, { registry: loaded });
    expectValidAnswer(answer);
    // policy-a places model-c; rank has model-c in clearing too. The route must appear once.
    const labels = answer.routes.map((entry) => entry.label);
    expect(labels.filter((label) => label === "model-c@harness-x")).toHaveLength(1);
  });
});

describe("rank with a known task uses cost-first clearing order", () => {
  test("a known task without floors ranks clearing routes by cost first, not capability first", async () => {
    const { writeJson, withTempDir } = await import("./helpers.js");
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        router: { rank: ["coding"] },
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: {
              low: { coding: 6 },
              normal: { coding: 7 },
              high: { coding: 8 },
            },
            rank: ["coding"],
          },
        },
        models: {
          "model-x": {
            family: "family-x",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-x", hosted: true, cost: 8 }],
          },
          "model-y": {
            family: "family-y",
            ratings: { coding: 9 },
            routes: [{ harness: "harness-x", modelId: "model-id-y", hosted: true, cost: 5 }],
          },
        },
      });
      const { loadRegistry } = await import("@dungle-scrubs/model-registry");
      const loaded = loadRegistry({ path });
      const answer = rank({ task: "task-a", stakes: "low" }, { registry: loaded });
      expectValidAnswer(answer);
      // Cost is a rating where higher means cheaper, so clearing order is
      // cost descending: model-x (cost 8) before model-y (cost 5), against
      // model-y's higher coding rating.
      expect(answer.routes.map((entry) => entry.label)).toEqual([
        "model-x@harness-x",
        "model-y@harness-x",
      ]);
    });
  });
});

describe("registry section validation for tasks and policy", () => {
  test("two policies that tie, a policy effort above the model's maxEffort, an undeclared label and an unknown field fail together", () => {
    const loaded = policyBroken();
    expect(() => rank({ task: "task-a" }, { registry: loaded })).toThrowError(RouterError);
    try {
      rank({ task: "task-a" }, { registry: loaded });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      const routerError = error as RouterError;
      expect(routerError.code).toBe("registry-sections-invalid");
      const codes = routerError.problems.map((problem) => problem.code);
      expect(codes).toContain("policy-tie");
      expect(codes).toContain("policy-route-effort-above-max");
      expect(codes).toContain("policy-route-label-unknown");
      expect(codes).toContain("tasks-field-unknown");
      expect(codes).toContain("policy-field-unknown");
      expect(routerError.message).toBe(
        `the router section has ${routerError.problems.length} problems`,
      );
    }
  });
});

describe("listTasks", () => {
  test("lists each task as { name, description } in file order", () => {
    const loaded = tasks();
    expect(listTasks({ registry: loaded })).toEqual([
      { name: "task-a", description: "Write or change code to a stated spec." },
      { name: "task-b", description: "Browse the web and gather references." },
    ]);
  });

  test("returns an empty list when the registry has no tasks section", () => {
    const loaded = loadLoaded(EMPTY);
    expect(listTasks({ registry: loaded })).toEqual([]);
  });

  test("throws registry-sections-invalid on the same problems as rank", () => {
    const loaded = policyBroken();
    expect(() => listTasks({ registry: loaded })).toThrowError(RouterError);
    try {
      listTasks({ registry: loaded });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      const routerError = error as RouterError;
      expect(routerError.code).toBe("registry-sections-invalid");
      const codes = routerError.problems.map((problem) => problem.code);
      expect(codes).toContain("policy-tie");
      expect(codes).toContain("policy-route-effort-above-max");
      expect(codes).toContain("policy-route-label-unknown");
    }
  });
});

describe("rank answers validate against answer.schema.json", () => {
  test("a policy-placed route carries placedBy: policy and floor: skipped", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.routes[0]?.placedBy).toBe("policy");
    expect(answer.routes[0]?.floor).toBe("skipped");
  });
});
