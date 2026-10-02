import { expect, test } from "vitest";
import { applyAvailability } from "../src/availability.js";
import { parseAvailabilityDocument } from "../src/availability-cli.js";
import { runCli } from "../src/cli-run.js";
import { rank } from "../src/index.js";
import {
  captureStream,
  expectValidAnswer,
  fixturePath,
  withEnv,
  withTempDir,
  writeJson,
} from "./helpers.js";

const FULL = fixturePath("full.json");
const QUERY = '{"minimums":{"coding":5}}';
const ROUTE = { label: "model-a@harness-x", meter: "meter-a", availability: "projected" as const };

async function run(args: string[]) {
  const out = captureStream();
  const err = captureStream();
  const exit = await runCli(args, { stdout: out.stream, stderr: err.stream });
  expect(exit, err.text()).toBe(0);
  expect(err.text()).toBe("");
  const answer: unknown = JSON.parse(out.text());
  expectValidAnswer(answer);
  return answer;
}

test("a covered projected route replaces its stale percent reason", () => {
  const first = applyAvailability(
    [ROUTE],
    [{ meter: "meter-a", status: "projected", percentRemaining: 60 }],
  );
  const caller = first.routes[0];
  expect(caller).toBeDefined();
  const result = applyAvailability(first.routes, [
    { meter: "meter-a", status: "projected", percentRemaining: 12 },
  ]);
  const route = result.routes[0];
  expect(route).not.toBe(caller);
  expect(route?.reasons?.map((reason) => reason.code)).toEqual(["meter-projected"]);
  expect(route?.reasons?.[0]?.message).toContain("12%");
  expect(route?.reasons?.[0]?.message).not.toContain("60%");
});

test("a projected reason changes when the meter becomes spend-to-zero", () => {
  const entries = [{ meter: "meter-a", status: "projected" as const, percentRemaining: 12 }];
  const first = applyAvailability([ROUTE], entries);
  const result = applyAvailability(first.routes, entries, { spendToZero: ["meter-a"] });
  expect(result.routes[0]).not.toBe(first.routes[0]);
  expect(result.routes[0]?.reasons?.map((reason) => reason.code)).toEqual([
    "meter-projected-spend-to-zero",
  ]);
});

test("a stale reason code is replaced even when its other fields match", () => {
  const entries = [{ meter: "meter-a", status: "projected" as const, percentRemaining: 12 }];
  const generated = applyAvailability([ROUTE], entries, { spendToZero: ["meter-a"] });
  const reason = generated.routes[0]?.reasons?.[0];
  expect(reason).toBeDefined();
  const caller = { ...ROUTE, reasons: [{ ...reason, code: "meter-projected" }] };
  const result = applyAvailability([caller], entries, { spendToZero: ["meter-a"] });
  expect(result.routes[0]).not.toBe(caller);
  expect(result.routes[0]?.reasons?.map((entry) => entry.code)).toEqual([
    "meter-projected-spend-to-zero",
  ]);
});

test.each(["fix", "field"] as const)("a stale reason %s is replaced", (field) => {
  const entries = [{ meter: "meter-a", status: "projected" as const, percentRemaining: 12 }];
  const generated = applyAvailability([ROUTE], entries);
  const reason = generated.routes[0]?.reasons?.[0];
  expect(reason).toBeDefined();
  const caller = { ...ROUTE, reasons: [{ ...reason, code: "meter-projected", [field]: "stale" }] };
  const result = applyAvailability([caller], entries);
  expect(result.routes[0]).not.toBe(caller);
  expect(result.routes[0]?.reasons).toEqual(generated.routes[0]?.reasons);
});

test("an unchanged non-meter reason list preserves caller identity", () => {
  const reasons = [{ code: "floor-not-met", message: "coding is below the floor" }];
  const caller = { ...ROUTE, availability: "ok" as const, reasons };
  const result = applyAvailability([caller], [{ meter: "meter-a", status: "ok" }]);
  expect(result.routes[0]).toBe(caller);
  expect(result.routes[0]?.reasons).toBe(reasons);
});

test("a better status cannot supply the deciding projected percent", () => {
  const result = applyAvailability(
    [ROUTE],
    [
      { meter: "meter-a", status: "projected", percentRemaining: 50 },
      { meter: "meter-a", status: "ok", percentRemaining: 10 },
    ],
  );
  expect(result.routes[0]?.availability).toBe("projected");
  expect(result.routes[0]?.reasons?.map((reason) => reason.code)).toEqual(["meter-projected"]);
  expect(result.routes[0]?.reasons?.[0]?.message).toContain("50%");
  expect(result.routes[0]?.reasons?.[0]?.message).not.toContain("10%");
});

test("removing another exhausted route leaves an unmetered pin used", () => {
  const query = { minimums: { coding: 5 }, pin: "model-b@harness-x" };
  const baseline = rank(query, { registry: FULL });
  const answer = rank(query, {
    registry: FULL,
    availability: [{ meter: "meter-a", status: "exhausted" }],
  });
  expectValidAnswer(baseline);
  expectValidAnswer(answer);
  expect(baseline.routes.find((route) => route.label === query.pin)?.meter).toBeUndefined();
  expect(answer.pin).toEqual({ label: query.pin, reason: "", used: true });
  expect(answer.pin).toEqual(baseline.pin);
  expect(answer.warnings.map((warning) => warning.code)).not.toContain("pin-unused");
  expect(answer.routes.some((route) => route.label === "model-a@harness-x")).toBe(false);
  expect(
    answer.removed.some(
      (route) => route.label === "model-a@harness-x" && route.reason.code === "meter-exhausted",
    ),
  ).toBe(true);
});

test("plain CLI ranking applies explicit config without a registry flag", async () => {
  await withTempDir(async (dir) => {
    const config = writeJson(dir, "config.json", { effort: { default: "low" } });
    await withTempDir(async (xdg) => {
      await withEnv(
        { MODEL_REGISTRY_FILE: FULL, XDG_CONFIG_HOME: xdg, MODEL_ROUTER_CONFIG: undefined },
        async () => {
          const answer = await run([QUERY, "--config", config]);
          expect(answer.routes.length).toBeGreaterThan(0);
          for (const route of answer.routes) expect(route.effort).toBe("low");
        },
      );
    });
  });
});

test("a null availability document is reading-invalid", () => {
  const result = parseAvailabilityDocument(null, { maxAgeSeconds: 60 });
  expect(result.entries).toEqual([]);
  expect(result.note?.code).toBe("availability-reading-invalid");
});

test("a null availability file ranks without availability", async () => {
  await withTempDir(async (dir) => {
    const file = writeJson(dir, "availability.json", null);
    const config = writeJson(dir, "config.json", {});
    const baseline = await run([QUERY, "--registry", FULL, "--config", config]);
    const answer = await run([
      QUERY,
      "--registry",
      FULL,
      "--config",
      config,
      "--availability-file",
      file,
    ]);
    expect(answer.availabilityNote?.code).toBe("availability-reading-invalid");
    expect(answer.routes).toEqual(baseline.routes);
    expect(answer.removed).toEqual(baseline.removed);
    expect(answer.warnings.map((warning) => warning.code)).not.toContain("meter-no-reading");
  });
});

test("a stale percent is replaced while non-meter reasons survive", () => {
  const floor = { code: "floor-not-met", message: "coding is below the floor" };
  const first = applyAvailability(
    [{ ...ROUTE, reasons: [floor] }],
    [{ meter: "meter-a", status: "projected", percentRemaining: 60 }],
  );
  const result = applyAvailability(first.routes, [
    { meter: "meter-a", status: "projected", percentRemaining: 12 },
  ]);
  expect(result.routes[0]).not.toBe(first.routes[0]);
  expect(result.routes[0]?.reasons?.map((reason) => reason.code)).toEqual([
    "floor-not-met",
    "meter-projected",
  ]);
  expect(result.routes[0]?.reasons?.[0]).toBe(floor);
  expect(result.routes[0]?.reasons?.[1]?.message).toContain("12%");
  expect(result.routes[0]?.reasons?.[1]?.message).not.toContain("60%");
});
