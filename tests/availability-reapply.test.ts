import { describe, expect, test } from "vitest";
import { applyAvailability } from "../src/availability.js";

describe("availability re-application", () => {
  test("an ok reading clears the only projected reason", () => {
    const route = {
      label: "model-a@harness-x",
      meter: "meter-a",
      availability: "projected" as const,
      reasons: [{ code: "meter-projected", message: "prior reading" }],
    };
    const result = applyAvailability([route], [{ meter: "meter-a", status: "ok" }]);
    expect(result.routes[0]?.availability).toBe("ok");
    expect(result.routes[0]?.reasons).toEqual([]);
    expect(route.reasons).toEqual([{ code: "meter-projected", message: "prior reading" }]);
  });

  test("an uncovered meter keeps both reasons and the caller's object", () => {
    const route = {
      label: "model-b@harness-x",
      meter: "meter-b",
      availability: "projected" as const,
      reasons: [
        { code: "floor-not-met", message: "below floor" },
        { code: "meter-projected", message: "prior reading" },
      ],
    };
    const result = applyAvailability([route], [{ meter: "meter-a", status: "ok" }]);
    expect(result.routes[0]).toBe(route);
    expect(result.routes[0]?.availability).toBe("projected");
    expect(result.routes[0]?.reasons).toEqual(route.reasons);
  });

  test("the worked example keeps projected and unmetered objects and reasons", () => {
    const projected = {
      label: "model-s@harness-x",
      meter: "meter-s",
      availability: "projected" as const,
      reasons: [{ code: "meter-projected-spend-to-zero", message: "prior reading" }],
    };
    const unmetered = {
      label: "model-c@harness-x",
      availability: "unmetered" as const,
      reasons: [{ code: "floor-not-met", message: "below floor" }],
    };
    const result = applyAvailability(
      [projected, unmetered],
      [{ meter: "meter-a", status: "exhausted" }],
    );
    expect(result.routes).toEqual([projected, unmetered]);
    expect(result.routes[0]).toBe(projected);
    expect(result.routes[1]).toBe(unmetered);
  });

  test("invalid or inherited availability uses the fallback", () => {
    const bogus = { label: "model-a@harness-x", meter: "meter-a", availability: "bogus" };
    const inherited = Object.assign(Object.create({ availability: "ok" }), {
      label: "model-b@harness-x",
      meter: "meter-a",
    });
    const result = applyAvailability([bogus, inherited], []);
    expect(result.routes.map((r) => r.availability)).toEqual(["unknown", "unknown"]);
    expect(result.routes[0]).not.toBe(bogus);
    expect(result.routes[1]).not.toBe(inherited);
  });

  test("an own valid availability with no change keeps the caller's object", () => {
    const route = { label: "model-a@harness-x", meter: "meter-a", availability: "ok" as const };
    expect(applyAvailability([route], []).routes[0]).toBe(route);
    expect(applyAvailability([route], [{ meter: "meter-a", status: "ok" }]).routes[0]).toBe(route);
  });

  test("re-applying the same projected reading keeps the caller's object", () => {
    const entry = { meter: "meter-a", status: "projected" as const, percentRemaining: 12 };
    const once = applyAvailability([{ label: "model-a@harness-x", meter: "meter-a" }], [entry]);
    const twice = applyAvailability(once.routes, [entry]);
    expect(twice.routes[0]).toBe(once.routes[0]);
  });
});
