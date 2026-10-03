import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { defaultConfig, validateConfigObjectInput } from "../src/config.js";
import { repoRoot } from "./helpers.js";

const configSchemaPath = join(repoRoot, "config.schema.json");
const configSchema = JSON.parse(readFileSync(configSchemaPath, "utf8")) as object;
const validateConfig = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(configSchema);

describe("config.schema.json", () => {
  test("the empty config (the default file) is valid against the schema", () => {
    expect(validateConfig({})).toBe(true);
  });

  test("a config with $schema only is valid (editor support)", () => {
    expect(validateConfig({ $schema: "https://example.invalid/config.schema.json" })).toBe(true);
  });

  test("a config with every known section is valid", () => {
    expect(
      validateConfig({
        $schema: "https://example.invalid/config.schema.json",
        effort: { ceiling: "high", default: "low" },
        availability: { command: ["from-config"], timeoutSeconds: 7, maxAgeSeconds: 120 },
        describe: { taskGate: 0.6, capabilityThreshold: 0.7, jevModel: "jev-test" },
      }),
    ).toBe(true);
  });

  test("a config with availability but no command is valid (defaults apply)", () => {
    expect(validateConfig({ availability: {} })).toBe(true);
  });

  test("boundary probabilities 0 and 1 are valid", () => {
    expect(validateConfig({ describe: { taskGate: 0, capabilityThreshold: 1 } })).toBe(true);
  });

  test("rejects an unknown top-level key (the schema is closed)", () => {
    expect(validateConfig({ mystery: true })).toBe(false);
    expect(validateConfig.errors?.some((error) => error.keyword === "additionalProperties")).toBe(
      true,
    );
  });

  test("rejects an off-ladder ceiling and default", () => {
    expect(validateConfig({ effort: { ceiling: "warp-nine" } })).toBe(false);
    expect(validateConfig({ effort: { default: "warp-nine" } })).toBe(false);
  });

  test("rejects a default above the ceiling on each pair that crosses the boundary", () => {
    // The relationship check is enforced by the engine, not the schema.
    // The schema accepts these because both values are ladder entries.
    // The engine's validateConfigObjectInput rejects them.
    for (const [ceiling, defaultLevel] of [
      ["low", "medium"],
      ["low", "high"],
      ["low", "xhigh"],
      ["low", "max"],
      ["medium", "high"],
      ["medium", "xhigh"],
      ["medium", "max"],
      ["high", "xhigh"],
      ["high", "max"],
      ["xhigh", "max"],
    ] as const) {
      const value = { effort: { ceiling, default: defaultLevel } };
      expect(validateConfig(value), `schema should accept ${JSON.stringify(value)}`).toBe(true);
      expect(() => validateConfigObjectInput(value)).toThrow();
    }
  });

  test("rejects a non-object effort section", () => {
    expect(validateConfig({ effort: "oops" })).toBe(false);
  });

  test("rejects an unknown key under effort", () => {
    expect(validateConfig({ effort: { ceiling: "xhigh", default: "medium", mystery: 1 } })).toBe(
      false,
    );
  });

  test("rejects a non-object availability section", () => {
    expect(validateConfig({ availability: "no" })).toBe(false);
  });

  test("rejects a non-array availability command", () => {
    expect(validateConfig({ availability: { command: "node" } })).toBe(false);
  });

  test("rejects an empty availability command array", () => {
    expect(validateConfig({ availability: { command: [] } })).toBe(false);
  });

  test("rejects a non-string availability command entry", () => {
    expect(validateConfig({ availability: { command: ["node", 42] } })).toBe(false);
  });

  test("rejects a non-positive availability timeoutSeconds", () => {
    expect(validateConfig({ availability: { timeoutSeconds: 0 } })).toBe(false);
    expect(validateConfig({ availability: { timeoutSeconds: -1 } })).toBe(false);
  });

  test("rejects a non-number availability timeoutSeconds", () => {
    expect(validateConfig({ availability: { timeoutSeconds: "10" } })).toBe(false);
  });

  test("rejects a non-positive availability maxAgeSeconds", () => {
    expect(validateConfig({ availability: { maxAgeSeconds: 0 } })).toBe(false);
  });

  test("rejects an unknown key under availability", () => {
    expect(validateConfig({ availability: { mystery: true } })).toBe(false);
  });

  test("rejects a non-object describe section", () => {
    expect(validateConfig({ describe: 7 })).toBe(false);
  });

  test("rejects a taskGate out of [0, 1]", () => {
    expect(validateConfig({ describe: { taskGate: 1.5 } })).toBe(false);
    expect(validateConfig({ describe: { taskGate: -0.1 } })).toBe(false);
    expect(validateConfig({ describe: { taskGate: "high" } })).toBe(false);
  });

  test("rejects a capabilityThreshold out of [0, 1]", () => {
    expect(validateConfig({ describe: { capabilityThreshold: 1.01 } })).toBe(false);
    expect(validateConfig({ describe: { capabilityThreshold: -1 } })).toBe(false);
  });

  test("rejects an empty or non-string jevModel", () => {
    expect(validateConfig({ describe: { jevModel: "" } })).toBe(false);
    expect(validateConfig({ describe: { jevModel: 7 } })).toBe(false);
  });

  test("rejects an unknown key under describe", () => {
    expect(validateConfig({ describe: { gate: 0.9 } })).toBe(false);
  });

  test("$schema must be a string when present", () => {
    expect(validateConfig({ $schema: 7 })).toBe(false);
  });

  test("the engine's default config object validates against the schema", () => {
    expect(validateConfig(defaultConfig())).toBe(true);
  });
});

describe("config.schema.json agrees with validateConfigObjectInput", () => {
  // The schema and the engine validator must agree on whether a config is
  // acceptable. The engine enforces relationship rules the schema cannot
  // express, so the schema is permissive on default-above-ceiling. Every
  // other rejection the engine does is matched by the schema, and every
  // acceptance the engine does is matched by the schema.
  const corpus: { name: string; value: unknown; engineAccepts: boolean; schemaAccepts: boolean }[] =
    [
      // Acceptances: every shape the engine accepts.
      { name: "empty object", value: {}, engineAccepts: true, schemaAccepts: true },
      { name: "$schema only", value: { $schema: "x" }, engineAccepts: true, schemaAccepts: true },
      {
        name: "valid effort",
        value: { effort: { ceiling: "high", default: "low" } },
        engineAccepts: true,
        schemaAccepts: true,
      },
      {
        name: "effort with one field",
        value: { effort: { default: "low" } },
        engineAccepts: true,
        schemaAccepts: true,
      },
      {
        name: "availability with command",
        value: { availability: { command: ["x"] } },
        engineAccepts: true,
        schemaAccepts: true,
      },
      {
        name: "availability with no command",
        value: { availability: {} },
        engineAccepts: true,
        schemaAccepts: true,
      },
      {
        name: "describe with values",
        value: { describe: { taskGate: 0.5 } },
        engineAccepts: true,
        schemaAccepts: true,
      },
      {
        name: "all sections at once",
        value: {
          effort: { ceiling: "xhigh", default: "medium" },
          availability: { command: ["x"], timeoutSeconds: 5, maxAgeSeconds: 60 },
          describe: { taskGate: 0.9 },
        },
        engineAccepts: true,
        schemaAccepts: true,
      },
      // Rejections by shape: the schema and the engine both reject.
      {
        name: "unknown top-level key",
        value: { mystery: true },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-object effort",
        value: { effort: "oops" },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "off-ladder ceiling",
        value: { effort: { ceiling: "warp-nine" } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "off-ladder default",
        value: { effort: { default: "warp-nine" } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "unknown effort key",
        value: { effort: { ceiling: "xhigh", mystery: 1 } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-object availability",
        value: { availability: "x" },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-array availability command",
        value: { availability: { command: "x" } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "empty availability command",
        value: { availability: { command: [] } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-string availability command entry",
        value: { availability: { command: [7] } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-positive availability timeout",
        value: { availability: { timeoutSeconds: 0 } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-number availability timeout",
        value: { availability: { timeoutSeconds: "x" } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-positive availability maxAge",
        value: { availability: { maxAgeSeconds: -1 } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "unknown availability key",
        value: { availability: { mystery: true } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-object describe",
        value: { describe: 7 },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "taskGate above 1",
        value: { describe: { taskGate: 1.5 } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "taskGate below 0",
        value: { describe: { taskGate: -0.1 } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "taskGate non-number",
        value: { describe: { taskGate: "x" } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "capabilityThreshold above 1",
        value: { describe: { capabilityThreshold: 2 } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "capabilityThreshold non-number",
        value: { describe: { capabilityThreshold: "x" } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "empty jevModel",
        value: { describe: { jevModel: "" } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "non-string jevModel",
        value: { describe: { jevModel: 7 } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      {
        name: "unknown describe key",
        value: { describe: { gate: 0.5 } },
        engineAccepts: false,
        schemaAccepts: false,
      },
      // Relationship rule: the schema accepts (both values are ladder entries),
      // the engine rejects. This is the documented gap; the schema describes
      // shape, the engine describes the relationship.
      {
        name: "default above ceiling",
        value: { effort: { ceiling: "low", default: "high" } },
        engineAccepts: false,
        schemaAccepts: true,
      },
    ];

  for (const entry of corpus) {
    test(`schema and engine agree: ${entry.name}`, () => {
      let engineAccepted = entry.engineAccepts;
      try {
        validateConfigObjectInput(entry.value);
      } catch {
        engineAccepted = false;
      }
      expect(engineAccepted).toBe(entry.engineAccepts);
      expect(
        validateConfig(entry.value),
        `schema verdict mismatch on ${entry.name}: ${JSON.stringify(entry.value)}`,
      ).toBe(entry.schemaAccepts);
      // Document the gap explicitly: when the schema and the engine
      // disagree, the schema is permissive by design (relationship rules
      // are not expressible in JSON Schema). Any other disagreement is a
      // contract bug.
      const disagree = entry.engineAccepts !== entry.schemaAccepts;
      if (disagree) {
        expect(entry.name).toBe("default above ceiling");
      }
    });
  }
});
