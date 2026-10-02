import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { RouterError } from "../src/error.js";
import { parseQuery } from "../src/query.js";
import { answerSchemaPath, querySchemaPath } from "./helpers.js";

const ajv = new Ajv2020({ allErrors: true, strictNumbers: true });

const digest = "sha256:c17ecff5329da3d1cf52589af2abef9140fb781325396b4c1d0d676822dd2789";

const appliedQuery = {
  excludeFamilies: [],
  minimums: {},
  needs: [],
  prefer: "cost",
  privacy: "normal",
  spec: "open",
  stakes: "normal",
} as const;

const baseAnswer = {
  availabilityNote: null,
  contract: 1,
  describe: null,
  pin: null,
  query: appliedQuery,
  registryDigest: digest,
  removed: [],
  routerVersion: "0.1.0",
  routes: [],
  warnings: [],
} as const;

const baseRoute = {
  availability: "unknown",
  family: "family-a",
  floor: "clears",
  harness: "harness-x",
  hosted: true,
  label: "model-a@harness-x",
  model: "model-a",
  modelId: "model-id-a",
  placedBy: "rank",
  reasons: [],
} as const;

describe("query.schema.json", () => {
  const validate = ajv.compile(JSON.parse(readFileSync(querySchemaPath, "utf8")) as object);

  test("rejects a field the contract does not define", () => {
    const result = validate({ minimums: {}, model: "x" });
    expect(result).toBe(false);
    expect(validate.errors?.some((error) => error.keyword === "additionalProperties")).toBe(true);
  });

  test("rejects a query with neither task nor minimums", () => {
    expect(validate({ privacy: "secret" })).toBe(false);
    expect(validate({})).toBe(false);
  });

  test("rejects a pin without task or minimums", () => {
    expect(validate({ pin: "model-a@harness-x" })).toBe(false);
  });

  test("rejects fixed vocabulary values off the list", () => {
    expect(validate({ minimums: {}, stakes: "urgent" })).toBe(false);
    expect(validate({ minimums: {}, prefer: "quality" })).toBe(false);
    expect(validate({ minimums: {}, privacy: "secrets" })).toBe(false);
    expect(validate({ minimums: {}, spec: "draft" })).toBe(false);
  });

  test("rejects values of the wrong type", () => {
    expect(validate({ minimums: [], task: "x" })).toBe(false);
    expect(validate({ task: 7, minimums: {} })).toBe(false);
    expect(validate({ task: "x", needs: "browser" })).toBe(false);
    expect(validate({ task: "x", pin: 9 })).toBe(false);
    expect(validate({ task: "x", minimums: { coding: "7" } })).toBe(false);
    expect(validate({ task: "x", effort: 5 })).toBe(false);
  });

  test("accepts every contract field together", () => {
    expect(
      validate({
        excludeFamilies: ["family-a"],
        effort: "warp-nine",
        minimums: { coding: 5 },
        needs: ["repo-access"],
        pin: "model-a@harness-x",
        prefer: "speed",
        privacy: "secret",
        spec: "settled",
        stakes: "high",
        task: "implement",
      }),
    ).toBe(true);
  });

  test("accepts an empty minimums object and any finite number as a floor", () => {
    expect(validate({ minimums: {} })).toBe(true);
    expect(validate({ minimums: { coding: 11 } })).toBe(true);
    expect(validate({ minimums: { coding: 0.5 } })).toBe(true);
    expect(validate({ minimums: { coding: -2 } })).toBe(true);
  });

  test("rejects non-finite numbers, which JSON builds from 1e400", () => {
    expect(validate({ minimums: { coding: Number.POSITIVE_INFINITY } })).toBe(false);
  });

  test("agrees with the engine's validator on every corpus entry", () => {
    const corpus: unknown[] = [
      {},
      { pin: "model-a@harness-x" },
      { privacy: "secret" },
      { task: "implement" },
      { minimums: {} },
      { minimums: { coding: 5 } },
      { minimums: { coding: 11 } },
      { minimums: { coding: 0.5 } },
      { minimums: [] },
      { minimums: { coding: "7" }, task: "x" },
      { task: 7, minimums: {} },
      { task: "x", needs: "browser" },
      { task: "x", needs: [7] },
      { task: "x", pin: 9 },
      { task: "x", effort: 5 },
      { task: "x", effort: "warp-nine" },
      { task: "x", stakes: "urgent" },
      { task: "x", prefer: "quality" },
      { task: "x", privacy: "secrets" },
      { task: "x", spec: "draft" },
      { task: "x", excludeFamilies: "family-a" },
      { task: "x", excludeFamilies: [3] },
      { task: "x", minimums: {}, tasl: "implement" },
      { minimums: { coding: Number.POSITIVE_INFINITY } },
      {
        excludeFamilies: ["family-a"],
        effort: "high",
        minimums: { coding: 5 },
        needs: ["repo-access"],
        pin: "model-a@harness-x",
        prefer: "speed",
        privacy: "secret",
        spec: "settled",
        stakes: "high",
        task: "implement",
      },
    ];
    for (const entry of corpus) {
      let engineAccepted = true;
      try {
        parseQuery(entry);
      } catch (error) {
        expect(error).toBeInstanceOf(RouterError);
        engineAccepted = false;
      }
      expect(validate(entry), `schema and parseQuery disagree on ${JSON.stringify(entry)}`).toBe(
        engineAccepted,
      );
    }
  });
});

describe("answer.schema.json", () => {
  const validate = ajv.compile(JSON.parse(readFileSync(answerSchemaPath, "utf8")) as object);

  test("accepts a minimal answer whose query is the full applied query", () => {
    expect(validate(baseAnswer)).toBe(true);
  });

  test("rejects malformed known query fields inside the answer", () => {
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, privacy: "secrets" } })).toBe(false);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, minimums: [] } })).toBe(false);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, minimums: { coding: "7" } } })).toBe(
      false,
    );
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, prefer: "quality" } })).toBe(false);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, stakes: "urgent" } })).toBe(false);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, spec: "draft" } })).toBe(false);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, needs: "browser" } })).toBe(false);
    expect(
      validate({ ...baseAnswer, query: { ...appliedQuery, excludeFamilies: "family-a" } }),
    ).toBe(false);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, task: 7 } })).toBe(false);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, effort: 5 } })).toBe(false);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, pin: 9 } })).toBe(false);
  });

  test("an applied query missing an applied default is not a contract 1 answer", () => {
    const { prefer: _prefer, ...withoutPrefer } = appliedQuery;
    expect(validate({ ...baseAnswer, query: withoutPrefer })).toBe(false);
  });

  test("the applied query carries the optional fields when the query stated them", () => {
    expect(
      validate({
        ...baseAnswer,
        query: {
          ...appliedQuery,
          effort: "high",
          pin: "model-a@harness-x",
          task: "implement",
        },
      }),
    ).toBe(true);
  });

  test("accepts a full route and validates against every placement value", () => {
    expect(validate({ ...baseAnswer, routes: [baseRoute] })).toBe(true);
    for (const availability of ["ok", "projected", "exhausted", "unknown", "unmetered"]) {
      expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, availability }] })).toBe(true);
    }
    expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, availability: "later" }] })).toBe(
      false,
    );
    for (const placedBy of ["rank", "pin"]) {
      expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, placedBy }] })).toBe(true);
    }
    expect(
      validate({ ...baseAnswer, routes: [{ ...baseRoute, placedBy: "policy", policy: "p1" }] }),
    ).toBe(true);
    expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, placedBy: "manual" }] })).toBe(false);
    for (const floor of ["clears", "below", "skipped"]) {
      expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, floor }] })).toBe(true);
    }
    expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, floor: "unknown" }] })).toBe(false);
  });

  test("a route without availability is not a contract 1 answer", () => {
    const { availability: _availability, ...withoutAvailability } = baseRoute;
    expect(validate({ ...baseAnswer, routes: [withoutAvailability] })).toBe(false);
  });

  test("a policy-placed route requires the policy name; other placements forbid it", () => {
    expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, placedBy: "policy" }] })).toBe(false);
    expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, policy: "p1" }] })).toBe(false);
    expect(
      validate({ ...baseAnswer, routes: [{ ...baseRoute, placedBy: "pin", policy: "p1" }] }),
    ).toBe(false);
  });

  test("rejects an answer whose contract is not 1", () => {
    expect(validate({ ...baseAnswer, contract: 2 })).toBe(false);
  });

  test("rejects a malformed registryDigest", () => {
    expect(validate({ ...baseAnswer, registryDigest: "not-a-digest" })).toBe(false);
    expect(validate({ ...baseAnswer, registryDigest: "sha256:abc" })).toBe(false);
  });

  test("accepts a pin report", () => {
    expect(
      validate({ ...baseAnswer, pin: { label: "model-a@harness-x", used: false, reason: "x" } }),
    ).toBe(true);
  });

  test("accepts a removed route with a coded reason", () => {
    expect(
      validate({
        ...baseAnswer,
        removed: [
          {
            label: "model-a@harness-x",
            reason: { code: "privacy-secret-not-eligible", message: "x", fix: "y" },
          },
        ],
      }),
    ).toBe(true);
  });

  test("allows fields the schema does not define", () => {
    expect(validate({ ...baseAnswer, extra: true })).toBe(true);
    expect(validate({ ...baseAnswer, routes: [{ ...baseRoute, extra: 1 }] })).toBe(true);
    expect(validate({ ...baseAnswer, query: { ...appliedQuery, extra: true } })).toBe(true);
  });

  const describeBlock = {
    model: "jev-1.13.0",
    taskGate: 0.85,
    capabilityThreshold: 0.5,
    task: {
      source: "jev",
      confidence: 0.9,
      candidates: [
        { task: "task-a", probability: 0.9 },
        { task: "task-b", probability: 0.1 },
      ],
    },
    needsAdded: [{ capability: "browser", probability: 0.8 }],
    usage: { input_tokens: 500, output_tokens: 30 },
  } as const;

  test("accepts a describe block with every field", () => {
    expect(validate({ ...baseAnswer, describe: describeBlock })).toBe(true);
    expect(
      validate({
        ...baseAnswer,
        describe: {
          ...describeBlock,
          model: null,
          usage: null,
          task: { source: "caller", confidence: null, candidates: [] },
          needsAdded: [],
        },
      }),
    ).toBe(true);
  });

  test("rejects a describe block with a bad source, gate, candidate or usage", () => {
    expect(
      validate({
        ...baseAnswer,
        describe: { ...describeBlock, task: { ...describeBlock.task, source: "guess" } },
      }),
    ).toBe(false);
    expect(validate({ ...baseAnswer, describe: { ...describeBlock, taskGate: 1.5 } })).toBe(false);
    expect(
      validate({
        ...baseAnswer,
        describe: {
          ...describeBlock,
          task: { ...describeBlock.task, candidates: [{ task: "task-a" }] },
        },
      }),
    ).toBe(false);
    expect(
      validate({ ...baseAnswer, describe: { ...describeBlock, usage: { input_tokens: 1 } } }),
    ).toBe(false);
    expect(
      validate({
        ...baseAnswer,
        describe: { ...describeBlock, needsAdded: [{ capability: "browser" }] },
      }),
    ).toBe(false);
  });
});
