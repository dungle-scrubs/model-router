import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { RouterConfigAvailability } from "./config.js";
import type { AvailabilityDocument, AvailabilityEntry, AvailabilityValue, Coded } from "./types.js";

/** A successful load carries the entries; a failure carries a `note` the
 * answer reports as `availabilityNote`. The two are exclusive: a failed
 * load returns no entries. */
export interface AvailabilityLoad {
  readonly entries: readonly AvailabilityEntry[];
  readonly note: Coded | null;
}

const VALID_STATUSES = new Set(["ok", "projected", "exhausted"]);

function note(code: string, message: string, fix: string): Coded {
  return { code, fix, message };
}

/** Decode one parsed JSON value into an availability document. A wrong
 * top level means the load fails with a `note`; a single bad entry is
 * skipped silently (the engine treats unknown statuses as no-op and
 * warns `availability-entry-invalid` separately). The caller passes
 * `maxAgeSeconds` for the staleness check. The check uses the document's
 * `generatedAt`. */
export function parseAvailabilityDocument(
  raw: unknown,
  options: { readonly maxAgeSeconds: number; readonly now?: Date },
): AvailabilityLoad {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        "the availability document must be a JSON object",
        "Replace the document with an object holding format, generatedAt and entries.",
      ),
    };
  }
  const doc = raw as Record<string, unknown>;
  if (doc["format"] !== 1) {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        'the availability document "format" is not 1',
        "Use a document at format version 1.",
      ),
    };
  }
  if (typeof doc["generatedAt"] !== "string") {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        'the availability document has no "generatedAt" string',
        'Add "generatedAt": "<ISO timestamp>" to the document.',
      ),
    };
  }
  if (!Array.isArray(doc["entries"])) {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        'the availability document "entries" is not an array',
        'Replace "entries" with an array of { meter, status } objects.',
      ),
    };
  }
  const now = options.now ?? new Date();
  const then = Date.parse(doc["generatedAt"]);
  if (Number.isNaN(then)) {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        'the availability document "generatedAt" is not a parseable date',
        'Set "generatedAt" to an ISO timestamp such as "2026-10-01T04:00:00Z".',
      ),
    };
  }
  const ageMs = now.getTime() - then;
  if (ageMs > options.maxAgeSeconds * 1000) {
    return {
      entries: [],
      note: note(
        "availability-reading-stale",
        `the availability document is older than ${options.maxAgeSeconds} seconds`,
        `Regenerate the document within ${options.maxAgeSeconds} seconds, or raise "availability"."maxAgeSeconds" in config.json.`,
      ),
    };
  }
  if (ageMs < 0) {
    return {
      entries: [],
      note: note(
        "availability-reading-stale",
        "the availability document has a generatedAt in the future",
        'Fix "generatedAt" to the actual time the document was produced.',
      ),
    };
  }
  return { entries: extractEntries(doc["entries"]), note: null };
}

function extractEntries(items: readonly unknown[]): readonly AvailabilityEntry[] {
  const out: AvailabilityEntry[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const meter = entry["meter"];
    const status = entry["status"];
    if (typeof meter !== "string" || meter.length === 0) continue;
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) continue;
    const built: {
      meter: string;
      status: AvailabilityValue;
      percentRemaining?: number;
      resetsAt?: string;
      note?: string;
    } = { meter, status: status as AvailabilityValue };
    if (
      typeof entry["percentRemaining"] === "number" &&
      Number.isFinite(entry["percentRemaining"])
    ) {
      built.percentRemaining = entry["percentRemaining"];
    }
    if (typeof entry["resetsAt"] === "string") built.resetsAt = entry["resetsAt"];
    if (typeof entry["note"] === "string") built.note = entry["note"];
    out.push(built);
  }
  return out;
}

/** Read an availability document from a path. The function reads the
 * file once and parses it. A missing file or unreadable file fails the
 * load with `availability-file-unreadable`; bad JSON or a wrong top
 * level fails with `availability-reading-invalid`. Staleness is checked
 * here against `maxAgeSeconds` because the document is fully parsed at
 * this point. */
export function readAvailabilityFile(
  path: string,
  options: { readonly maxAgeSeconds: number; readonly now?: Date },
): AvailabilityLoad {
  if (!existsSync(path)) {
    return {
      entries: [],
      note: note(
        "availability-file-unreadable",
        `the availability file at "${path}" does not exist`,
        `Make the file "${path}" readable, or pass a different --availability-file path.`,
      ),
    };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      entries: [],
      note: note(
        "availability-file-unreadable",
        `the availability file at "${path}" could not be read: ${reason}`,
        `Make the file "${path}" readable as a regular file, or pass a different --availability-file path.`,
      ),
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        `the availability file at "${path}" is not valid JSON`,
        "Replace the file with valid JSON such as the document a user converter writes.",
      ),
    };
  }
  return parseAvailabilityDocument(raw, options);
}

/** Run the configured availability command and parse its stdout. The
 * command runs without a shell, with a SIGTERM kill at `timeoutSeconds`.
 * A non-zero exit, a missing command, or a timeout is reported with
 * `availability-command-failed`. */
export function runAvailabilityCommand(
  command: readonly string[],
  options: { readonly maxAgeSeconds: number; readonly timeoutSeconds: number; readonly now?: Date },
): AvailabilityLoad {
  if (command.length === 0) {
    return {
      entries: [],
      note: note(
        "availability-command-missing",
        "the availability command was empty",
        'Set "availability"."command" in config.json to a non-empty argv array.',
      ),
    };
  }
  const [bin, ...argvRest] = command as [string, ...string[]];
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, argvRest, {
      encoding: "utf8",
      timeout: options.timeoutSeconds * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      entries: [],
      note: note(
        "availability-command-failed",
        `the availability command did not start: ${reason}`,
        "Adjust the command in config.json, or use --availability-file.",
      ),
    };
  }
  const errResult = result as { error?: NodeJS.ErrnoException };
  if (errResult.error !== undefined) {
    const code = errResult.error.code;
    if (code === "ENOENT") {
      return {
        entries: [],
        note: note(
          "availability-command-failed",
          `the command "${bin}" was not found`,
          "Adjust the command in config.json, or use --availability-file.",
        ),
      };
    }
    if (code === "ETIMEDOUT") {
      return {
        entries: [],
        note: note(
          "availability-command-failed",
          `the availability command was killed after ${options.timeoutSeconds} seconds`,
          `Lower the work the command does, raise "availability"."timeoutSeconds" in config.json, or use --availability-file.`,
        ),
      };
    }
    return {
      entries: [],
      note: note(
        "availability-command-failed",
        `the availability command did not start: ${errResult.error.message}`,
        "Adjust the command in config.json, or use --availability-file.",
      ),
    };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return {
      entries: [],
      note: note(
        "availability-command-failed",
        `the availability command was killed after ${options.timeoutSeconds} seconds`,
        `Lower the work the command does, raise "availability"."timeoutSeconds" in config.json, or use --availability-file.`,
      ),
    };
  }
  if (result.status !== 0) {
    const stderrText = typeof result.stderr === "string" ? result.stderr : "";
    return {
      entries: [],
      note: note(
        "availability-command-failed",
        `the availability command exited with code ${result.status ?? "null"} (stderr: ${stderrText.trim()})`,
        "Adjust the command in config.json.",
      ),
    };
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        "the availability command output is not valid JSON",
        "Make the command emit a JSON document that matches availability.schema.json.",
      ),
    };
  }
  return parseAvailabilityDocument(raw, options);
}

/** Convenience type for the CLI dispatch: the engine does not need this
 * shape directly, but having one keeps the CLI's logic in one place. */
export interface AvailabilityCliSource {
  readonly command: boolean;
  readonly config: RouterConfigAvailability | undefined;
  readonly file: string | undefined;
}

/** Resolve the availability source for the CLI. A failure produces a
 * `note` and no document. The function never throws. */
export function loadAvailabilityForCli(source: AvailabilityCliSource): AvailabilityLoad {
  const maxAgeSeconds = source.config?.maxAgeSeconds ?? 300;
  const timeoutSeconds = source.config?.timeoutSeconds ?? 10;
  if (source.command) {
    if (source.config?.command === undefined) {
      return {
        entries: [],
        note: note(
          "availability-command-missing",
          "--availability was given but availability.command is not set in config.json",
          'Add "availability"."command" to config.json, or use --availability-file <path>.',
        ),
      };
    }
    return runAvailabilityCommand(source.config.command, { maxAgeSeconds, timeoutSeconds });
  }
  if (source.file !== undefined) {
    return readAvailabilityFile(source.file, { maxAgeSeconds });
  }
  return { entries: [], note: null };
}

/** The schema version's typed shape, kept here so callers can name it
 * when writing tests. The document's `entries` survive the type guard. */
export function isAvailabilityDocument(value: unknown): value is AvailabilityDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj["format"] === 1 && typeof obj["generatedAt"] === "string" && Array.isArray(obj["entries"])
  );
}
