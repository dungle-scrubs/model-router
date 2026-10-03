import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "@dungle-scrubs/model-registry";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RouterError } from "../src/error.js";
import { validateRouterSections } from "../src/sections.js";
import { repoRoot } from "./helpers.js";

const routerSectionsSchemaPath = join(repoRoot, "router-sections.schema.json");
const routerSectionsSchema = JSON.parse(readFileSync(routerSectionsSchemaPath, "utf8")) as object;
const validateSections = new Ajv2020({
  allErrors: true,
  strictNumbers: true,
}).compile(routerSectionsSchema);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-router-sections-schema-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registryFile(value: unknown): string {
  const path = join(dir, "registry.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function load(value: unknown) {
  return loadRegistry({ path: registryFile(value) });
}

const VALID_RATINGS = { coding: "Writes and changes code to a spec." };
const VALID_ROUTER = { rank: ["coding"] };

describe("router-sections.schema.json", () => {
  test("a router section with just rank is valid", () => {
    expect(validateSections({ router: VALID_ROUTER })).toBe(true);
  });

  test("a router section with rank and questions is valid", () => {
    expect(
      validateSections({
        router: { rank: ["coding"], questions: { browser: "Do you need a browser?" } },
      }),
    ).toBe(true);
  });

  test("a tasks section with one valid task is valid", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      }),
    ).toBe(true);
  });

  test("a policy section with one valid policy is valid", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "model-a@harness-x" }],
            reason: "First.",
          },
        },
      }),
    ).toBe(true);
  });

  test("rejects a router section that is missing", () => {
    expect(validateSections({})).toBe(false);
  });

  test("rejects a router section that is not an object", () => {
    expect(validateSections({ router: "oops" })).toBe(false);
  });

  test("rejects a router section with no rank", () => {
    expect(validateSections({ router: {} })).toBe(false);
  });

  test("rejects a router section with an empty rank", () => {
    expect(validateSections({ router: { rank: [] } })).toBe(false);
  });

  test("rejects a router section with a non-string rank entry", () => {
    expect(validateSections({ router: { rank: [7] } })).toBe(false);
  });

  test("rejects a router section with an unknown key", () => {
    expect(validateSections({ router: { rank: ["coding"], mystery: true } })).toBe(false);
  });

  test("rejects a router questions section that is not an object", () => {
    expect(validateSections({ router: { rank: ["coding"], questions: "x" } })).toBe(false);
  });

  test("rejects a router questions entry that is not a string", () => {
    expect(validateSections({ router: { rank: ["coding"], questions: { browser: 7 } } })).toBe(
      false,
    );
  });

  test("rejects a tasks section that is not an object", () => {
    expect(validateSections({ router: VALID_ROUTER, tasks: "oops" })).toBe(false);
  });

  test("rejects a task that is not an object", () => {
    expect(validateSections({ router: VALID_ROUTER, tasks: { "task-a": "oops" } })).toBe(false);
  });

  test("rejects a task missing description", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a task missing minimums", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: { "task-a": { description: "Code.", rank: ["coding"] } },
      }),
    ).toBe(false);
  });

  test("rejects a task missing one stakes entry in minimums", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a task minimums with an unknown stakes key", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: {
              low: { coding: 6 },
              normal: { coding: 7 },
              high: { coding: 8 },
              urgent: { coding: 9 },
            },
            rank: ["coding"],
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a task minimums stake that is not an object", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: "oops", normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a task minimum value that is not a number", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: "6" }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a task missing rank", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects an empty task rank", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: [],
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a non-array task needs", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
            needs: "repo-access",
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a non-string task needs entry", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
            needs: [7],
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a task effort off the ladder", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
            effort: "warp-nine",
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a task with an unknown key", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
            mystery: true,
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy that is not an object", () => {
    expect(validateSections({ router: VALID_ROUTER, policy: { "policy-a": "oops" } })).toBe(false);
  });

  test("rejects a policy missing task", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": { stakes: ["low"], routes: [{ route: "x@y" }], reason: "First." },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy missing stakes", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": { task: "task-a", routes: [{ route: "x@y" }], reason: "First." },
        },
      }),
    ).toBe(false);
  });

  test("rejects an empty policy stakes array", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": { task: "task-a", stakes: [], routes: [{ route: "x@y" }], reason: "First." },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy stakes entry off the allowed list", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["urgent"],
            routes: [{ route: "x@y" }],
            reason: "First.",
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy missing routes", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: { "policy-a": { task: "task-a", stakes: ["low"], reason: "First." } },
      }),
    ).toBe(false);
  });

  test("rejects an empty policy routes array", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": { task: "task-a", stakes: ["low"], routes: [], reason: "First." },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy route that is not an object", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: ["x@y"],
            reason: "First.",
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy route missing the route label", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": { task: "task-a", stakes: ["low"], routes: [{}], reason: "First." },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy route with an unknown key", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y", mystery: true }],
            reason: "First.",
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy missing reason", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy reason that is not a string", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: 7,
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy spec that is not 'settled'", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: "First.",
            spec: "open",
          },
        },
      }),
    ).toBe(false);
  });

  test("accepts a policy with spec 'settled'", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: "First.",
            spec: "settled",
          },
        },
      }),
    ).toBe(true);
  });

  test("rejects a policy since that is not a string", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: "First.",
            since: 7,
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects a policy with an unknown key", () => {
    expect(
      validateSections({
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: "First.",
            mystery: true,
          },
        },
      }),
    ).toBe(false);
  });
});

describe("router-sections.schema.json agrees with validateRouterSections", () => {
  // The schema describes the shape the engine accepts. The schema cannot
  // express cross-reference rules (an undeclared rating, an undeclared
  // route label, two policies tied on the same query), so those rejections
  // come from the engine alone and are skipped here. Every shape
  // rejection is reported by both.
  const corpus: {
    name: string;
    value: unknown;
    schemaPasses: boolean;
    enginePasses: boolean;
  }[] = [
    // Acceptances.
    {
      name: "router only",
      value: { router: VALID_ROUTER },
      schemaPasses: true,
      enginePasses: true,
    },
    {
      name: "router with questions",
      value: { router: { rank: ["coding"], questions: { browser: "x" } } },
      schemaPasses: true,
      enginePasses: true,
    },
    {
      name: "valid task",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
      schemaPasses: true,
      enginePasses: true,
    },
    {
      name: "valid policy",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: "First.",
          },
        },
      },
      schemaPasses: true,
      enginePasses: true,
    },
    // Shape rejections the schema expresses.
    { name: "missing router", value: {}, schemaPasses: false, enginePasses: false },
    {
      name: "non-object router",
      value: { router: "oops" },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "router with no rank",
      value: { router: {} },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "router with empty rank",
      value: { router: { rank: [] } },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "router with non-string rank entry",
      value: { router: { rank: [7] } },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "router with unknown key",
      value: { router: { rank: ["coding"], mystery: true } },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "router questions not object",
      value: { router: { rank: ["coding"], questions: "x" } },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "router questions entry not string",
      value: { router: { rank: ["coding"], questions: { browser: 7 } } },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "tasks not object",
      value: { router: VALID_ROUTER, tasks: "oops" },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task not object",
      value: { router: VALID_ROUTER, tasks: { "task-a": "oops" } },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task missing description",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task missing minimums",
      value: {
        router: VALID_ROUTER,
        tasks: { "task-a": { description: "Code.", rank: ["coding"] } },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task missing one stakes",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task minimums with unknown stakes",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: {
              low: { coding: 6 },
              normal: { coding: 7 },
              high: { coding: 8 },
              urgent: { coding: 9 },
            },
            rank: ["coding"],
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task minimums stake not object",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: "oops", normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task minimum value not number",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: "6" }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task missing rank",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task empty rank",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: [],
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task needs not array",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
            needs: "repo-access",
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task needs entry not string",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
            needs: [7],
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task effort off ladder",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
            effort: "warp-nine",
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "task unknown key",
      value: {
        router: VALID_ROUTER,
        tasks: {
          "task-a": {
            description: "Code.",
            minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
            rank: ["coding"],
            mystery: true,
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy not object",
      value: { router: VALID_ROUTER, policy: { "policy-a": "oops" } },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy missing task",
      value: {
        router: VALID_ROUTER,
        policy: { "policy-a": { stakes: ["low"], routes: [{ route: "x@y" }], reason: "First." } },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy missing stakes",
      value: {
        router: VALID_ROUTER,
        policy: { "policy-a": { task: "task-a", routes: [{ route: "x@y" }], reason: "First." } },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy empty stakes",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": { task: "task-a", stakes: [], routes: [{ route: "x@y" }], reason: "First." },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy stakes off list",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["urgent"],
            routes: [{ route: "x@y" }],
            reason: "First.",
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy missing routes",
      value: {
        router: VALID_ROUTER,
        policy: { "policy-a": { task: "task-a", stakes: ["low"], reason: "First." } },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy empty routes",
      value: {
        router: VALID_ROUTER,
        policy: { "policy-a": { task: "task-a", stakes: ["low"], routes: [], reason: "First." } },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy route not object",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": { task: "task-a", stakes: ["low"], routes: ["x@y"], reason: "First." },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy route missing label",
      value: {
        router: VALID_ROUTER,
        policy: { "policy-a": { task: "task-a", stakes: ["low"], routes: [{}], reason: "First." } },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy route unknown key",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y", mystery: true }],
            reason: "First.",
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy missing reason",
      value: {
        router: VALID_ROUTER,
        policy: { "policy-a": { task: "task-a", stakes: ["low"], routes: [{ route: "x@y" }] } },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy reason not string",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": { task: "task-a", stakes: ["low"], routes: [{ route: "x@y" }], reason: 7 },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy spec not 'settled'",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: "First.",
            spec: "open",
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy since not string",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: "First.",
            since: 7,
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
    {
      name: "policy unknown key",
      value: {
        router: VALID_ROUTER,
        policy: {
          "policy-a": {
            task: "task-a",
            stakes: ["low"],
            routes: [{ route: "x@y" }],
            reason: "First.",
            mystery: true,
          },
        },
      },
      schemaPasses: false,
      enginePasses: false,
    },
  ];

  for (const entry of corpus) {
    test(`schema and engine agree: ${entry.name}`, async () => {
      // Build a full registry file: the schema only describes the router
      // sections, but the engine reads the whole file. Pad the registry
      // with cross-reference declarations the engine needs to make the
      // shape-only rejection surface.
      const value = entry.value as {
        router?: { questions?: Record<string, string> };
        tasks?: Record<string, unknown>;
        policy?: Record<string, { task?: string; routes?: { route?: string }[] }>;
      };
      const capabilities: Record<string, string> = {};
      if (value.router?.questions !== undefined) {
        for (const capability of Object.keys(value.router.questions)) {
          capabilities[capability] = "a capability";
        }
      }
      const tasks: Record<string, unknown> = value.tasks ?? {};
      if (value.policy !== undefined) {
        for (const policy of Object.values(value.policy)) {
          if (policy.task !== undefined && !(policy.task in tasks)) {
            tasks[policy.task] = {
              description: "Code.",
              minimums: { low: { coding: 6 }, normal: { coding: 7 }, high: { coding: 8 } },
              rank: ["coding"],
            };
          }
        }
      }
      const models: Record<string, unknown> = {};
      if (value.policy !== undefined) {
        for (const policy of Object.values(value.policy)) {
          for (const route of policy.routes ?? []) {
            if (typeof route?.route !== "string") continue;
            const match = route.route.match(/^([^@]+)@([^/]+)(?:\/(.+))?$/);
            if (match === null) continue;
            const [, modelKey, harness, provider] = match;
            if (modelKey === undefined) continue;
            if (models[modelKey] === undefined) {
              models[modelKey] = {
                family: "family-a",
                routes: [
                  {
                    harness,
                    modelId: `${modelKey}-id`,
                    hosted: true,
                    ...(provider !== undefined ? { provider } : {}),
                  },
                ],
              };
            }
          }
        }
      }
      const fullRegistry = {
        format: 1,
        ratings: VALID_RATINGS,
        ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
        router: value.router,
        ...(Object.keys(tasks).length > 0 ? { tasks } : {}),
        ...(value.policy !== undefined ? { policy: value.policy } : {}),
        models,
      };
      const loaded = load(fullRegistry);
      let enginePasses = entry.enginePasses;
      try {
        validateRouterSections(loaded);
      } catch (error) {
        if (!(error instanceof RouterError)) throw error;
        enginePasses = false;
      }
      expect(enginePasses, `engine verdict mismatch on ${entry.name}`).toBe(entry.enginePasses);
      expect(
        validateSections(entry.value),
        `schema verdict mismatch on ${entry.name}: ${JSON.stringify(validateSections.errors)}`,
      ).toBe(entry.schemaPasses);
    });
  }
});
