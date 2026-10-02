/**
 * The package's TypeSafe System One (Jev) client.
 *
 * One state, many typed questions, answered in parallel in a single request.
 * The describe step builds its questions and gates the answers; this module
 * carries the request and owns the response contract: every 200 body is
 * validated against the questions that were sent before it is returned. It
 * is exported as `askJev` with `JevError` and the question, answer and
 * response types; the key and retry helpers stay private.
 *
 * The client is raw fetch against POST /v1/systemone, not the official SDK:
 * the request is three fields, and the retry schedule and the key handling
 * are policy the router keeps beside its gates. `TYPESAFE_API_KEY` is read
 * from the environment and never printed.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const KEY_VARIABLE = "TYPESAFE_API_KEY";

/** The Jev model this package pins, for the describe step and for any
 * direct `askJev` call that names no model. Versioned, not an alias: the
 * describe gates were tuned against a model that must not move underneath
 * them. The response's `model` field reports what answered. */
export const DEFAULT_JEV_MODEL = "jev-1.13.0";

/** Status codes the service asks callers to retry. */
const RETRYABLE = new Set([429, 529]);

/** Bounds each attempt; a timeout is UNREACHABLE naming the limit and is
 * not retried. */
const DEFAULT_TIMEOUT_MS = 15000;

/** A retry delay above this, from `Retry-After` or the backoff, stops the
 * retries at once with RATE_LIMITED: an early retry into the same 429 is
 * worse than giving up. */
const RETRY_DELAY_CAP_MS = 30000;

export type JevErrorCode =
  | "MISSING_KEY"
  | "RATE_LIMITED"
  | "SERVICE_ERROR"
  | "UNREACHABLE"
  | "BAD_RESPONSE";

/** The one error the Jev client throws. `code` is stable; `status` carries
 * the HTTP status when one arrived, else undefined. */
export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status: number | undefined;

  constructor(code: JevErrorCode, message: string, status: number | undefined = undefined) {
    super(message);
    this.name = "JevError";
    this.code = code;
    this.status = status;
  }
}

/** A Choice question: one option from a named set, with a rubric per option. */
export type JevChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: unknown;
  readonly criteria: Readonly<Record<string, string>>;
};

/** A Score question: a position on ordered, described levels. */
export type JevScoreQuestion = {
  readonly type: "score";
  readonly instructions: unknown;
  readonly criteria: readonly string[];
};

/** A Noul question: a yes/no whose probability of yes is the signal. */
export type JevNoulQuestion = {
  readonly type: "noul";
  readonly instructions: unknown;
  readonly criteria?: { readonly true: string; readonly false: string };
};

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

/** A Choice answer: the picked option, the full distribution, and the
 * confidence derived from it. */
export type JevChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
};

/** A Score answer: the probability-weighted level, the legend echoing the
 * levels by index, and the distribution. */
export type JevScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
};

/** A Noul answer: the probability of yes. Noul carries no confidence. */
export type JevNoulAnswer = {
  readonly type: "noul";
  readonly noul: number;
};

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

/** One Jev response: what answered, one answer per question id, and the
 * token counts. */
export type JevResponse = {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
};

export type AskJevOptions = {
  /** The model that handles the request. The default is the package pin;
   * pin it once thresholds are tuned against another model. */
  readonly model?: string;
  readonly maxAttempts?: number;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to a real timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Base for the exponential backoff, in milliseconds. */
  readonly backoffMs?: number;
  /** Bounds each attempt in milliseconds. A timeout is UNREACHABLE naming
   * the limit and is not retried. */
  readonly timeoutMs?: number;
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function isOwnObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A probability: a finite number in [0, 1]. */
function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A token count: a non-negative integer. */
function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function badResponse(message: string): JevError {
  return new JevError("BAD_RESPONSE", `${ENDPOINT} returned an unusable answer: ${message}`);
}

/** Check a choice answer against the question it answers. The message names
 * the question id and the field; it never names the value or the state. */
function validateChoiceAnswer(
  id: string,
  question: JevChoiceQuestion,
  answer: Record<string, unknown>,
): void {
  if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
    throw badResponse(
      `the answer for question "${id}" names a "choice" the question did not offer`,
    );
  }
  if (!isUnit(answer.confidence)) {
    throw badResponse(
      `the answer for question "${id}" has a "confidence" that is not a probability in [0, 1]`,
    );
  }
  if (!isOwnObject(answer.probabilities)) {
    throw badResponse(`the answer for question "${id}" has no "probabilities" object`);
  }
  for (const probability of Object.values(answer.probabilities)) {
    if (!isUnit(probability)) {
      throw badResponse(
        `the answer for question "${id}" has a "probabilities" entry that is not a probability in [0, 1]`,
      );
    }
  }
}

/** Check a score answer against the question it answers. */
function validateScoreAnswer(id: string, answer: Record<string, unknown>): void {
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
    throw badResponse(`the answer for question "${id}" has a "score" that is not a finite number`);
  }
  if (!isUnit(answer.confidence)) {
    throw badResponse(
      `the answer for question "${id}" has a "confidence" that is not a probability in [0, 1]`,
    );
  }
  if (!isOwnObject(answer.legend)) {
    throw badResponse(`the answer for question "${id}" has no "legend" object`);
  }
  for (const value of Object.values(answer.legend)) {
    if (typeof value !== "string") {
      throw badResponse(
        `the answer for question "${id}" has a "legend" value that is not a string`,
      );
    }
  }
  if (!isOwnObject(answer.probabilities)) {
    throw badResponse(`the answer for question "${id}" has no "probabilities" object`);
  }
  for (const probability of Object.values(answer.probabilities)) {
    if (!isUnit(probability)) {
      throw badResponse(
        `the answer for question "${id}" has a "probabilities" entry that is not a probability in [0, 1]`,
      );
    }
  }
}

/** Check a noul answer against the question it answers. */
function validateNoulAnswer(id: string, answer: Record<string, unknown>): void {
  if (!isUnit(answer.noul)) {
    throw badResponse(
      `the answer for question "${id}" has a "noul" that is not a probability in [0, 1]`,
    );
  }
}

/** Validate a 200 body against the questions that were sent: model and
 * usage are present and well formed, and every asked question has an own
 * answer of the asked type in shape. Answers to unasked questions are
 * ignored. Any miss is BAD_RESPONSE; the message names the question id and
 * the field, never the value or the state. */
function validateResponse(
  parsed: unknown,
  questions: Readonly<Record<string, JevQuestion>>,
): JevResponse {
  if (!isOwnObject(parsed)) {
    throw badResponse("the body is not a JSON object");
  }
  if (typeof parsed.model !== "string" || parsed.model.length === 0) {
    throw badResponse('the field "model" is missing or not a non-empty string');
  }
  if (
    !isOwnObject(parsed.usage) ||
    !isTokenCount(parsed.usage.input_tokens) ||
    !isTokenCount(parsed.usage.output_tokens)
  ) {
    throw badResponse('the field "usage" is missing or not token counts');
  }
  const answers = parsed.answers;
  if (!isOwnObject(answers)) {
    throw badResponse("there is no answers object");
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(answers, id)) {
      throw badResponse(`the answer for question "${id}" is missing`);
    }
    const answer = answers[id];
    if (!isOwnObject(answer)) {
      throw badResponse(`the answer for question "${id}" is not a JSON object`);
    }
    if (answer.type !== question.type) {
      throw badResponse(
        `the answer for question "${id}" has a "type" that differs from the question's`,
      );
    }
    if (question.type === "choice") {
      validateChoiceAnswer(id, question, answer);
    } else if (question.type === "score") {
      validateScoreAnswer(id, answer);
    } else {
      validateNoulAnswer(id, answer);
    }
  }
  return parsed as JevResponse;
}

/** `Retry-After` is seconds or an HTTP date. Anything else falls back to the
 * exponential schedule rather than guessing. */
function retryDelay(header: string | null, attempt: number, base: number): number {
  const exponential = base * 2 ** attempt;
  if (!header) return exponential;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return exponential;
  return Math.max(0, date - Date.now());
}

/** Read the key, or throw the error that names how to supply it. The message
 * names only the variable: no credential tool, no path. */
function requireKey(environment: NodeJS.ProcessEnv = process.env): string {
  const key = environment[KEY_VARIABLE];
  if (typeof key === "string" && key.length > 0) return key;
  throw new JevError(
    "MISSING_KEY",
    `${KEY_VARIABLE} is not set. Set it in the environment and run the command again.`,
  );
}

/**
 * Ask Jev one state and a map of questions. Every question sees the same
 * state and none sees another's answer, so asking more costs tokens and
 * almost no latency. Retries 429 and 529 with backoff; every other failure
 * throws.
 */
export async function askJev(
  state: unknown,
  questions: Readonly<Record<string, JevQuestion>>,
  options: AskJevOptions = {},
): Promise<JevResponse> {
  const key = requireKey();
  const call = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? wait;
  const maxAttempts = options.maxAttempts ?? 4;
  const backoffMs = options.backoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({
    state,
    model: options.model ?? DEFAULT_JEV_MODEL,
    questions,
  });

  let lastStatus = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response: Response;
    // One signal per attempt: AbortSignal.timeout fires once.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      response = await call(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        // A timeout is not retried: the endpoint stalled for the whole
        // bound, and the message names the limit that fired.
        throw new JevError(
          "UNREACHABLE",
          `could not reach ${ENDPOINT}: the attempt exceeded the ${timeoutMs} ms timeout`,
        );
      }
      throw new JevError(
        "UNREACHABLE",
        `could not reach ${ENDPOINT}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.ok) {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        // A 200 whose body is not JSON is an unusable answer, not a crash.
        throw new JevError(
          "BAD_RESPONSE",
          `${ENDPOINT} returned HTTP 200 with a body that is not JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return validateResponse(parsed, questions);
    }

    lastStatus = response.status;
    if (!RETRYABLE.has(response.status)) {
      // The client throws only JevError: even the error body failing to
      // read stays a SERVICE_ERROR carrying the status.
      let errorText: string;
      try {
        errorText = await response.text();
      } catch (error) {
        errorText = `the error body could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      throw new JevError(
        "SERVICE_ERROR",
        `${ENDPOINT} returned HTTP ${response.status}: ${errorText}`,
        response.status,
      );
    }
    if (attempt < maxAttempts - 1) {
      const delay = retryDelay(response.headers.get("Retry-After"), attempt, backoffMs);
      if (delay > RETRY_DELAY_CAP_MS) {
        throw new JevError(
          "RATE_LIMITED",
          `${ENDPOINT} returned HTTP ${lastStatus} and asked to wait ${delay} ms, above the ${RETRY_DELAY_CAP_MS} ms retry cap. This is a service failure, not a setup problem: the key resolved.`,
          lastStatus,
        );
      }
      await sleep(delay);
    }
  }

  throw new JevError(
    "RATE_LIMITED",
    `${ENDPOINT} returned HTTP ${lastStatus} on every one of ${maxAttempts} attempts. This is a service failure, not a setup problem: the key resolved.`,
    lastStatus,
  );
}
