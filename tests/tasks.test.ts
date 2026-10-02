import { describe, expect, test } from "vitest";
import { listTasks, RouterError, rank } from "../src/index.js";
import { expectValidAnswer, fixturePath, loadLoaded } from "./helpers.js";

const TASKS = fixturePath("tasks.json");
const EMPTY = fixturePath("empty-models.json");
const POLICY_BROKEN = fixturePath("policy-broken.json");

const tasks = () => loadLoaded(TASKS);
const policyBroken = () => loadLoaded(POLICY_BROKEN);

describe("rank with a known task", () => {
  test("a task query at each stakes level uses that level's floors", () => {
    const loaded = tasks();
    const low = rank({ task: "task-a", stakes: "low" }, { registry: loaded });
    expectValidAnswer(low);
    // task.minimums.low requires coding >= 6.
    // model-a coding=7 (clears, no repo), model-b coding=7 (clears, no repo), model-c coding=8 (clears, repo yes)
    // policy-a places model-b (rejected by hard limit) and model-c (placed).
    expect(
      low.removed
        .filter((entry) => entry.reason.code === "policy-route-removed")
        .map((entry) => entry.label),
    ).toEqual(["model-b@harness-x"]);
    expect(low.routes.map((entry) => entry.label)).toEqual(["model-c@harness-x"]);

    const high = rank({ task: "task-a", stakes: "high" }, { registry: loaded });
    expectValidAnswer(high);
    // task.minimums.high requires coding >= 8.
    // model-c (8 >= 8) is the only candidate.
    expect(
      high.removed
        .filter((entry) => entry.reason.code === "policy-route-removed")
        .map((entry) => entry.label),
    ).toEqual(["model-b@harness-x"]);
    expect(high.routes.map((entry) => entry.label)).toEqual(["model-c@harness-x"]);
  });

  test("a task query with inline minimums replaces the task floor per rating", () => {
    const loaded = tasks();
    const answer = rank(
      { task: "task-a", stakes: "normal", minimums: { coding: 9 } },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    // Inline coding=9 replaces task's coding=7 at normal stakes. No model clears.
    // policy-a still places model-c with floor=skipped.
    expect(answer.routes.map((entry) => entry.label)).toEqual(["model-c@harness-x"]);
    expect(answer.routes[0]?.floor).toBe("skipped");
    expect(answer.routes[0]?.placedBy).toBe("policy");
  });

  test("inline needs add to the task's needs", () => {
    const loaded = tasks();
    const answer = rank(
      { task: "task-a", stakes: "normal", needs: ["browser"] },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    // task.needs=repo-access, plus inline needs=browser.
    // No model has both: model-c has repo-access but not browser.
    expect(answer.routes).toEqual([]);
    expect(answer.removed.map((entry) => entry.reason.code)).toEqual(
      expect.arrayContaining(["needs-not-satisfied", "policy-route-removed"]),
    );
  });

  test("inline effort replaces the task's effort on the applied query", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal", effort: "low" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.query.effort).toBe("low");
    expect(answer.warnings.map((entry) => entry.code)).not.toContain("effort-unapplied");
  });
});

describe("rank with a misspelled task", () => {
  test("an unknown task ranks by router.rank with a warning naming the task", () => {
    const loaded = tasks();
    const answer = rank({ task: "ghost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.warnings.map((entry) => entry.code)).toEqual(["task-unranked"]);
    expect(answer.warnings[0]?.message).toBe(
      'the task "ghost" was not ranked; this release ranks by router.rank only',
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
  test("a policy route that a hard limit removed lands in removed with a policy warning", () => {
    const loaded = tasks();
    const answer = rank({ task: "task-a", stakes: "normal" }, { registry: loaded });
    expectValidAnswer(answer);
    // policy-a has routes [model-b@harness-x, model-c@harness-x].
    // model-b lacks repo-access; policy route is removed with policy-route-removed code.
    const removedPolicy = answer.removed.filter(
      (entry) => entry.reason.code === "policy-route-removed",
    );
    expect(removedPolicy.map((entry) => entry.label)).toEqual(["model-b@harness-x"]);
    expect(removedPolicy[0]?.reason.field).toBe('$.policy["policy-a"].routes');
    expect(removedPolicy[0]?.reason.message).toContain("policy-a");
    expect(removedPolicy[0]?.reason.message).toContain("model-b@harness-x");
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
