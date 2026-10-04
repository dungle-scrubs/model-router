import { expect, test } from "vitest";
import type { Answer, AvailabilityEntry } from "../src/index.js";
import { defaultConfig, rank } from "../src/index.js";
import goldens from "./fixtures/pre-profile-goldens.json" with { type: "json" };
import { expectValidAnswer, expectValidError, fixturePath } from "./helpers.js";

interface Golden {
  readonly fixture: string;
  readonly sourceFixture?: string;
  readonly query: unknown;
  readonly availability?: readonly AvailabilityEntry[];
  readonly answer?: unknown;
  readonly error?: unknown;
}
const cases = goldens.cases as readonly Golden[];

test("compatibility evidence is the last pre-profile release over every existing registry fixture", () => {
  expect(goldens.baseline).toBe("bf93b1f");
  expect(goldens.routerVersion).toBe("0.1.0");
  expect([...new Set(cases.map((entry) => entry.fixture))]).toEqual([
    "describe.json",
    "empty-models.json",
    "full.json",
    "minimal.json",
    "missing-rank.json",
    "no-questions.json",
    "no-router.json",
    "not-json.json",
    "own-props.json",
    "policy-broken.json",
    "routes.json",
    "speed.json",
    "tasks.json",
    "ties.json",
  ]);
  expect(cases).toHaveLength(226);
});

for (const [index, entry] of cases.entries()) {
  test(`0.1.0 golden ${index}: ${entry.fixture} ${JSON.stringify(entry.query)}${entry.availability === undefined ? "" : " with availability"}`, () => {
    const registry = fixturePath(entry.fixture);
    const options = {
      registry,
      config: defaultConfig(),
      ...(entry.availability === undefined ? {} : { availability: entry.availability }),
    };
    if (entry.answer !== undefined) {
      expectValidAnswer(entry.answer);
      const oldAnswer = entry.answer as Answer;
      const answer = rank(entry.query, options);
      expectValidAnswer(answer);
      expect(answer).toEqual({ ...oldAnswer, query: { ...oldAnswer.query, profile: "default" } });
    } else {
      let caught: unknown;
      try {
        rank(entry.query, options);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      const error = caught as { toJSON(): Record<string, unknown> };
      const envelope = error.toJSON();
      expectValidError({ error: envelope });
      delete envelope.path;
      if (typeof envelope.message === "string")
        envelope.message = envelope.message.replaceAll(registry, "<registry>");
      expect(envelope).toEqual(entry.error);
    }
  });
}

test("goldens include actual outputs from both existing availability command fixtures", () => {
  expect(
    cases
      .filter((entry) => entry.sourceFixture !== undefined)
      .map((entry) => ({
        sourceFixture: entry.sourceFixture,
        availability: entry.availability,
      })),
  ).toEqual([
    { sourceFixture: "availability-print.js", availability: [{ meter: "meter-a", status: "ok" }] },
    { sourceFixture: "availability-expired-print.js", availability: [] },
  ]);
});
