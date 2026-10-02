import { describe, expect, test } from "vitest";
import { rank } from "../src/rank.js";
import type { AvailabilityEntry } from "../src/types.js";
import { expectValidAnswer, fixturePath, withTempDir, writeJson } from "./helpers.js";

const FULL = fixturePath("full.json");

describe("rank availability usability", () => {
  test("unknown status neither covers a meter nor changes its route", () => {
    const answer = rank(
      { minimums: { coding: 5 } },
      {
        registry: FULL,
        availability: [{ meter: "meter-a", status: "unknown" }] as unknown as AvailabilityEntry[],
      },
    );
    expectValidAnswer(answer);
    expect(answer.routes.find((r) => r.label === "model-a@harness-x")?.availability).toBe(
      "unknown",
    );
    expect(answer.warnings.filter((w) => w.code === "meter-no-reading")).toEqual([
      expect.objectContaining({
        field: "$.entries",
        message: 'the meter "meter-a" is used by routes but has no availability entry',
      }),
    ]);
  });

  test.each([
    { meter: "meter-zzz", status: "bogus" },
    Object.assign(Object.create({ status: "ok" }), { meter: "meter-zzz" }),
    { meter: "", status: "ok" },
    { meter: 7, status: "ok" },
  ])("unusable entry %j gives no undeclared warning", (entry) => {
    const answer = rank(
      { minimums: { coding: 5 } },
      { registry: FULL, availability: [entry] as unknown as AvailabilityEntry[] },
    );
    expectValidAnswer(answer);
    expect(answer.warnings.map((w) => w.code)).not.toContain("meter-undeclared");
    expect(answer.warnings.map((w) => w.code)).toContain("meter-no-reading");
  });

  test("a usable undeclared entry names the meter with the entries field", () => {
    const answer = rank(
      { minimums: { coding: 5 } },
      { registry: FULL, availability: [{ meter: "meter-zzz", status: "ok" }] },
    );
    expectValidAnswer(answer);
    expect(answer.warnings.find((w) => w.code === "meter-undeclared")).toMatchObject({
      field: "$.entries",
      message: 'the meter "meter-zzz" is not declared in the registry\'s meters section',
    });
  });

  test("all-exhausted keeps a used pin and removes nothing", async () => {
    await withTempDir(async (dir) => {
      const registry = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Code." },
        router: { rank: ["coding"] },
        meters: { "meter-a": {} },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [
              { harness: "harness-x", modelId: "model-id-a", hosted: true, meter: "meter-a" },
            ],
          },
        },
      });
      const answer = rank(
        { minimums: { coding: 5 }, pin: "model-a@harness-x" },
        { registry, availability: [{ meter: "meter-a", status: "exhausted" }] },
      );
      expectValidAnswer(answer);
      expect(answer.removed).toEqual([]);
      expect(answer.routes.map((r) => r.availability)).toEqual(["exhausted"]);
      expect(answer.pin?.used).toBe(true);
      expect(answer.warnings.map((w) => w.code)).toContain("availability-exhausted-all");
      expect(answer.warnings.map((w) => w.code)).not.toContain("pin-unused");
    });
  });
});
