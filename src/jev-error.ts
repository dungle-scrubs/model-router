/** The Jev client's one error type, in its own module so the image checks
 * and the client share it without importing each other. */

export type JevErrorCode =
  | "MISSING_KEY"
  | "RATE_LIMITED"
  | "SERVICE_ERROR"
  | "UNREACHABLE"
  | "BAD_RESPONSE"
  | "IMAGE_UNREADABLE"
  | "IMAGE_FORMAT"
  | "IMAGE_FILE_SIZE"
  | "IMAGE_DIMENSIONS"
  | "REQUEST_TOO_LARGE";

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
