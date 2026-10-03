import { describe, expect, test } from "vitest";
import { RouterError } from "../src/error.js";
import { applyQueryDefaults, parseQuery } from "../src/query.js";
import { expectValidRouterError } from "./helpers.js";

function catchRouterError(fn: () => unknown): RouterError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RouterError) expectValidRouterError(error);
    if (error instanceof RouterError) return error;
    throw error;
  }
  throw new Error("expected parseQuery to throw a RouterError");
}

function envelopeOf(fn: () => unknown) {
  return catchRouterError(fn).toJSON();
}

describe("parseQuery accepts the contract fields", () => {
  test("an inline minimums query parses", () => {
    expect(parseQuery({ minimums: { coding: 5 } })).toEqual({ minimums: { coding: 5 } });
  });

  test("an empty minimums object states no floor explicitly", () => {
    expect(parseQuery({ minimums: {} })).toEqual({ minimums: {} });
  });

  test("a query may carry task, effort and pin alongside minimums", () => {
    expect(
      parseQuery({
        task: "implement",
        minimums: { coding: 7 },
        effort: "xhigh",
        pin: "model-a@harness-x",
      }),
    ).toEqual({
      task: "implement",
      minimums: { coding: 7 },
      effort: "xhigh",
      pin: "model-a@harness-x",
    });
  });

  test("every optional field parses", () => {
    expect(
      parseQuery({
        excludeFamilies: ["family-a"],
        effort: "high",
        minimums: { coding: 5 },
        needs: ["browser"],
        pin: "model-a@harness-x",
        prefer: "speed",
        privacy: "secret",
        spec: "settled",
        stakes: "high",
      }),
    ).toEqual({
      excludeFamilies: ["family-a"],
      effort: "high",
      minimums: { coding: 5 },
      needs: ["browser"],
      pin: "model-a@harness-x",
      prefer: "speed",
      privacy: "secret",
      spec: "settled",
      stakes: "high",
    });
  });

  test("an off-ladder effort parses; it is a warning, not a shape error", () => {
    expect(parseQuery({ minimums: {}, effort: "warp-nine" })).toEqual({
      minimums: {},
      effort: "warp-nine",
    });
  });

  test("a minimum may be any finite number; range checks are not shape checks", () => {
    expect(parseQuery({ minimums: { coding: 11 } })).toEqual({ minimums: { coding: 11 } });
    expect(parseQuery({ minimums: { coding: 0.5 } })).toEqual({ minimums: { coding: 0.5 } });
  });

  test("a JSON text string parses like the object it holds", () => {
    expect(parseQuery('{"minimums":{"coding":5}}')).toEqual({ minimums: { coding: 5 } });
  });
});

describe("parseQuery rejects invalid input with query-invalid", () => {
  test("text that is not JSON", () => {
    expect(envelopeOf(() => parseQuery("not json"))).toEqual({
      code: "query-invalid",
      field: "query",
      fix: "Pass one JSON object as the query argument, or - to read the query from stdin.",
      message: "the query is not valid JSON: not json",
      problems: [],
    });
  });

  test("JSON that is not an object", () => {
    expect(catchRouterError(() => parseQuery("[1,2]")).message).toBe(
      "the query must be a JSON object",
    );
    expect(catchRouterError(() => parseQuery("42")).message).toBe(
      "the query must be a JSON object",
    );
  });

  test("a field the contract does not define", () => {
    expect(envelopeOf(() => parseQuery({ minimums: {}, tasl: "implement" }))).toEqual({
      code: "query-invalid",
      field: "tasl",
      fix: 'Remove "tasl", or correct its name; the query accepts task, minimums, needs, effort, pin, stakes, prefer, privacy, excludeFamilies and spec.',
      message: 'the field "tasl" is not defined by the query contract',
      problems: [],
    });
  });

  test("a query with neither task nor minimums", () => {
    expect(envelopeOf(() => parseQuery({ privacy: "secret" }))).toEqual({
      code: "query-invalid",
      field: "query",
      fix: 'Add "task": "<name>" or "minimums": { ... } to the query.',
      message: 'a query must carry "task" or "minimums"',
      problems: [],
    });
    expect(catchRouterError(() => parseQuery({})).code).toBe("query-invalid");
  });

  test("a pin without task or minimums", () => {
    expect(catchRouterError(() => parseQuery({ pin: "model-a@harness-x" })).code).toBe(
      "query-invalid",
    );
  });

  test("a fixed vocabulary value that is not on the list", () => {
    expect(envelopeOf(() => parseQuery({ minimums: {}, stakes: "urgent" }))).toEqual({
      code: "query-invalid",
      field: "stakes",
      fix: 'Set the field "stakes" to one of the listed values.',
      message: 'the field "stakes" must be one of: low, normal, high',
      problems: [],
    });
    expect(catchRouterError(() => parseQuery({ minimums: {}, prefer: "quality" })).message).toBe(
      'the field "prefer" must be one of: cost, speed',
    );
    expect(catchRouterError(() => parseQuery({ minimums: {}, privacy: "secrets" })).message).toBe(
      'the field "privacy" must be one of: normal, secret',
    );
    expect(catchRouterError(() => parseQuery({ minimums: {}, spec: "draft" })).message).toBe(
      'the field "spec" must be one of: open, settled',
    );
  });

  test("a field of the wrong type", () => {
    const task = catchRouterError(() => parseQuery({ task: 7, minimums: {} }));
    expect(task.message).toBe('the field "task" must be of type string');
    expect(task.field).toBe("task");
    expect(catchRouterError(() => parseQuery({ minimums: [], task: "x" })).message).toContain(
      "minimums",
    );
    expect(catchRouterError(() => parseQuery({ task: "x", needs: "browser" })).message).toBe(
      'the field "needs" must be of type array',
    );
    const minimum = catchRouterError(() => parseQuery({ task: "x", minimums: { coding: "7" } }));
    expect(minimum.message).toBe('the field "coding" must be of type number');
    expect(minimum.field).toBe("coding");
    expect(catchRouterError(() => parseQuery({ task: "x", pin: 9 })).message).toBe(
      'the field "pin" must be of type string',
    );
  });

  test("a non-finite number, which JSON builds from 1e400", () => {
    expect(catchRouterError(() => parseQuery('{"minimums":{"coding":1e400}}')).code).toBe(
      "query-invalid",
    );
    expect(
      catchRouterError(() => parseQuery({ minimums: { coding: Number.POSITIVE_INFINITY } })).code,
    ).toBe("query-invalid");
  });
});

describe("applyQueryDefaults", () => {
  test("fills every default the contract defines", () => {
    expect(applyQueryDefaults({ minimums: {} })).toEqual({
      excludeFamilies: [],
      minimums: {},
      needs: [],
      prefer: "cost",
      privacy: "normal",
      spec: "open",
      stakes: "normal",
    });
  });

  test("echoes task, effort and pin when the query names them", () => {
    expect(
      applyQueryDefaults({
        task: "implement",
        minimums: { coding: 7 },
        effort: "high",
        pin: "model-a@harness-x",
      }),
    ).toEqual({
      effort: "high",
      excludeFamilies: [],
      minimums: { coding: 7 },
      needs: [],
      pin: "model-a@harness-x",
      prefer: "cost",
      privacy: "normal",
      spec: "open",
      stakes: "normal",
      task: "implement",
    });
  });

  test("deduplicates needs and excludeFamilies, keeping first order", () => {
    expect(
      applyQueryDefaults({
        excludeFamilies: ["family-b", "family-a", "family-b"],
        minimums: {},
        needs: ["browser", "repo-access", "browser"],
      }),
    ).toEqual({
      excludeFamilies: ["family-b", "family-a"],
      minimums: {},
      needs: ["browser", "repo-access"],
      prefer: "cost",
      privacy: "normal",
      spec: "open",
      stakes: "normal",
    });
  });

  test("minimums defaults to no floor when only a task is named", () => {
    expect(applyQueryDefaults({ task: "implement" }).minimums).toEqual({});
  });

  test("a floor named __proto__ is an own property of a null-prototype map", () => {
    // JSON.parse builds an own "__proto__" property the way the CLI's JSON
    // text does; an object literal would set the prototype instead.
    const applied = applyQueryDefaults(JSON.parse('{"minimums":{"__proto__":5,"coding":6}}'));
    const protoKey = "__proto__";
    expect(Object.hasOwn(applied.minimums, protoKey)).toBe(true);
    expect(applied.minimums[protoKey]).toBe(5);
    expect(applied.minimums.coding).toBe(6);
    // The applied floor map is name-keyed with no prototype, like the
    // registry's maps: inherited names are absent instead of leaking
    // Object.prototype members.
    expect(Object.getPrototypeOf(applied.minimums)).toBe(null);
    expect(applied.minimums.toString).toBeUndefined();
  });
});
