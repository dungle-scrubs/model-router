import { describe, expect, test, vi } from "vitest";
import { describe as describeStep } from "../src/describe.js";
import { RouterError } from "../src/error.js";
import { JevError } from "../src/jev.js";
import { rank } from "../src/rank.js";
import { fixturePath, withEnv } from "./helpers.js";

const FIXTURE = fixturePath("describe.json");
const MINIMAL = fixturePath("minimal.json");
const NO_QUESTIONS = fixturePath("no-questions.json");

const USAGE = { input_tokens: 500, output_tokens: 30 };

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const choiceAnswer = (
  choice: string,
  confidence: number,
  probabilities: Record<string, number>,
) => ({
  type: "choice" as const,
  choice,
  confidence,
  probabilities,
});

const noulAnswer = (noul: number) => ({ type: "noul" as const, noul });

/** The recorded happy-path response: task-a at 0.9, browser at 0.8, repo-access at 0.2. */
const happyBody = {
  model: "jev-1.13.0",
  answers: {
    task: choiceAnswer("task-a", 0.9, { "task-a": 0.9, "task-b": 0.1 }),
    needs_browser: noulAnswer(0.8),
    "needs_repo-access": noulAnswer(0.2),
  },
  usage: USAGE,
};

type SeenRequest =
  | { state: unknown; model: string; questions: Record<string, unknown> }
  | undefined;

/** Stub the real fetch with a recorded response and capture the request body. */
function stubFetch(
  body: unknown,
  status = 200,
): { seen: () => SeenRequest; spy: ReturnType<typeof vi.spyOn> } {
  let seen: SeenRequest;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    seen = JSON.parse(String((init as RequestInit).body)) as NonNullable<SeenRequest>;
    if (status === 200) return ok(body);
    return new Response("upstream said no", { status });
  });
  return { seen: () => seen, spy };
}

async function catchRouterError(promise: Promise<unknown>): Promise<RouterError> {
  try {
    await promise;
  } catch (error) {
    expect(error, `expected a RouterError, got ${String(error)}`).toBeInstanceOf(RouterError);
    return error as RouterError;
  }
  throw new Error("expected a throw, got a return");
}

describe("the describe step's privacy gate", () => {
  test("privacy absent is query-invalid on the privacy field and makes no request", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await catchRouterError(
        describeStep("some work", '{"stakes":"high"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("query-invalid");
      expect(error.field).toBe("privacy");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));

  test("privacy secret is describe-private and makes no request", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"secret"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-private");
      expect(error.field).toBe("privacy");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));

  test("privacy secret refuses before the registry loads: a missing registry path still gives describe-private", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"secret"}', {
          registry: "/nonexistent/registry.json",
        }),
      );
      expect(error.code).toBe("describe-private");
      expect(error.field).toBe("privacy");
    }));

  test("a whitespace-only description is query-invalid and makes no request", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await catchRouterError(
        describeStep("   \n  ", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("query-invalid");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));

  test("a partial query with an unknown field is query-invalid before any request", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal","tsk":"task-a"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("query-invalid");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));

  test("a registry with no tasks and a task-needed query is query-invalid with no request", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: MINIMAL }),
      );
      expect(error.code).toBe("query-invalid");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));
});

describe("the describe step's Jev request", () => {
  test("the state is the work description and nothing else", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { seen, spy } = stubFetch(happyBody);
      await describeStep("read the git history and report", '{"privacy":"normal"}', {
        registry: FIXTURE,
      });
      expect(seen()?.state).toBe("read the git history and report");
      spy.mockRestore();
    }));

  test("the pinned model from the config goes out", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { seen, spy } = stubFetch(happyBody);
      await describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE });
      expect(seen()?.model).toBe("jev-1.13.0");
      spy.mockRestore();
    }));

  test("the task question offers every declared task with its description", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { seen, spy } = stubFetch(happyBody);
      await describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE });
      const taskQuestion = seen()?.questions.task as {
        type: string;
        criteria: Record<string, string>;
      };
      expect(taskQuestion.type).toBe("choice");
      expect(taskQuestion.criteria).toEqual({
        "task-a": "Implements a change to code in a repository.",
        "task-b": "Researches a question and reports the answer as text.",
      });
      spy.mockRestore();
    }));

  test("a caller task removes the task question; the capability questions stay", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { seen, spy } = stubFetch(happyBody);
      await describeStep("some work", '{"privacy":"normal","task":"task-b"}', {
        registry: FIXTURE,
      });
      const keys = Object.keys(seen()?.questions ?? {}).sort();
      expect(keys).toEqual(["needs_browser", "needs_repo-access"]);
      spy.mockRestore();
    }));

  test("inline minimums remove the task question the same way", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { seen, spy } = stubFetch(happyBody);
      await describeStep("some work", '{"privacy":"normal","minimums":{"coding":7}}', {
        registry: FIXTURE,
      });
      expect(Object.hasOwn(seen()?.questions ?? {}, "task")).toBe(false);
      spy.mockRestore();
    }));

  test("each router.questions entry becomes one noul question with the registry's wording", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { seen, spy } = stubFetch(happyBody);
      await describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE });
      const questions = seen()?.questions ?? {};
      expect(questions.needs_browser).toEqual({
        type: "noul",
        instructions:
          "Does the work described in the state require driving a web browser, meaning loading pages, clicking or reading a rendered DOM?",
      });
      expect(questions["needs_repo-access"]).toEqual({
        type: "noul",
        instructions:
          "Does the work described in the state require reading or changing files in the workspace?",
      });
      spy.mockRestore();
    }));
});

describe("the describe step's gate and result", () => {
  test("a recorded response fills the task and adds the capabilities that clear the threshold", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep("some work", '{"privacy":"normal","stakes":"high"}', {
        registry: FIXTURE,
      });
      expect(result.query.task).toBe("task-a");
      expect(result.query.needs).toEqual(["browser"]);
      expect(result.query.privacy).toBe("normal");
      expect(result.query.stakes).toBe("high");
      expect(result.describe.model).toBe("jev-1.13.0");
      expect(result.describe.taskGate).toBe(0.85);
      expect(result.describe.capabilityThreshold).toBe(0.5);
      expect(result.describe.task.source).toBe("jev");
      expect(result.describe.task.confidence).toBe(0.9);
      expect(result.describe.task.candidates).toEqual([
        { task: "task-a", probability: 0.9 },
        { task: "task-b", probability: 0.1 },
      ]);
      expect(result.describe.needsAdded).toEqual([{ capability: "browser", probability: 0.8 }]);
      expect(result.describe.usage).toEqual(USAGE);
      expect(result.warnings).toEqual([]);
      spy.mockRestore();
    }));

  test("the filled query ranks: the task's floors and the added need apply", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep("some work", '{"privacy":"normal"}', {
        registry: FIXTURE,
      });
      const answer = rank(result.query, { registry: FIXTURE });
      expect(answer.query.task).toBe("task-a");
      // task-a needs repo-access; browser was added, so model-b (no browser) is gone.
      expect(answer.removed.map((entry) => entry.label)).toEqual(["model-b@harness-x"]);
      expect(answer.routes.map((route) => route.label)).toEqual([
        "model-a@harness-x",
        "model-c@harness-y",
      ]);
      spy.mockRestore();
    }));

  test("a confidence below taskGate keeps the guess and warns task-uncertain with a fix", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        ...happyBody,
        answers: {
          task: choiceAnswer("task-b", 0.6, { "task-a": 0.4, "task-b": 0.6 }),
          needs_browser: noulAnswer(0.1),
          "needs_repo-access": noulAnswer(0.1),
        },
      };
      const { spy } = stubFetch(body);
      const result = await describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE });
      expect(result.query.task).toBe("task-b");
      expect(result.warnings).toHaveLength(1);
      const warning = result.warnings[0];
      expect(warning?.code).toBe("task-uncertain");
      expect(warning?.fix).toContain("task");
      expect(result.describe.task.confidence).toBe(0.6);
      expect(result.describe.task.candidates[0]).toEqual({ task: "task-b", probability: 0.6 });
      spy.mockRestore();
    }));

  test("a caller task is kept with source caller and no candidates", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep("some work", '{"privacy":"normal","task":"task-b"}', {
        registry: FIXTURE,
      });
      expect(result.query.task).toBe("task-b");
      expect(result.describe.task.source).toBe("caller");
      expect(result.describe.task.confidence).toBeNull();
      expect(result.describe.task.candidates).toEqual([]);
      expect(result.warnings).toEqual([]);
      spy.mockRestore();
    }));

  test("inline minimums are kept with source inline-need and no task on the query", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep("some work", '{"privacy":"normal","minimums":{}}', {
        registry: FIXTURE,
      });
      expect(result.query.task).toBeUndefined();
      expect(result.query.minimums).toEqual({});
      expect(result.describe.task.source).toBe("inline-need");
      spy.mockRestore();
    }));

  test("a capability answer never removes a capability the caller named", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep(
        "some work",
        '{"privacy":"normal","task":"task-b","needs":["repo-access","browser"]}',
        { registry: FIXTURE },
      );
      expect(result.query.needs).toEqual(["repo-access", "browser"]);
      expect(result.describe.needsAdded).toEqual([]);
      spy.mockRestore();
    }));

  test("a capability the caller already named is not reported as added", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep(
        "some work",
        '{"privacy":"normal","task":"task-b","needs":["browser"]}',
        { registry: FIXTURE },
      );
      expect(result.query.needs).toEqual(["browser"]);
      expect(result.describe.needsAdded).toEqual([]);
      spy.mockRestore();
    }));

  test("an unusable capability answer makes the whole response unusable", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        ...happyBody,
        answers: {
          task: choiceAnswer("task-a", 0.9, { "task-a": 0.9, "task-b": 0.1 }),
          needs_browser: { type: "score", score: 1, legend: {}, probabilities: {}, confidence: 1 },
          "needs_repo-access": noulAnswer(0.1),
        },
      };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      spy.mockRestore();
    }));
});

describe("the describe step with nothing to ask", () => {
  test("a task the caller named and no router.questions means no request, no key and no warning", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await describeStep(
        "some work",
        '{"privacy":"normal","task":"task-b","needs":["repo-access"]}',
        { registry: NO_QUESTIONS },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.query.task).toBe("task-b");
      expect(result.query.needs).toEqual(["repo-access"]);
      expect(result.describe.model).toBeNull();
      expect(result.describe.task.source).toBe("caller");
      expect(result.describe.task.confidence).toBeNull();
      expect(result.describe.task.candidates).toEqual([]);
      expect(result.describe.needsAdded).toEqual([]);
      expect(result.describe.usage).toBeNull();
      expect(result.warnings).toEqual([]);
      fetchSpy.mockRestore();
    }));

  test("inline minimums the caller stated mean the same: no request with nothing to ask", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await describeStep(
        "some work",
        '{"privacy":"normal","minimums":{"coding":7}}',
        { registry: NO_QUESTIONS },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.describe.task.source).toBe("inline-need");
      expect(result.warnings).toEqual([]);
      fetchSpy.mockRestore();
    }));
});

describe("the describe step's config gates", () => {
  test("a lower taskGate takes the same confidence without the warning, and the block shows the applied value", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        ...happyBody,
        answers: {
          task: choiceAnswer("task-b", 0.6, { "task-a": 0.4, "task-b": 0.6 }),
          needs_browser: noulAnswer(0.1),
          "needs_repo-access": noulAnswer(0.1),
        },
      };
      const { spy } = stubFetch(body);
      const result = await describeStep("some work", '{"privacy":"normal"}', {
        registry: FIXTURE,
        config: { describe: { taskGate: 0.5 } },
      });
      expect(result.warnings).toEqual([]);
      expect(result.describe.taskGate).toBe(0.5);
      spy.mockRestore();
    }));

  test("a higher capabilityThreshold with the same answer adds nothing, and the block shows the applied value", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep("some work", '{"privacy":"normal"}', {
        registry: FIXTURE,
        config: { describe: { capabilityThreshold: 0.9 } },
      });
      expect(result.query.needs).toEqual([]);
      expect(result.describe.needsAdded).toEqual([]);
      expect(result.describe.capabilityThreshold).toBe(0.9);
      spy.mockRestore();
    }));

  test("a config file drives the gates the same way as the object form", async () => {
    // Covered end to end in the CLI tests; the object form is the library
    // seam and shares one validator with the file form.
    await withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep("some work", '{"privacy":"normal"}', {
        registry: FIXTURE,
        config: { describe: { taskGate: 0.85, capabilityThreshold: 0.5 } },
      });
      expect(result.describe.taskGate).toBe(0.85);
      expect(result.describe.capabilityThreshold).toBe(0.5);
      spy.mockRestore();
    });
  });
});

describe("the describe step when Jev fails", () => {
  test("a missing key with the task needed is describe-failed naming only the variable", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toBe(
        "the describe step needed a task from Jev and the call failed (MISSING_KEY): " +
          "TYPESAFE_API_KEY is not set. Set it in the environment and run the command again.",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));

  test("a missing key with a caller task continues with capabilities-unasked", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const result = await describeStep("some work", '{"privacy":"normal","task":"task-b"}', {
        registry: FIXTURE,
      });
      expect(result.query.task).toBe("task-b");
      expect(result.query.needs).toEqual([]);
      expect(result.describe.model).toBeNull();
      expect(result.describe.task.source).toBe("caller");
      expect(result.describe.task.confidence).toBeNull();
      expect(result.describe.task.candidates).toEqual([]);
      expect(result.describe.needsAdded).toEqual([]);
      expect(result.describe.usage).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.code).toBe("capabilities-unasked");
      expect(result.warnings[0]?.message).toContain("MISSING_KEY");
      expect(result.warnings[0]?.fix).toContain("needs");
    }));

  test("a missing key with inline minimums continues with capabilities-unasked", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const result = await describeStep(
        "some work",
        '{"privacy":"normal","minimums":{"coding":7}}',
        { registry: FIXTURE },
      );
      expect(result.describe.task.source).toBe("inline-need");
      expect(result.warnings.map((warning) => warning.code)).toEqual(["capabilities-unasked"]);
    }));

  test("a failed request with the task needed is describe-failed carrying the code", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch({}, 400);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("SERVICE_ERROR");
      spy.mockRestore();
    }));

  test("a response without a usable task answer is describe-failed", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = { model: "jev-1.13.0", answers: {}, usage: USAGE };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      spy.mockRestore();
    }));

  test("a task answer naming an undeclared task is unusable", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        model: "jev-1.13.0",
        answers: {
          task: choiceAnswer("task-zz", 0.99, { "task-zz": 0.99 }),
          needs_browser: noulAnswer(0.1),
          "needs_repo-access": noulAnswer(0.1),
        },
        usage: USAGE,
      };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      spy.mockRestore();
    }));

  test("an error response whose body read fails is describe-failed carrying SERVICE_ERROR", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const broken = {
        ok: false,
        status: 502,
        headers: { get: () => null },
        text: () => Promise.reject(new Error("stream reset")),
      } as unknown as Response;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(broken);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("SERVICE_ERROR");
      fetchSpy.mockRestore();
    }));
});

describe("the Jev 200 body is validated against the questions sent", () => {
  test("a choice answer without confidence is describe-failed carrying BAD_RESPONSE", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        model: "jev-1.13.0",
        answers: {
          task: {
            type: "choice",
            choice: "task-a",
            probabilities: { "task-a": 0.9, "task-b": 0.1 },
          },
          needs_browser: noulAnswer(0.8),
          "needs_repo-access": noulAnswer(0.2),
        },
        usage: USAGE,
      };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      expect(error.message).toContain("task");
      expect(error.message).toContain("confidence");
      spy.mockRestore();
    }));

  test("a choice answer without probabilities is describe-failed", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        model: "jev-1.13.0",
        answers: {
          task: { type: "choice", choice: "task-a", confidence: 0.9 },
          needs_browser: noulAnswer(0.8),
          "needs_repo-access": noulAnswer(0.2),
        },
        usage: USAGE,
      };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      expect(error.message).toContain("probabilities");
      spy.mockRestore();
    }));

  test("a string confidence is describe-failed", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        ...happyBody,
        answers: {
          task: {
            type: "choice",
            choice: "task-a",
            confidence: "0.1",
            probabilities: { "task-a": 0.9, "task-b": 0.1 },
          },
          needs_browser: noulAnswer(0.1),
          "needs_repo-access": noulAnswer(0.1),
        },
      };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      spy.mockRestore();
    }));

  test("a probability outside [0, 1] is describe-failed", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        ...happyBody,
        answers: {
          task: choiceAnswer("task-a", 0.9, { "task-a": 1.5, "task-b": 0.1 }),
          needs_browser: noulAnswer(0.1),
          "needs_repo-access": noulAnswer(0.1),
        },
      };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      expect(error.message).toContain("probabilities");
      spy.mockRestore();
    }));

  test("a body without model is describe-failed", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        answers: {
          task: choiceAnswer("task-a", 0.9, { "task-a": 0.9, "task-b": 0.1 }),
          needs_browser: noulAnswer(0.1),
          "needs_repo-access": noulAnswer(0.1),
        },
        usage: USAGE,
      };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      expect(error.message).toContain("model");
      spy.mockRestore();
    }));

  test("a body without usage is describe-failed", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        model: "jev-1.13.0",
        answers: {
          task: choiceAnswer("task-a", 0.9, { "task-a": 0.9, "task-b": 0.1 }),
          needs_browser: noulAnswer(0.1),
          "needs_repo-access": noulAnswer(0.1),
        },
      };
      const { spy } = stubFetch(body);
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error.code).toBe("describe-failed");
      expect(error.message).toContain("BAD_RESPONSE");
      expect(error.message).toContain("usage");
      spy.mockRestore();
    }));

  test("a noul outside [0, 1] with a caller task warns capabilities-unasked and keeps the needs", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        model: "jev-1.13.0",
        answers: {
          needs_browser: noulAnswer(7),
          "needs_repo-access": noulAnswer(0.1),
        },
        usage: USAGE,
      };
      const { spy } = stubFetch(body);
      const result = await describeStep(
        "some work",
        '{"privacy":"normal","task":"task-b","needs":["repo-access"]}',
        { registry: FIXTURE },
      );
      expect(result.query.needs).toEqual(["repo-access"]);
      expect(result.describe.needsAdded).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.code).toBe("capabilities-unasked");
      expect(result.warnings[0]?.message).toContain("BAD_RESPONSE");
      spy.mockRestore();
    }));

  test("a missing capability answer with a caller task warns capabilities-unasked and keeps the needs", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        model: "jev-1.13.0",
        answers: { "needs_repo-access": noulAnswer(0.1) },
        usage: USAGE,
      };
      const { spy } = stubFetch(body);
      const result = await describeStep(
        "some work",
        '{"privacy":"normal","task":"task-b","needs":["repo-access"]}',
        { registry: FIXTURE },
      );
      expect(result.query.needs).toEqual(["repo-access"]);
      expect(result.describe.needsAdded).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.code).toBe("capabilities-unasked");
      expect(result.warnings[0]?.message).toContain("BAD_RESPONSE");
      spy.mockRestore();
    }));
});

describe("JevError stays distinguishable", () => {
  test("the describe step does not leak a bare JevError for a task-needed failure", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new JevError("UNREACHABLE", "down"));
      const error = await catchRouterError(
        describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE }),
      );
      expect(error).toBeInstanceOf(RouterError);
      expect(error).not.toBeInstanceOf(JevError);
      fetchSpy.mockRestore();
    }));
});

describe("boundary and passthrough behavior", () => {
  test("a confidence exactly at taskGate is taken without the warning", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        ...happyBody,
        answers: {
          task: choiceAnswer("task-a", 0.85, { "task-a": 0.85, "task-b": 0.15 }),
          needs_browser: noulAnswer(0.1),
          "needs_repo-access": noulAnswer(0.1),
        },
      };
      const { spy } = stubFetch(body);
      const result = await describeStep("some work", '{"privacy":"normal"}', {
        registry: FIXTURE,
      });
      expect(result.warnings).toEqual([]);
      expect(result.query.task).toBe("task-a");
      spy.mockRestore();
    }));

  test("a noul exactly at capabilityThreshold is added", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        ...happyBody,
        answers: {
          task: choiceAnswer("task-a", 0.9, { "task-a": 0.9, "task-b": 0.1 }),
          needs_browser: noulAnswer(0.5),
          "needs_repo-access": noulAnswer(0.1),
        },
      };
      const { spy } = stubFetch(body);
      const result = await describeStep("some work", '{"privacy":"normal"}', {
        registry: FIXTURE,
      });
      expect(result.query.needs).toEqual(["browser"]);
      expect(result.describe.needsAdded).toEqual([{ capability: "browser", probability: 0.5 }]);
      spy.mockRestore();
    }));

  test("the filled query echoes every caller field it did not fill", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { spy } = stubFetch(happyBody);
      const result = await describeStep(
        "some work",
        {
          effort: "high",
          excludeFamilies: ["family-b"],
          pin: "model-a@harness-x",
          prefer: "speed",
          privacy: "normal",
          spec: "settled",
          stakes: "high",
        },
        { registry: FIXTURE },
      );
      expect(result.query).toEqual({
        effort: "high",
        excludeFamilies: ["family-b"],
        needs: ["browser"],
        pin: "model-a@harness-x",
        prefer: "speed",
        privacy: "normal",
        spec: "settled",
        stakes: "high",
        task: "task-a",
      });
      spy.mockRestore();
    }));

  test("the task question carries its instruction text", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { seen, spy } = stubFetch(happyBody);
      await describeStep("some work", '{"privacy":"normal"}', { registry: FIXTURE });
      const taskQuestion = seen()?.questions.task as { instructions: unknown };
      expect(String(taskQuestion.instructions)).toContain("Which task type");
      spy.mockRestore();
    }));

  test("the describe block echoes the pinned model from the config", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const { seen, spy } = stubFetch(happyBody);
      await describeStep("some work", '{"privacy":"normal"}', {
        registry: FIXTURE,
        config: { describe: { jevModel: "jev-test" } },
      });
      expect(seen()?.model).toBe("jev-test");
      spy.mockRestore();
    }));
});
