import type { LoadedRegistry } from "@dungle-scrubs/model-registry";
import { RouterError } from "./error.js";
import type { RouterProblem, RouterSections } from "./types.js";

function pathJoin(parent: string, child: string): string {
  return `${parent}[${JSON.stringify(child)}]`;
}

function sampleRating(loaded: LoadedRegistry): string {
  return Object.keys(loaded.registry.ratings ?? {})[0] ?? "rating-a";
}

function rankLine(loaded: LoadedRegistry): string {
  return `"router": { "rank": ["${sampleRating(loaded)}"] }`;
}

/**
 * Read and validate the router's section of the registry file. The loader
 * passes it through untouched in `loaded.sections`; this module is the one
 * place that knows its shape. Returns the validated `rank` list; throws a
 * RouterError with `registry-sections-invalid` on any problem.
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

  if (problems.length > 0) {
    const [first, ...rest] = problems as [RouterProblem, ...RouterProblem[]];
    throw sectionsError(first, rest);
  }

  return { rank };
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
