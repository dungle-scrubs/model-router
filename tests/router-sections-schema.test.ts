import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import schema from "../router-sections.schema.json" with { type: "json" };
import { validateRouterSections } from "../src/sections.js";
import { expectValidRouterError, fixturePath, loadLoaded } from "./helpers.js";

const validate = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(schema);
const loaded = loadLoaded(fixturePath("full.json"));
const task = {
  description: "Task a.",
  minimums: { low: { coding: 6 }, normal: {}, high: {} },
  rank: ["coding"],
};
const policy = {
  task: "task-a",
  stakes: ["low"],
  routes: [{ route: "model-a@harness-x" }],
  reason: "Reason a.",
};
const base = {
  router: { rank: ["coding"] },
  tasks: { "task-a": task },
  policy: { "policy-a": policy },
};
const cases: { name: string; value: Record<string, unknown>; valid: boolean }[] = [
  { name: "all sections", value: base, valid: true },
  { name: "router only", value: { router: base.router }, valid: true },
  {
    name: "empty optional sections",
    value: { router: base.router, tasks: {}, policy: {} },
    valid: true,
  },
  { name: "missing router", value: {}, valid: false },
  {
    name: "unowned registry fields",
    value: { ...base, format: 1, models: {}, ratings: {} },
    valid: true,
  },
];
function section(name: string, key: string, value: unknown, valid = false) {
  cases.push({ name, value: { ...base, [key]: value }, valid });
}
function taskCase(name: string, patch: Record<string, unknown>, valid = false) {
  section(name, "tasks", { "task-a": { ...task, ...patch } }, valid);
}
function policyCase(name: string, patch: Record<string, unknown>, valid = false) {
  section(name, "policy", { "policy-a": { ...policy, ...patch } }, valid);
}
for (const key of ["router", "tasks", "policy"]) {
  for (const value of [null, [], "x", 7])
    section(`${key} not object ${JSON.stringify(value)}`, key, value);
}
section("router missing rank", "router", {});
section("router unknown key", "router", { ...base.router, mystery: true });
for (const rank of [[], "coding", [7], [null]]) {
  section(`router rank ${JSON.stringify(rank)}`, "router", { rank });
  taskCase(`task rank ${JSON.stringify(rank)}`, { rank });
}
section("duplicate rank accepted", "router", { rank: ["coding", "coding"] }, true);
for (const questions of [null, [], "x", { browser: 7 }, { browser: null }])
  section(`questions ${JSON.stringify(questions)}`, "router", { ...base.router, questions });
section("empty question accepted", "router", { ...base.router, questions: { browser: "" } }, true);
for (const value of [null, [], "x", 7]) {
  section(`task entry ${JSON.stringify(value)}`, "tasks", { "task-a": value });
  section(`policy entry ${JSON.stringify(value)}`, "policy", { "policy-a": value });
}
for (const key of ["description", "minimums", "rank"]) {
  const value: Record<string, unknown> = { ...task };
  delete value[key];
  section(`missing task ${key}`, "tasks", { "task-a": value });
}
for (const description of [7, null, [], "a\nb", "a\rb", "a\r\nb", "a\n"])
  taskCase(`description ${JSON.stringify(description)}`, { description });
taskCase("empty task description accepted", { description: "" }, true);
for (const minimums of [null, [], 7, "x", { low: {}, high: {} }, { ...task.minimums, urgent: {} }])
  taskCase(`minimums ${JSON.stringify(minimums)}`, { minimums });
for (const stake of ["low", "normal", "high"]) {
  for (const value of [null, [], 7, { coding: "6" }, { coding: null }])
    taskCase(`${stake} floors ${JSON.stringify(value)}`, {
      minimums: { ...task.minimums, [stake]: value },
    });
}
taskCase(
  "unbounded rating floors",
  { minimums: { low: { coding: -1 }, normal: { coding: 1.5 }, high: { coding: 100 } } },
  true,
);
for (const needs of [null, "browser", [7], [null]])
  taskCase(`needs ${JSON.stringify(needs)}`, { needs });
taskCase("valid needs", { needs: ["browser", "browser"] }, true);
taskCase("empty needs", { needs: [] }, true);
for (const effort of [null, 7, "off-ladder", ""]) {
  taskCase(`task effort ${JSON.stringify(effort)}`, { effort });
  policyCase(`policy route effort ${JSON.stringify(effort)}`, {
    routes: [{ route: "model-a@harness-x", effort }],
  });
}
for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
  taskCase(`valid task effort ${effort}`, { effort }, true);
  policyCase(
    `valid policy effort ${effort}`,
    { routes: [{ route: "model-b@harness-x", effort }] },
    true,
  );
}
taskCase("unknown task field", { mystery: true });
for (const key of ["task", "stakes", "routes", "reason"]) {
  const value: Record<string, unknown> = { ...policy };
  delete value[key];
  section(`missing policy ${key}`, "policy", { "policy-a": value });
}
for (const task of [7, null, []]) policyCase(`policy task ${JSON.stringify(task)}`, { task });
for (const stakes of [null, "low", [], ["urgent"], [7]])
  policyCase(`stakes ${JSON.stringify(stakes)}`, { stakes });
policyCase("duplicate stakes accepted", { stakes: ["low", "low"] }, true);
for (const routes of [
  null,
  "x",
  [],
  [7],
  [null],
  [{}],
  [{ route: 7 }],
  [{ route: "model-a@harness-x", mystery: true }],
])
  policyCase(`routes ${JSON.stringify(routes)}`, { routes });
for (const reason of [null, 7, []]) policyCase(`reason ${JSON.stringify(reason)}`, { reason });
policyCase("empty reason accepted", { reason: "" }, true);
policyCase("multiline reason accepted", { reason: "a\nb" }, true);
for (const since of [null, 7, []]) policyCase(`since ${JSON.stringify(since)}`, { since });
policyCase("since not parsed", { since: "not a date" }, true);
for (const spec of [null, 7, "open"]) policyCase(`spec ${JSON.stringify(spec)}`, { spec });
policyCase("settled spec", { spec: "settled" }, true);
policyCase("unknown policy field", { mystery: true });

describe("router-sections.schema.json agrees with validateRouterSections on local rules", () => {
  test.each(cases)("$name", ({ value, valid }) => {
    let accepted = true;
    try {
      validateRouterSections({ ...loaded, sections: value as typeof loaded.sections });
    } catch (error) {
      expectValidRouterError(error);
      accepted = false;
    }
    expect(accepted).toBe(valid);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(valid);
  });
  test("the full registry passes without claiming ownership of other sections", () => {
    expect(validate({ ...loaded.registry, ...base })).toBe(true);
  });
});

describe("content-dependent checks remain with the engine", () => {
  const values = [
    { ...base, router: { rank: ["unknown-rating"] } },
    { ...base, router: { ...base.router, questions: { "unknown-capability": "Question?" } } },
    { ...base, tasks: { "task-a": { ...task, needs: ["unknown-capability"] } } },
    {
      ...base,
      tasks: {
        "task-a": { ...task, minimums: { ...task.minimums, low: { "unknown-rating": 5 } } },
      },
    },
    { ...base, policy: { "policy-a": { ...policy, task: "unknown-task" } } },
    {
      ...base,
      policy: { "policy-a": { ...policy, routes: [{ route: "unknown-model@harness-x" }] } },
    },
    {
      ...base,
      policy: {
        "policy-a": { ...policy, routes: [{ route: "model-a@harness-x", effort: "max" }] },
      },
    },
    {
      ...base,
      policy: {
        "policy-a": {
          ...policy,
          routes: [{ route: "model-a@harness-x" }, { route: "model-a@harness-x", effort: "low" }],
        },
      },
    },
    { ...base, policy: { "policy-a": policy, "policy-b": policy } },
  ];
  test.each(values.map((value, index) => ({ value, index })))(
    "engine-only check $index",
    ({ value }) => {
      expect(validate(value)).toBe(true);
      let accepted = true;
      try {
        validateRouterSections({ ...loaded, sections: value as typeof loaded.sections });
      } catch (error) {
        expectValidRouterError(error);
        accepted = false;
      }
      expect(accepted).toBe(false);
    },
  );
});
