import { describe, expect, test, vi } from "vitest";
import {
  askJev,
  type JevChoiceAnswer,
  JevError,
  type JevNoulAnswer,
  type JevQuestion,
} from "../src/jev.js";
import { withEnv } from "./helpers.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const QUESTIONS: Record<string, JevQuestion> = {
  urgent: {
    type: "noul",
    instructions: "Does the work described in the state need to finish today?",
    criteria: { true: "The state names a same-day deadline.", false: "No deadline is named." },
  },
};

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const fail = (status: number, headers: Record<string, string> = {}): Response =>
  new Response("upstream said no", { status, headers });

/** A response that sends its headers and one body chunk, then stalls: the
 * stream never completes until the attempt's signal aborts, when it errors
 * with the signal's own reason. */
const stalledBody = (status: number, signal: AbortSignal | null | undefined): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
  return new Response(body, { status });
};

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

  test("an empty key throws MISSING_KEY before any call", async () => {
    await withEnv({ TYPESAFE_API_KEY: "" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("MISSING_KEY");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  test("a key of only printable ASCII, including both boundary characters, is used", async () =>
    withEnv({ TYPESAFE_API_KEY: "!key-a~" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok({
          model: "m",
          answers: { urgent: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      const result = await askJev("state", QUESTIONS, { sleep: never });
      expect(result.model).toBe("m");
      const init = fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> };
      expect(init.headers.Authorization).toBe("Bearer !key-a~");
      fetchSpy.mockRestore();
    }));

  test("the missing-key message names only TYPESAFE_API_KEY", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.message).toBe(
        "TYPESAFE_API_KEY is not set. Set it in the environment and run the command again.",
      );
      expect(error.message).not.toMatch(/~|\//);
    });
  });

  test("a key with a line break is refused before any call", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a\nX" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("MISSING_KEY");
      expect(error.message).toBe(
        "TYPESAFE_API_KEY is set but is not a usable key: it holds a space, a line break or another character outside printable ASCII. Set it to the key alone and run the command again.",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));

  test("a key with an inner space is refused the same way", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a X" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("MISSING_KEY");
      expect(error.message).toBe(
        "TYPESAFE_API_KEY is set but is not a usable key: it holds a space, a line break or another character outside printable ASCII. Set it to the key alone and run the command again.",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));

  test("a key with a non-ASCII character is refused the same way", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a\u00e9" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("MISSING_KEY");
      expect(error.message).toBe(
        "TYPESAFE_API_KEY is set but is not a usable key: it holds a space, a line break or another character outside printable ASCII. Set it to the key alone and run the command again.",
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));
});

describe("askJev key redaction", () => {
  test("a fetch error that echoes the key has every occurrence redacted", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("echo Bearer key-a and key-a again"));
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("UNREACHABLE");
      expect(error.message).toBe(
        `could not reach ${ENDPOINT}: echo Bearer [redacted] and [redacted] again`,
      );
      fetchSpy.mockRestore();
    }));

  test("an error body that echoes the key has it redacted", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("denied key-a", { status: 500 }));
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("SERVICE_ERROR");
      expect(error.message).toBe(`${ENDPOINT} returned HTTP 500: denied [redacted]`);
      fetchSpy.mockRestore();
    }));

  test("a failed error-body read that echoes the key has it redacted", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const broken = {
        ok: false,
        status: 502,
        headers: { get: () => null },
        text: () => Promise.reject(new Error("stream reset while reading key-a")),
      } as unknown as Response;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(broken);
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("SERVICE_ERROR");
      expect(error.message).toBe(
        `${ENDPOINT} returned HTTP 502: the error body could not be read: stream reset while reading [redacted]`,
      );
      fetchSpy.mockRestore();
    }));

  test("a short-word key never corrupts the fixed error-body phrase", async () =>
    withEnv({ TYPESAFE_API_KEY: "error" }, async () => {
      const broken = {
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: () => Promise.reject(new Error("stream reset")),
      } as unknown as Response;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(broken);
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("SERVICE_ERROR");
      expect(error.message).toBe(
        `${ENDPOINT} returned HTTP 500: the error body could not be read: stream reset`,
      );
      fetchSpy.mockRestore();
    }));

  test("a failed error-body read that echoes a short-word key redacts only the echo", async () =>
    withEnv({ TYPESAFE_API_KEY: "error" }, async () => {
      const broken = {
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: () => Promise.reject(new Error("stream reset while reading error")),
      } as unknown as Response;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(broken);
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("SERVICE_ERROR");
      expect(error.message).toBe(
        `${ENDPOINT} returned HTTP 500: the error body could not be read: stream reset while reading [redacted]`,
      );
      fetchSpy.mockRestore();
    }));

  test("a 200 body that echoes the key is never printed with it", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("key-a", { status: 200 }));
      const error = await rejected(askJev("state", QUESTIONS, { sleep: never }));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).not.toContain("key-a");
      expect(error.message).toContain("[redacted]");
      fetchSpy.mockRestore();
    }));
});

describe("askJev option checks", () => {
  /** Refuse a bad option with the spy up before the call and refusing
   * every request: a client that skips the check and calls anyway is
   * both observed and still refused here, with the key in place. */
  const rejectsRangeError = (call: () => Promise<unknown>, message: string) =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("no request was expected"));
      const error = await call().then(
        () => {
          throw new Error("expected a rejection");
        },
        (caught: unknown) => caught,
      );
      expect(error, `expected a RangeError, got ${String(error)}`).toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe(message);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

  test("options are checked before the key is read: no key, bad option, no call", async () =>
    withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("no request was expected"));
      const error = await askJev("state", QUESTIONS, { maxAttempts: 0 }).then(
        () => {
          throw new Error("expected a rejection");
        },
        (caught: unknown) => caught,
      );
      expect(error, `expected a RangeError, got ${String(error)}`).toBeInstanceOf(RangeError);
      expect(error).not.toBeInstanceOf(JevError);
      expect((error as Error).message).toBe(
        'askJev option "maxAttempts" must be a positive integer',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }));

  test("maxAttempts 0 is refused", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { maxAttempts: 0 }),
      'askJev option "maxAttempts" must be a positive integer',
    ));

  test("maxAttempts 1.5 is refused", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { maxAttempts: 1.5 }),
      'askJev option "maxAttempts" must be a positive integer',
    ));

  test("timeoutMs -1 is refused", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { timeoutMs: -1 }),
      'askJev option "timeoutMs" must be a positive integer of at most 2147483647',
    ));

  test("timeoutMs 0 is refused", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { timeoutMs: 0 }),
      'askJev option "timeoutMs" must be a positive integer of at most 2147483647',
    ));

  test("timeoutMs 1.5 is refused", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { timeoutMs: 1.5 }),
      'askJev option "timeoutMs" must be a positive integer of at most 2147483647',
    ));

  test("backoffMs -1 is refused", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { backoffMs: -1 }),
      'askJev option "backoffMs" must be a finite number of at least 0',
    ));

  test("backoffMs NaN is refused", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { backoffMs: Number.NaN }),
      'askJev option "backoffMs" must be a finite number of at least 0',
    ));

  test("timeoutMs one above the timer bound is refused with no request", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { timeoutMs: 2147483648 }),
      'askJev option "timeoutMs" must be a positive integer of at most 2147483647',
    ));

  test("timeoutMs far above the timer bound is refused the same way", () =>
    rejectsRangeError(
      () => askJev("state", QUESTIONS, { timeoutMs: Number.MAX_SAFE_INTEGER }),
      'askJev option "timeoutMs" must be a positive integer of at most 2147483647',
    ));

  test("the boundary values are accepted: maxAttempts 1, timeoutMs 1, backoffMs 0", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok({
          model: "m",
          answers: { urgent: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      const result = await askJev("state", QUESTIONS, {
        maxAttempts: 1,
        timeoutMs: 1,
        backoffMs: 0,
        sleep: never,
      });
      expect(result.model).toBe("m");
      fetchSpy.mockRestore();
    }));

  test("timeoutMs exactly at the timer bound is accepted and returns the answer", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok({
          model: "m",
          answers: { urgent: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      const result = await askJev("state", QUESTIONS, {
        timeoutMs: 2147483647,
        sleep: never,
      });
      expect(result.answers.urgent).toEqual({ type: "noul", noul: 0.5 });
      fetchSpy.mockRestore();
    }));
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

  test("the model defaults to the pinned package default when no option names one", async () =>
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
      expect(sent.model).toBe("jev-1.13.0");
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

  test("a Retry-After of zero sleeps zero, including a non-integer zero", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let attempt = 0;
      const headers = [{ "Retry-After": "0" }, { "Retry-After": "0.0" }];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const header = headers[attempt];
        attempt++;
        return header === undefined
          ? ok({
              model: "m",
              answers: { urgent: { type: "noul", noul: 0.5 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          : fail(429, header);
      });
      await askJev("state", QUESTIONS, {
        backoffMs: 10,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      });
      expect(slept).toEqual([0, 0]);
      fetchSpy.mockRestore();
    }));

  test("a negative Retry-After falls back to the exponential delay", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return attempt < 2
          ? fail(429, { "Retry-After": "-30" })
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
      expect(slept).toEqual([10]);
      fetchSpy.mockRestore();
    }));

  test("an unparseable Retry-After falls back to the exponential delay", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return attempt < 2
          ? fail(429, { "Retry-After": "soon" })
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
      expect(slept).toEqual([10]);
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

  test("an exhausted backoff throws RATE_LIMITED with the status after one sleep per retry", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return fail(429);
      });
      const error = await rejected(
        askJev("state", QUESTIONS, {
          maxAttempts: 3,
          backoffMs: 1,
          sleep: (ms) => {
            slept.push(ms);
            return Promise.resolve();
          },
        }),
      );
      expect(attempt).toBe(3);
      expect(slept).toEqual([1, 2]);
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.status).toBe(429);
      fetchSpy.mockRestore();
    }));

  test("exhausted attempts throw RATE_LIMITED with the exact message and the status", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let calls = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        calls++;
        return fail(429, { "Retry-After": "0" });
      });
      const error = await rejected(
        askJev("state", QUESTIONS, {
          maxAttempts: 2,
          sleep: (ms) => {
            slept.push(ms);
            return Promise.resolve();
          },
        }),
      );
      expect(calls).toBe(2);
      expect(slept).toEqual([0]);
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.status).toBe(429);
      expect(error.message).toBe(
        `${ENDPOINT} returned HTTP 429 on every one of 2 attempts. This is a service failure, not a setup problem: the key resolved.`,
      );
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

  test("a timeout while the 200 body streams is UNREACHABLE with the status, after one call", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      let calls = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        calls++;
        return Promise.resolve(stalledBody(200, (init as RequestInit).signal));
      });
      const error = await rejected(askJev("state", QUESTIONS, { timeoutMs: 50, sleep: never }));
      expect(error.code).toBe("UNREACHABLE");
      expect(error.status).toBe(200);
      expect(error.message).toBe(
        `could not reach ${ENDPOINT}: the attempt exceeded the 50 ms timeout`,
      );
      expect(calls).toBe(1);
      fetchSpy.mockRestore();
    }));

  test("a timeout while the error body streams is UNREACHABLE with the status, after one call", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      let calls = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        calls++;
        return Promise.resolve(stalledBody(500, (init as RequestInit).signal));
      });
      const error = await rejected(askJev("state", QUESTIONS, { timeoutMs: 50, sleep: never }));
      expect(error.code).toBe("UNREACHABLE");
      expect(error.status).toBe(500);
      expect(error.message).toBe(
        `could not reach ${ENDPOINT}: the attempt exceeded the 50 ms timeout`,
      );
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
      expect(error.message).toBe(
        `${ENDPOINT} returned HTTP 429 and the next retry would wait 86400000 ms, above the 30000 ms retry cap. This is a service failure, not a setup problem: the key resolved.`,
      );
      expect(calls).toBe(1);
      expect(slept).toEqual([]);
      fetchSpy.mockRestore();
    }));

  test("a Retry-After of exactly the cap retries and sleeps the capped delay", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let attempt = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempt++;
        return attempt < 2
          ? fail(429, { "Retry-After": "30" })
          : ok({
              model: "m",
              answers: { urgent: { type: "noul", noul: 0.5 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            });
      });
      const result = await askJev("state", QUESTIONS, {
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      });
      expect(result.model).toBe("m");
      expect(slept).toEqual([30000]);
      fetchSpy.mockRestore();
    }));

  test("a Retry-After one second above the cap stops instead of sleeping", async () =>
    withEnv({ TYPESAFE_API_KEY: "k-123" }, async () => {
      const slept: number[] = [];
      let calls = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        calls++;
        return fail(429, { "Retry-After": "31" });
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
      expect(error.message).toBe(
        `${ENDPOINT} returned HTTP 429 and the next retry would wait 31000 ms, above the 30000 ms retry cap. This is a service failure, not a setup problem: the key resolved.`,
      );
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

  /** Run one askJev call against a stubbed 200 body and return its error. */
  async function askBody(questions: Record<string, JevQuestion>, body: unknown): Promise<JevError> {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok(body));
    try {
      return await rejected(askJev("state", questions, { sleep: never }));
    } finally {
      fetchSpy.mockRestore();
    }
  }

  /** The same, from raw body text, for values JSON.stringify cannot write
   * (a 1e999 literal that parses to Infinity). */
  async function askRawBody(
    questions: Record<string, JevQuestion>,
    bodyText: string,
  ): Promise<JevError> {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(bodyText, { status: 200 }));
    try {
      return await rejected(askJev("state", questions, { sleep: never }));
    } finally {
      fetchSpy.mockRestore();
    }
  }

  test("a noul question answered as a choice is refused on the type alone", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, okBody({ urgent: { type: "choice", noul: 0.9 } }));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "urgent" has a "type" that differs from the question's`,
      );
    }));

  test("a body that is not a JSON object is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, [1, 2]);
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the body is not a JSON object`,
      );
    }));

  test("null for answers is refused, not a TypeError", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, okBody(null));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: there is no answers object`,
      );
    }));

  test("an array for answers is refused the same way", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, okBody([]));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: there is no answers object`,
      );
    }));

  test("null for one answer is refused, not a TypeError", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, okBody({ urgent: null }));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "urgent" is not a JSON object`,
      );
    }));

  test("null for usage is refused, not a TypeError", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, {
        model: "m",
        answers: { urgent: { type: "noul", noul: 0.5 } },
        usage: null,
      });
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the field "usage" is missing or not token counts`,
      );
    }));

  test("null for probabilities is refused, not a TypeError", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(
        choiceQuestions,
        okBody({
          pick: { type: "choice", choice: "task-a", confidence: 0.8, probabilities: null },
        }),
      );
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "pick" has no "probabilities" object`,
      );
    }));

  test("null for legend is refused, not a TypeError", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(
        scoreQuestions,
        okBody({
          level: {
            type: "score",
            score: 1.5,
            confidence: 0.7,
            legend: null,
            probabilities: { "0": 1 },
          },
        }),
      );
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "level" has no "legend" object`,
      );
    }));

  test("a confidence of exactly 0 and exactly 1 is accepted", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      for (const confidence of [0, 1]) {
        const answer = {
          type: "choice",
          choice: "task-a",
          confidence,
          probabilities: { "task-a": 1, "task-b": 0 },
        };
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(ok(okBody({ pick: answer })));
        const result = await askJev("state", choiceQuestions, { sleep: never });
        expect((result.answers.pick as JevChoiceAnswer).confidence).toBe(confidence);
        fetchSpy.mockRestore();
      }
    }));

  test("a noul of exactly 0 and exactly 1 is accepted", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      for (const noul of [0, 1]) {
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(ok(okBody({ urgent: { type: "noul", noul } })));
        const result = await askJev("state", QUESTIONS, { sleep: never });
        expect((result.answers.urgent as JevNoulAnswer).noul).toBe(noul);
        fetchSpy.mockRestore();
      }
    }));

  test("a confidence below 0 is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(
        choiceQuestions,
        okBody({
          pick: {
            type: "choice",
            choice: "task-a",
            confidence: -0.01,
            probabilities: { "task-a": 1 },
          },
        }),
      );
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "pick" has a "confidence" that is not a probability in [0, 1]`,
      );
    }));

  test("a noul below 0 and above 1 is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      for (const noul of [-0.01, 1.01]) {
        const error = await askBody(QUESTIONS, okBody({ urgent: { type: "noul", noul } }));
        expect(error.code).toBe("BAD_RESPONSE");
        expect(error.message).toBe(
          `${ENDPOINT} returned an unusable answer: the answer for question "urgent" has a "noul" that is not a probability in [0, 1]`,
        );
      }
    }));

  test("a non-finite score is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      // Written as raw text: 1e999 parses to Infinity, which
      // JSON.stringify cannot express.
      const error = await askRawBody(
        scoreQuestions,
        '{"model":"m","answers":{"level":{"type":"score","score":1e999,"confidence":0.7,"legend":{"0":"low"},"probabilities":{"0":1}}},"usage":{"input_tokens":1,"output_tokens":1}}',
      );
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "level" has a "score" that is not a finite number`,
      );
    }));

  test("a score answer with a bad confidence is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(
        scoreQuestions,
        okBody({
          level: {
            type: "score",
            score: 1.5,
            confidence: 1.01,
            legend: { "0": "low" },
            probabilities: { "0": 1 },
          },
        }),
      );
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "level" has a "confidence" that is not a probability in [0, 1]`,
      );
    }));

  test("a score answer whose legend holds a non-string is refused with the exact message", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(
        scoreQuestions,
        okBody({
          level: {
            type: "score",
            score: 1.5,
            confidence: 0.7,
            legend: { "0": 3 },
            probabilities: { "0": 1 },
          },
        }),
      );
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "level" has a "legend" value that is not a string`,
      );
    }));

  test("a score answer without probabilities is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(
        scoreQuestions,
        okBody({
          level: { type: "score", score: 1.5, confidence: 0.7, legend: { "0": "low" } },
        }),
      );
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "level" has no "probabilities" object`,
      );
    }));

  test("a score answer with an out-of-range probability is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(
        scoreQuestions,
        okBody({
          level: {
            type: "score",
            score: 1.5,
            confidence: 0.7,
            legend: { "0": "low" },
            probabilities: { "0": 1.5 },
          },
        }),
      );
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "level" has a "probabilities" entry that is not a probability in [0, 1]`,
      );
    }));

  test("an empty model string is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, {
        model: "",
        answers: { urgent: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the field "model" is missing or not a non-empty string`,
      );
    }));

  test("a negative input token count is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, {
        model: "m",
        answers: { urgent: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: -1, output_tokens: 1 },
      });
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the field "usage" is missing or not token counts`,
      );
    }));

  test("a fractional input token count is refused", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, {
        model: "m",
        answers: { urgent: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1.5, output_tokens: 1 },
      });
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the field "usage" is missing or not token counts`,
      );
    }));

  test("a zero input token count is accepted", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok({
          model: "m",
          answers: { urgent: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      );
      const result = await askJev("state", QUESTIONS, { sleep: never });
      expect(result.usage.input_tokens).toBe(0);
      fetchSpy.mockRestore();
    }));

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

  test("a choice answer whose probabilities name an unoffered key is BAD_RESPONSE", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        ok(
          okBody({
            pick: {
              type: "choice",
              choice: "task-a",
              confidence: 0.8,
              probabilities: { "task-a": 0.8, "task-zz": 0.2 },
            },
          }),
        ),
      );
      const error = await rejected(askJev("state", choiceQuestions, { sleep: never }));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "pick" has a "probabilities" key the question did not offer`,
      );
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

  test("a 200 whose answers lack the asked id is refused naming the id", async () =>
    withEnv({ TYPESAFE_API_KEY: "key-a" }, async () => {
      const error = await askBody(QUESTIONS, okBody({ unasked: { type: "noul", noul: 0.5 } }));
      expect(error.code).toBe("BAD_RESPONSE");
      expect(error.message).toBe(
        `${ENDPOINT} returned an unusable answer: the answer for question "urgent" is missing`,
      );
    }));
});
