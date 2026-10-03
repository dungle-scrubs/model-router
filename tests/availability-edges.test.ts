import { describe, expect, test } from "vitest";
import { applyAvailability } from "../src/availability.js";
import { parseAvailabilityDocument } from "../src/availability-cli.js";
import type { AvailabilityEntry } from "../src/types.js";
import { expectActionable } from "./helpers.js";

describe("availability edge contracts", () => {
  test("equal-percent ties name the first input's resetsAt", () => {
    const first = {
      meter: "meter-a",
      status: "projected" as const,
      percentRemaining: 12,
      resetsAt: "2026-10-01T12:30:00Z",
    };
    const second = { ...first, resetsAt: "2026-10-01T13:30:00Z" };
    const routes = [{ label: "model-a@harness-x", meter: "meter-a" }];
    expect(applyAvailability(routes, [first, second]).routes[0]?.reasons?.[0]?.message).toBe(
      'the route\'s meter "meter-a" is projected to exhaust (12% remaining, resets at 2026-10-01T12:30:00Z)',
    );
    expect(applyAvailability(routes, [second, first]).routes[0]?.reasons?.[0]?.message).toBe(
      'the route\'s meter "meter-a" is projected to exhaust (12% remaining, resets at 2026-10-01T13:30:00Z)',
    );
  });

  test("an empty route list is not all-exhausted", () => {
    expect(applyAvailability([], [{ meter: "meter-a", status: "exhausted" }])).toEqual({
      routes: [],
      removed: [],
      warnings: [],
    });
  });

  test("an ok reading clears the reason left by all-exhausted", () => {
    const once = applyAvailability(
      [{ label: "model-a@harness-x", meter: "meter-a" }],
      [{ meter: "meter-a", status: "exhausted" }],
    );
    expect(once.routes[0]?.reasons?.map((r) => r.code)).toEqual(["meter-exhausted"]);
    const result = applyAvailability(once.routes, [{ meter: "meter-a", status: "ok" }]);
    expect(result.routes[0]?.availability).toBe("ok");
    expect(result.routes[0]?.reasons).toEqual([]);
  });

  test.each([
    [
      { percentRemaining: 12, resetsAt: "2026-10-01T12:30:00Z" },
      " (12% remaining, resets at 2026-10-01T12:30:00Z)",
    ],
    [{ percentRemaining: 12 }, " (12% remaining)"],
    [{ resetsAt: "2026-10-01T12:30:00Z" }, " (resets at 2026-10-01T12:30:00Z)"],
    [{}, ""],
  ] as const)("reason messages have the exact reading tail %j", (reading, tail) => {
    const routes = [{ label: "model-a@harness-x", meter: "meter-a" }];
    for (const [status, options, code, message] of [
      [
        "projected",
        undefined,
        "meter-projected",
        'the route\'s meter "meter-a" is projected to exhaust',
      ],
      [
        "projected",
        { spendToZero: ["meter-a"] },
        "meter-projected-spend-to-zero",
        'the route\'s meter "meter-a" is projected to exhaust on a spend-to-zero meter; the route keeps its place',
      ],
      ["exhausted", undefined, "meter-exhausted", 'the route\'s meter "meter-a" is exhausted'],
    ] as const) {
      const result = applyAvailability(routes, [{ meter: "meter-a", status, ...reading }], options);
      expect(result.routes[0]?.reasons?.[0]).toMatchObject({ code, message: message + tail });
      expectActionable(result.routes[0]?.reasons?.[0]);
    }
  });

  test("the reader warns with code and index for every invalid-entry branch", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const result = parseAvailabilityDocument(
      {
        format: 1,
        generatedAt: now.toISOString(),
        entries: [
          null,
          { meter: "", status: "ok" },
          { meter: "meter-a", status: "ok", resetsAt: 7 },
          { meter: "meter-a", status: "ok", resetsAt: "not-a-date" },
          { meter: "meter-a", status: "ok", note: 7 },
          {
            meter: "meter-a",
            status: "ok",
            note: "reading",
            resetsAt: "2026-10-01T12:30:00Z",
            percentRemaining: 12,
          },
        ],
      },
      { maxAgeSeconds: 300, now },
    );
    expect(result.note).toBeNull();
    expect(result.entries).toEqual([
      {
        meter: "meter-a",
        status: "ok",
        note: "reading",
        resetsAt: "2026-10-01T12:30:00Z",
        percentRemaining: 12,
      },
    ]);
    const expectedMessages = [
      "the entry is not a JSON object",
      "the entry has no meter string",
      "the entry has a resetsAt of type number",
      "the entry has an unparseable resetsAt",
      "the entry has a note of type number",
    ];
    expect(
      result.warnings.map((w) => ({ code: w.code, field: w.field, message: w.message })),
    ).toEqual(
      expectedMessages.map((message, index) => ({
        code: "availability-entry-invalid",
        field: `$.entries[${index}]`,
        message,
      })),
    );
    for (const warning of result.warnings) {
      expectActionable(warning);
    }
  });

  test("an inherited status does not cover a meter", () => {
    const entry = Object.assign(Object.create({ status: "ok" }), {
      meter: "meter-a",
    }) as AvailabilityEntry;
    expect(
      applyAvailability([{ label: "model-a@harness-x", meter: "meter-a" }], [entry]).routes[0]
        ?.availability,
    ).toBe("unknown");
  });

  test("a non-finite percentRemaining on an exhausted entry drops the percent and keeps resetsAt", () => {
    const routes = [
      { label: "model-a@harness-x", meter: "meter-a" },
      { label: "model-c@harness-x" },
    ];
    for (const percent of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const entry = {
        meter: "meter-a",
        status: "exhausted" as const,
        percentRemaining: percent,
        resetsAt: "2026-10-01T12:30:00Z",
      } as unknown as AvailabilityEntry;
      const result = applyAvailability(routes, [entry]);
      expect(
        result.routes.map((r) => r.label),
        `percent=${String(percent)}`,
      ).toEqual(["model-c@harness-x"]);
      expect(result.removed[0]?.reason.code, `percent=${String(percent)}`).toBe("meter-exhausted");
      expect(result.removed[0]?.reason.message, `percent=${String(percent)}`).toBe(
        'the route\'s meter "meter-a" is exhausted (resets at 2026-10-01T12:30:00Z)',
      );
    }
  });

  test("a non-string resetsAt on a projected entry drops the time and keeps the percent", () => {
    const routes = [{ label: "model-a@harness-x", meter: "meter-a" }];
    for (const resetsAt of [null, 7]) {
      const entry = {
        meter: "meter-a",
        status: "projected" as const,
        percentRemaining: 12,
        resetsAt,
      } as unknown as AvailabilityEntry;
      const result = applyAvailability(routes, [entry]);
      expect(result.routes[0]?.reasons?.[0]?.message, `resetsAt=${String(resetsAt)}`).toBe(
        'the route\'s meter "meter-a" is projected to exhaust (12% remaining)',
      );
    }
  });

  test("the tie branch prefers the lower percent even when its resetsAt is not a string", () => {
    const routes = [{ label: "model-a@harness-x", meter: "meter-a" }];
    const entries = [
      {
        meter: "meter-a",
        status: "projected" as const,
        percentRemaining: 40,
        resetsAt: "2026-10-01T12:30:00Z",
      },
      {
        meter: "meter-a",
        status: "projected" as const,
        percentRemaining: 5,
        resetsAt: null,
      },
    ] as unknown as AvailabilityEntry[];
    const result = applyAvailability(routes, entries);
    expect(result.routes[0]?.reasons?.[0]?.message).toBe(
      'the route\'s meter "meter-a" is projected to exhaust (5% remaining)',
    );
  });
});

describe("future timestamp boundary", () => {
  test("even one millisecond after the read is stale", () => {
    const result = parseAvailabilityDocument(
      {
        format: 1,
        generatedAt: "2026-10-01T12:00:00.001Z",
        entries: [{ meter: "meter-a", status: "ok" }],
      },
      { maxAgeSeconds: 300, now: new Date("2026-10-01T12:00:00Z") },
    );
    expect(result.note?.code).toBe("availability-reading-stale");
    expect(result.note?.message).toBe("the availability document has a generatedAt in the future");
    expect(result.entries).toEqual([]);
  });
});
