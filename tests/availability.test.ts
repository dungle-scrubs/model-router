import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { dropExpired, applyAvailability as pureApplyAvailability } from "../src/availability.js";
import {
  loadAvailabilityForCli,
  parseAvailabilityDocument,
  readAvailabilityFile,
  runAvailabilityCommand,
} from "../src/availability-cli.js";
import { type AnswerRoute, rank } from "../src/index.js";
import { expectValidAnswer, fixturePath, runBuiltCli, withTempDir, writeJson } from "./helpers.js";

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
    entries: (overrides?.entries ?? [{ meter: "meter-a", status: "ok" }]) as readonly {
      meter: string;
      status: string;
      percentRemaining?: number;
      note?: string;
      resetsAt?: string;
    }[],
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
    const first = pureApplyAvailability(routes, []);
    expect(first.routes).toHaveLength(3);
    expect(first.routes.map((r) => r.availability)).toEqual(["unknown", "unknown", "unmetered"]);
    expect(first.routes.map((r) => r.label)).toEqual([
      "model-a@harness-x",
      "model-s@harness-x",
      "model-c@harness-x",
    ]);
    const second = pureApplyAvailability(first.routes, [{ meter: "meter-x", status: "exhausted" }]);
    expect(second.routes.map((r) => r.label)).toEqual([
      "model-a@harness-x",
      "model-s@harness-x",
      "model-c@harness-x",
    ]);
    expect(second.removed).toEqual([]);
  });

  test("the worked example reproduces without a spendToZero list", () => {
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
    const projected = result.routes.find((r) => r.label === "model-a@harness-x");
    expect(projected?.availability).toBe("projected");
    expect(projected?.reasons?.map((r) => r.code)).toEqual(["meter-projected"]);
  });

  test("several entries on one meter: same status picks the lowest percentRemaining", () => {
    const result = pureApplyAvailability(routes, [
      { meter: "meter-a", status: "projected", percentRemaining: 60 },
      { meter: "meter-a", status: "projected", percentRemaining: 12 },
    ]);
    expect(
      result.routes.find((route) => route.meter === "meter-a")?.reasons?.[0]?.message,
    ).toContain("12% remaining");
    expect(result.removed).toEqual([]);
  });

  test("accepts saved answer routes from a list shape as-is", () => {
    const saved = [
      { availability: "ok", label: "model-a@harness-x", meter: "meter-a" },
      { availability: "unmetered", label: "model-c@harness-x" },
    ] as const;
    const result = pureApplyAvailability(saved, [{ meter: "meter-a", status: "exhausted" }]);
    expect(result.routes.map((r) => r.label)).toEqual(["model-c@harness-x"]);
    expect(result.removed.map((r) => r.label)).toEqual(["model-a@harness-x"]);
  });

  test("returns the caller's objects unchanged when no entry covers the routes", () => {
    const result = pureApplyAvailability(routes, []);
    for (let i = 0; i < routes.length; i += 1) {
      expect(result.routes[i]).toBe(routes[i]);
    }
  });

  test("the reason message names the deciding entry's percentRemaining and resetsAt", () => {
    // Two projected entries at 40 and 12: the lowest percent wins, and the
    // message surfaces it. Reversing the order gives the same outcome.
    const result = pureApplyAvailability(routes, [
      {
        meter: "meter-a",
        status: "projected",
        percentRemaining: 40,
        resetsAt: "2026-10-01T09:00:00Z",
      },
      {
        meter: "meter-a",
        status: "projected",
        percentRemaining: 12,
        resetsAt: "2026-10-01T09:00:00Z",
      },
    ]);
    const projected = result.routes.find((r) => r.label === "model-a@harness-x");
    const projectedReason = projected?.reasons?.[0];
    expect(projectedReason?.message).toContain("12%");
    expect(projectedReason?.message).toContain("resets at 2026-10-01T09:00:00Z");
    // Reversing the input order keeps the same outcome: the tie-break on
    // percent is not order-dependent.
    const reversed = pureApplyAvailability(routes, [
      {
        meter: "meter-a",
        status: "projected",
        percentRemaining: 12,
        resetsAt: "2026-10-01T09:00:00Z",
      },
      {
        meter: "meter-a",
        status: "projected",
        percentRemaining: 40,
        resetsAt: "2026-10-01T09:00:00Z",
      },
    ]);
    const reversedProjected = reversed.routes.find((r) => r.label === "model-a@harness-x");
    expect(reversedProjected?.reasons?.[0]?.message).toContain("12%");
  });

  test("an entry without a percent loses the tie to an entry with one", () => {
    // Tie-break on percent: an entry with 30% wins over one without a percent.
    const result = pureApplyAvailability(routes, [
      { meter: "meter-a", status: "projected" },
      {
        meter: "meter-a",
        status: "projected",
        percentRemaining: 30,
        resetsAt: "2026-10-01T09:00:00Z",
      },
    ]);
    const projected = result.routes.find((r) => r.label === "model-a@harness-x");
    expect(projected?.reasons?.[0]?.message).toContain("30%");
    expect(projected?.reasons?.[0]?.message).toContain("resets at 2026-10-01T09:00:00Z");
  });

  test("an entry with an unknown status does not cover the meter", () => {
    const result = pureApplyAvailability(routes, [
      {
        meter: "meter-a",
        status: "unknown" as unknown as import("../src/types.js").AvailabilityEntryStatus,
      },
    ]);
    expect(result.routes.find((r) => r.label === "model-a@harness-x")?.availability).toBe(
      "unknown",
    );
    expect(result.routes.map((r) => r.label)).toEqual([
      "model-a@harness-x",
      "model-s@harness-x",
      "model-c@harness-x",
    ]);
    expect(result.removed).toEqual([]);
    for (const status of ["unmetered", "constructor", "bogus"] as const) {
      const r = pureApplyAvailability(routes, [
        {
          meter: "meter-a",
          status: status as unknown as import("../src/types.js").AvailabilityEntryStatus,
        },
      ]);
      const a = r.routes.find((route) => route.label === "model-a@harness-x");
      expect(a?.availability).toBe("unknown");
      expect(r.removed).toEqual([]);
    }
  });

  test("plain {label, meter} objects with no entries come back unknown or unmetered in order", () => {
    // The generic signature accepts plain objects (no cast).
    const plain = [
      { label: "model-a@harness-x", meter: "meter-a" },
      { label: "model-c@harness-x" },
    ];
    const withMeter = pureApplyAvailability(plain, []);
    expect(withMeter.routes[0]?.availability).toBe("unknown");
    expect(withMeter.routes[1]?.availability).toBe("unmetered");
    expect(withMeter.routes.map((r) => r.label)).toEqual([
      "model-a@harness-x",
      "model-c@harness-x",
    ]);
  });

  test("rank-built routes passed through JSON.parse(JSON.stringify(...)) still work", () => {
    // The round-trip through JSON is how saved answers travel; the function
    // must accept them.
    const plain = JSON.parse(
      JSON.stringify([
        { availability: "unknown", label: "model-a@harness-x", meter: "meter-a" },
        { availability: "unmetered", label: "model-c@harness-x" },
      ]),
    );
    const result = pureApplyAvailability(plain, [{ meter: "meter-a", status: "exhausted" }]);
    expect(result.routes.map((r) => r.label)).toEqual(["model-c@harness-x"]);
    expect(result.removed.map((r) => r.label)).toEqual(["model-a@harness-x"]);
  });

  test("inputs are deep-equal to a snapshot taken before the call", () => {
    // Snapshot the routes before the call; deep-equal afterwards. A
    // mutation would break the assertion.
    const snapshot = JSON.parse(JSON.stringify(routes));
    pureApplyAvailability(routes, [{ meter: "meter-a", status: "exhausted" }]);
    expect(JSON.parse(JSON.stringify(routes))).toEqual(snapshot);
  });

  test("applying a projected entry twice leaves one reason on the route", () => {
    // Re-applying: the second call replaces the meter-projected reason
    // with its own, so the route carries a single reason after the second
    // call. The second call uses spend-to-zero to keep the route in place.
    const once = pureApplyAvailability(
      routes,
      [{ meter: "meter-a", status: "projected", percentRemaining: 12 }],
      { spendToZero: ["meter-a"] },
    );
    const withReason = once.routes.find((r) => r.label === "model-a@harness-x");
    expect(withReason?.reasons?.map((r) => r.code)).toEqual(["meter-projected-spend-to-zero"]);
    const twice = pureApplyAvailability(
      once.routes,
      [{ meter: "meter-a", status: "projected", percentRemaining: 12 }],
      { spendToZero: ["meter-a"] },
    );
    const stillOneReason = twice.routes.find((r) => r.label === "model-a@harness-x");
    expect(stillOneReason?.reasons?.map((r) => r.code)).toEqual(["meter-projected-spend-to-zero"]);
  });

  test("applying an ok entry replaces a prior meter reason and keeps floor-not-met", () => {
    // The route already carries floor-not-met from rank. An ok entry covers
    // the meter, so the old meter reason is replaced; the floor reason stays.
    const ranked: readonly Route[] = [
      {
        availability: "unknown",
        label: "model-a@harness-x",
        meter: "meter-a",
        reasons: [
          {
            code: "floor-not-met",
            message: "the model's rating for coding is 4, below the floor 5",
          },
        ],
      },
    ];
    const projected = pureApplyAvailability(ranked, [
      { meter: "meter-a", status: "projected", percentRemaining: 12 },
    ]);
    const afterProjected = projected.routes[0];
    expect(afterProjected?.reasons?.map((r) => r.code)).toEqual([
      "floor-not-met",
      "meter-projected",
    ]);
    const ok = pureApplyAvailability(projected.routes, [{ meter: "meter-a", status: "ok" }]);
    const finalRoute = ok.routes[0];
    expect(finalRoute?.availability).toBe("ok");
    expect(finalRoute?.reasons?.map((r: { code: string }) => r.code)).toEqual(["floor-not-met"]);
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

  test("drops entries whose resetsAt equals now", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const entries = [{ meter: "meter-a", status: "ok" as const, resetsAt: now.toISOString() }];
    expect(dropExpired(entries, now)).toEqual([]);
  });

  test("keeps entries whose resetsAt is one millisecond after now", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const later = new Date(now.getTime() + 1);
    const entries = [{ meter: "meter-a", status: "ok" as const, resetsAt: later.toISOString() }];
    expect(dropExpired(entries, now).map((e) => e.meter)).toEqual(["meter-a"]);
  });
});

describe("parseAvailabilityDocument staleness boundaries", () => {
  test("a document whose generatedAt is exactly maxAgeSeconds old is fresh", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const generatedAt = new Date(now.getTime() - 300 * 1000).toISOString();
    const result = parseAvailabilityDocument(availabilityDoc({ generatedAt }), {
      maxAgeSeconds: 300,
      now,
    });
    expect(result.note).toBeNull();
  });

  test("a document one millisecond older than maxAgeSeconds is stale", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const generatedAt = new Date(now.getTime() - 300 * 1000 - 1).toISOString();
    const result = parseAvailabilityDocument(availabilityDoc({ generatedAt }), {
      maxAgeSeconds: 300,
      now,
    });
    expect(result.note?.code).toBe("availability-reading-stale");
  });
});

describe("parseAvailabilityDocument", () => {
  test("accepts the RFC's worked example", () => {
    const entries = [
      {
        meter: "meter-a",
        status: "projected",
        resetsAt: "2026-10-01T09:00:00Z",
        percentRemaining: 12,
        note: "weekly window",
      },
      { meter: "meter-b", status: "exhausted" },
    ];
    const result = parseAvailabilityDocument(
      { format: 1, generatedAt: "2026-10-01T04:00:00Z", entries },
      {
        maxAgeSeconds: 300,
        now: new Date("2026-10-01T04:00:01Z"),
      },
    );
    expect(result.entries).toEqual(entries);
    expect(result.note).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  test("rejects a non-object top level with availability-reading-invalid", () => {
    const result = parseAvailabilityDocument(7, { maxAgeSeconds: 300 });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
    expect(result.note?.message).toBe("the availability document must be a JSON object");
    expect(result.note?.fix).toContain("Replace the document with an object");
  });

  test("rejects an unknown format with availability-reading-invalid", () => {
    const result = parseAvailabilityDocument(availabilityDoc({ format: 99 }), {
      maxAgeSeconds: 300,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
    expect(result.note?.message).toContain("format is not 1");
    expect(result.note?.fix).toBe("Use a document at format version 1.");
  });

  test("rejects a missing generatedAt string with availability-reading-invalid", () => {
    const result = parseAvailabilityDocument({ format: 1, entries: [] }, { maxAgeSeconds: 300 });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
    expect(result.note?.message).toContain("no");
    expect(result.note?.message).toContain("generatedAt");
    expect(result.note?.fix).toContain("Add");
  });

  test("rejects a non-array entries field with availability-reading-invalid", () => {
    const result = parseAvailabilityDocument(
      { format: 1, generatedAt: new Date().toISOString(), entries: "no" },
      { maxAgeSeconds: 300 },
    );
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
    expect(result.note?.message).toContain("entries is not an array");
    expect(result.note?.fix).toContain("Replace");
  });

  test("rejects an unparseable generatedAt with availability-reading-invalid", () => {
    const result = parseAvailabilityDocument(availabilityDoc({ generatedAt: "not-a-date" }), {
      maxAgeSeconds: 300,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
    expect(result.note?.message).toContain("not a parseable date");
  });

  test("flags an old document as stale", () => {
    const old = new Date(Date.now() - 1000 * 1000).toISOString();
    const result = parseAvailabilityDocument(availabilityDoc({ generatedAt: old }), {
      maxAgeSeconds: 60,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-stale");
    expect(result.note?.message).toContain("older than 60 seconds");
    expect(result.note?.fix).toContain("Regenerate the document within 60 seconds");
  });

  test("flags a future generatedAt as stale", () => {
    const future = new Date(Date.now() + 1000 * 1000).toISOString();
    const result = parseAvailabilityDocument(availabilityDoc({ generatedAt: future }), {
      maxAgeSeconds: 300,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-stale");
    expect(result.note?.message).toBe("the availability document has a generatedAt in the future");
  });
});

describe("parseAvailabilityDocument with skipped entries", () => {
  test("a document with one good and three bad entries applies the good one and warns", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const result = parseAvailabilityDocument(
      availabilityDoc({
        generatedAt: now.toISOString(),
        entries: [
          { meter: "meter-a", status: "ok" },
          { meter: "meter-b" } as unknown as { meter: string; status: string },
          { meter: "meter-c", status: "exausted" },
          { meter: "meter-d", status: "ok", percentRemaining: "12" as unknown as number },
        ],
      }),
      { maxAgeSeconds: 300, now },
    );
    expect(result.entries.map((e) => e.meter)).toEqual(["meter-a"]);
    expect(result.note).toBeNull();
    expect(result.warnings.map((w) => w.code)).toEqual([
      "availability-entry-invalid",
      "availability-entry-invalid",
      "availability-entry-invalid",
    ]);
    const fields = result.warnings.map((w) => w.field);
    expect(fields).toEqual(["$.entries[1]", "$.entries[2]", "$.entries[3]"]);
    expect(result.warnings[0]?.message).toContain("status");
    expect(result.warnings[1]?.message).toContain("exausted");
    expect(result.warnings[2]?.message).toContain("percentRemaining");
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
      expect(result.note?.message).toContain("does not exist");
    });
  });

  test("a directory path fails with availability-file-unreadable (could not be read)", async () => {
    await withTempDir(async (dir) => {
      const result = readAvailabilityFile(dir, { maxAgeSeconds: 300 });
      expect(result.entries).toEqual([]);
      expect(result.note?.code).toBe("availability-file-unreadable");
      expect(result.note?.message).toContain("could not be read");
    });
  });

  test("a file that is not JSON fails with availability-reading-invalid", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "bad.json");
      writeFileSync(path, "{not json");
      const result = readAvailabilityFile(path, { maxAgeSeconds: 300 });
      expect(result.entries).toEqual([]);
      expect(result.note?.code).toBe("availability-reading-invalid");
      expect(result.note?.message).toContain("is not valid JSON");
    });
  });
});

describe("runAvailabilityCommand", () => {
  test("a command that prints a fresh ok document succeeds", () => {
    const result = runAvailabilityCommand(
      [
        "node",
        "-e",
        'process.stdout.write(JSON.stringify({format:1,generatedAt:new Date().toISOString(),entries:[{meter:"meter-a",status:"ok"}]}))',
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
    expect(result.note?.message).toMatch(/not found|did not start/);
  });

  test("a non-zero exit fails with availability-command-failed", () => {
    const result = runAvailabilityCommand(["node", "-e", "process.exit(1)"], {
      maxAgeSeconds: 300,
      timeoutSeconds: 10,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-command-failed");
    expect(result.note?.message).toContain("exited with code 1");
  });

  test("a command that exceeds the timeout fails with availability-command-failed", () => {
    const result = runAvailabilityCommand(
      ["node", "-e", "setTimeout(() => process.stdout.write('done'), 60000)"],
      { maxAgeSeconds: 300, timeoutSeconds: 1 },
    );
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-command-failed");
    expect(result.note?.message).toBe("the availability command was killed after 1 second");
  });

  test("a timeoutSeconds other than 1 uses the plural form", () => {
    const result = runAvailabilityCommand(
      ["node", "-e", "setTimeout(() => process.stdout.write('done'), 60000)"],
      { maxAgeSeconds: 300, timeoutSeconds: 2 },
    );
    expect(result.note?.message).toContain("killed after 2 seconds");
  });

  test.skipIf(process.platform === "win32")(
    "a signal-killed child is reported as killed by signal",
    () => {
      // Windows cannot deliver signals to a child Node process: the
      // runtime exits cleanly via the SIGTERM kill instead. Skip on win32.
      const result = runAvailabilityCommand(
        ["node", "-e", "process.kill(process.pid, 'SIGKILL')"],
        {
          maxAgeSeconds: 300,
          timeoutSeconds: 5,
        },
      );
      expect(result.note?.code).toBe("availability-command-failed");
      expect(result.note?.message).toContain("killed by signal SIGKILL");
    },
  );

  test("an ENOBUFS from the spawn buffer reports output exceeded 8 MiB", async () => {
    await withTempDir(async (dir) => {
      const fixture = join(dir, "big.js");
      // A 16 KiB payload exceeds the 4 KiB test buffer.
      const payload = "x".repeat(16384);
      writeFileSync(fixture, `process.stdout.write(${JSON.stringify(payload)});\n`, "utf8");
      const result = runAvailabilityCommand(["node", fixture], {
        maxAgeSeconds: 300,
        timeoutSeconds: 5,
        maxBuffer: 4096,
      });
      expect(result.note?.code).toBe("availability-command-failed");
      expect(result.note?.message).toContain("exceeded 8 MiB");
    });
  });

  test("a command that emits bad JSON fails with availability-reading-invalid", () => {
    const result = runAvailabilityCommand(["node", "-e", "process.stdout.write('oops')"], {
      maxAgeSeconds: 300,
      timeoutSeconds: 10,
    });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-reading-invalid");
    expect(result.note?.message).toBe("the availability command output is not valid JSON");
  });

  test("an empty command fails with availability-command-missing", () => {
    const result = runAvailabilityCommand([], { maxAgeSeconds: 300, timeoutSeconds: 10 });
    expect(result.entries).toEqual([]);
    expect(result.note?.code).toBe("availability-command-missing");
    expect(result.note?.message).toBe("the availability command was empty");
    expect(result.note?.fix).toContain("non-empty argv array");
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
    expect(result.note?.message).toContain(
      "--availability was given but availability.command is not set",
    );
  });

  test("--availability-file with a config that has no command reads the file", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "avail.json", availabilityDoc());
      const result = loadAvailabilityForCli({
        command: false,
        config: { maxAgeSeconds: 300, timeoutSeconds: 10 },
        file: path,
      });
      expect(result.entries).toHaveLength(1);
      expect(result.note).toBeNull();
    });
  });

  test("--availability with a command that prints an expired entry drops it", () => {
    const result = loadAvailabilityForCli({
      command: true,
      config: {
        command: ["node", fixturePath("availability-expired-print.js")],
        maxAgeSeconds: 300,
        timeoutSeconds: 10,
      },
      file: undefined,
    });
    expect(result.note).toBeNull();
    expect(result.entries).toEqual([]);
  });
});

describe("rank with the availability option", () => {
  test("an ok entry keeps the metered route first and unmetered routes second", () => {
    const answer = rank(
      { minimums: { coding: 5 } },
      { registry: FULL, availability: [{ meter: "meter-a", status: "ok" }] },
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
        availability: [{ meter: "meter-a", status: "exhausted" }],
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

  test("rank with an exhausted entry whose resetsAt has passed removes the route", () => {
    const answer = rank(
      { minimums: { coding: 5 } },
      {
        registry: FULL,
        availability: [{ meter: "meter-a", status: "exhausted", resetsAt: "2000-01-01T00:00:00Z" }],
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

  test("rank ignores expiry before and after the same resetsAt", () => {
    // Pin a fake-timer scenario so the test is deterministic: the CLI
    // owns the clock, and rank itself does not consult it. The same answer
    // comes back before and after the resetsAt.
    const resetsAt = "2026-10-01T12:30:00Z";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      const before = rank(
        { minimums: { coding: 5 } },
        {
          registry: FULL,
          availability: [{ meter: "meter-a", status: "exhausted", resetsAt }],
        },
      );
      expectValidAnswer(before);
      vi.setSystemTime(new Date("2026-10-01T13:00:00Z"));
      const after = rank(
        { minimums: { coding: 5 } },
        {
          registry: FULL,
          availability: [{ meter: "meter-a", status: "exhausted", resetsAt }],
        },
      );
      expectValidAnswer(after);
      expect(before).toEqual(after);
      // rank ignores the clock: an entry is honored regardless of when the
      // call runs, so the route is removed in both cases.
      expect(before.routes.find((r) => r.label === "model-a@harness-x")).toBeUndefined();
      expect(after.routes.find((r) => r.label === "model-a@harness-x")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
          availability: [{ meter: "meter-a", status: "projected" }],
        },
      );
      expectValidAnswer(answer);
      const a = answer.routes.find((r) => r.label === "model-a@harness-x");
      const b = answer.routes.find((r) => r.label === "model-b@harness-x");
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
          availability: [{ meter: "meter-undeclared", status: "ok" }],
        },
      );
      expectValidAnswer(answer);
      expect(answer.warnings.map((w) => w.code)).toContain("meter-undeclared");
    });
  });

  test("two entries on one undeclared meter give one meter-undeclared warning", async () => {
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
          availability: [
            { meter: "meter-undeclared", status: "ok" },
            { meter: "meter-undeclared", status: "projected" },
          ],
        },
      );
      expectValidAnswer(answer);
      const undeclared = answer.warnings.filter((w) => w.code === "meter-undeclared");
      expect(undeclared).toHaveLength(1);
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
          availability: [{ meter: "meter-a", status: "ok" }],
        },
      );
      expectValidAnswer(answer);
      expect(answer.warnings.map((w) => w.code)).toContain("meter-no-reading");
    });
  });

  test("meter-no-reading fires for availability: [] and not without the option", () => {
    const withOption = rank({ minimums: { coding: 5 } }, { registry: FULL, availability: [] });
    expectValidAnswer(withOption);
    expect(withOption.warnings.map((w) => w.code)).toContain("meter-no-reading");
    const withoutOption = rank({ minimums: { coding: 5 } }, { registry: FULL });
    expectValidAnswer(withoutOption);
    expect(withoutOption.warnings.map((w) => w.code)).not.toContain("meter-no-reading");
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
      // rank does not read the clock. A caller that wants stale entries
      // dropped runs dropExpired before passing entries.
      const expired = new Date(Date.now() - 1000 * 60).toISOString();
      const live = dropExpired(
        [{ meter: "meter-a", status: "exhausted", resetsAt: expired }],
        new Date(),
      );
      const answer = rank(
        { minimums: { coding: 5 } },
        {
          registry: path,
          availability: live,
        },
      );
      expectValidAnswer(answer);
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
          availability: [{ meter: "meter-a", status: "exhausted" }],
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

  test("an exhausted pin that applyAvailability removes reports pin.used false and adds pin-unused", () => {
    const answer = rank(
      { minimums: { coding: 5 }, pin: "model-a@harness-x" },
      {
        registry: FULL,
        availability: [{ meter: "meter-a", status: "exhausted" }],
      },
    );
    expectValidAnswer(answer);
    expect(answer.pin).toEqual({
      label: "model-a@harness-x",
      reason: "meter-exhausted",
      used: false,
    });
    const warning = answer.warnings.find((w) => w.code === "pin-unused");
    expect(warning).toBeDefined();
    expect(warning?.field).toBe("$.pin");
    expect(warning?.message).toContain("model-a@harness-x");
    expect(warning?.message).toContain("exhausted");
    expect(answer.routes.find((r) => r.label === "model-a@harness-x")).toBeUndefined();
    expect(answer.removed.some((r) => r.label === "model-a@harness-x")).toBe(true);
  });

  test("a projected meter-a entry on a pin route that stays used leaves the pin in place", () => {
    const answer = rank(
      { minimums: { coding: 5 }, pin: "model-a@harness-x" },
      {
        registry: FULL,
        availability: [{ meter: "meter-a", status: "projected" }],
      },
    );
    expectValidAnswer(answer);
    expect(answer.pin).toEqual({ label: "model-a@harness-x", reason: "", used: true });
    expect(answer.warnings.map((w) => w.code)).not.toContain("pin-unused");
  });

  test("the availability option preserves the engine's ordering for healthy routes", async () => {
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
          availability: [
            { meter: "meter-a", status: "ok" },
            { meter: "meter-b", status: "ok" },
          ],
        },
      );
      expectValidAnswer(withAvailability);
      expect(withAvailability.routes.map((r) => r.label)).toEqual(
        okCall.routes.map((r) => r.label),
      );
    });
  });

  test("a registry's spendToZero meter keeps a projected route in its place", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "registry.json", {
        format: 1,
        ratings: { coding: "Code." },
        router: { rank: ["coding"] },
        meters: { "meter-a": { spendToZero: true } },
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
          availability: [{ meter: "meter-a", status: "projected" }],
        },
      );
      expectValidAnswer(answer);
      const a = answer.routes.find((r) => r.label === "model-a@harness-x");
      expect(a?.availability).toBe("projected");
      expect(a?.reasons.map((r) => r.code)).toEqual(["meter-projected-spend-to-zero"]);
    });
  });

  test("the same registry without spendToZero demotes the projected route", async () => {
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
          availability: [{ meter: "meter-a", status: "projected" }],
        },
      );
      expectValidAnswer(answer);
      const a = answer.routes.find((r) => r.label === "model-a@harness-x");
      const b = answer.routes.find((r) => r.label === "model-b@harness-x");
      expect(answer.routes.indexOf(a as AnswerRoute)).toBeGreaterThan(
        answer.routes.indexOf(b as AnswerRoute),
      );
      expect(a?.reasons.map((r) => r.code)).toEqual(["meter-projected"]);
    });
  });

  test("a projected entry read through parseAvailabilityDocument reaches a route as projected", async () => {
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
        },
      });
      const doc = availabilityDoc({ entries: [{ meter: "meter-a", status: "projected" }] });
      const parsed = parseAvailabilityDocument(doc, { maxAgeSeconds: 300 });
      const answer = rank(
        { minimums: { coding: 5 } },
        { registry: path, availability: parsed.entries },
      );
      expectValidAnswer(answer);
      const a = answer.routes.find((r) => r.label === "model-a@harness-x");
      expect(a?.availability).toBe("projected");
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
    expect(answer.warnings.map((w) => w.code)).not.toContain("meter-no-reading");
  });

  test("no --availability flag gives no availabilityNote and no meter-no-reading warning", () => {
    const result = runBuiltCli(['{"minimums":{"coding":5}}', "--registry", FULL]);
    expect(result.exitCode).toBe(0);
    const answer = JSON.parse(result.stdout);
    expectValidAnswer(answer);
    expect(answer.availabilityNote).toBeNull();
    expect(answer.warnings.map((w) => w.code)).not.toContain("meter-no-reading");
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

  test("--availability-file with a fresh document applies the readings (temp dir)", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "avail.json", {
        format: 1,
        generatedAt: new Date().toISOString(),
        entries: [{ meter: "meter-a", status: "exhausted" }],
      });
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability-file",
        path,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.removed.some((r: { label: string }) => r.label === "model-a@harness-x")).toBe(
        true,
      );
    });
  });

  test("--availability-file with an exhausted entry whose resetsAt has passed keeps the route", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "expired.json", {
        format: 1,
        generatedAt: new Date().toISOString(),
        entries: [{ meter: "meter-a", status: "exhausted", resetsAt: "2000-01-01T00:00:00Z" }],
      });
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability-file",
        path,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      // The CLI is supposed to drop the expired entry before the engine
      // sees it, so model-a@harness-x stays and is not in removed.
      expect(
        answer.routes.find((r: { label: string }) => r.label === "model-a@harness-x"),
      ).toBeDefined();
      expect(answer.removed.some((r: { label: string }) => r.label === "model-a@harness-x")).toBe(
        false,
      );
    });
  });

  test("--availability-file with a stale document exits 0 with availability-reading-stale", async () => {
    await withTempDir(async (dir) => {
      const old = new Date(Date.now() - 1000 * 1000).toISOString();
      const path = writeJson(dir, "stale.json", {
        format: 1,
        generatedAt: old,
        entries: [{ meter: "meter-a", status: "exhausted" }],
      });
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability-file",
        path,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-reading-stale");
    });
  });

  test("--availability-file with bad JSON fails with availability-reading-invalid", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "bad.json");
      writeFileSync(path, "{not json");
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability-file",
        path,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-reading-invalid");
    });
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

  test("--availability with a configured command runs it and applies the document", async () => {
    await withTempDir(async (dir) => {
      const configPath = writeJson(dir, "config.json", {
        availability: { command: ["node", PRINT] },
      });
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability",
        "--config",
        configPath,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote).toBeNull();
      expect(
        answer.routes.find((r: { label: string }) => r.label === "model-a@harness-x")?.availability,
      ).toBe("ok");
      expect(answer.warnings.map((w) => w.code)).not.toContain("meter-no-reading");
    });
  });

  test("--availability with a missing configured command fails with availability-command-failed", async () => {
    await withTempDir(async (dir) => {
      const configPath = writeJson(dir, "config.json", {
        availability: { command: ["definitely-not-a-real-binary"] },
      });
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability",
        "--config",
        configPath,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-command-failed");
    });
  });

  test("--availability with a command that exceeds timeoutSeconds fails with availability-command-failed", async () => {
    await withTempDir(async (dir) => {
      const configPath = writeJson(dir, "config.json", {
        availability: {
          command: ["node", "-e", "setTimeout(() => {}, 60000)"],
          timeoutSeconds: 1,
        },
      });
      const result = runBuiltCli([
        '{"minimums":{"coding":5}}',
        "--registry",
        FULL,
        "--availability",
        "--config",
        configPath,
      ]);
      expect(result.exitCode).toBe(0);
      const answer = JSON.parse(result.stdout);
      expectValidAnswer(answer);
      expect(answer.availabilityNote?.code).toBe("availability-command-failed");
      expect(answer.availabilityNote?.message).toContain("killed");
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
});

describe("availability flags on subcommands", () => {
  test("tasks with --availability exits 2 with query-invalid", () => {
    const result = runBuiltCli(["tasks", "--registry", FULL, "--availability"]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("availability");
    expect(error.message).toBe("the --availability option does not apply to the tasks subcommand.");
    // check rejects the flag too, so the fix cannot name it.
    expect(error.fix).toBe("Run model-router '<query>' to use --availability.");
  });

  test("tasks with --availability given before the subcommand word exits 2 with query-invalid", () => {
    const result = runBuiltCli(["--availability", "tasks", "--registry", FULL]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("availability");
    expect(error.message).toBe("the --availability option does not apply to the tasks subcommand.");
    expect(error.fix).toBe("Run model-router '<query>' to use --availability.");
  });

  test("tasks with --availability-file exits 2 with query-invalid", () => {
    const result = runBuiltCli(["tasks", "--registry", FULL, "--availability-file", "./any.json"]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("availability");
    expect(error.message).toBe(
      "the --availability-file option does not apply to the tasks subcommand.",
    );
    expect(error.fix).toBe("Run model-router '<query>' to use --availability.");
  });

  test("check with --availability exits 2 with query-invalid", () => {
    const result = runBuiltCli(["check", "--registry", FULL, "--availability"]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("availability");
    expect(error.message).toBe("the --availability option does not apply to the check subcommand.");
    expect(error.fix).toBe("Run model-router '<query>' to use --availability.");
  });

  test("check with --availability-file exits 2 with query-invalid", () => {
    const result = runBuiltCli(["check", "--registry", FULL, "--availability-file", "./any.json"]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("query-invalid");
    expect(error.field).toBe("availability");
    expect(error.message).toBe(
      "the --availability-file option does not apply to the check subcommand.",
    );
    expect(error.fix).toBe("Run model-router '<query>' to use --availability.");
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
