import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import schema from "../config.schema.json" with { type: "json" };
import { defaultConfig, validateConfigObjectInput } from "../src/config.js";
import { expectValidRouterError } from "./helpers.js";

const validate = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(schema);
const levels = ["low", "medium", "high", "xhigh", "max"] as const;
const cases: { name: string; value: unknown; valid: boolean }[] = [
  { name: "empty", value: {}, valid: true },
  { name: "defaults", value: defaultConfig(), valid: true },
  {
    name: "all sections",
    value: {
      $schema: "x",
      effort: { ceiling: "high", default: "low" },
      availability: { command: ["command-a", ""], timeoutSeconds: 0.1, maxAgeSeconds: 0.1 },
      describe: { taskGate: 0, capabilityThreshold: 1, jevModel: " model-a " },
    },
    valid: true,
  },
  { name: "empty sections", value: { effort: {}, availability: {}, describe: {} }, valid: true },
  { name: "empty argv string", value: { availability: { command: [""] } }, valid: true },
  ...[null, [], "x", 7, true].map((value) => ({
    name: `root ${JSON.stringify(value)}`,
    value,
    valid: false,
  })),
  { name: "unknown root key", value: { mystery: true }, valid: false },
  ...[null, 7, {}, [], false].map((value) => ({
    name: `$schema ignored ${JSON.stringify(value)}`,
    value: { $schema: value },
    valid: true,
  })),
];
for (const section of ["effort", "availability", "describe"]) {
  for (const value of [null, [], 7, "x", true])
    cases.push({
      name: `${section} not object ${JSON.stringify(value)}`,
      value: { [section]: value },
      valid: false,
    });
  cases.push({
    name: `${section} unknown key`,
    value: { [section]: { mystery: true } },
    valid: false,
  });
}
for (const field of ["ceiling", "default"]) {
  for (const value of [null, 7, "off-ladder", {}, []])
    cases.push({
      name: `effort ${field} invalid ${JSON.stringify(value)}`,
      value: { effort: { [field]: value } },
      valid: false,
    });
}
for (const [ceilingIndex, ceiling] of levels.entries()) {
  for (const [defaultIndex, defaultLevel] of levels.entries())
    cases.push({
      name: `effort ${ceiling}/${defaultLevel}`,
      value: { effort: { ceiling, default: defaultLevel } },
      valid: defaultIndex <= ceilingIndex,
    });
  cases.push({
    name: `ceiling ${ceiling} with implicit default`,
    value: { effort: { ceiling } },
    valid: ceilingIndex >= 1,
  });
  cases.push({
    name: `default ${ceiling} with implicit ceiling`,
    value: { effort: { default: ceiling } },
    valid: ceilingIndex <= 3,
  });
}
for (const value of [null, "command-a", [], [7], [null]])
  cases.push({
    name: `command invalid ${JSON.stringify(value)}`,
    value: { availability: { command: value } },
    valid: false,
  });
for (const field of ["timeoutSeconds", "maxAgeSeconds"]) {
  for (const value of [0, -1, "1", null, [], true])
    cases.push({
      name: `${field} invalid ${JSON.stringify(value)}`,
      value: { availability: { [field]: value } },
      valid: false,
    });
}
for (const field of ["taskGate", "capabilityThreshold"]) {
  for (const value of [0, 0.5, 1, -0.1, 1.1, "0.5", null, [], true])
    cases.push({
      name: `${field} ${JSON.stringify(value)}`,
      value: { describe: { [field]: value } },
      valid: typeof value === "number" && value >= 0 && value <= 1,
    });
}
for (const value of ["", " ", "\t\r\n", "\u00a0", "\ufeff", null, 7, {}, []])
  cases.push({
    name: `jevModel invalid ${JSON.stringify(value)}`,
    value: { describe: { jevModel: value } },
    valid: false,
  });

describe("config.schema.json agrees with validateConfigObjectInput on JSON input", () => {
  test.each(cases)("$name", ({ value, valid }) => {
    let accepted = true;
    try {
      validateConfigObjectInput(value);
    } catch (error) {
      expectValidRouterError(error);
      accepted = false;
    }
    expect(accepted).toBe(valid);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(valid);
  });
});
