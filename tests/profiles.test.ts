import { readFileSync } from "node:fs";
import { loadRegistry } from "@dungle-scrubs/model-registry";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";
import answerSchema from "../answer.schema.json" with { type: "json" };
import querySchema from "../query.schema.json" with { type: "json" };
import { runCli } from "../src/cli-run.js";
import {
  type AppliedQuery,
  defaultConfig,
  describe as describeStep,
  type Query,
  rank,
} from "../src/index.js";
import {
  captureStream,
  errorMatching,
  expectActionable,
  expectValidAnswer,
  expectValidError,
  fixturePath,
  runBuiltCli,
  withEnv,
  withTempDir,
  writeJson,
} from "./helpers.js";

const REGISTRY = fixturePath("profiles.json");
const A = "model-a@harness-x/provider-a";
const B = "model-a@harness-x/provider-b";
const C = "model-a@harness-x/provider-c";
const options = { registry: REGISTRY, config: defaultConfig() };
function ranked(
  query: unknown,
  availability?: NonNullable<Parameters<typeof rank>[1]>["availability"],
) {
  const answer = rank(query, {
    ...options,
    ...(availability === undefined ? {} : { availability }),
  });
  expectValidAnswer(answer);
  return answer;
}
function labels(answer: ReturnType<typeof rank>) {
  return answer.routes.map((route) => route.label);
}
function rawRegistry() {
  return JSON.parse(readFileSync(REGISTRY, "utf8"));
}
async function runBoth(args: string[], profile: string | undefined) {
  const results = [runBuiltCli(args, { MODEL_ROUTER_PROFILE: profile })];
  await withEnv({ MODEL_ROUTER_PROFILE: profile }, async () => {
    const out = captureStream();
    const err = captureStream();
    const exitCode = await runCli(args, { stdout: out.stream, stderr: err.stream });
    const stderr = err.text();
    if (stderr.length > 0) expectValidError(JSON.parse(stderr));
    results.push({ exitCode, stdout: out.text(), stderr });
  });
  return results;
}

describe("profile membership", () => {
  test("library restricts candidates before hard limits and preserves ranked label order", () => {
    const query: Query = { minimums: {}, profile: "budget" };
    const answer = ranked(query);
    const profile: AppliedQuery["profile"] = answer.query.profile;
    const name: string = profile;
    expect(labels(answer)).toEqual([A, C]);
    expect(name).toBe("budget");
    expect(answer.contract).toBe(1);
    expect(answer.removed).toEqual([]);
    const limited = ranked({ minimums: {}, profile: "budget", privacy: "secret" });
    expect(labels(limited)).toEqual([A]);
    expect(limited.removed.map((route) => route.label)).toEqual([C]);
  });

  test("library defaults to default and never reads the CLI profile variable", async () => {
    await withEnv({ MODEL_ROUTER_PROFILE: "budget" }, () => {
      const answer = ranked({ minimums: {} });
      expect(labels(answer)).toEqual([B, A, C]);
      expect(answer.query.profile).toBe("default");
    });
  });

  test.each(["__proto__", "constructor"])("selects the own profile %s", (profile) => {
    const answer = ranked({ minimums: {}, profile });
    expect(labels(answer)).toEqual([profile === "__proto__" ? A : C]);
    expect(answer.query.profile).toBe(profile);
  });

  test.each(["nope", "", "toString"])("unknown profile %s fails without fallback", (profile) => {
    expect(() => ranked({ minimums: {}, profile })).toThrow(
      errorMatching({
        code: "profile-unknown",
        field: "profile",
        problems: [],
        message: `the profile "${profile}" is not declared in the registry`,
        fix: 'Select one of the registry profiles: "default", "budget", "__proto__", "constructor".',
      }),
    );
  });

  test("an inherited profile is not a loader key", () => {
    const loaded = loadRegistry({ path: REGISTRY });
    const profiles = Object.assign(
      Object.create({ inherited: loaded.profiles.budget }),
      loaded.profiles,
    );
    expect(() =>
      rank(
        { minimums: {}, profile: "inherited" },
        { ...options, registry: { ...loaded, profiles } },
      ),
    ).toThrow(errorMatching({ code: "profile-unknown", field: "profile", problems: [] }));
  });

  test("loader, sections, query and config failures precede profile lookup", () => {
    for (const [registry, query, config, code] of [
      [
        fixturePath("no-router.json"),
        { minimums: {}, profile: "nope" },
        {},
        "registry-sections-invalid",
      ],
      [REGISTRY, { profile: "nope" }, {}, "query-invalid"],
      [REGISTRY, { minimums: {}, profile: "nope" }, { unknown: true }, "config-invalid"],
    ] as const) {
      expect(() => rank(query, { registry, config })).toThrow(errorMatching({ code }));
    }
  });

  test("CLI keeps section failures ahead of malformed queries and profile lookup", async () => {
    for (const query of ["{oops", '{"minimums":{},"profile":"nope","unknown":true}']) {
      for (const result of await runBoth(
        [query, "--registry", fixturePath("no-router.json")],
        "budget",
      )) {
        expect(result.exitCode).toBe(4);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr).error.code).toBe("registry-sections-invalid");
      }
    }
  });

  test("a declared default uses only its explicit membership", async () => {
    await withTempDir((dir) => {
      const raw = rawRegistry();
      raw.profiles.default = { description: "Selected default.", routes: [C] };
      const answer = rank(
        { minimums: {} },
        { ...options, registry: writeJson(dir, "registry.json", raw) },
      );
      expectValidAnswer(answer);
      expect(answer.query.profile).toBe("default");
      expect(labels(answer)).toEqual([C]);
      expect(answer.removed).toEqual([]);
    });
  });

  test("an empty profile returns an empty answer without borrowing default", async () => {
    await withTempDir((dir) => {
      const raw = rawRegistry();
      raw.profiles.budget.routes = [];
      const answer = rank(
        { task: "task-a", profile: "budget", pin: A },
        { ...options, registry: writeJson(dir, "registry.json", raw) },
      );
      expectValidAnswer(answer);
      expect(labels(answer)).toEqual([]);
      expect(answer.removed).toEqual([]);
      expect(answer.pin).toEqual({ label: A, used: false, reason: "pin-outside-profile" });
    });
  });

  test("speed, floors and effort still apply inside membership", () => {
    const speed = ranked({ minimums: {}, prefer: "speed", profile: "budget", effort: "xhigh" });
    expect(labels(speed)).toEqual([C, A]);
    expect(speed.routes.every((route) => route.effort === "high")).toBe(true);
    expect(speed.warnings.filter((warning) => warning.code === "effort-above-max")).toHaveLength(2);
    const below = ranked({ minimums: { coding: 9 }, prefer: "speed", profile: "budget" });
    expect(labels(below)).toEqual([A, C]);
    expect(below.routes.every((route) => route.floor === "below")).toBe(true);
  });

  test("exhausted-all retention counts only profile members", () => {
    const answer = ranked({ minimums: {}, profile: "budget", pin: A }, [
      { meter: "meter-a", status: "exhausted" },
    ]);
    expect(labels(answer)).toEqual([A, C]);
    expect(answer.routes.every((route) => route.availability === "exhausted")).toBe(true);
    expect(answer.removed).toEqual([]);
    expect(answer.pin?.used).toBe(true);
    expect(answer.query.profile).toBe("budget");
    expect(answer.warnings.map((warning) => warning.code)).toContain("availability-exhausted-all");
  });

  test("the exhausted-pin early answer carries its profile", async () => {
    await withTempDir((dir) => {
      const raw = rawRegistry();
      delete raw.models["model-a"].routes[2].meter;
      const answer = rank(
        { minimums: {}, profile: "budget", pin: A },
        {
          ...options,
          registry: writeJson(dir, "registry.json", raw),
          availability: [{ meter: "meter-a", status: "exhausted" }],
        },
      );
      expectValidAnswer(answer);
      expect(labels(answer)).toEqual([C]);
      expect(answer.query.profile).toBe("budget");
      expect(answer.pin).toEqual({ label: A, used: false, reason: "meter-exhausted" });
    });
  });
});

describe("describe profile validation", () => {
  function unknownProfile(profile: string) {
    return errorMatching({
      code: "profile-unknown",
      field: "profile",
      problems: [],
      message: `the profile "${profile}" is not declared in the registry`,
      fix: 'Select one of the registry profiles: "default", "budget", "__proto__", "constructor".',
    });
  }

  test("unknown profile fails before a needed Jev request", async () => {
    await withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        await expect(
          describeStep("some work", { privacy: "normal", profile: "nope" }, options),
        ).rejects.toThrow(unknownProfile("nope"));
      } finally {
        try {
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          fetchSpy.mockRestore();
        }
      }
    });
  });

  test.each(["nope", "", "toString"])(
    "unknown profile %s fails even with nothing to ask",
    async (profile) => {
      await expect(
        describeStep("some work", { privacy: "normal", task: "task-a", profile }, options),
      ).rejects.toThrow(unknownProfile(profile));
    },
  );

  test("an inherited profile is rejected before the nothing-to-ask return", async () => {
    const loaded = loadRegistry({ path: REGISTRY });
    const profiles = Object.create(
      { inherited: loaded.profiles.budget },
      Object.getOwnPropertyDescriptors(loaded.profiles),
    );
    await expect(
      describeStep(
        "some work",
        { privacy: "normal", task: "task-a", profile: "inherited" },
        { ...options, registry: { ...loaded, profiles } },
      ),
    ).rejects.toThrow(unknownProfile("inherited"));
  });

  test("the library ignores the CLI profile variable and leaves profile absent", async () => {
    await withEnv({ MODEL_ROUTER_PROFILE: "nope" }, async () => {
      const result = await describeStep(
        "some work",
        { privacy: "normal", task: "task-a" },
        options,
      );
      expect(result.query.profile).toBeUndefined();
      expect(Object.hasOwn(result.query, "profile")).toBe(false);
    });
  });

  test.each([
    [fixturePath("no-router.json"), {}, "registry-sections-invalid"],
    [REGISTRY, { unknown: true }, "config-invalid"],
  ] as const)("sections and config precede profile lookup: %s", async (registry, config, code) => {
    await expect(
      describeStep(
        "some work",
        { privacy: "normal", task: "task-a", profile: "nope" },
        { registry, config },
      ),
    ).rejects.toThrow(errorMatching({ code }));
  });

  test.each(["query", "variable"])(
    "CLI rejects unknown describe profile from %s without a key",
    async (source) => {
      await withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
        const query = { privacy: "normal", ...(source === "query" ? { profile: "nope" } : {}) };
        const results = await runBoth(
          [
            JSON.stringify(query),
            "--registry",
            REGISTRY,
            "--describe",
            fixturePath("profile-work.txt"),
          ],
          source === "variable" ? "nope" : undefined,
        );
        for (const result of results) {
          expect.soft(result.exitCode).toBe(2);
          expect.soft(result.stdout).toBe("");
          expect.soft(JSON.parse(result.stderr).error).toMatchObject({
            code: "profile-unknown",
            field: "profile",
          });
        }
      });
    },
  );

  test.each(["query", "variable"])(
    "in-process CLI rejects unknown describe profile from %s before fetch",
    async (source) => {
      await withEnv(
        {
          TYPESAFE_API_KEY: "key-a",
          MODEL_ROUTER_PROFILE: source === "variable" ? "nope" : undefined,
        },
        async () => {
          const fetchSpy = vi.spyOn(globalThis, "fetch");
          try {
            const out = captureStream();
            const err = captureStream();
            const query = { privacy: "normal", ...(source === "query" ? { profile: "nope" } : {}) };
            const exitCode = await runCli(
              [
                JSON.stringify(query),
                "--registry",
                REGISTRY,
                "--describe",
                fixturePath("profile-work.txt"),
              ],
              { stdout: out.stream, stderr: err.stream },
            );
            expect(exitCode).toBe(2);
            expect(out.text()).toBe("");
            const envelope = JSON.parse(err.text());
            expectValidError(envelope);
            expect(envelope.error.code).toBe("profile-unknown");
          } finally {
            try {
              expect(fetchSpy).not.toHaveBeenCalled();
            } finally {
              fetchSpy.mockRestore();
            }
          }
        },
      );
    },
  );
});

describe("pins and policies stay inside the profile", () => {
  test("outside pin is unused before hard-limit and availability checks", () => {
    const answer = ranked({ minimums: {}, profile: "budget", pin: B, privacy: "secret" }, [
      { meter: "meter-a", status: "exhausted" },
    ]);
    expect(labels(answer)).toEqual([A]);
    expect(answer.pin).toEqual({ label: B, reason: "pin-outside-profile", used: false });
    const warning = answer.warnings.find((item) => item.code === "pin-unused");
    expect(warning).toEqual({
      code: "pin-unused",
      field: "$.pin",
      message: `the pin "${B}" was not used; it is outside profile "budget"`,
      fix: 'Choose a pin inside profile "budget", or select another profile.',
    });
    expectActionable(warning);
    expect(answer.removed.map((route) => route.label)).toEqual([C]);
  });

  test("unknown pins and hard-limited member pins keep their existing reasons", () => {
    const unknown = ranked({ minimums: {}, profile: "budget", pin: "model-missing@harness-x" });
    expect(unknown.pin?.reason).toBe("unknown-label");
    expect(unknown.warnings.map((item) => item.code)).toContain("pin-unknown");
    const limited = ranked({ minimums: {}, profile: "budget", pin: C, privacy: "secret" });
    expect(limited.pin?.reason).toBe("privacy-secret-not-eligible");
    expect(limited.warnings.map((item) => item.code)).toContain("pin-unused");
  });

  test("member pins still lead policy placement and use its effort", () => {
    const answer = ranked({ task: "task-a", profile: "budget", pin: A });
    expect(labels(answer)).toEqual([A, C]);
    expect(answer.pin).toEqual({ label: A, used: true, reason: "" });
    expect(answer.routes[0]).toMatchObject({ placedBy: "pin", floor: "skipped", effort: "low" });
  });

  test("outside policy route is omitted with policy, route and profile named", () => {
    const answer = ranked({ task: "task-a", profile: "budget" });
    expect(labels(answer)).toEqual([A, C]);
    expect(answer.removed).toEqual([]);
    expect(answer.routes[0]).toMatchObject({
      placedBy: "policy",
      policy: "policy-a",
      floor: "skipped",
      effort: "low",
    });
    const warning = answer.warnings.find((item) => item.code === "policy-route-outside-profile");
    expect(warning).toEqual({
      code: "policy-route-outside-profile",
      field: '$.policy["policy-a"].routes',
      message: `the policy "policy-a" names the route "${B}", which is outside profile "budget"`,
      fix: 'Adjust policy "policy-a" or profile "budget" so the route is a member.',
    });
    expectActionable(warning);
  });

  test("hard-limited member policy routes still warn policy-route-removed", () => {
    const answer = ranked({ task: "task-a", profile: "budget", excludeFamilies: ["family-a"] });
    expect(labels(answer)).toEqual([]);
    expect(answer.removed.map((route) => route.label)).toEqual([A, C]);
    expect(
      answer.warnings
        .filter((item) => item.code.startsWith("policy-route-"))
        .map((item) => item.code),
    ).toEqual(["policy-route-outside-profile", "policy-route-removed"]);
  });
});

describe("built CLI profile selection", () => {
  test.each([
    ["query field", "budget", undefined, "budget", [A, C]],
    ["variable", undefined, "budget", "budget", [A, C]],
    ["field beats variable", "budget", "nope", "budget", [A, C]],
    ["default", undefined, undefined, "default", [B, A, C]],
    ["empty variable is unset", undefined, "", "default", [B, A, C]],
    ["explicit default beats variable", "default", "budget", "default", [B, A, C]],
  ] as const)(
    "%s applies on plain and describe ranking paths",
    async (_name, profile, env, expected, expectedLabels) => {
      for (const described of [false, true]) {
        const query = {
          minimums: {},
          privacy: "normal",
          ...(profile === undefined ? {} : { profile }),
        };
        const args = [JSON.stringify(query), "--registry", REGISTRY];
        if (described) args.push("--describe", fixturePath("profile-work.txt"));
        for (const result of await runBoth(args, env)) {
          expect(result.exitCode, result.stderr).toBe(0);
          const answer = JSON.parse(result.stdout);
          expectValidAnswer(answer);
          expect(answer.query.profile).toBe(expected);
          expect(labels(answer)).toEqual(expectedLabels);
          expect(answer.describe === null).toBe(!described);
        }
      }
    },
  );

  test.each(["query", "variable", "empty query"])(
    "unknown profile from %s fails at exit 2",
    async (source) => {
      const query = {
        minimums: {},
        ...(source === "query"
          ? { profile: "nope" }
          : source === "empty query"
            ? { profile: "" }
            : {}),
      };
      for (const result of await runBoth(
        [JSON.stringify(query), "--registry", REGISTRY],
        source === "variable" ? "nope" : "budget",
      )) {
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        const envelope = JSON.parse(result.stderr).error;
        expect(envelope).toMatchObject({ code: "profile-unknown", field: "profile", problems: [] });
        expect(envelope.fix).toBe(
          'Select one of the registry profiles: "default", "budget", "__proto__", "constructor".',
        );
        expectActionable(envelope);
      }
    },
  );
});

describe("additive profile schemas", () => {
  const ajv = new Ajv2020({ allErrors: true });
  const validateQuery = ajv.compile(querySchema);
  const validateAnswer = ajv.compile(answerSchema);
  test("query accepts a profile string, including empty, but rejects other types", () => {
    expect(validateQuery({ minimums: {}, profile: "budget" })).toBe(true);
    expect(validateQuery({ minimums: {}, profile: "" })).toBe(true);
    expect(validateQuery({ minimums: {}, profile: 1 })).toBe(false);
  });
  test("answer accepts string profile and legacy answers but rejects non-string profile", () => {
    const answer = ranked({ minimums: {} });
    expect(validateAnswer(answer)).toBe(true);
    const { profile: _profile, ...query } = answer.query;
    expect(validateAnswer({ ...answer, query })).toBe(true);
    expectValidAnswer({ ...answer, query });
    expect(validateAnswer({ ...answer, query: { ...query, profile: 1 } })).toBe(false);
  });
  test("describe preserves profile in its partial and filled queries", async () => {
    const result = await describeStep(
      "Write code.",
      { minimums: {}, privacy: "normal", profile: "budget" },
      options,
    );
    expect(result.query).toMatchObject({ profile: "budget", minimums: {}, privacy: "normal" });
    const answer = rank(result.query, options);
    expectValidAnswer(answer);
    expect(answer.query.profile).toBe("budget");
    expect(labels(answer)).toEqual([A, C]);
  });
});
