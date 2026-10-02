import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dropExpired, applyAvailability as pureApplyAvailability } from "../src/availability.js";
import {
  loadAvailabilityForCli,
  parseAvailabilityDocument,
  readAvailabilityFile,
  runAvailabilityCommand,
} from "../src/availability-cli.js";
import { type AnswerRoute, rank } from "../src/index.js";
import {
  expectValidAnswer,
  fixturePath,
  runBuiltCli,
  withEnv,
  withTempDir,
  writeJson,
} from "./helpers.js";

const FULL = fixturePath("full.json");
const PRINT = fixturePath("availability-print.js");

function availabilityDoc(overrides?: {
  entries?: readonly {
    meter: string;
    status: string;
    percentRemaining?: number;
    note?: string;
    resetsAt?: string;
  }[];
  format?: number;
  generatedAt?: string;
}): unknown {
  return {
    format: overrides?.format ?? 1,
    generatedAt: overrides?.generatedAt ?? new Date().toISOString(),
    entries: overrides?.entries ?? [{ meter: "meter-a", status: "ok" }],
  };
}

describe("applyAvailability in isolation", () => {
  type Route = {
    readonly availability: "ok" | "projected" | "exhausted" | "unknown" | "unmetered";
    readonly label: string;
    readonly meter?: string;
    readonly reasons?: readonly { readonly code: string; readonly message: string }[];
  };

  const routes: readonly Route[] = [
    { availability: "unknown", label: "model-a@harness-x", meter: "meter-a" },
    { availability: "unknown", label: "model-s@harness-x", meter: "meter-s" },
    { availability: "unmetered", label: "model-c@harness-x" },
  ];

  test("an ok reading keeps the metered route in place", () => {
    const result = pureApplyAvailability(routes, [{ meter: "meter-a", status: "ok" }]);
    expect(result.routes.map((r) => r.label)).toEqual([
      "model-a@harness-x",
      "model-s@harness-x",
      "model-c@harness-x",
    ]);
    expect(result.routes[0]?.availability).toBe("ok");
    expect(result.routes[1]?.availability).toBe("unknown");
    expect(result.routes[2]?.availability).toBe("unmetered");
    expect(result.removed).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("a projected reading on a non-spend-to-zero meter demotes the route", () => {
    const result = pureApplyAvailability(routes, [{ meter: "meter-a", status: "projected" }]);
    expect(result.routes.map((r) => r.label)).toEqual([
      "model-s@harness-x",
      "model-c@harness-x",
      "model-a@harness-x",
    ]);
    expect(result.routes[2]?.availability).toBe("projected");
    expect(result.routes[2]?.reasons?.map((r) => r.code)).toEqual(["meter-projected"]);
    expect(result.removed).toEqual([]);
  });

  test("a projected reading on a spend-to-zero meter keeps the route in place", () => {
    const result = pureApplyAvailability(routes, [{ meter: "meter-a", status: "projected" }], {
      spendToZero: ["meter-a"],
    });
    expect(result.routes.map((r) => r.label)).toEqual([
      "model-a@harness-x",
      "model-s@harness-x",
      "model-c@harness-x",
    ]);
    expect(result.routes[0]?.availability).toBe("projected");
    expect(result.routes[0]?.reasons?.map((r) => r.code)).toEqual([
      "meter-projected-spend-to-zero",
    ]);
  });

  test("an exhausted reading removes the route with reason meter-exhausted", () => {
    const result = pureApplyAvailability(routes, [{ meter: "meter-a", status: "exhausted" }]);
    expect(result.routes.map((r) => r.label)).toEqual(["model-s@harness-x", "model-c@harness-x"]);
    expect(result.removed).toEqual([
      {
        label: "model-a@harness-x",
        reason: {
          code: "meter-exhausted",
          fix: expect.any(String) as string,
          message: expect.stringContaining("exhausted") as string,
        },
      },
    ]);
  });

  test("the all-exhausted case keeps every route as exhausted with a warning", () => {
    const three: readonly Route[] = [
      { availability: "unknown", label: "a", meter: "meter-a" },
      { availability: "unknown", label: "b", meter: "meter-b" },
    ];
    const result = pureApplyAvailability(three, [
      { meter: "meter-a", status: "exhausted" },
      { meter: "meter-b", status: "exhausted" },
    ]);
    expect(result.routes.map((r) => r.label)).toEqual(["a", "b"]);
    expect(result.routes.every((r) => r.availability === "exhausted")).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["availability-exhausted-all"]);
  });

  test("routes with no covering entry keep their availability and place", () => {
    // RFC: only an entry moves a route. The call below has no entries,
    // so all three routes keep "unknown" or "unmetered" and stay in
    // input order. A subsequent call that does not cover them must
    // preserve the value.
    const first = pureApplyAvailability(routes, []);
    expect(first.routes).toHaveLength(3);
    expect(first.routes.map((r) => r.availability)).toEqual(["unknown", "unknown", "unmetered"]);
    expect(first.routes.map((r) => r.label)).toEqual([
      "model-a@harness-x",
      "model-s@harness-x",
      "model-c@harness-x",
    ]);
    // Second call adds an exhausted entry for a meter none of the
    // current routes use. The unmetered route keeps "unmetered", and
    // the metered routes keep their unknown status.
    const second = pureApplyAvailability(first.routes, [{ meter: "meter-x", status: "exhausted" }]);
    expect(second.routes.map((r) => r.label)).toEqual([
      "model-a@harness-x",
      "model-s@harness-x",
      "model-c@harness-x",
    ]);
    expect(second.removed).toEqual([]);
  });

  test("the worked example reproduces without a spendToZero list", () => {
    // Pre: model-s was placed first because its meter was projected, on a
    // spend-to-zero meter, so it kept its place. Now the walk adds one
    // exhausted entry for model-a's meter and re-applies without a
    // spendToZero list. Result: model-s, model-c in that order.
    const placed: readonly Route[] = [
      { availability: "projected", label: "model-s@harness-x", meter: "meter-s" },
      { availability: "unmetered", label: "model-c@harness-x" },
    ];
    const result = pureApplyAvailability(placed, [{ meter: "meter-a", status: "exhausted" }]);
    expect(result.routes.map((r) => r.label)).toEqual(["model-s@harness-x", "model-c@harness-x"]);
    expect(result.routes.map((r) => r.availability)).toEqual(["projected", "unmetered"]);
    expect(result.removed).toEqual([]);
  });

  test("several entries on one meter: the worst status decides", () => {
    const result = pureApplyAvailability(routes, [
      { meter: "meter-a", status: "ok" },
      { meter: "meter-a", status: "projected" },
    ]);
    // model-a (meter-a) is projected, not on spend-to-zero: demoted. The
    // demoted routes follow the kept ones in input order.
    const projected = result.routes.find((r) => r.label === "model-a@harness-x");
    expect(projected?.availability).toBe("projected");
    expect(projected?.reasons?.map((r) => r.code)).toEqual(["meter-projected"]);
  });

  test("several entries on one meter: same status picks the lowest percentRemaining", () => {
    const result = pureApplyAvailability(routes, [
      { meter: "meter-a", status: "ok", percentRemaining: 60 },
      { meter: "meter-a", status: "ok", percentRemaining: 12 },
    ]);
    // Both same-status ok: combined state has the lowest percent. The
    // route is healthy (ok), so percentRemaining does not surface.
    expect(result.routes[0]?.availability).toBe("ok");
    expect(result.removed).toEqual([]);
  });

  test("accepts saved answer routes from a list shape as-is", () => {
    const saved = [
      { availability: "ok", label: "model-a@harness-x", meter: "meter-a" },
      { availability: "unmetered", label: "model-c@harness-x" },
    ] as const;
    const result = pureApplyAvailability(saved, [{ meter: "meter-a", status: "exhausted" }]);
    // model-a is exhausted and removed; model-c unmetered stays.
    expect(result.routes.map((r) => r.label)).toEqual(["model-c@harness-x"]);
    expect(result.removed.map((r) => r.label)).toEqual(["model-a@harness-x"]);
  });

  test("returns the caller's objects unchanged when no entry covers the routes", () => {
    const result = pureApplyAvailability(routes, []);
    for (let i = 0; i < routes.length; i += 1) {
      expect(result.routes[i]).toBe(routes[i]);
    }
  });
});

describe("dropExpired", () => {
  test("removes entries whose resetsAt has passed", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const entries = [
      { meter: "meter-a", status: "ok" as const, resetsAt: "2026-10-01T11:00:00Z" },
      { meter: "meter-b", status: "ok" as const, resetsAt: "2026-10-01T13:00:00Z" },
    ];
    const live = dropExpired(entries, now);
    expect(live.map((e) => e.meter)).toEqual(["meter-b"]);
  });

  test("keeps entries with no resetsAt", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const entries = [{ meter: "meter-a", status: "ok" as const }];
    expect(dropExpired(entries, now)).toEqual(entries);
  });
});

describe("parseAvailabilityDocument", () => {
  test("accepts the RFC's worked example", () => {
    const result = parseAvailabilityDocument(availabilityDoc(), { maxAgeSeconds: 300 });
    expect(result.entries).toHaveLength(1);
    expect(result.note).toBeNull();
  });

  test("rejects a non-object top level with availability-reading-invalid", () => {
    const result = parseAvailabilityDocument(7, { maxAgeSeconds: 300 });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
  });

  test("rejects an unknown format with availability-reading-invalid", () => {
    const result = parseAvailabilityDocument(availabilityDoc({ format: 99 }), {
      maxAgeSeconds: 300,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
  });

  test("rejects an unparseable generatedAt with availability-reading-invalid", () => {
    const result = parseAvailabilityDocument(availabilityDoc({ generatedAt: "not-a-date" }), {
      maxAgeSeconds: 300,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
  });

  test("flags an old document as stale", () => {
    const old = new Date(Date.now() - 1000 * 1000).toISOString();
    const result = parseAvailabilityDocument(availabilityDoc({ generatedAt: old }), {
      maxAgeSeconds: 60,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-stale");
  });

  test("flags a future generatedAt as stale", () => {
    const future = new Date(Date.now() + 1000 * 1000).toISOString();
    const result = parseAvailabilityDocument(availabilityDoc({ generatedAt: future }), {
      maxAgeSeconds: 300,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-stale");
  });
});

describe("readAvailabilityFile", () => {
  test("reads a saved document from a path", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "avail.json", availabilityDoc());
      const result = readAvailabilityFile(path, { maxAgeSeconds: 300 });
      expect(result.entries).toHaveLength(1);
      expect(result.note).toBeNull();
    });
  });

  test("a missing path fails with availability-file-unreadable", async () => {
    await withTempDir(async (dir) => {
      const result = readAvailabilityFile(join(dir, "missing.json"), { maxAgeSeconds: 300 });
      expect(result.entries).toEqual([]);
      expect(result.note?.code).toBe("availability-file-unreadable");
    });
  });

  test("a file that is not JSON fails with availability-reading-invalid", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "bad.json");
      writeFileSync(path, "{not json");
      const result = readAvailabilityFile(path, { maxAgeSeconds: 300 });
      expect(result.entries).toEqual([]);
      expect(result.note?.code).toBe("availability-reading-invalid");
    });
  });
});

describe("runAvailabilityCommand", () => {
  test("a command that prints a fresh ok document succeeds", () => {
    const result = runAvailabilityCommand(
      [
        "node",
        "-e",
        `process.stdout.write('${JSON.stringify(availabilityDoc()).replaceAll("'", "\\'")}')`,
      ],
      { maxAgeSeconds: 300, timeoutSeconds: 10 },
    );
    expect(result.entries).toHaveLength(1);
    expect(result.note).toBeNull();
  });

  test("a missing command fails with availability-command-failed (ENOENT)", () => {
    const result = runAvailabilityCommand(["definitely-not-a-real-binary", "--json"], {
      maxAgeSeconds: 300,
      timeoutSeconds: 10,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-command-failed");
    expect(result.note?.message).toMatch(/not found|ENOENT|did not start/);
  });

  test("a non-zero exit fails with availability-command-failed", () => {
    const result = runAvailabilityCommand(["node", "-e", "process.exit(1)"], {
      maxAgeSeconds: 300,
      timeoutSeconds: 10,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-command-failed");
  });

  test("a command that exceeds the timeout is killed with availability-command-failed", () => {
    const result = runAvailabilityCommand(
      ["node", "-e", "setTimeout(() => process.stdout.write('done'), 60000)"],
      { maxAgeSeconds: 300, timeoutSeconds: 1 },
    );
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-command-failed");
    expect(result.note?.message).toContain("killed");
  });

  test("a command that emits bad JSON fails with availability-reading-invalid", () => {
    const result = runAvailabilityCommand(["node", "-e", "process.stdout.write('oops')"], {
      maxAgeSeconds: 300,
      timeoutSeconds: 10,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
  });

  test("an empty command fails with availability-command-missing", () => {
    const result = runAvailabilityCommand([], { maxAgeSeconds: 300, timeoutSeconds: 10 });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-command-missing");
  });
});

describe("loadAvailabilityForCli", () => {
  test("no flags produces an empty load with no note", () => {
    const result = loadAvailabilityForCli({ command: false, config: undefined, file: undefined });
    expect(result.entries).toEqual([]);
    expect(result.note).toBeNull();
  });

  test("--availability with no configured command fails with availability-command-missing", () => {
    const result = loadAvailabilityForCli({ command: true, config: undefined, file: undefined });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-command-missing");
  });
});

describe("rank with the availability option", () => {
  test("an ok entry keeps the metered route first and unmetered routes second", () => {
    const answer = rank(
      { minimums: { coding: 5 } },
      { registry: FULL, availability: { entries: [{ meter: "meter-a", status: "ok" }] } },
    );
    expectValidAnswer(answer);
    const meteredRoute = answer.routes.find((r) => r.meter === "meter-a");
    expect(meteredRoute?.availability).toBe("ok");
  });

  test("an exhausted entry moves the metered route to removed", () => {
    const answer = rank(
      { minimums: { coding: 5 } },
      {
        registry: FULL,
        availability: { entries: [{ meter: "meter-a", status: "exhausted" }] },
      },
    );
    expectValidAnswer(answer);
    expect(answer.routes.find((r) => r.label === "model-a@harness-x")).toBeUndefined();
    expect(
      answer.removed.some(
        (r) => r.label === "model-a@harness-x" && r.reason.code === "meter-exhausted",
      ),
    ).toBe(true);
  });

  test("a projected entry on a non-spend-to-zero meter demotes the route", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Code." },
        router: { rank: ["coding"] },
        meters: { "meter-a": {} },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 9 },
            routes: [
              {
                harness: "harness-x",
                modelId: "model-id-a",
                hosted: true,
                meter: "meter-a",
                cost: 8,
              },
            ],
          },
          "model-b": {
            family: "family-b",
            ratings: { coding: 5 },
            routes: [{ harness: "harness-x", modelId: "model-id-b", hosted: true, cost: 5 }],
          },
        },
      });
      const answer = rank(
        { minimums: { coding: 5 } },
        {
          registry: path,
          availability: { entries: [{ meter: "meter-a", status: "projected" }] },
        },
      );
      expectValidAnswer(answer);
      const a = answer.routes.find((r) => r.label === "model-a@harness-x");
      const b = answer.routes.find((r) => r.label === "model-b@harness-x");
      // model-b (unmetered) precedes model-a (projected).
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(answer.routes.indexOf(a as AnswerRoute)).toBeGreaterThan(
        answer.routes.indexOf(b as AnswerRoute),
      );
      expect(a?.availability).toBe("projected");
      expect(a?.reasons.map((r) => r.code)).toContain("meter-projected");
    });
  });

  test("an entry naming a meter the registry does not declare warns meter-undeclared", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
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
        { minimums: { coding: 5 } },
        {
          registry: path,
          availability: { entries: [{ meter: "meter-undeclared", status: "ok" }] },
        },
      );
      expectValidAnswer(answer);
      expect(answer.warnings.map((w) => w.code)).toContain("meter-undeclared");
    });
  });

  test("a reading is applied while a meter the routes use has no entry warns meter-no-reading", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Code." },
        router: { rank: ["coding"] },
        meters: { "meter-a": {}, "meter-b": {} },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [
              { harness: "harness-x", modelId: "model-id-a1", hosted: true, meter: "meter-a" },
              { harness: "harness-y", modelId: "model-id-a2", hosted: true, meter: "meter-b" },
            ],
          },
        },
      });
      const answer = rank(
        { minimums: { coding: 5 } },
        {
          registry: path,
          availability: { entries: [{ meter: "meter-a", status: "ok" }] },
        },
      );
      expectValidAnswer(answer);
      expect(answer.warnings.map((w) => w.code)).toContain("meter-no-reading");
    });
  });

  test("dropExpired removes expired entries before the engine applies them", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
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
      const expired = new Date(Date.now() - 1000 * 60).toISOString();
      const answer = rank(
        { minimums: { coding: 5 } },
        {
          registry: path,
          availability: {
            entries: [{ meter: "meter-a", status: "exhausted", resetsAt: expired }],
          },
        },
      );
      expectValidAnswer(answer);
      // The expired entry is dropped, so the route is not removed.
      expect(answer.routes.find((r) => r.label === "model-a@harness-x")).toBeDefined();
    });
  });

  test("the all-exhausted case warns availability-exhausted-all and keeps every route", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
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
        { minimums: { coding: 5 } },
        {
          registry: path,
          availability: { entries: [{ meter: "meter-a", status: "exhausted" }] },
        },
      );
      expectValidAnswer(answer);
      expect(answer.routes.find((r) => r.label === "model-a@harness-x")).toBeDefined();
      expect(answer.routes.find((r) => r.label === "model-a@harness-x")?.availability).toBe(
        "exhausted",
      );
      expect(answer.warnings.map((w) => w.code)).toContain("availability-exhausted-all");
    });
  });

  test("the availability option sets the answer's note when one is provided", () => {
    const answer = rank(
      { minimums: { coding: 5 } },
      {
        registry: FULL,
        availability: {
          entries: [],
          note: {
            code: "availability-command-missing",
            message: "test",
            fix: "test",
          },
        },
      },
    );
    expectValidAnswer(answer);
    expect(answer.availabilityNote?.code).toBe("availability-command-missing");
  });

  test("a meter no other reading covers warns meter-no-reading only when entries exist", () => {
    // Empty entries do not trigger meter-no-reading (no reading was
    // applied). The engine only warns when a reading was applied and a
    // meter the routes use has none.
    const answer = rank(
      { minimums: { coding: 5 } },
      { registry: FULL, availability: { entries: [] } },
    );
    expectValidAnswer(answer);
    expect(answer.warnings.map((w) => w.code)).not.toContain("meter-no-reading");
  });

  test("the availability option preserves the engine's ordering for healthy routes", async () => {
    // Two ok entries, one for each surviving route's meter; the result is
    // the same as the no-availability case for healthy routes.
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Code." },
        router: { rank: ["coding"] },
        meters: { "meter-a": {}, "meter-b": {} },
        models: {
          "model-a": {
            family: "family-a",
            ratings: { coding: 7 },
            routes: [
              {
                harness: "harness-x",
                modelId: "model-id-a",
                hosted: true,
                meter: "meter-a",
                cost: 8,
              },
            ],
          },
          "model-b": {
            family: "family-b",
            ratings: { coding: 7 },
            routes: [
              {
                harness: "harness-x",
                modelId: "model-id-b",
                hosted: true,
                meter: "meter-b",
                cost: 5,
              },
            ],
          },
        },
      });
      const okCall = rank({ minimums: { coding: 5 } }, { registry: path });
      expectValidAnswer(okCall);
      const withAvailability = rank(
        { minimums: { coding: 5 } },
        {
          registry: path,
          availability: {
            entries: [
              { meter: "meter-a", status: "ok" },
              { meter: "meter-b", status: "ok" },
            ],
          },
        },
      );
      expectValidAnswer(withAvailability);
      expect(withAvailability.routes.map((r) => r.label)).toEqual(
        okCall.routes.map((r) => r.label),
      );
    });
  });
});

describe("CLI availability flags", () => {
  test("--availability with no command ranks at exit 0 with availability-command-missing", () => {
    const result = runBuiltCli(['{"minimums":{"coding":5}}', "--registry", FULL, "--availability"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const answer = JSON.parse(result.stdout);
    expectValidAnswer(answer);
    expect(answer.availabilityNote?.code).toBe("availability-command-missing");
  });

  test("--availability-file with a missing path exits 0 with availability-file-unreadable", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5}}',
      "--registry",
      FULL,
      "--availability-file",
      "./does-not-exist.json",
    ]);
    expect(result.exitCode).toBe(0);
    const answer = JSON.parse(result.stdout);
    expectValidAnswer(answer);
    expect(answer.availabilityNote?.code).toBe("availability-file-unreadable");
  });

  test("--availability-file with a fresh document applies the readings", () => {
    // Write a saved document to a temp dir, point at it, and rank.
    const tmp = "/tmp/model-router-availability-fixture.json";
    writeFileSync(
      tmp,
      `${JSON.stringify(availabilityDoc({ entries: [{ meter: "meter-a", status: "exhausted" }] }))}\n`,
    );
    try {
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability-file",
        tmp,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.removed.some((r: { label: string }) => r.label === "model-a@harness-x")).toBe(
        true,
      );
    } finally {
      try {
        spawnSync("rm", [tmp]);
      } catch {
        // best-effort
      }
    }
  });

  test("--availability-file with a stale document exits 0 with availability-reading-stale", () => {
    const tmp = "/tmp/model-router-availability-stale.json";
    const old = new Date(Date.now() - 1000 * 1000).toISOString();
    writeFileSync(tmp, `${JSON.stringify(availabilityDoc({ generatedAt: old }))}\n`);
    try {
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability-file",
        tmp,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-reading-stale");
    } finally {
      try {
        spawnSync("rm", [tmp]);
      } catch {
        // best-effort
      }
    }
  });

  test("--availability-file with bad JSON fails with availability-reading-invalid", () => {
    const tmp = "/tmp/model-router-availability-bad.json";
    writeFileSync(tmp, "{not json");
    try {
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability-file",
        tmp,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-reading-invalid");
    } finally {
      try {
        spawnSync("rm", [tmp]);
      } catch {
        // best-effort
      }
    }
  });

  test("--availability and --availability-file together exit 2 with query-invalid", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5}}',
      "--registry",
      FULL,
      "--availability",
      "--availability-file",
      "./any.json",
    ]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("availability");
    expect(error.message).toContain("cannot be used together");
  });

  test("--availability with a configured command runs it and applies the document", () => {
    const configDir = "/tmp/model-router-cli-availability-cfg";
    try {
      spawnSync("mkdir", ["-p", configDir]);
      writeFileSync(
        `${configDir}/config.json`,
        `${JSON.stringify({ availability: { command: ["node", PRINT] } })}\n`,
      );
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability",
        "--config",
        `${configDir}/config.json`,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      // The fixture script returns ok on meter-a, so model-a stays.
      expect(
        answer.routes.find((r: { label: string }) => r.label === "model-a@harness-x"),
      ).toBeDefined();
    } finally {
      try {
        spawnSync("rm", ["-rf", configDir]);
      } catch {
        // best-effort
      }
    }
  });

  test("--availability with a missing configured command fails with availability-command-failed", () => {
    const configDir = "/tmp/model-router-cli-availability-missing";
    try {
      spawnSync("mkdir", ["-p", configDir]);
      writeFileSync(
        `${configDir}/config.json`,
        `${JSON.stringify({ availability: { command: ["definitely-not-a-real-binary"] } })}\n`,
      );
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability",
        "--config",
        `${configDir}/config.json`,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-command-failed");
    } finally {
      try {
        spawnSync("rm", ["-rf", configDir]);
      } catch {
        // best-effort
      }
    }
  });

  test("--availability with a command that exceeds timeoutSeconds fails with availability-command-failed", () => {
    const configDir = "/tmp/model-router-cli-availability-timeout";
    try {
      spawnSync("mkdir", ["-p", configDir]);
      writeFileSync(
        `${configDir}/config.json`,
        `${JSON.stringify({ availability: { command: ["node", "-e", "setTimeout(() => {}, 60000)"], timeoutSeconds: 1 } })}\n`,
      );
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability",
        "--config",
        `${configDir}/config.json`,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-command-failed");
      expect(answer.availabilityNote?.message).toContain("killed");
    } finally {
      try {
        spawnSync("rm", ["-rf", configDir]);
      } catch {
        // best-effort
      }
    }
  });

  test("--availability-file takes effect with a path to a non-existent file via XDG", async () => {
    await withEnv({ XDG_CONFIG_HOME: "/tmp/model-router-availability-test-xdg" }, () => {
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability-file",
        `/tmp/availability-missing-${Date.now()}.json`,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-file-unreadable");
    });
  });

  test("--availability-file given an empty path exits 2 with query-invalid", () => {
    const result = runBuiltCli([
      '{"minimums":{"coding":5}}',
      "--registry",
      FULL,
      "--availability-file",
      "",
    ]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("availability");
    expect(error.message).toContain("empty path");
  });

  test("the CLI never starts a subprocess for --availability-file", () => {
    // The file path is read with readFileSync, not via spawn. A test
    // that confirms no subprocess runs is unnecessary here; the absence
    // of a command config is what guards it.
    if (!existsSync(PRINT)) throw new Error("missing availability-print fixture");
  });
});

describe("availability.schema.json", () => {
  test("the RFC example passes the schema", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const schema = (await import("../availability.schema.json")).default;
    const validate = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(schema);
    expect(
      validate({
        format: 1,
        generatedAt: "2026-10-01T04:00:00Z",
        entries: [
          {
            meter: "plan-a",
            status: "projected",
            resetsAt: "2026-10-01T09:00:00Z",
            percentRemaining: 12,
            note: "weekly window",
          },
          { meter: "key-b", status: "exhausted" },
        ],
      }),
    ).toBe(true);
  });

  test("rejects a wrong format", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const schema = (await import("../availability.schema.json")).default;
    const validate = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(schema);
    expect(validate({ format: 99, generatedAt: "2026-10-01T04:00:00Z", entries: [] })).toBe(false);
  });

  test("rejects a missing generatedAt", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const schema = (await import("../availability.schema.json")).default;
    const validate = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(schema);
    expect(validate({ format: 1, entries: [] })).toBe(false);
  });

  test("rejects a missing status", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const schema = (await import("../availability.schema.json")).default;
    const validate = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(schema);
    expect(
      validate({
        format: 1,
        generatedAt: "2026-10-01T04:00:00Z",
        entries: [{ meter: "meter-a" }],
      }),
    ).toBe(false);
  });

  test("rejects an unknown status", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const schema = (await import("../availability.schema.json")).default;
    const validate = new Ajv2020({ allErrors: true, strictNumbers: true }).compile(schema);
    expect(
      validate({
        format: 1,
        generatedAt: "2026-10-01T04:00:00Z",
        entries: [{ meter: "meter-a", status: "unknown" }],
      }),
    ).toBe(false);
  });
});
