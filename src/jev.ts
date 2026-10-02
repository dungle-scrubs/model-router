/**
 * The package's TypeSafe System One (Jev) client.
 *
 * One state, many typed questions, answered in parallel in a single request.
 * The describe step builds its questions and gates the answers; this module
 * only carries the request. It is exported as `askJev` with `JevError` and
 * the question, answer and response types; the key and retry helpers stay
 * private.
 *
 * The client is raw fetch against POST /v1/systemone, not the official SDK:
 * the request is three fields, and the retry schedule and the key handling
 * are policy the router keeps beside its gates. `TYPESAFE_API_KEY` is read
 * from the environment and never printed.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const KEY_VARIABLE = "TYPESAFE_API_KEY";

/** Status codes the service asks callers to retry. */
const RETRYABLE = new Set([429, 529]);

export type JevErrorCode =
  | "MISSING_KEY"
  | "RATE_LIMITED"
  | "SERVICE_ERROR"
  | "UNREACHABLE"
  | "BAD_RESPONSE";

/** The one error the Jev client throws. `code` is stable; `status` carries
 * the HTTP status when one arrived. */
export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;

  constructor(code: JevErrorCode, message: string, status?: number) {
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
  /** The model that handles the request. Pin it once thresholds are tuned;
   * `jev-latest` moves underneath them. */
  readonly model?: string;
  readonly maxAttempts?: number;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to a real timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Base for the exponential backoff, in milliseconds. */
  readonly backoffMs?: number;
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  const body = JSON.stringify({
    state,
    model: options.model ?? "jev-latest",
    questions,
  });

  let lastStatus = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await call(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
      });
    } catch (error) {
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
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("answers" in parsed) ||
        !parsed.answers ||
        typeof parsed.answers !== "object"
      ) {
        throw new JevError("BAD_RESPONSE", `${ENDPOINT} returned no answers object`);
      }
      return parsed as JevResponse;
    }

    lastStatus = response.status;
    if (!RETRYABLE.has(response.status)) {
      throw new JevError(
        "SERVICE_ERROR",
        `${ENDPOINT} returned HTTP ${response.status}: ${await response.text()}`,
        response.status,
      );
    }
    if (attempt < maxAttempts - 1) {
      await sleep(retryDelay(response.headers.get("Retry-After"), attempt, backoffMs));
    }
  }

  throw new JevError(
    "RATE_LIMITED",
    `${ENDPOINT} returned HTTP ${lastStatus} on every one of ${maxAttempts} attempts. This is a service failure, not a setup problem: the key resolved.`,
    lastStatus,
  );
}
