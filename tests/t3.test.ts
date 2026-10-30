import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RouterError } from "../src/index.js";
import { toT3Targets } from "../src/t3.js";
import { runT3Cli } from "../src/t3-cli-run.js";
import { repoRoot } from "./helpers.js";

function answer(routes: readonly Record<string, unknown>[]) {
  return { contract: 1, routes };
}

const CAPABILITIES = {
  providers: [
    {
      providerInstanceId: "claudeAgent",
      canRunChildTask: true,
      constraints: [],
      omittedModels: 3,
      models: [
        {
          id: "claude-opus-5-5",
          options: [
            { id: "effort", values: ["low", "medium", "high", "xhigh", "max", "ultrathink"] },
            { id: "fastMode", values: [false, true] },
          ],
        },
      ],
    },
    {
      providerInstanceId: "codex",
      canRunChildTask: true,
      constraints: [],
      models: [
        { id: "gpt-6.1-sol", options: [{ id: "reasoningEffort", values: ["low", "high"] }] },
      ],
    },
    {
      providerInstanceId: "pi",
      canRunChildTask: true,
      constraints: [],
      omittedModels: 40,
      models: [
        { id: "default" },
        { id: "zai/glm-5.3", options: [{ id: "thinking", values: ["low", "high", "max"] }] },
        {
          id: "minimax/MiniMax-M2.7",
          options: [{ id: "thinking", values: ["off", "minimal", "low"] }],
        },
        {
          id: "openai-codex/gpt-6.1-sol",
          options: [{ id: "thinking", values: ["minimal", "medium"] }],
        },
        { id: "lab/max-only", options: [{ id: "thinking", values: ["max"] }] },
      ],
    },
    {
      providerInstanceId: "cursor",
      canRunChildTask: false,
      constraints: ["Provider instance is disabled."],
      models: [],
    },
  ],
};

function only(route: Record<string, unknown>, options = {}) {
  const [first] = toT3Targets(answer([route]), [CAPABILITIES], options).routes;
  return first;
}

describe("toT3Targets", () => {
  test("maps claude to claudeAgent and keeps an offered effort", () => {
    expect(
      only({ label: "opus@claude", harness: "claude", modelId: "claude-opus-5-5", effort: "high" }),
    ).toEqual({
      label: "opus@claude",
      notes: [],
      status: "ready",
      target: {
        model: "claude-opus-5-5",
        options: { effort: "high" },
        providerInstanceId: "claudeAgent",
      },
    });
  });

  test("names a pi provider's model provider/modelId, and keeps a bare pi modelId", () => {
    const routed = toT3Targets(
      answer([
        {
          label: "sol@pi/openai-codex",
          harness: "pi",
          provider: "openai-codex",
          modelId: "gpt-6.1-sol",
          effort: "medium",
        },
        { label: "glm@pi", harness: "pi", modelId: "zai/glm-5.3", effort: "high" },
      ]),
      [CAPABILITIES],
    ).routes;
    expect(routed.map((route) => (route.status === "ready" ? route.target.model : null))).toEqual([
      "openai-codex/gpt-6.1-sol",
      "zai/glm-5.3",
    ]);
  });

  test("uses the effort option id the model declares", () => {
    const route = only({
      label: "sol@codex",
      harness: "codex",
      modelId: "gpt-6.1-sol",
      effort: "low",
    });
    expect(route?.status === "ready" && route.target.options).toEqual({ reasoningEffort: "low" });
  });

  test("finds Cursor's reasoning_effort, and skips a boolean thinking switch", () => {
    const cursor = {
      providers: [
        {
          providerInstanceId: "cursor",
          canRunChildTask: true,
          models: [
            {
              id: "grok-4.7",
              options: [
                { id: "fastMode", values: [false, true] },
                { id: "reasoning_effort", values: ["low", "medium", "high", "xhigh"] },
              ],
            },
            {
              id: "claude-opus-5",
              options: [
                { id: "thinking", values: [false, true] },
                { id: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
              ],
            },
          ],
        },
      ],
    };
    const routes = toT3Targets(
      answer([
        { label: "grok@cursor", harness: "cursor", modelId: "grok-4.7", effort: "high" },
        { label: "opus@cursor", harness: "cursor", modelId: "claude-opus-5", effort: "max" },
      ]),
      [cursor],
    ).routes;
    expect(routes.map((route) => (route.status === "ready" ? route.target.options : null))).toEqual(
      [{ reasoning_effort: "high" }, { effort: "max" }],
    );
  });

  test("lowers an unoffered effort to the nearest level below, with a note", () => {
    const route = only({ label: "glm@pi", harness: "pi", modelId: "zai/glm-5.3", effort: "xhigh" });
    expect(route).toMatchObject({
      status: "ready",
      target: { options: { thinking: "high" } },
      notes: [
        {
          code: "t3-effort-lowered",
          message: "T3 offers zai/glm-5.3 no xhigh; high is the nearest level below",
        },
      ],
    });
  });

  test("raises to the nearest level above only when the model offers nothing lower", () => {
    const route = only({
      label: "max-only@pi",
      harness: "pi",
      modelId: "lab/max-only",
      effort: "medium",
    });
    expect(route).toMatchObject({
      status: "ready",
      target: { options: { thinking: "max" } },
      notes: [
        {
          code: "t3-effort-raised",
          message:
            "T3 offers lab/max-only nothing at or below medium; max is the nearest level above",
        },
      ],
    });
  });

  test("an effort off the registry's ladder is not applied, and says so", () => {
    const route = only({
      label: "opus@claude",
      harness: "claude",
      modelId: "claude-opus-5-5",
      effort: "ultrathink",
    });
    expect(route).toMatchObject({
      status: "ready",
      target: { options: {} },
      notes: [
        {
          code: "t3-effort-unsupported",
          message:
            "the requested effort ultrathink is not on the registry's ladder; no effort is applied",
        },
      ],
    });
  });

  test("prefers the effort option id order over the model's declaration order", () => {
    const both = {
      providers: [
        {
          providerInstanceId: "pi",
          canRunChildTask: true,
          models: [
            {
              id: "lab/two-options",
              options: [
                { id: "thinking", values: ["low", "high"] },
                { id: "effort", values: ["low", "medium", "high"] },
              ],
            },
          ],
        },
      ],
    };
    const [route] = toT3Targets(
      answer([{ label: "two@pi", harness: "pi", modelId: "lab/two-options", effort: "medium" }]),
      [both],
    ).routes;
    expect(route?.status === "ready" && route.target.options).toEqual({ effort: "medium" });
  });

  test("never snaps to a level off the registry's ladder", () => {
    const route = only({
      label: "m27@pi",
      harness: "pi",
      modelId: "minimax/MiniMax-M2.7",
      effort: "high",
    });
    expect(route).toMatchObject({
      status: "ready",
      target: { options: { thinking: "low" } },
      notes: [{ code: "t3-effort-lowered" }],
    });
  });

  test("a model without an effort option runs with no options and a note", () => {
    const route = only({
      label: "pi-default@pi",
      harness: "pi",
      modelId: "default",
      effort: "high",
    });
    expect(route).toMatchObject({
      status: "ready",
      target: { options: {} },
      notes: [{ code: "t3-effort-unsupported" }],
    });
  });

  test("a route without effort clears inherited options with an empty object", () => {
    const route = only({ label: "opus@claude", harness: "claude", modelId: "claude-opus-5-5" });
    expect(route).toMatchObject({ status: "ready", notes: [], target: { options: {} } });
  });

  test("a disabled provider is unavailable and names T3's constraint", () => {
    expect(only({ label: "grok@cursor", harness: "cursor", modelId: "grok-4.7" })).toEqual({
      label: "grok@cursor",
      reason: {
        code: "t3-provider-unavailable",
        message: "T3 cannot run child tasks on cursor: Provider instance is disabled.",
      },
      status: "unavailable",
    });
  });

  test("a harness with no T3 provider is unavailable", () => {
    expect(only({ label: "x@popeye", harness: "popeye", modelId: "x" })).toMatchObject({
      status: "unavailable",
      reason: { code: "t3-provider-absent" },
    });
  });

  test("an unlisted model asks for a lookup until the caller names it as searched", () => {
    const route = {
      label: "kimi@pi/opencode-go",
      harness: "pi",
      provider: "opencode-go",
      modelId: "kimi-k3",
    };
    expect(only(route)).toEqual({
      label: "kimi@pi/opencode-go",
      providerInstanceId: "pi",
      search: "opencode-go/kimi-k3",
      status: "lookup",
    });
    expect(only(route, { searched: ["opencode-go/kimi-k3"] })).toMatchObject({
      status: "unavailable",
      reason: { code: "t3-model-not-offered" },
    });
  });

  test("a search result merges in, and its empty provider lists remove nothing", () => {
    // The search result leaves out canRunChildTask for pi: the earlier
    // document's true stands.
    const search = {
      providers: [
        { providerInstanceId: "claudeAgent", canRunChildTask: true, models: [] },
        {
          providerInstanceId: "pi",
          models: [{ id: "opencode-go/kimi-k3", options: [{ id: "thinking", values: ["max"] }] }],
        },
      ],
    };
    const routes = toT3Targets(
      answer([
        {
          label: "kimi",
          harness: "pi",
          provider: "opencode-go",
          modelId: "kimi-k3",
          effort: "medium",
        },
        { label: "opus", harness: "claude", modelId: "claude-opus-5-5", effort: "max" },
      ]),
      [CAPABILITIES, search],
      { searched: ["opencode-go/kimi-k3"] },
    ).routes;
    expect(routes.map((route) => route.status)).toEqual(["ready", "ready"]);
    expect(routes[0]).toMatchObject({ target: { options: { thinking: "max" } } });
  });

  test("a model listed again in a later document keeps the later copy", () => {
    const relisted = {
      providers: [
        {
          providerInstanceId: "codex",
          models: [
            {
              id: "gpt-6.1-sol",
              options: [{ id: "reasoningEffort", values: ["low", "medium", "high"] }],
            },
          ],
        },
      ],
    };
    const [route] = toT3Targets(
      answer([{ label: "sol@codex", harness: "codex", modelId: "gpt-6.1-sol", effort: "medium" }]),
      [CAPABILITIES, relisted],
    ).routes;
    expect(route).toMatchObject({ notes: [], target: { options: { reasoningEffort: "medium" } } });
  });

  test("a provider that states canRunChildTask false in a later document becomes unavailable", () => {
    const disabled = { providers: [{ providerInstanceId: "codex", canRunChildTask: false }] };
    const [route] = toT3Targets(
      answer([{ label: "sol@codex", harness: "codex", modelId: "gpt-6.1-sol" }]),
      [CAPABILITIES, disabled],
    ).routes;
    expect(route).toMatchObject({
      status: "unavailable",
      reason: { code: "t3-provider-unavailable" },
    });
  });

  test("keeps the answer's route order", () => {
    const routes = toT3Targets(
      answer([
        { label: "b", harness: "cursor", modelId: "grok-4.7" },
        { label: "a", harness: "claude", modelId: "claude-opus-5-5" },
      ]),
      [CAPABILITIES],
    ).routes;
    expect(routes.map((route) => route.label)).toEqual(["b", "a"]);
  });

  test.each([
    ["a non-answer", { routes: [] }, [CAPABILITIES], "answer"],
    [
      "a route without harness",
      answer([{ label: "x", modelId: "m" }]),
      [CAPABILITIES],
      "answer.routes[0].harness",
    ],
    ["capabilities without providers", answer([]), [{}], "capabilities[0].providers"],
  ])("rejects %s with t3-input-invalid", (_name, input, capabilities, field) => {
    let thrown: unknown;
    try {
      toT3Targets(input, capabilities);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouterError);
    expect((thrown as RouterError).toJSON()).toMatchObject({ code: "t3-input-invalid", field });
  });
});

function sink() {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => chunks.push(chunk) > 0 };
}

function cli(
  argv: string[],
  stdin: unknown,
  files: Record<string, unknown> = { "caps.json": CAPABILITIES },
) {
  const stdout = sink();
  const stderr = sink();
  const exitCode = runT3Cli(argv, {
    readFile: (path) => {
      if (!(path in files)) throw new Error("ENOENT");
      return JSON.stringify(files[path]);
    },
    readStdin: () => JSON.stringify(stdin),
    stderr,
    stdout,
  });
  return { exitCode, stderr: stderr.chunks.join(""), stdout: stdout.chunks.join("") };
}

describe("model-router-t3", () => {
  test("prints the translation as one JSON line and exits 0", () => {
    const result = cli(
      ["--capabilities", "caps.json"],
      answer([{ label: "opus", harness: "claude", modelId: "claude-opus-5-5", effort: "max" }]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout).routes[0].target.options).toEqual({ effort: "max" });
  });

  test("exits 3 when no route can run, still printing the translation", () => {
    const result = cli(
      ["--capabilities", "caps.json"],
      answer([{ label: "grok", harness: "cursor", modelId: "grok-4.7" }]),
    );
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).routes[0].status).toBe("unavailable");
  });

  test("passes --searched through", () => {
    const result = cli(
      ["--capabilities", "caps.json", "--searched", "opencode-go/kimi-k3"],
      answer([{ label: "kimi", harness: "pi", provider: "opencode-go", modelId: "kimi-k3" }]),
    );
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).routes[0].reason.code).toBe("t3-model-not-offered");
  });

  test.each([
    ["no --capabilities", [], "capabilities"],
    ["an unreadable file", ["--capabilities", "missing.json"], "capabilities"],
    ["an unknown flag", ["--capabilities", "caps.json", "--bogus"], "argv"],
  ])("exits 2 on %s with a t3-input-invalid envelope", (_name, argv, field) => {
    const result = cli(argv, answer([]));
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "t3-input-invalid", field });
  });

  test("accepts -h for help", () => {
    const result = cli(["-h"], answer([]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("model-router-t3 --capabilities");
  });

  test("an invalid JSON capabilities file is named in the error", () => {
    const stdout = sink();
    const stderr = sink();
    const exitCode = runT3Cli(["--capabilities", "ok.json", "--capabilities", "broken.json"], {
      readFile: (path) => (path === "broken.json" ? "{not json" : JSON.stringify(CAPABILITIES)),
      readStdin: () => JSON.stringify(answer([])),
      stderr,
      stdout,
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr.chunks.join("")).error.message).toBe(
      "the capabilities file broken.json is not valid JSON",
    );
  });

  test("the built bin runs from dist", () => {
    const run = spawnSync(process.execPath, [join(repoRoot, "dist", "t3-cli.js"), "--help"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("model-router-t3 --capabilities");
  });
});
