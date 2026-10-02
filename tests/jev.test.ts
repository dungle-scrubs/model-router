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
      expect(error.message).toContain("TYPESAFE_API_KEY");
      expect(error.message).not.toMatch(/opchain|1password|op:\/\//i);
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
          answers: {},
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
          answers: {},
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
          : ok({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
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
          : ok({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
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
          : ok({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
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
          : ok({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
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
