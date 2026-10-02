import { RouterError } from "./error.js";
import {
  askJev,
  type JevChoiceAnswer,
  JevError,
  type JevNoulAnswer,
  type JevQuestion,
  type JevResponse,
} from "./jev.js";
import { parsePartialQuery } from "./query.js";
import { resolveConfig, resolveRegistry } from "./rank.js";
import { validateRouterSections } from "./sections.js";
import type {
  Coded,
  DescribeNeedAdded,
  DescribeOptions,
  DescribeResult,
  DescribeTaskCandidate,
  Query,
} from "./types.js";

/** The id of the task question. Ids are for this code only; Jev never sees
 * them. */
const TASK_QUESTION_ID = "task";

/** The id prefix of a capability question: `needs_` plus the capability the
 * registry's questions section names. */
const CAPABILITY_PREFIX = "needs_";

/** The task question's instruction, ported from the routing query builder
 * the RFC moves into this package. */
const TASK_INSTRUCTIONS =
  "The state is a description of one piece of work that will be handed to a worker model. Which task type is it? Pick the type whose description covers the work actually being asked for.";

function invalid(field: string, message: string, fix: string): RouterError {
  return new RouterError({ code: "query-invalid", field, fix, message, problems: [] });
}

function describePrivate(): RouterError {
  return new RouterError({
    code: "describe-private",
    field: "privacy",
    fix: "Run the describe step with privacy: normal, or rank a privacy: secret query without the describe step.",
    message:
      "the describe step sends the work description to a hosted Jev model, so it never runs for privacy: secret work",
    problems: [],
  });
}

function describeFailed(code: string, message: string): RouterError {
  return new RouterError({
    code: "describe-failed",
    field: "describe",
    fix: 'Set TYPESAFE_API_KEY in the environment, or pass "task" or "minimums" in the query so the describe step needs no Jev answer.',
    message: `the describe step needed a task from Jev and the call failed (${code}): ${message}`,
    problems: [],
  });
}

/** A record with no prototype, so a registry name such as "__proto__" is an
 * ordinary own property instead of a prototype write. */
function nullRecord<TValue>(): Record<string, TValue> {
  return Object.create(null) as Record<string, TValue>;
}

/** The candidates of a choice answer: every option with its probability,
 * highest first. */
function candidatesOf(probabilities: Readonly<Record<string, number>>): DescribeTaskCandidate[] {
  const candidates = Object.entries(probabilities).map(([task, probability]) => ({
    probability,
    task,
  }));
  candidates.sort((a, b) => b.probability - a.probability);
  return candidates;
}

/** Copy the caller's query fields, replacing task and needs with the filled
 * values. Every other field is the caller's. */
function filledQuery(partial: Query, task: string | undefined, needs: readonly string[]): Query {
  return {
    ...(partial.excludeFamilies !== undefined ? { excludeFamilies: partial.excludeFamilies } : {}),
    ...(partial.effort !== undefined ? { effort: partial.effort } : {}),
    ...(partial.minimums !== undefined ? { minimums: partial.minimums } : {}),
    ...(partial.pin !== undefined ? { pin: partial.pin } : {}),
    ...(partial.prefer !== undefined ? { prefer: partial.prefer } : {}),
    ...(partial.privacy !== undefined ? { privacy: partial.privacy } : {}),
    ...(partial.spec !== undefined ? { spec: partial.spec } : {}),
    ...(partial.stakes !== undefined ? { stakes: partial.stakes } : {}),
    ...(task !== undefined ? { task } : {}),
    needs,
  };
}

/**
 * The describe step: read a prose work description, fill the partial
 * query's task and add to its needs.
 *
 * The checks run in the contract's order. No request leaves the machine
 * before the privacy gate passes: `privacy` must be stated, and secret work
 * is refused outright. The task question rides only when the partial query
 * has neither `task` nor `minimums`; one capability question rides per
 * router.questions entry, always. Jev's task is taken at or above
 * `describe.taskGate`; below it the guess is kept with a `task-uncertain`
 * warning. A capability answer at or above `describe.capabilityThreshold`
 * adds the capability; it never removes one the caller named.
 *
 * When Jev gives no answer, the task's necessity decides: needed means
 * `describe-failed`; not needed means the caller's query continues with a
 * `capabilities-unasked` warning.
 */
export async function describe(
  text: string,
  partialQuery: unknown,
  options: DescribeOptions = {},
): Promise<DescribeResult> {
  if (typeof text !== "string") {
    throw invalid(
      "text",
      "the work description must be a string",
      "Pass the work description as text; the describe step sends it to Jev as the state.",
    );
  }
  const loaded = resolveRegistry(options.registry);
  const sections = validateRouterSections(loaded);
  const partial = parsePartialQuery(partialQuery);

  if (partial.privacy === undefined) {
    throw invalid(
      "privacy",
      'the query must state "privacy" for the describe step; the default does not apply',
      'Add "privacy": "normal" to the query. Secret work never reaches the describe step.',
    );
  }
  if (partial.privacy === "secret") {
    throw describePrivate();
  }
  if (text.trim().length === 0) {
    throw invalid(
      "text",
      "the work description is empty",
      "Describe the work in the description file, or rank without the describe step.",
    );
  }

  const loadedConfig = resolveConfig(options.config);
  const config = loadedConfig.config;
  const taskNeeded = partial.task === undefined && partial.minimums === undefined;

  // Build the question set: the task choice over the declared tasks, plus
  // one noul per router.questions entry.
  const questions: Record<string, JevQuestion> = {};
  if (taskNeeded) {
    const criteria = nullRecord<string>();
    for (const [name, task] of Object.entries(sections.tasks)) {
      criteria[name] = task.description;
    }
    if (Object.keys(criteria).length === 0) {
      throw invalid(
        "task",
        "the registry declares no tasks, so the describe step cannot fill one",
        'Pass "task" or "minimums" in the query, or declare tasks in the registry.',
      );
    }
    questions[TASK_QUESTION_ID] = {
      type: "choice",
      instructions: TASK_INSTRUCTIONS,
      criteria,
    };
  }
  for (const [capability, questionText] of Object.entries(sections.questions)) {
    questions[`${CAPABILITY_PREFIX}${capability}`] = {
      type: "noul",
      instructions: questionText,
    };
  }

  let response: JevResponse;
  try {
    response = await askJev(text, questions, { model: config.describe.jevModel });
  } catch (error) {
    // The client throws only JevError; anything else is an internal fault
    // and is rethrown unchanged rather than relabelled.
    if (!(error instanceof JevError)) throw error;
    if (taskNeeded) {
      throw describeFailed(error.code, error.message);
    }
    // The task was not needed: continue on the caller's own fields and say
    // the capabilities were never asked.
    const warnings: Coded[] = [
      {
        code: "capabilities-unasked",
        message: `Jev gave no answer (${error.code}), so no capability question was read; the query keeps the needs you stated`,
        fix: 'Add any capability the work needs to "needs" in the query, or retry when Jev answers.',
      },
    ];
    const source = partial.task !== undefined ? "caller" : "inline-need";
    return {
      describe: {
        model: null,
        taskGate: config.describe.taskGate,
        capabilityThreshold: config.describe.capabilityThreshold,
        task: { source, confidence: null, candidates: [] },
        needsAdded: [],
        usage: null,
      },
      query: filledQuery(partial, partial.task, [...new Set(partial.needs ?? [])]),
      warnings,
    };
  }

  const warnings: Coded[] = [];
  let task: string | undefined = partial.task;
  let confidence: number | null = null;
  let candidates: DescribeTaskCandidate[] = [];
  if (taskNeeded) {
    // The client validated the answer's shape and that its choice was
    // offered: the criteria held only declared tasks.
    const answer = response.answers[TASK_QUESTION_ID] as JevChoiceAnswer;
    task = answer.choice;
    confidence = answer.confidence;
    candidates = candidatesOf(answer.probabilities);
    if (answer.confidence < config.describe.taskGate) {
      warnings.push({
        code: "task-uncertain",
        field: "task",
        message: `Jev's task "${answer.choice}" is below the taskGate ${config.describe.taskGate}; the guess was kept`,
        fix: 'Pass "task" in the query to state the task yourself.',
      });
    }
  }
  const taskSource = partial.task !== undefined ? "caller" : taskNeeded ? "jev" : "inline-need";

  // Capabilities: escalate-only. A noul at or above the threshold adds the
  // capability, and a capability the caller named is never reported as
  // added. The client guarantees every capability answer exists and is a
  // noul in [0, 1].
  const needs = [...new Set(partial.needs ?? [])];
  const needsAdded: DescribeNeedAdded[] = [];
  for (const capability of Object.keys(sections.questions)) {
    const answer = response.answers[`${CAPABILITY_PREFIX}${capability}`] as JevNoulAnswer;
    if (answer.noul >= config.describe.capabilityThreshold && !needs.includes(capability)) {
      needs.push(capability);
      needsAdded.push({ capability, probability: answer.noul });
    }
  }

  return {
    describe: {
      model: response.model,
      taskGate: config.describe.taskGate,
      capabilityThreshold: config.describe.capabilityThreshold,
      task: { source: taskSource, confidence, candidates },
      needsAdded,
      usage: response.usage,
    },
    query: filledQuery(partial, task, needs),
    warnings,
  };
}
