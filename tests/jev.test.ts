import { describe, expect, test, vi } from "vitest";
import { askJev, JevError, type JevQuestion } from "../src/jev.js";
import { withEnv } from "./helpers.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const QUESTIONS: Record<string, JevQuestion> = {
  urgent: {
    type: "noul",
    instructions: "Does the work described in the state read secret material?",
    criteria: { true: "A secret value passes through.", false: "Only a path or a name." },
  },
};

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const fail = (status: number, headers: Record<string, string> = {}): Response =>
  new Response("upstream said no", { status, headers });

const never = (): Promise<void> => {
  throw new Error("sleep should not be called");
};

async function rejected(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    expect(error, `expected a JevError, got ${String(error)}`).toBeInstanceOf(JevError);
    return error as JevError;
  }
  throw new Error("expected a rejection, got a resolved promise");
}

describe("askJev key handling", () => {
  test("a missing key throws MISSING_KEY before any request", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("MISSING_KEY");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  test("the missing-key message names only TYPESAFE_API_KEY", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.message).toBe(
        "TYPESAFE_API_KEY is not set. Set it in the environment and run the command again.",
      );
      expect(error.message).not.toMatch(/~|\//);
    });
  });
});

describe("askJev request shape", () => {
  test("a successful call returns the parsed body", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const body = {
        model: "jev-1.13.0",
        answers: { urgent: { type: "noul", noul: 0.91 } },
        usage: { input_tokens: 1160, output_tokens: 180 },
      };
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(body));
      const result = await askJev("state", QUESTIONS, { sleep: never });
      expect(result.model).toBe("jev-1.13.0");
      expect(result.answers.urgent).toEqual({ type: "noul", noul: 0.91 });
      expect(result.usage).toEqual({ input_tokens: 1160, output_tokens: 180 });
      fetchSpy.mockRestore();
    }));

  test("the request posts to the endpoint with the bearer key, model and every question", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok({
          model: "jev-1.13.0",
          answers: { urgent: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      await askJev("the state", QUESTIONS, { model: "jev-1.13.0", sleep: never });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [
        string,
        { headers: Record<string, string>; body: string; method: string },
      ];
      expect(url).toBe(ENDPOINT);
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer k-123");
      expect(init.headers["Content-Type"]).toBe("application/json");
      const sent = JSON.parse(init.body) as {
        state: unknown;
        model: string;
        questions: Record<string, unknown>;
      };
      expect(sent.state).toBe("the state");
      expect(sent.model).toBe("jev-1.13.0");
      expect(Object.keys(sent.questions)).toEqual(["urgent"]);
      fetchSpy.mockRestore();
    }));

  test("the model defaults to jev-latest when no option names one", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok({
          model: "jev-1.13.0",
          answers: { urgent: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      await askJev("state", QUESTIONS, { sleep: never });
      const init = fetchSpy.mock.calls[0]?.[1] as { body: string } | undefined;
      expect(init).toBeDefined();
      const sent = JSON.parse(init?.body ?? "") as {
        model: string;
      };
      expect(sent.model).toBe("jev-latest");
      fetchSpy.mockRestore();
    }));
});

describe("askJev retry and failure handling", () => {
  test("429 retries with exponential backoff and then succeeds", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return attempt < 3
          ? fail(429)
          : ok({
              model: "m",
              answers: { urgent: { type: "noul", noul: 0.5 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            });
      });
      const result = await askJev("state", QUESTIONS, {
        backoffMs: 10,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      });
      expect(result.model).toBe("m");
      expect(attempt).toBe(3);
      expect(slept).toEqual([10, 20]);
      fetchSpy.mockRestore();
    }));

  test("a Retry-After header in seconds replaces the exponential schedule", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return attempt < 2
          ? fail(429, { "Retry-After": "1" })
          : ok({
              model: "m",
              answers: { urgent: { type: "noul", noul: 0.5 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            });
      });
      await askJev("state", QUESTIONS, {
        backoffMs: 10,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      });
      expect(slept).toEqual([1000]);
      fetchSpy.mockRestore();
    }));

  test("a Retry-After date in the past clamps to zero", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return attempt < 2
          ? fail(429, { "Retry-After": new Date(Date.now() - 60_000).toUTCString() })
          : ok({
              model: "m",
              answers: { urgent: { type: "noul", noul: 0.5 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            });
      });
      await askJev("state", QUESTIONS, {
        backoffMs: 10,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      });
      expect(slept).toEqual([0]);
      fetchSpy.mockRestore();
    }));

  test("529 is retried like 429", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return attempt < 2
          ? fail(529)
          : ok({
              model: "m",
              answers: { urgent: { type: "noul", noul: 0.5 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            });
      });
      const result = await askJev("state", QUESTIONS, {
        backoffMs: 1,
        sleep: () => Promise.resolve(),
      });
      expect(result.model).toBe("m");
      expect(attempt).toBe(2);
      fetchSpy.mockRestore();
    }));

  test("an exhausted backoff throws RATE_LIMITED with the status", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return fail(429);
      });
      const error = await rejected(
        askJev("state", QUESTIONS, {
          maxAttempts: 3,
          backoffMs: 1,
          sleep: () => Promise.resolve(),
        }),
      );
      expect(attempt).toBe(3);
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.status).toBe(429);
      fetchSpy.mockRestore();
    }));

  test("a non-retryable status throws SERVICE_ERROR on the first response", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return fail(400);
      });
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(attempt).toBe(1);
      expect(error.code).toBe("SERVICE_ERROR");
      expect(error.status).toBe(400);
      fetchSpy.mockRestore();
    }));

  test("a network failure throws UNREACHABLE", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("UNREACHABLE");
      expect(error.message).toContain("ENOTFOUND");
      fetchSpy.mockRestore();
    }));

  test("an error response whose body read fails is SERVICE_ERROR with the status", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const broken = {
        ok: false,
        status: 502,
        headers: { get: () => null },
        text: () => Promise.reject(new Error("stream reset")),
      } as unknown as Response;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(broken);
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("SERVICE_ERROR");
      expect(error.status).toBe(502);
      expect(error.message).toContain("502");
      fetchSpy.mockRestore();
    }));

  test("a stalled endpoint times out with UNREACHABLE naming the limit, after one call", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      let calls = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted due to timeout")),
          );
        });
      });
      const error = await rejected(askJev("state", QUESTIONS, { timeoutMs: 20, sleep: never }));
      expect(error.code).toBe("UNREACHABLE");
      expect(error.message).toContain("20 ms timeout");
      expect(calls).toBe(1);
      fetchSpy.mockRestore();
    }));

  test("a Retry-After above the cap stops the retries at once with RATE_LIMITED naming the wait", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let calls = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        calls++;
        return fail(429, { "Retry-After": "86400" });
      });
      const error = await rejected(
        askJev("state", QUESTIONS, {
          sleep: (ms) => {
            slept.push(ms);
            return Promise.resolve();
          },
        }),
      );
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.message).toContain("86400000");
      expect(calls).toBe(1);
      expect(slept).toEqual([]);
      fetchSpy.mockRestore();
    }));

  test("a 200 without an answers object throws BAD_RESPONSE", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ model: "m" }));
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("BAD_RESPONSE");
      fetchSpy.mockRestore();
    }));

  test("a 200 whose body is not JSON throws BAD_RESPONSE", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("not json", { status: 200 }));
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("BAD_RESPONSE");
      fetchSpy.mockRestore();
    }));
});

describe("askJev defaults", () => {
  test("the default attempt count is 4", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return fail(429);
      });
      const error = await rejected(
        askJev("state", QUESTIONS, { backoffMs: 1, sleep: () => Promise.resolve() }),
      );
      expect(error.code).toBe("RATE_LIMITED");
      expect(attempt).toBe(4);
      fetchSpy.mockRestore();
    }));
});

describe("askJev response validation", () => {
  const okBody = (answers: unknown): Record<string, unknown> => ({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 10, output_tokens: 2 },
  });

  const choiceQuestions: Record<string, JevQuestion> = {
    pick: {
      type: "choice",
      instructions: "Pick the matching item.",
      criteria: { "task-a": "covers a", "task-b": "covers b" },
    },
  };

  const scoreQuestions: Record<string, JevQuestion> = {
    level: {
      type: "score",
      instructions: "Score the item.",
      criteria: ["low", "mid", "high"],
    },
  };

  test("a well-formed choice answer for an asked choice question is returned", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const answer = {
        type: "choice",
        choice: "task-a",
        confidence: 0.8,
        probabilities: { "task-a": 0.8, "task-b": 0.2 },
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(ok(okBody({ pick: answer })));
      const result = await askJev("state", choiceQuestions, { sleep: never });
      expect(result.answers.pick).toStrictEqual(answer);
      fetchSpy.mockRestore();
    }));

  test("a choice outside the question's criteria is BAD_RESPONSE naming the id and the field", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok(
          okBody({
            pick: {
              type: "choice",
              choice: "task-zz",
              confidence: 0.8,
              probabilities: { "task-zz": 1 },
            },
          }),
        ),
      );
      const error = await rejected(askJev("state", choiceQuestions, { sleep: never }));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toContain("pick");
      expect(error.message).toContain("choice");
      fetchSpy.mockRestore();
    }));

  test("a well-formed score answer for an asked score question is returned", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const answer = {
        type: "score",
        score: 1.5,
        confidence: 0.7,
        legend: { "0": "low", "1": "mid", "2": "high" },
        probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 },
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(ok(okBody({ level: answer })));
      const result = await askJev("state", scoreQuestions, { sleep: never });
      expect(result.answers.level).toStrictEqual(answer);
      fetchSpy.mockRestore();
    }));

  test("a score answer whose legend holds a non-string is BAD_RESPONSE naming the id and the field", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok(
          okBody({
            level: {
              type: "score",
              score: 1.5,
              confidence: 0.7,
              legend: { "0": 3 },
              probabilities: { "0": 1 },
            },
          }),
        ),
      );
      const error = await rejected(askJev("state", scoreQuestions, { sleep: never }));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toContain("level");
      expect(error.message).toContain("legend");
      fetchSpy.mockRestore();
    }));

  test("a noul outside [0, 1] is BAD_RESPONSE naming the id and the field", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(ok(okBody({ urgent: { type: "noul", noul: 7 } })));
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toContain("urgent");
      expect(error.message).toContain("noul");
      fetchSpy.mockRestore();
    }));

  test("an answer for a question that was not asked is ignored", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok(
          okBody({
            urgent: { type: "noul", noul: 0.4 },
            unasked: { type: "noul", noul: 0.9 },
          }),
        ),
      );
      const result = await askJev("state", QUESTIONS, { sleep: never });
      expect(Object.keys(result.answers).sort()).toEqual(["unasked", "urgent"]);
      fetchSpy.mockRestore();
    }));
});
