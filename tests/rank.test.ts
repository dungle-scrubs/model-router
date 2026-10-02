import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRegistry, RegistryError } from "@dungle-scrubs/model-registry";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { RouterError, rank } from "../src/index.js";
import {
  expectValidAnswer,
  fixturePath,
  sha256Hex,
  withEnv,
  withTempDir,
  writeJson,
} from "./helpers.js";

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
          effort: "medium",
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
          effort: "medium",
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
          effort: "medium",
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
          effort: "medium",
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
          effort: "medium",
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
          effort: "medium",
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
    expectValidAnswer(answer);
    const boundary = answer.routes.find((route) => route.label === "model-b@harness-x");
    expect(boundary?.floor).toBe("clears");
    expect(boundary?.reasons).toEqual([]);
    const aboveFloor = rank({ minimums: { coding: 7 } }, { registry: loaded });
    expectValidAnswer(aboveFloor);
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
    expectValidAnswer(answer);
    const noTaste = answer.routes.find((route) => route.label === "model-d@harness-z");
    expect(noTaste?.floor).toBe("below");
    expect(noTaste?.reasons[0]?.message).toBe(
      'the model has no value for rating "taste" (floor 1)',
    );
  });

  test("a model whose rating exactly meets one floor but misses another has one reason, not two", () => {
    const loaded = full();
    // model-b has coding=5 and taste=4. Floor coding=5 (meets) and taste=5 (misses).
    // Below-floor reasons: only taste, not coding.
    const answer = rank({ minimums: { coding: 5, taste: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    const boundary = answer.routes.find((route) => route.label === "model-b@harness-x");
    expect(boundary?.floor).toBe("below");
    expect(boundary?.reasons).toEqual([
      {
        code: "floor-not-met",
        field: '$.minimums["taste"]',
        message: 'the model\'s rating for "taste" is 4, below the floor 5',
      },
    ]);
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
      'the task "ghost" is not declared in the registry\'s tasks section; ranking by router.rank',
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
      "tied-speed@harness-x",
      "medium@harness-x",
      "slow@harness-x",
      "no-speed@harness-x",
    ]);
  });

  test("an equal response time is decided by cost, against file order", () => {
    const loaded = loadRegistry({ path: SPEED });
    const answer = rank({ minimums: { coding: 5 }, prefer: "speed" }, { registry: loaded });
    expectValidAnswer(answer);
    const order = labels(answer);
    expect(order.indexOf("tied-speed@harness-x")).toBeLessThan(order.indexOf("medium@harness-x"));
    expect(order).toEqual([
      "fast@harness-x",
      "tied-speed@harness-x",
      "medium@harness-x",
      "slow@harness-x",
      "no-speed@harness-x",
    ]);
  });

  test("a route with no responseSeconds sorts below every route that has one", () => {
    const loaded = loadRegistry({ path: SPEED });
    const answer = rank({ minimums: { coding: 5 }, prefer: "speed" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer).at(-1)).toBe("no-speed@harness-x");
  });

  test("under prefer: cost the response times are ignored and cost decides", () => {
    const loaded = loadRegistry({ path: SPEED });
    const answer = rank({ minimums: { coding: 5 }, prefer: "cost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual([
      "slow@harness-x",
      "tied-speed@harness-x",
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
  test("the second rank rating, then cost, decide ties against file order", () => {
    const loaded = loadRegistry({ path: fixturePath("ties.json") });
    const answer = rank({ task: "ghost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["task-unranked"]);
    expect(labels(answer)).toEqual([
      "model-u@harness-u",
      "model-q@harness-q",
      "model-s@harness-s",
      "model-r@harness-r",
      "model-p@harness-p",
    ]);
  });
});

describe("rank tie-breaking on the model's route order", () => {
  const ROUTES = fixturePath("routes.json");
  const tiedOrder = ["model-a@harness-x", "model-b@harness-z", "model-a@harness-y"];

  test("routes tied on ratings and cost order by the route's place in its model, then file order", () => {
    const loaded = loadRegistry({ path: ROUTES });
    const answer = rank({ minimums: { coding: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual(tiedOrder);
  });

  test("the same route order decides ties under an unknown task", () => {
    const loaded = loadRegistry({ path: ROUTES });
    const answer = rank({ task: "ghost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual(tiedOrder);
  });

  test("routes below a floor keep the same route-order tie-break", () => {
    const loaded = loadRegistry({ path: ROUTES });
    const answer = rank({ minimums: { coding: 9 } }, { registry: loaded });
    expectValidAnswer(answer);
    for (const route of answer.routes) {
      expect(route.floor).toBe("below");
    }
    expect(labels(answer)).toEqual(tiedOrder);
  });

  test("an equal response time under prefer: speed falls through to the same route order", () => {
    const loaded = loadRegistry({ path: ROUTES });
    const answer = rank({ minimums: { coding: 5 }, prefer: "speed" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual(tiedOrder);
  });
});

describe("rank reads only the model's own rating entries", () => {
  const OWN_PROPS = fixturePath("own-props.json");

  test("a declared rating named constructor, missing from a model, counts as below its floor", () => {
    const loaded = loadRegistry({ path: OWN_PROPS });
    const answer = rank({ minimums: { constructor: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    const below = answer.routes.find((route) => route.label === "model-n@harness-x");
    expect(below?.floor).toBe("below");
    expect(below?.reasons).toEqual([
      {
        code: "floor-not-met",
        field: '$.minimums["constructor"]',
        message: 'the model has no value for rating "constructor" (floor 5)',
      },
    ]);
    const clears = answer.routes.find((route) => route.label === "model-o@harness-x");
    expect(clears?.floor).toBe("clears");
    expect(clears?.reasons).toEqual([]);
  });

  test("a rank rating named constructor, missing from a model, sorts that model below", () => {
    const loaded = loadRegistry({ path: OWN_PROPS });
    const answer = rank({ task: "ghost" }, { registry: loaded });
    expectValidAnswer(answer);
    expect(labels(answer)).toEqual(["model-o@harness-x", "model-m@harness-x", "model-n@harness-x"]);
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
    expectValidAnswer(answer);
    const a1 = answer.removed.find((entry) => entry.label === "model-a@harness-x");
    expect(a1?.reason.code).toBe("family-excluded-by-query");
    const a2 = answer.removed.find((entry) => entry.label === "model-a@harness-y/provider-1");
    expect(a2?.reason.code).toBe("privacy-secret-not-eligible");
    const b1 = answer.removed.find((entry) => entry.label === "model-b@harness-x");
    expect(b1?.reason.code).toBe("privacy-secret-not-eligible");
  });
});

describe("rank warnings for fields this slice applies", () => {
  test("a query naming effort, pin and settled spec still warns only for policy-none", () => {
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
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["policy-none"]);
    expect(answer.pin).toEqual({ label: "model-a@harness-x", reason: "", used: true });
    expect(answer.query.effort).toBe("high");
    expect(answer.query.pin).toBe("model-a@harness-x");
    expect(answer.query.spec).toBe("settled");
    // Effort is applied: the pinned route carries the requested effort.
    const pinned = answer.routes[0];
    expect(pinned?.effort).toBe("high");
    expect(pinned?.placedBy).toBe("pin");
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
    expectValidAnswer(answer);
    expect(answer.warnings).toEqual([
      {
        code: "task-unranked",
        message:
          'the task "implement" is not declared in the registry\'s tasks section; ranking by router.rank',
        fix: "Correct the task name, or add the task to the registry's tasks section.",
      },
    ]);
    const inline = rank({ minimums: { coding: 5 } }, { registry: loaded });
    expectValidAnswer(inline);
    expect(labels(answer)).toEqual(inline.routes.map((route) => route.label));
  });

  test("every removal reason carries its full coded shape", () => {
    const loaded = full();
    const privacy = rank({ minimums: { coding: 5 }, privacy: "secret" }, { registry: loaded });
    expectValidAnswer(privacy);
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
    expectValidAnswer(family);
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
    expectValidAnswer(needs);
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
    expectValidAnswer(answer);
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
    expectValidAnswer(answer);
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
    expectValidAnswer(answer);
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
    expectValidAnswer(answer);
    expect(answer.registryDigest).toBe(loaded.digest);
  });

  test("without an option the loader's path order applies", async () => {
    await withEnv({ MODEL_REGISTRY_FILE: FULL }, () => {
      const answer = rank({ minimums: { coding: 5 } });
      expectValidAnswer(answer);
      expect(answer.registryDigest).toBe(`sha256:${sha256Hex(readFileSync(FULL))}`);
    });
  });

  test("a loader failure rethrows the RegistryError unchanged", async () => {
    await withTempDir(async (dir) => {
      const missing = resolve(dir, "nonexistent", "nope.json");
      try {
        rank({ minimums: { coding: 5 } }, { registry: missing });
        throw new Error("expected rank to rethrow");
      } catch (error) {
        expect(error).toBeInstanceOf(RegistryError);
        const registryError = error as RegistryError;
        expect(registryError.code).toBe("registry-missing");
        expect(registryError.path).toBe(missing);
      }
    });
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
    expectValidAnswer(first);
    const second = rank({ minimums: { coding: 5 }, prefer: "speed" }, { registry: loaded });
    expectValidAnswer(second);
    expect(second).toEqual(first);
  });

  test("a registry with no routes is an answer, not an error", () => {
    const answer = rank({ minimums: {} }, { registry: fixturePath("empty-models.json") });
    expectValidAnswer(answer);
    expect(answer.routes).toEqual([]);
    expect(answer.warnings).toEqual([]);
  });
});

describe("rank places the pin first", () => {
  test("a used pin goes first with placedBy: pin and floor: skipped", () => {
    const loaded = full();
    const answer = rank(
      { minimums: { coding: 5 }, pin: "model-a@harness-x" },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(answer.pin).toEqual({ label: "model-a@harness-x", reason: "", used: true });
    expect(answer.routes[0]).toMatchObject({
      floor: "skipped",
      label: "model-a@harness-x",
      placedBy: "pin",
    });
    // The pinned route is filtered out of the ranked list so it does not
    // appear twice.
    const labels = answer.routes.map((route) => route.label);
    expect(labels.filter((label) => label === "model-a@harness-x")).toHaveLength(1);
  });

  test("a pin against an unknown label falls through to the fallback ranking with a reason", () => {
    const loaded = full();
    const answer = rank(
      { minimums: { coding: 5 }, pin: "model-z@harness-x" },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(answer.pin).toEqual({
      label: "model-z@harness-x",
      reason: "unknown-label",
      used: false,
    });
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["pin-unknown"]);
    // The fallback ranking is the full registry ranking: every surviving
    // route appears, none carries placedBy: pin.
    expect(answer.routes.every((route) => route.placedBy !== "pin")).toBe(true);
  });

  test("a pin against a hard-limit-removed route keeps the hard-limit code as the reason", () => {
    const loaded = full();
    // needs=telepathy removes every route. The pin's reason is the loader's
    // hard-limit code so the caller can tell which rule rejected it.
    const answer = rank(
      {
        minimums: { coding: 5 },
        needs: ["telepathy"],
        pin: "model-a@harness-x",
      },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(answer.pin).toEqual({
      label: "model-a@harness-x",
      reason: "needs-not-satisfied",
      used: false,
    });
    expect(answer.warnings.map((warning) => warning.code)).toEqual([
      "capability-unknown",
      "pin-unused",
    ]);
    expect(answer.routes).toEqual([]);
  });

  test("a pin under privacy: secret keeps only privacyEligible routes and pins the surviving one", () => {
    const loaded = full();
    const answer = rank(
      {
        minimums: { coding: 5 },
        pin: "model-a@harness-x",
        privacy: "secret",
      },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(answer.pin?.used).toBe(true);
    expect(answer.routes[0]?.label).toBe("model-a@harness-x");
    expect(answer.routes[0]?.placedBy).toBe("pin");
  });

  test("a pin that fails privacy: secret reports privacy-secret-not-eligible", () => {
    const loaded = full();
    // model-b@harness-x is not privacyEligible; the pin lands on the
    // privacy-secret-not-eligible hard-limit reason.
    const answer = rank(
      {
        minimums: { coding: 5 },
        pin: "model-b@harness-x",
        privacy: "secret",
      },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    expect(answer.pin).toEqual({
      label: "model-b@harness-x",
      reason: "privacy-secret-not-eligible",
      used: false,
    });
  });

  test("a pin and a policy together: the pin leads the policy routes", async () => {
    // Build a registry where the pin's route survives the hard limits and
    // the policy's routes survive, so both placements happen in order.
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        capabilities: { "repo-access": "Can read and change files in the workspace." },
        router: { rank: ["coding"] },
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 5 }, normal: { coding: 5 }, high: { coding: 5 } },
            rank: ["coding"],
            needs: ["repo-access"],
          },
        },
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low", "normal", "high"],
            routes: [{ route: "model-b@harness-x" }, { route: "model-c@harness-x" }],
            reason: "Cheap code routes run first.",
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [
              {
                harness: "harness-x",
                modelId: "model-id-a",
                hosted: true,
                capabilities: ["repo-access"],
              },
            ],
          },
          "model-b": {
            family: "family-b",
            ratings: { coding: 6 },
            routes: [
              {
                harness: "harness-x",
                modelId: "model-id-b",
                hosted: true,
                capabilities: ["repo-access"],
              },
            ],
          },
          "model-c": {
            family: "family-c",
            ratings: { coding: 6 },
            routes: [
              {
                harness: "harness-x",
                modelId: "model-id-c",
                hosted: true,
                capabilities: ["repo-access"],
              },
            ],
          },
        },
      });
      const answer = rank(
        {
          minimums: { coding: 5 },
          pin: "model-a@harness-x",
          stakes: "normal",
          task: "task-a",
        },
        { registry: path },
      );
      expectValidAnswer(answer);
      expect(answer.pin?.used).toBe(true);
      expect(answer.routes[0]?.placedBy).toBe("pin");
      expect(answer.routes[0]?.label).toBe("model-a@harness-x");
      expect(answer.routes[1]?.placedBy).toBe("policy");
      expect(answer.routes[1]?.label).toBe("model-b@harness-x");
    });
  });

  test("the pin's pinned route is dropped from the ranked list, not duplicated", () => {
    const loaded = full();
    const answer = rank(
      { minimums: { coding: 5 }, pin: "model-c@harness-x" },
      { registry: loaded },
    );
    expectValidAnswer(answer);
    const labels = answer.routes.map((route) => route.label);
    // model-c clears the floor at coding 5, so it would normally appear in
    // the rank output. With the pin, the rank output drops it and only the
    // pin route remains for that label.
    expect(labels.filter((label) => label === "model-c@harness-x")).toHaveLength(1);
    expect(answer.routes[0]?.placedBy).toBe("pin");
    expect(answer.routes[0]?.label).toBe("model-c@harness-x");
  });
});

describe("rank resolves effort", () => {
  test("an off-ladder query effort is reported and the default applies", () => {
    const loaded = full();
    const answer = rank({ effort: "warp-nine", minimums: { coding: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.warnings.map((warning) => warning.code)).toEqual(["effort-off-ladder"]);
    expect(answer.warnings[0]?.message).toContain("warp-nine");
    // The configured default (medium) is the level every route carries.
    for (const route of answer.routes) {
      expect(route.effort).toBe("medium");
    }
  });

  test("a query effort on the ladder wins over the config default", () => {
    const loaded = full();
    const answer = rank({ effort: "high", minimums: { coding: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    expect(answer.warnings).toEqual([]);
    for (const route of answer.routes) {
      expect(route.effort).toBe("high");
    }
  });

  test("a query's effort wins over the task's effort", async () => {
    // The RFC names the order policy > query > task > default. The query
    // sits between the policy route and the task, so a query effort is
    // requested first.
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        router: { rank: ["coding"] },
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 5 }, normal: { coding: 5 }, high: { coding: 5 } },
            rank: ["coding"],
            effort: "high",
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      });
      const answer = rank(
        { effort: "low", minimums: { coding: 5 }, task: "task-a" },
        { registry: path },
      );
      expectValidAnswer(answer);
      // The query's effort "low" wins over the task's "high", so the route
      // carries "low".
      const routeA = answer.routes.find((route) => route.label === "model-a@harness-x");
      expect(routeA?.effort).toBe("low");
      expect(answer.query.effort).toBe("low");
    });
  });

  test("a task's effort applies when the query omits effort", async () => {
    // With no query effort, the task's effort is the request.
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        router: { rank: ["coding"] },
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 5 }, normal: { coding: 5 }, high: { coding: 5 } },
            rank: ["coding"],
            effort: "high",
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      });
      const answer = rank({ minimums: { coding: 5 }, task: "task-a" }, { registry: path });
      expectValidAnswer(answer);
      const routeA = answer.routes.find((route) => route.label === "model-a@harness-x");
      expect(routeA?.effort).toBe("high");
    });
  });

  test("a fixedEffort replaces the requested level", async () => {
    // Build a registry with fixedEffort and a request that the fixedEffort
    // overrides, so the test proves the override applies.
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        router: { rank: ["coding"] },
        models: {
          "model-fixed": {
            family: "family-a",
            fixedEffort: "high",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-fixed", hosted: true }],
          },
        },
      });
      const answer = rank({ effort: "low", minimums: { coding: 5 } }, { registry: path });
      expectValidAnswer(answer);
      const fixed = answer.routes.find((route) => route.label === "model-fixed@harness-x");
      expect(fixed?.effort).toBe("high");
    });
  });

  test("a maxEffort caps the requested level with a warning", async () => {
    // A request above the model's maxEffort is lowered, with a warning.
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        router: { rank: ["coding"] },
        models: {
          "model-max": {
            family: "family-a",
            maxEffort: "medium",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-max", hosted: true }],
          },
        },
      });
      const answer = rank({ effort: "high", minimums: { coding: 5 } }, { registry: path });
      expectValidAnswer(answer);
      const maxed = answer.routes.find((route) => route.label === "model-max@harness-x");
      expect(maxed?.effort).toBe("medium");
      expect(answer.warnings.map((warning) => warning.code)).toContain("effort-above-max");
    });
  });

  test("a maxEffort caps the requested level with a warning", () => {
    const loaded = full();
    // model-a in `full` has maxEffort=high; an effort=xhigh request is
    // lowered to high for that route, with one warning.
    const answer = rank({ effort: "xhigh", minimums: { coding: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    const modelA = answer.routes.find((route) => route.label === "model-a@harness-x");
    expect(modelA?.effort).toBe("high");
    expect(answer.warnings.map((warning) => warning.code)).toContain("effort-above-max");
  });

  test("a request above the configured ceiling is capped last, with a warning", () => {
    const loaded = full();
    const answer = rank(
      { effort: "max", minimums: { coding: 5 } },
      { registry: loaded, config: { effort: { ceiling: "high", default: "medium" } } },
    );
    expectValidAnswer(answer);
    for (const route of answer.routes) {
      expect(route.effort).toBe("high");
    }
    // Every route carried a single effort-ceiling warning: no route is
    // pushed to max under the default ceiling.
    expect(answer.routes).toHaveLength(6);
    const ceilingWarnings = answer.warnings.filter((warning) => warning.code === "effort-ceiling");
    expect(ceilingWarnings.length).toBeGreaterThan(0);
  });

  test("the router never emits max under the default ceiling", () => {
    const loaded = full();
    const answer = rank({ effort: "max", minimums: { coding: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    for (const route of answer.routes) {
      expect(route.effort).not.toBe("max");
    }
  });

  test("a policy route's per-route effort overrides the shared request", async () => {
    // Build a fixture where the policy's per-route effort is the only signal
    // for that route's level, so the test proves the override applies.
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Writes and changes code to a spec." },
        router: { rank: ["coding"] },
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 5 }, normal: { coding: 5 }, high: { coding: 5 } },
            rank: ["coding"],
          },
        },
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low", "normal", "high"],
            routes: [{ route: "model-a@harness-x", effort: "low" }],
            reason: "Cheap first.",
          },
        },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [{ harness: "harness-x", modelId: "model-id-a", hosted: true }],
          },
        },
      });
      const answer = rank({ minimums: { coding: 5 }, task: "task-a" }, { registry: path });
      expectValidAnswer(answer);
      const policyRouteA = answer.routes.find(
        (route) => route.label === "model-a@harness-x" && route.placedBy === "policy",
      );
      // The shared request (no effort named) is the config default "medium";
      // the per-route "low" overrides that for this route alone.
      expect(policyRouteA?.effort).toBe("low");
    });
  });

  test("a warning is added for each rule that lowered the level", () => {
    const loaded = full();
    // model-a has maxEffort=high; a request for "xhigh" is first capped to
    // "high" by maxEffort, then a configured ceiling of "medium" caps again,
    // producing two warnings: one effort-above-max and one effort-ceiling.
    const answer = rank(
      { effort: "xhigh", minimums: { coding: 5 } },
      { registry: loaded, config: { effort: { ceiling: "medium", default: "medium" } } },
    );
    expectValidAnswer(answer);
    expect(answer.warnings.map((warning) => warning.code)).toContain("effort-above-max");
    expect(answer.warnings.map((warning) => warning.code)).toContain("effort-ceiling");
    const modelA = answer.routes.find((route) => route.label === "model-a@harness-x");
    expect(modelA?.effort).toBe("medium");
  });
});
