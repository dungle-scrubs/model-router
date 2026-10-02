import type { RouterErrorDetails } from "./types.js";

const ERROR_NAME = "RouterError";

/**
 * The single error type the router throws. One run collects every problem in
 * `problems`; the JSON serialization never includes the stack or the
 * underlying cause.
 */
export class RouterError extends Error {
  readonly code: RouterErrorDetails["code"];
  readonly field: string;
  readonly fix: string;
  readonly problems: RouterErrorDetails["problems"];

  constructor(details: RouterErrorDetails) {
    super(details.message);
    this.name = ERROR_NAME;
    this.code = details.code;
    this.field = details.field;
    this.fix = details.fix;
    this.problems = details.problems;
  }

  toJSON(): RouterErrorDetails {
    return {
      code: this.code,
      field: this.field,
      fix: this.fix,
      message: this.message,
      problems: this.problems,
    };
  }
}
