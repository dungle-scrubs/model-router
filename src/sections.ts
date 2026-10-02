import type { LoadedRegistry } from "@dungle-scrubs/model-registry";
import { EFFORT_LADDER } from "@dungle-scrubs/model-registry";
import { RouterError } from "./error.js";
import type {
  PolicyEntry,
  PolicyRoute,
  PolicySpec,
  RouterProblem,
  RouterSections,
  Stakes,
} from "./types.js";

function pathJoin(parent: string, child: string): string {
  return `${parent}[${JSON.stringify(child)}]`;
}

/** A record with no prototype, so a registry name such as "__proto__" is an
 * ordinary own property instead of a prototype write. */
function nullRecord<TValue>(): Record<string, TValue> {
  return Object.create(null) as Record<string, TValue>;
}

function sampleRating(loaded: LoadedRegistry): string {
  return Object.keys(loaded.registry.ratings ?? {})[0] ?? "rating-a";
}

function rankLine(loaded: LoadedRegistry): string {
  return `"router": { "rank": ["${sampleRating(loaded)}"] }`;
}

const TASK_FIELDS: readonly string[] = ["description", "minimums", "rank", "needs", "effort"];
const POLICY_FIELDS: readonly string[] = ["task", "stakes", "routes", "reason", "since", "spec"];
const STAKES_VALUES: readonly string[] = ["low", "normal", "high"];

/**
 * Read and validate the router's section of the registry file. The loader
 * passes it through untouched in `loaded.sections`; this module is the one
 * place that knows its shape. Returns the validated `rank` list, plus the
 * tasks and policy maps; throws a RouterError with
 * `registry-sections-invalid` on any problem.
 */
export function validateRouterSections(loaded: LoadedRegistry): RouterSections {
  const section = loaded.sections.router;
  const problems: RouterProblem[] = [];
  const rank: string[] = [];

  if (section === undefined) {
    throw sectionsError(
      {
        code: "router-section-missing",
        field: '$["router"]',
        message: "the registry file has no router section, which model-router requires",
        fix: `Add the line ${rankLine(loaded)} to the registry file, with the ratings that order routes.`,
      },
      [],
    );
  }

  if (!isPlainObject(section)) {
    throw sectionsError(
      {
        code: "router-section-not-object",
        field: '$["router"]',
        message: "the router section must be a JSON object",
        fix: `Replace the router section with an object such as ${rankLine(loaded)}.`,
      },
      [],
    );
  }

  const rankField = section.rank;
  if (rankField === undefined) {
    problems.push({
      code: "router-rank-missing",
      field: pathJoin('$["router"]', "rank"),
      message: "the router section has no rank list, which model-router requires",
      fix: `Add "rank": ["${sampleRating(loaded)}"] inside the router section, with the ratings that order routes.`,
    });
  } else if (!Array.isArray(rankField) || rankField.length === 0) {
    problems.push({
      code: "router-rank-invalid",
      field: pathJoin('$["router"]', "rank"),
      message: "the router rank must be a non-empty array of rating names",
      fix: `Set "rank" to a non-empty array of declared rating names, such as ["${sampleRating(loaded)}"].`,
    });
  } else {
    const declaredRatings = loaded.registry.ratings ?? {};
    rankField.forEach((entry, index) => {
      const field = `$["router"]["rank"][${index}]`;
      if (typeof entry !== "string") {
        problems.push({
          code: "router-rank-entry-not-string",
          field,
          message: `the router rank entry at index ${index} must be a string`,
          fix: `Set the rank entry at index ${index} to a declared rating name.`,
        });
        return;
      }
      if (!Object.hasOwn(declaredRatings, entry)) {
        problems.push({
          code: "router-rank-unknown",
          field,
          message: `the rating "${entry}" is not declared in the ratings section`,
          fix: `Add "${entry}" to the ratings section, or remove it from "router"."rank".`,
        });
        return;
      }
      rank.push(entry);
    });
  }

  const questions = section.questions;
  if (questions !== undefined) {
    if (!isPlainObject(questions)) {
      problems.push({
        code: "router-questions-not-object",
        field: pathJoin('$["router"]', "questions"),
        message: "the router questions section must be a JSON object",
        fix: "Replace the router questions section with a JSON object, or remove it.",
      });
    } else {
      const declaredCapabilities = loaded.registry.capabilities ?? {};
      for (const [capability, question] of Object.entries(questions)) {
        if (!Object.hasOwn(declaredCapabilities, capability)) {
          problems.push({
            code: "router-question-capability-unknown",
            field: pathJoin(pathJoin('$["router"]', "questions"), capability),
            message: `the capability "${capability}" is not declared in the capabilities section`,
            fix: `Add "${capability}" to the capabilities section, or remove it from "router"."questions".`,
          });
        }
        if (typeof question !== "string") {
          problems.push({
            code: "router-question-not-string",
            field: pathJoin(pathJoin('$["router"]', "questions"), capability),
            message: `the question for "${capability}" must be a string`,
            fix: `Set the question for "${capability}" to a yes/no question sentence.`,
          });
        }
      }
    }
  }

  for (const name of Object.keys(section)) {
    if (name !== "rank" && name !== "questions") {
      problems.push({
        code: "router-field-unknown",
        field: pathJoin('$["router"]', name),
        message: `the field "${name}" is not part of the router section`,
        fix: 'Remove the field; the router section accepts only "rank" and "questions".',
      });
    }
  }

  const tasksSection = loaded.sections.tasks;
  const tasksMap = validateTasks(tasksSection, loaded, problems);

  const policySection = loaded.sections.policy;
  const policiesMap = validatePolicy(policySection, loaded, tasksMap, problems);

  if (problems.length > 0) {
    const [first, ...rest] = problems as [RouterProblem, ...RouterProblem[]];
    throw sectionsError(first, rest);
  }

  return { policies: policiesMap, rank, tasks: tasksMap };
}

type TasksMap = RouterSections["tasks"];
type PoliciesMap = RouterSections["policies"];

function validateTasks(raw: unknown, loaded: LoadedRegistry, problems: RouterProblem[]): TasksMap {
  if (raw === undefined) return {};
  const sectionField = '$["tasks"]';
  if (!isPlainObject(raw)) {
    problems.push({
      code: "tasks-section-not-object",
      field: sectionField,
      message: "the tasks section must be a JSON object",
      fix: 'Replace the tasks section with an object such as "tasks": { "task-a": { ... } }.',
    });
    return {};
  }

  const declaredRatings = loaded.registry.ratings ?? {};
  const declaredCapabilities = loaded.registry.capabilities ?? {};
  const tasksMap = nullRecord<import("./types.js").TaskEntry>();
  for (const [taskName, taskRaw] of Object.entries(raw)) {
    const taskField = pathJoin(sectionField, taskName);
    if (!isPlainObject(taskRaw)) {
      problems.push({
        code: "tasks-entry-not-object",
        field: taskField,
        message: `the task "${taskName}" must be a JSON object`,
        fix: `Replace the task "${taskName}" with an object that has description, minimums and rank.`,
      });
      continue;
    }

    const description = taskRaw.description;
    if (description === undefined) {
      problems.push({
        code: "tasks-description-missing",
        field: pathJoin(taskField, "description"),
        message: `the task "${taskName}" has no description, which model-router requires`,
        fix: `Add a one-line description to the task "${taskName}".`,
      });
    } else if (typeof description !== "string") {
      problems.push({
        code: "tasks-description-not-string",
        field: pathJoin(taskField, "description"),
        message: `the task "${taskName}" description must be a string`,
        fix: `Set the description of "${taskName}" to a one-line sentence.`,
      });
    }

    const minimums = taskRaw.minimums;
    if (minimums === undefined) {
      problems.push({
        code: "tasks-minimums-missing",
        field: pathJoin(taskField, "minimums"),
        message: `the task "${taskName}" has no minimums, which model-router requires`,
        fix: `Add a minimums map with low, normal and high entries to the task "${taskName}".`,
      });
    } else if (!isPlainObject(minimums)) {
      problems.push({
        code: "tasks-minimums-not-object",
        field: pathJoin(taskField, "minimums"),
        message: `the task "${taskName}" minimums must be a JSON object`,
        fix: `Replace the minimums of "${taskName}" with an object mapping stakes to rating floors.`,
      });
    } else {
      for (const stakes of STAKES_VALUES) {
        const stakeField = pathJoin(`${pathJoin(taskField, "minimums")}`, stakes);
        if (!Object.hasOwn(minimums, stakes)) {
          problems.push({
            code: "tasks-minimums-stake-missing",
            field: stakeField,
            message: `the task "${taskName}" minimums is missing the "${stakes}" stakes`,
            fix: `Add "${stakes}" to the minimums of "${taskName}".`,
          });
          continue;
        }
        const stakeFloors = minimums[stakes];
        if (!isPlainObject(stakeFloors)) {
          problems.push({
            code: "tasks-minimums-stake-not-object",
            field: stakeField,
            message: `the task "${taskName}" minimums["${stakes}"] must be a JSON object`,
            fix: `Replace the "${stakes}" entry of "${taskName}" minimums with a rating object.`,
          });
          continue;
        }
        for (const [rating, value] of Object.entries(stakeFloors)) {
          const ratingField = pathJoin(stakeField, rating);
          if (!Object.hasOwn(declaredRatings, rating)) {
            problems.push({
              code: "tasks-minimums-rating-unknown",
              field: ratingField,
              message: `the rating "${rating}" is not declared in the ratings section`,
              fix: `Add "${rating}" to the ratings section, or remove it from "${taskName}" minimums.`,
            });
            continue;
          }
          if (typeof value !== "number" || !Number.isFinite(value)) {
            problems.push({
              code: "tasks-minimums-rating-not-number",
              field: ratingField,
              message: `the floor for "${rating}" in "${taskName}" minimums["${stakes}"] must be a finite number`,
              fix: `Set the floor for "${rating}" in "${taskName}" minimums["${stakes}"] to a number.`,
            });
          }
        }
      }
      // The stakes map is closed: any key beyond low, normal and high is a
      // problem, even when all three required entries are present.
      for (const stakeKey of Object.keys(minimums)) {
        if (!STAKES_VALUES.includes(stakeKey)) {
          problems.push({
            code: "tasks-minimums-stake-unknown",
            field: pathJoin(pathJoin(taskField, "minimums"), stakeKey),
            message: `the task "${taskName}" minimums carries the unknown stakes "${stakeKey}"`,
            fix: `Remove "${stakeKey}" from the minimums of "${taskName}"; the stakes are low, normal and high.`,
          });
        }
      }
    }

    const rankList = taskRaw.rank;
    if (rankList === undefined) {
      problems.push({
        code: "tasks-rank-missing",
        field: pathJoin(taskField, "rank"),
        message: `the task "${taskName}" has no rank list, which model-router requires`,
        fix: `Add a non-empty rank list of declared rating names to the task "${taskName}".`,
      });
    } else if (!Array.isArray(rankList) || rankList.length === 0) {
      problems.push({
        code: "tasks-rank-invalid",
        field: pathJoin(taskField, "rank"),
        message: `the task "${taskName}" rank must be a non-empty array of rating names`,
        fix: `Set the rank of "${taskName}" to a non-empty array of declared rating names.`,
      });
    } else {
      rankList.forEach((entry, index) => {
        const field = `${pathJoin(taskField, "rank")}[${index}]`;
        if (typeof entry !== "string") {
          problems.push({
            code: "tasks-rank-entry-not-string",
            field,
            message: `the task "${taskName}" rank entry at index ${index} must be a string`,
            fix: `Set the rank entry of "${taskName}" at index ${index} to a declared rating name.`,
          });
          return;
        }
        if (!Object.hasOwn(declaredRatings, entry)) {
          problems.push({
            code: "tasks-rank-rating-unknown",
            field,
            message: `the rating "${entry}" is not declared in the ratings section`,
            fix: `Add "${entry}" to the ratings section, or remove it from "${taskName}" rank.`,
          });
        }
      });
    }

    if (Object.hasOwn(taskRaw, "needs")) {
      const needs = taskRaw.needs;
      if (!Array.isArray(needs)) {
        problems.push({
          code: "tasks-needs-not-array",
          field: pathJoin(taskField, "needs"),
          message: `the task "${taskName}" needs must be a list of declared capability names`,
          fix: `Replace the needs of "${taskName}" with a list of declared capability names.`,
        });
      } else {
        needs.forEach((entry, index) => {
          const field = `${pathJoin(taskField, "needs")}[${index}]`;
          if (typeof entry !== "string") {
            problems.push({
              code: "tasks-needs-entry-not-string",
              field,
              message: `the task "${taskName}" needs entry at index ${index} must be a string`,
              fix: `Set the needs entry of "${taskName}" at index ${index} to a declared capability name.`,
            });
            return;
          }
          if (!Object.hasOwn(declaredCapabilities, entry)) {
            problems.push({
              code: "tasks-needs-capability-unknown",
              field,
              message: `the capability "${entry}" is not declared in the capabilities section`,
              fix: `Add "${entry}" to the capabilities section, or remove it from "${taskName}" needs.`,
            });
          }
        });
      }
    }

    if (Object.hasOwn(taskRaw, "effort")) {
      const effort = taskRaw.effort;
      if (typeof effort !== "string" || !(EFFORT_LADDER as readonly string[]).includes(effort)) {
        problems.push({
          code: "tasks-effort-invalid",
          field: pathJoin(taskField, "effort"),
          message: `the task "${taskName}" effort must be one of ${EFFORT_LADDER.join(", ")}`,
          fix: `Set the effort of "${taskName}" to one of ${EFFORT_LADDER.join(", ")}.`,
        });
      }
    }

    for (const name of Object.keys(taskRaw)) {
      if (!TASK_FIELDS.includes(name)) {
        problems.push({
          code: "tasks-field-unknown",
          field: pathJoin(taskField, name),
          message: `the field "${name}" is not part of the task "${taskName}"`,
          fix: `Remove the field "${name}" from the task "${taskName}".`,
        });
      }
    }

    const taskMinimums = readTaskMinimums(minimums);
    const taskRank = readTaskRank(rankList);
    const taskNeeds = readTaskNeeds(taskRaw.needs);
    const taskEffort = readTaskEffort(taskRaw.effort);

    tasksMap[taskName] = {
      description: typeof description === "string" ? description : "",
      ...(taskEffort === undefined ? {} : { effort: taskEffort }),
      minimums: taskMinimums,
      needs: taskNeeds,
      rank: taskRank,
    };
  }

  return tasksMap;
}

function readTaskMinimums(
  raw: unknown,
): Readonly<Record<string, Readonly<Record<string, number>>>> {
  if (!isPlainObject(raw)) return {};
  const out = nullRecord<Record<string, number>>();
  for (const stake of STAKES_VALUES) {
    const stakeFloors = raw[stake];
    if (!isPlainObject(stakeFloors)) continue;
    const inner = nullRecord<number>();
    for (const [rating, value] of Object.entries(stakeFloors)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        inner[rating] = value;
      }
    }
    if (Object.keys(inner).length > 0) out[stake] = inner;
  }
  return out;
}

function readTaskRank(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function readTaskNeeds(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function readTaskEffort(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function validatePolicy(
  raw: unknown,
  loaded: LoadedRegistry,
  tasksMap: TasksMap,
  problems: RouterProblem[],
): PoliciesMap {
  if (raw === undefined) return {};
  const sectionField = '$["policy"]';
  if (!isPlainObject(raw)) {
    problems.push({
      code: "policy-section-not-object",
      field: sectionField,
      message: "the policy section must be a JSON object",
      fix: 'Replace the policy section with an object such as "policy": { "name": { ... } }.',
    });
    return {};
  }

  const declaredRoutes = loaded.routes;
  const policiesMap = nullRecord<PolicyEntry>();

  for (const [policyName, policyRaw] of Object.entries(raw)) {
    const policyField = pathJoin(sectionField, policyName);
    if (!isPlainObject(policyRaw)) {
      problems.push({
        code: "policy-entry-not-object",
        field: policyField,
        message: `the policy "${policyName}" must be a JSON object`,
        fix: `Replace the policy "${policyName}" with an object that has task, stakes, routes and reason.`,
      });
      continue;
    }

    const task = policyRaw.task;
    if (task === undefined) {
      problems.push({
        code: "policy-task-missing",
        field: pathJoin(policyField, "task"),
        message: `the policy "${policyName}" has no task, which model-router requires`,
        fix: `Add a task name to the policy "${policyName}".`,
      });
    } else if (typeof task !== "string" || !Object.hasOwn(tasksMap, task)) {
      problems.push({
        code: "policy-task-unknown",
        field: pathJoin(policyField, "task"),
        message: `the task "${task}" is not declared in the tasks section`,
        fix: `Add "${task}" to the tasks section, or correct the policy "${policyName}" task.`,
      });
    }

    const stakes = policyRaw.stakes;
    if (stakes === undefined) {
      problems.push({
        code: "policy-stakes-missing",
        field: pathJoin(policyField, "stakes"),
        message: `the policy "${policyName}" has no stakes list, which model-router requires`,
        fix: `Add a stakes list to the policy "${policyName}".`,
      });
    } else if (!Array.isArray(stakes) || stakes.length === 0) {
      problems.push({
        code: "policy-stakes-invalid",
        field: pathJoin(policyField, "stakes"),
        message: `the policy "${policyName}" stakes must be a non-empty array of stakes levels`,
        fix: `Set the stakes of "${policyName}" to a non-empty list of low, normal or high.`,
      });
    } else {
      stakes.forEach((entry, index) => {
        const field = `${pathJoin(policyField, "stakes")}[${index}]`;
        if (typeof entry !== "string" || !STAKES_VALUES.includes(entry)) {
          problems.push({
            code: "policy-stakes-entry-invalid",
            field,
            message: `the policy "${policyName}" stakes entry at index ${index} must be low, normal or high`,
            fix: `Set the stakes entry of "${policyName}" at index ${index} to low, normal or high.`,
          });
        }
      });
    }

    const routes = policyRaw.routes;
    const routeEntries: PolicyRoute[] = [];
    if (routes === undefined) {
      problems.push({
        code: "policy-routes-missing",
        field: pathJoin(policyField, "routes"),
        message: `the policy "${policyName}" has no routes list, which model-router requires`,
        fix: `Add a routes list to the policy "${policyName}".`,
      });
    } else if (!Array.isArray(routes) || routes.length === 0) {
      problems.push({
        code: "policy-routes-invalid",
        field: pathJoin(policyField, "routes"),
        message: `the policy "${policyName}" routes must be a non-empty array`,
        fix: `Set the routes of "${policyName}" to a non-empty array of route entries.`,
      });
    } else {
      routes.forEach((entry, index) => {
        const field = `${pathJoin(policyField, "routes")}[${index}]`;
        if (!isPlainObject(entry)) {
          problems.push({
            code: "policy-route-not-object",
            field,
            message: `the policy "${policyName}" route at index ${index} must be a JSON object`,
            fix: `Set the route at index ${index} of "${policyName}" to an object with "route".`,
          });
          return;
        }
        const routeLabel = entry.route;
        if (typeof routeLabel !== "string") {
          problems.push({
            code: "policy-route-label-missing",
            field: pathJoin(field, "route"),
            message: `the policy "${policyName}" route at index ${index} is missing a label`,
            fix: `Set the "route" of the policy "${policyName}" route at index ${index} to a label.`,
          });
        } else {
          routeEntries.push(
            typeof entry.effort === "string"
              ? { effort: entry.effort, route: routeLabel }
              : { route: routeLabel },
          );
          if (!Object.hasOwn(declaredRoutes, routeLabel)) {
            problems.push({
              code: "policy-route-label-unknown",
              field: pathJoin(field, "route"),
              message: `the label "${routeLabel}" is not declared by any route`,
              fix: `Add the route "${routeLabel}" to the models section, or remove it from "${policyName}".`,
            });
          }
        }
        if (typeof routeLabel === "string" && Object.hasOwn(declaredRoutes, routeLabel)) {
          // The loader's route index is the one label authority: it holds the
          // exact label (including a present-but-empty provider) and the
          // model that owns the route.
          const modelKey = declaredRoutes[routeLabel]?.model;
          if (modelKey !== undefined) {
            const model = loaded.registry.models[modelKey];
            if (model !== undefined) {
              const modelMax = model.maxEffort;
              const modelFixed = model.fixedEffort;
              const policyEffort = entry.effort;
              if (typeof policyEffort === "string") {
                if (!(EFFORT_LADDER as readonly string[]).includes(policyEffort)) {
                  problems.push({
                    code: "policy-route-effort-invalid",
                    field: pathJoin(field, "effort"),
                    message: `the policy "${policyName}" route "${routeLabel}" effort must be one of ${EFFORT_LADDER.join(", ")}`,
                    fix: `Set the effort of the policy "${policyName}" route "${routeLabel}" to one of ${EFFORT_LADDER.join(", ")}.`,
                  });
                } else if (modelFixed !== undefined && policyEffort !== modelFixed) {
                  problems.push({
                    code: "policy-route-effort-fixed-mismatch",
                    field: pathJoin(field, "effort"),
                    message: `the policy "${policyName}" route "${routeLabel}" effort "${policyEffort}" differs from the model's fixedEffort "${modelFixed}"`,
                    fix: `Remove the policy route's effort, or set it to "${modelFixed}".`,
                  });
                } else if (modelMax !== undefined && exceedsLadder(policyEffort, modelMax)) {
                  problems.push({
                    code: "policy-route-effort-above-max",
                    field: pathJoin(field, "effort"),
                    message: `the policy "${policyName}" route "${routeLabel}" effort "${policyEffort}" is above the model's maxEffort "${modelMax}"`,
                    fix: `Lower the policy route's effort to "${modelMax}" or below, or remove it.`,
                  });
                }
              }
            }
          }
        }
        if (Object.hasOwn(entry, "effort") && typeof entry.effort !== "string") {
          problems.push({
            code: "policy-route-effort-not-string",
            field: pathJoin(field, "effort"),
            message: `the policy "${policyName}" route at index ${index} effort must be a string`,
            fix: `Set the effort of the policy "${policyName}" route at index ${index} to a string.`,
          });
        }
        for (const name of Object.keys(entry)) {
          if (name !== "route" && name !== "effort") {
            problems.push({
              code: "policy-route-field-unknown",
              field: pathJoin(field, name),
              message: `the field "${name}" is not part of a policy route`,
              fix: `Remove the field "${name}" from the policy "${policyName}" route at index ${index}.`,
            });
          }
        }
      });
    }

    const reason = policyRaw.reason;
    if (reason === undefined) {
      problems.push({
        code: "policy-reason-missing",
        field: pathJoin(policyField, "reason"),
        message: `the policy "${policyName}" has no reason, which model-router requires`,
        fix: `Add a one-line reason to the policy "${policyName}".`,
      });
    } else if (typeof reason !== "string") {
      problems.push({
        code: "policy-reason-not-string",
        field: pathJoin(policyField, "reason"),
        message: `the policy "${policyName}" reason must be a string`,
        fix: `Set the reason of "${policyName}" to a one-line sentence.`,
      });
    }

    let spec: PolicySpec | undefined;
    if (Object.hasOwn(policyRaw, "spec")) {
      const policySpec = policyRaw.spec;
      if (typeof policySpec !== "string" || policySpec !== "settled") {
        problems.push({
          code: "policy-spec-invalid",
          field: pathJoin(policyField, "spec"),
          message: `the policy "${policyName}" spec must be settled`,
          fix: `Set the spec of "${policyName}" to settled, or remove it.`,
        });
      } else {
        spec = policySpec;
      }
    }

    if (Object.hasOwn(policyRaw, "since")) {
      if (typeof policyRaw.since !== "string") {
        problems.push({
          code: "policy-since-not-string",
          field: pathJoin(policyField, "since"),
          message: `the policy "${policyName}" since must be a string`,
          fix: `Set the since of "${policyName}" to a date string.`,
        });
      }
    }

    for (const name of Object.keys(policyRaw)) {
      if (!POLICY_FIELDS.includes(name)) {
        problems.push({
          code: "policy-field-unknown",
          field: pathJoin(policyField, name),
          message: `the field "${name}" is not part of the policy "${policyName}"`,
          fix: `Remove the field "${name}" from the policy "${policyName}".`,
        });
      }
    }

    if (Array.isArray(stakes)) {
      policiesMap[policyName] = {
        name: policyName,
        routes: routeEntries,
        stakes: stakes.filter(
          (entry): entry is Stakes =>
            typeof entry === "string" && STAKES_VALUES.includes(entry as Stakes),
        ),
        ...(spec === undefined ? {} : { spec }),
        task: typeof task === "string" ? task : "",
      };
    }
  }

  detectPolicyTies(policiesMap, problems);
  return policiesMap;
}

function detectPolicyTies(policies: PoliciesMap, problems: RouterProblem[]): void {
  const entries = Object.values(policies);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a === undefined || b === undefined) continue;
      if (a.task !== b.task) continue;
      const shared = a.stakes.filter((stake) => b.stakes.includes(stake));
      if (shared.length === 0) continue;
      // A tie is two policies that match the same query at the same level:
      // the same task, an overlapping stakes level, the same spec condition.
      // Only "settled" is a valid spec condition, so a specless policy and
      // a settled one never tie: the settled policy beats it.
      if (a.spec !== b.spec) continue;
      const specText = a.spec === undefined ? "no spec" : `spec "${a.spec}"`;
      problems.push({
        code: "policy-tie",
        field: '$["policy"]',
        message: `policies "${a.name}" and "${b.name}" both cover task "${a.task}" at stakes ${shared.join(", ")} with ${specText}`,
        fix: "Adjust one of the policies so only one applies to each query, or rename a task.",
      });
    }
  }
}

function exceedsLadder(value: string, ceiling: string): boolean {
  const ladder = EFFORT_LADDER as readonly string[];
  const valueIndex = ladder.indexOf(value);
  const ceilingIndex = ladder.indexOf(ceiling);
  if (valueIndex === -1 || ceilingIndex === -1) return false;
  return valueIndex > ceilingIndex;
}

function sectionsError(first: RouterProblem, rest: readonly RouterProblem[]): RouterError {
  return new RouterError({
    code: "registry-sections-invalid",
    field: first.field,
    fix:
      rest.length === 0
        ? first.fix
        : "Fix each problem listed in problems, then run model-router again.",
    message:
      rest.length === 0 ? first.message : `the router section has ${rest.length + 1} problems`,
    problems: [first, ...rest],
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
