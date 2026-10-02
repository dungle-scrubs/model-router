import { readFileSync } from "node:fs";
import { loadRegistry, RegistryError } from "@dungle-scrubs/model-registry";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { RouterError, rank } from "../src/index.js";
import { expectValidAnswer, fixturePath, sha256Hex, withEnv } from "./helpers.js";

const FULL = fixturePath("full.json");
const SPEED = fixturePath("speed.json");
const MINIMAL = fixturePath("minimal.json");

function full() {
  return loadRegistry({ path: FULL });
}

function labels(answer: ReturnType<typeof rank>): string[] {
  return answer.routes.map((route) => route.label);
}

describe("rank with inline minimums", () => {
  test("answers with the full contract 1 shape, cheapest clearing route first", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer).toEqual({
      availabilityNote: null,
      contract: 1,
      describe: null,
      pin: null,
      query: {
        excludeFamilies: [],
        minimums: { coding: 5 },
        needs: [],
        prefer: "cost",
        privacy: "normal",
        spec: "open",
        stakes: "normal",
      },
      registryDigest: `sha256:${sha256Hex(readFileSync(FULL))}`,
      removed: [],
      routerVersion: packageJson.version,
      routes: [
        {
          availability: "unmetered",
          family: "family-b",
          floor: "clears",
          harness: "harness-x",
          hosted: true,
          label: "model-b@harness-x",
          model: "model-b",
          modelId: "model-id-b1",
          placedBy: "rank",
          reasons: [],
        },
        {
          availability: "unknown",
          family: "family-a",
          floor: "clears",
          harness: "harness-x",
          hosted: false,
          label: "model-a@harness-x",
          meter: "meter-a",
          model: "model-a",
          modelId: "model-id-a1",
          placedBy: "rank",
          reasons: [],
        },
        {
          availability: "unmetered",
          family: "family-a",
          floor: "clears",
          harness: "harness-y",
          hosted: true,
          label: "model-a@harness-y/provider-1",
          model: "model-a",
          modelId: "model-id-a2",
          placedBy: "rank",
          provider: "provider-1",
          reasons: [],
        },
        {
          availability: "unmetered",
          family: "family-b",
          floor: "clears",
          harness: "harness-z",
          hosted: true,
          label: "model-d@harness-z",
          model: "model-d",
          modelId: "model-id-d1",
          placedBy: "rank",
          reasons: [],
        },
        {
          availability: "unmetered",
          family: "family-a",
          floor: "clears",
          harness: "harness-x",
          hosted: false,
          label: "model-c@harness-x",
          model: "model-c",
          modelId: "model-id-c1",
          placedBy: "rank",
          reasons: [],
        },
        {
          availability: "unmetered",
          family: "family-a",
          floor: "below",
          harness: "harness-w",
          hosted: true,
          label: "model-e@harness-w",
          model: "model-e",
          modelId: "model-id-e1",
          placedBy: "rank",
          reasons: [
            {
              code: "floor-not-met",
              field: '$.minimums["coding"]',
              message: 'the model has no value for rating "coding" (floor 5)',
            },
          ],
        },
      ],
      warnings: [],
    });
  });

  test("orders clearing routes by cost, then rank ratings, then file order", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 7 } }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual([
      "model-a@harness-x",
      "model-a@harness-y/provider-1",
      "model-c@harness-x",
      "model-d@harness-z",
      "model-b@harness-x",
      "model-e@harness-w",
    ]);
  });

  test("a minimum exactly at the floor clears it, without a floor reason", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 5 } }, { registry: loaded });
    const boundary = answer.routes.find((route) => route.label === "model-b@harness-x");
    expect(boundary?.floor).toBe("clears");
    expect(boundary?.reasons).toEqual([]);
    const aboveFloor = rank({ minimums: { coding: 7 } }, { registry: loaded });
    const justClears = aboveFloor.routes.find((route) => route.label === "model-a@harness-x");
    expect(justClears?.floor).toBe("clears");
    expect(justClears?.reasons).toEqual([]);
  });

  test("routes below a floor come after every clearing route, by rank ratings then cost", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 8 } }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual([
      "model-c@harness-x",
      "model-a@harness-x",
      "model-a@harness-y/provider-1",
      "model-d@harness-z",
      "model-b@harness-x",
      "model-e@harness-w",
    ]);
    for (const route of answer.routes.slice(1)) {
      expect(route.floor).toBe("below");
      expect(route.reasons.map((reason) => reason.code)).toEqual(["floor-not-met"]);
    }
    expect(answer.routes[1]?.reasons[0]?.message).toBe(
      'the model\'s rating for "coding" is 7, below the floor 8',
    );
  });

  test("a model with no value for a floor rating counts as below that floor", () => {
    const loaded = full();
    const answer = rank({ minimums: { taste: 1 } }, { registry: loaded });
    const noTaste = answer.routes.find((route) => route.label === "model-d@harness-z");
    expect(noTaste?.floor).toBe("below");
    expect(noTaste?.reasons[0]?.message).toBe(
      'the model has no value for rating "taste" (floor 1)',
    );
  });

  test("a route with no cost sorts below every clearing route that has one", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 6 } }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual([
      "model-a@harness-x",
      "model-a@harness-y/provider-1",
      "model-d@harness-z",
      "model-c@harness-x",
      "model-b@harness-x",
      "model-e@harness-w",
    ]);
    expect(answer.routes[3]?.floor).toBe("clears");
  });
});

describe("rank for a task this release does not rank", () => {
  const capabilityOrder = [
    "model-c@harness-x",
    "model-a@harness-x",
    "model-a@harness-y/provider-1",
    "model-d@harness-z",
    "model-b@harness-x",
    "model-e@harness-w",
  ];

  test("a query naming a task orders every route by router.rank", () => {
    const loaded = full();
    const answer = rank({ task: "ghost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual(capabilityOrder);
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["task-unranked"]);
    expect(answer.warnings[0]?.message).toBe(
      'the task "ghost" was not ranked; this release ranks by router.rank only',
    );
    expect(answer.query.task).toBe("ghost");
  });

  test("a model with no rank rating sorts below every route that has it", () => {
    const loaded = full();
    const answer = rank({ task: "ghost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer).at(-1)).toBe("model-e@harness-w");
  });
});

describe("rank with an explicitly empty floor set", () => {
  test("minimums {} states no floor and orders every route by the clearing order, cost first", () => {
    const loaded = full();
    const answer = rank({ minimums: {} }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual([
      "model-b@harness-x",
      "model-a@harness-x",
      "model-e@harness-w",
      "model-a@harness-y/provider-1",
      "model-d@harness-z",
      "model-c@harness-x",
    ]);
    expect(answer.warnings).toEqual([]);
    for (const route of answer.routes) {
      expect(route.floor).toBe("clears");
    }
  });

  test("a task alongside an empty floor set still ranks most capable first", () => {
    const loaded = full();
    const answer = rank({ task: "ghost", minimums: {} }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)[0]).toBe("model-c@harness-x");
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["task-unranked"]);
  });
});

describe("rank under prefer: speed", () => {
  test("clearing routes sort by response time first, then the cost order", () => {
    const loaded = loadRegistry({ path: SPEED });
    const answer = rank({ minimums: { coding: 5 }, prefer: "speed" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual([
      "fast@harness-x",
      "medium@harness-x",
      "slow@harness-x",
      "no-speed@harness-x",
    ]);
  });

  test("a route with no responseSeconds sorts below every route that has one", () => {
    const loaded = loadRegistry({ path: SPEED });
    const answer = rank({ minimums: { coding: 5 }, prefer: "speed" }, { registry: loaded });
    expect(labels(answer).at(-1)).toBe("no-speed@harness-x");
  });

  test("under prefer: cost the response times are ignored and cost decides", () => {
    const loaded = loadRegistry({ path: SPEED });
    const answer = rank({ minimums: { coding: 5 }, prefer: "cost" }, { registry: loaded });
    expect(labels(answer)).toEqual([
      "slow@harness-x",
      "fast@harness-x",
      "medium@harness-x",
      "no-speed@harness-x",
    ]);
  });

  test("under prefer: speed with no floors, response time leads and missing times fall back to cost", () => {
    const loaded = full();
    const answer = rank({ minimums: {}, prefer: "speed" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual([
      "model-b@harness-x",
      "model-a@harness-x",
      "model-e@harness-w",
      "model-a@harness-y/provider-1",
      "model-d@harness-z",
      "model-c@harness-x",
    ]);
  });
});

describe("rank tie-breaking on the ties fixture", () => {
  test("rank ties fall through to cost, and missing values sort below", () => {
    const loaded = loadRegistry({ path: fixturePath("ties.json") });
    const answer = rank({ task: "ghost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["task-unranked"]);
    expect(labels(answer)).toEqual([
      "model-q@harness-q",
      "model-s@harness-s",
      "model-r@harness-r",
      "model-p@harness-p",
    ]);
  });
});

describe("rank hard limits", () => {
  test("privacy: secret keeps only privacyEligible routes", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 5 }, privacy: "secret" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual(["model-a@harness-x", "model-c@harness-x"]);
    expect(answer.removed.map((entry) => entry.label)).toEqual([
      "model-a@harness-y/provider-1",
      "model-b@harness-x",
      "model-d@harness-z",
      "model-e@harness-w",
    ]);
    for (const entry of answer.removed) {
      expect(entry.reason.code).toBe("privacy-secret-not-eligible");
      expect(entry.reason.message).toBe(
        "privacy: secret material never goes to a route that is not privacyEligible",
      );
    }
  });

  test("privacy: secret with nothing left keeps the answer and adds the local-or-nothing warning", () => {
    const loaded = loadRegistry({ path: MINIMAL });
    const answer = rank({ minimums: { coding: 5 }, privacy: "secret" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.removed.map((entry) => entry.label)).toEqual(["model-a@harness-x"]);
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["local-or-nothing"]);
    expect(answer.warnings[0]?.message).toContain("runs locally or not at all");
    expect(answer.warnings[0]?.fix).toBe(
      "Either run the work locally, or do not do this work on this machine.",
    );
  });

  test("excludeFamilies removes every route of a listed family", () => {
    const loaded = full();
    const answer = rank(
      { minimums: { coding: 5 }, excludeFamilies: ["family-b"] },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual([
      "model-a@harness-x",
      "model-a@harness-y/provider-1",
      "model-c@harness-x",
      "model-e@harness-w",
    ]);
    for (const entry of answer.removed) {
      expect(entry.reason.code).toBe("family-excluded-by-query");
    }
  });

  test("an unknown family excludes nothing, with a warning", () => {
    const loaded = full();
    const answer = rank(
      { minimums: { coding: 5 }, excludeFamilies: ["family-z"] },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(answer.removed).toEqual([]);
    expect(answer.routes).toHaveLength(6);
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["family-unknown"]);
    expect(answer.warnings[0]?.message).toBe(
      'the family "family-z" is not in the registry; it excludes nothing',
    );
  });

  test("needs removes every route that lacks a needed capability", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 5 }, needs: ["repo-access"] }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual(["model-a@harness-y/provider-1"]);
    expect(answer.removed).toHaveLength(5);
    const missing = answer.removed.find((entry) => entry.label === "model-b@harness-x");
    expect(missing?.reason.code).toBe("needs-not-satisfied");
    expect(missing?.reason.message).toBe(
      "the route does not list every capability the query needs: repo-access",
    );
  });

  test("a need naming an undeclared capability removes every route, with a warning", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 5 }, needs: ["telepathy"] }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.removed).toHaveLength(6);
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["capability-unknown"]);
    expect(answer.warnings[0]?.message).toBe(
      'the need "telepathy" names a capability the registry does not declare; every route lacking it is removed',
    );
  });

  test("the first hard limit a route fails names its removal", () => {
    const loaded = full();
    const answer = rank(
      {
        excludeFamilies: ["family-a", "family-b"],
        minimums: { coding: 5 },
        needs: ["repo-access"],
        privacy: "secret",
      },
      { registry: loaded },
    );
    const a1 = answer.removed.find((entry) => entry.label === "model-a@harness-x");
    expect(a1?.reason.code).toBe("family-excluded-by-query");
    const a2 = answer.removed.find((entry) => entry.label === "model-a@harness-y/provider-1");
    expect(a2?.reason.code).toBe("privacy-secret-not-eligible");
    const b1 = answer.removed.find((entry) => entry.label === "model-b@harness-x");
    expect(b1?.reason.code).toBe("privacy-secret-not-eligible");
  });
});

describe("rank warnings for fields this slice does not apply", () => {
  test("a query naming effort, pin and settled spec warns for each, in order", () => {
    const loaded = full();
    const answer = rank(
      {
        effort: "high",
        minimums: { coding: 5 },
        pin: "model-a@harness-x",
        spec: "settled",
      },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(answer.warnings).toEqual([
      {
        code: "effort-unapplied",
        message:
          'the query effort "high" was not applied; this release does not resolve effort levels',
        fix: "Remove effort from the query; effort resolution arrives in a later release.",
      },
      {
        code: "pin-unapplied",
        message: 'the pin "model-a@harness-x" was not used; this release does not place pins',
        fix: "Remove pin from the query; pins arrive in a later release.",
      },
      {
        code: "policy-none",
        message: 'the spec "settled" matched no policy; normal ranking was used',
        fix: "Remove spec from the query, or add a matching policy when policies ship.",
      },
    ]);
    expect(answer.pin).toBeNull();
    expect(answer.query.effort).toBe("high");
    expect(answer.query.pin).toBe("model-a@harness-x");
    expect(answer.query.spec).toBe("settled");
  });

  test("a minimum naming an undeclared rating warns and makes every route below", () => {
    const loaded = full();
    const answer = rank({ minimums: { vibes: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["rating-unknown"]);
    expect(answer.warnings[0]?.message).toBe(
      'the minimum "vibes" names a rating the registry does not declare; every route counts as below that floor',
    );
    for (const route of answer.routes) {
      expect(route.floor).toBe("below");
    }
    expect(labels(answer)).toEqual([
      "model-c@harness-x",
      "model-a@harness-x",
      "model-a@harness-y/provider-1",
      "model-d@harness-z",
      "model-b@harness-x",
      "model-e@harness-w",
    ]);
  });

  test("a task alongside minimums still warns that the task was not ranked", () => {
    const loaded = full();
    const answer = rank({ task: "implement", minimums: { coding: 5 } }, { registry: loaded });
    expect(answer.warnings).toEqual([
      {
        code: "task-unranked",
        message: 'the task "implement" was not ranked; this release ranks by router.rank only',
        fix: "State minimums for inline floors; ranking by task arrives in a later release.",
      },
    ]);
    expect(labels(answer)).toEqual(
      rank({ minimums: { coding: 5 } }, { registry: loaded }).routes.map((route) => route.label),
    );
  });

  test("every removal reason carries its full coded shape", () => {
    const loaded = full();
    const privacy = rank({ minimums: { coding: 5 }, privacy: "secret" }, { registry: loaded });
    expect(privacy.removed[0]).toEqual({
      label: "model-a@harness-y/provider-1",
      reason: {
        code: "privacy-secret-not-eligible",
        fix: "Mark the route's privacyEligible field true, or run the work without privacy: secret.",
        message: "privacy: secret material never goes to a route that is not privacyEligible",
      },
    });

    const family = rank(
      { minimums: { coding: 5 }, excludeFamilies: ["family-a"] },
      { registry: loaded },
    );
    expect(family.removed[0]).toEqual({
      label: "model-a@harness-x",
      reason: {
        code: "family-excluded-by-query",
        fix: "Remove the family from excludeFamilies, or change the route's family.",
        message: "the route's family is in the query's excludeFamilies",
        field: '$.excludeFamilies["family-a"]',
      },
    });

    const needs = rank({ minimums: { coding: 5 }, needs: ["repo-access"] }, { registry: loaded });
    expect(needs.removed[0]).toEqual({
      label: "model-a@harness-x",
      reason: {
        code: "needs-not-satisfied",
        fix: "Add the missing capabilities to the route, or remove them from needs.",
        message: "the route does not list every capability the query needs: repo-access",
        field: '$.needs["repo-access"]',
      },
    });
  });

  test("the family-unknown and capability-unknown warnings carry their fixes", () => {
    const loaded = full();
    const answer = rank(
      {
        excludeFamilies: ["family-z"],
        minimums: { coding: 5 },
        needs: ["telepathy"],
      },
      { registry: loaded },
    );
    expect(answer.warnings).toEqual([
      {
        code: "capability-unknown",
        field: '$.needs["telepathy"]',
        message:
          'the need "telepathy" names a capability the registry does not declare; every route lacking it is removed',
        fix: 'Declare "telepathy" in the registry\'s capabilities section, or remove it from needs.',
      },
      {
        code: "family-unknown",
        field: '$.excludeFamilies["family-z"]',
        message: 'the family "family-z" is not in the registry; it excludes nothing',
        fix: "Name a family the registry declares, or remove it from excludeFamilies.",
      },
    ]);
  });

  test("the rating-unknown warning carries its fix and field", () => {
    const loaded = full();
    const answer = rank({ minimums: { vibes: 5 } }, { registry: loaded });
    expect(answer.warnings).toEqual([
      {
        code: "rating-unknown",
        field: '$.minimums["vibes"]',
        message:
          'the minimum "vibes" names a rating the registry does not declare; every route counts as below that floor',
        fix: 'Declare "vibes" in the registry\'s ratings section, or remove it from minimums.',
      },
    ]);
  });

  test("the answered query reports what was applied, deduplicated", () => {
    const loaded = full();
    const answer = rank(
      {
        excludeFamilies: ["family-b", "family-b"],
        minimums: { coding: 5 },
        needs: ["browser", "browser"],
        task: "implement",
      },
      { registry: loaded },
    );
    expect(answer.query).toEqual({
      excludeFamilies: ["family-b"],
      minimums: { coding: 5 },
      needs: ["browser"],
      prefer: "cost",
      privacy: "normal",
      spec: "open",
      stakes: "normal",
      task: "implement",
    });
  });
});

describe("rank registry input", () => {
  test("a path string loads the registry", () => {
    const answer = rank({ minimums: { coding: 5 } }, { registry: FULL });
    expectValidAnswer(answer);
    expect(answer.registryDigest).toBe(`sha256:${sha256Hex(readFileSync(FULL))}`);
  });

  test("a loaded registry is used as-is, so the digest is the loader's", () => {
    const loaded = full();
    const answer = rank({ minimums: { coding: 5 } }, { registry: loaded });
    expect(answer.registryDigest).toBe(loaded.digest);
  });

  test("without an option the loader's path order applies", async () => {
    await withEnv({ MODEL_REGISTRY_FILE: FULL }, () => {
      const answer = rank({ minimums: { coding: 5 } });
      expect(answer.registryDigest).toBe(`sha256:${sha256Hex(readFileSync(FULL))}`);
    });
  });

  test("a loader failure rethrows the RegistryError unchanged", () => {
    try {
      rank({ minimums: { coding: 5 } }, { registry: "/nonexistent/nope.json" });
      throw new Error("expected rank to rethrow");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      const registryError = error as RegistryError;
      expect(registryError.code).toBe("registry-missing");
      expect(registryError.path).toBe("/nonexistent/nope.json");
    }
  });

  test("a bad router section fails before an invalid query is read", () => {
    try {
      rank({ total: "nonsense" }, { registry: fixturePath("no-router.json") });
      throw new Error("expected rank to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("registry-sections-invalid");
    }
  });

  test("an invalid query fails with query-invalid after the registry loads", () => {
    try {
      rank({ total: "nonsense" }, { registry: FULL });
      throw new Error("expected rank to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("query-invalid");
    }
  });

  test("the same registry and query rank identically twice", () => {
    const loaded = full();
    const first = rank({ minimums: { coding: 5 }, prefer: "speed" }, { registry: loaded });
    const second = rank({ minimums: { coding: 5 }, prefer: "speed" }, { registry: loaded });
    expect(second).toEqual(first);
  });

  test("a registry with no routes is an answer, not an error", () => {
    const answer = rank({ minimums: {} }, { registry: fixturePath("empty-models.json") });
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.warnings).toEqual([]);
  });
});
