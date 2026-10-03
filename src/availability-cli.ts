import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dropExpired } from "./availability.js";
import type { RouterConfigAvailability } from "./config.js";
import type {
  AvailabilityEntry,
  AvailabilityEntryStatus,
  AvailabilityValue,
  Coded,
} from "./types.js";

export interface AvailabilityLoad {
  readonly entries: readonly AvailabilityEntry[];
  readonly note: Coded | null;
  readonly warnings: readonly Coded[];
}

const VALID_STATUSES = new Set<AvailabilityValue>(["ok", "projected", "exhausted"]);
const EIGHT_MIB = 8 * 1024 * 1024;

function note(code: string, message: string, fix: string): Coded {
  return { code, fix, message };
}

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
      warnings: [],
    };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.format !== 1) {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        "the availability document format is not 1",
        "Use a document at format version 1.",
      ),
      warnings: [],
    };
  }
  if (typeof doc.generatedAt !== "string") {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        "the availability document has no generatedAt string",
        "Add generatedAt: an ISO timestamp string to the document.",
      ),
      warnings: [],
    };
  }
  if (!Array.isArray(doc.entries)) {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        "the availability document entries is not an array",
        "Replace entries with an array of { meter, status } objects.",
      ),
      warnings: [],
    };
  }
  const now = options.now ?? new Date();
  const then = Date.parse(doc.generatedAt);
  if (Number.isNaN(then)) {
    return {
      entries: [],
      note: note(
        "availability-reading-invalid",
        "the availability document generatedAt is not a parseable date",
        "Set generatedAt to an ISO timestamp such as 2026-10-01T04:00:00Z.",
      ),
      warnings: [],
    };
  }
  const ageMs = now.getTime() - then;
  if (ageMs > options.maxAgeSeconds * 1000) {
    return {
      entries: [],
      note: note(
        "availability-reading-stale",
        `the availability document is older than ${options.maxAgeSeconds} seconds`,
        "Regenerate the document within " +
          options.maxAgeSeconds +
          " seconds, or raise availability.maxAgeSeconds in config.json.",
      ),
      warnings: [],
    };
  }
  if (ageMs < 0) {
    return {
      entries: [],
      note: note(
        "availability-reading-stale",
        "the availability document has a generatedAt in the future",
        "Fix generatedAt to the actual time the document was produced.",
      ),
      warnings: [],
    };
  }
  return extractEntries(doc.entries);
}

function extractEntries(items: readonly unknown[]): AvailabilityLoad {
  const kept: AvailabilityEntry[] = [];
  const warnings: Coded[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      warnings.push(
        entryInvalid(index, "the entry is not a JSON object", "Replace it with an object."),
      );
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.meter !== "string" || entry.meter.length === 0) {
      warnings.push(
        entryInvalid(
          index,
          "the entry has no meter string",
          "Add meter: a non-empty string to the entry.",
        ),
      );
      continue;
    }
    if (
      typeof entry.status !== "string" ||
      !VALID_STATUSES.has(entry.status as AvailabilityValue)
    ) {
      const status = entry.status;
      const statusText = typeof status === "string" ? JSON.stringify(status) : typeof status;
      warnings.push(
        entryInvalid(
          index,
          `the entry has no known status (received ${statusText})`,
          "Set status to ok, projected or exhausted.",
        ),
      );
      continue;
    }
    if (
      "percentRemaining" in entry &&
      (typeof entry.percentRemaining !== "number" || !Number.isFinite(entry.percentRemaining))
    ) {
      warnings.push(
        entryInvalid(
          index,
          `the entry has a percentRemaining of type ${typeof entry.percentRemaining}`,
          "Set percentRemaining to a finite number, or remove the field.",
        ),
      );
      continue;
    }
    if ("resetsAt" in entry) {
      if (typeof entry.resetsAt !== "string") {
        warnings.push(
          entryInvalid(
            index,
            `the entry has a resetsAt of type ${typeof entry.resetsAt}`,
            "Set resetsAt to an ISO timestamp string, or remove the field.",
          ),
        );
        continue;
      }
      const parsed = Date.parse(entry.resetsAt);
      if (Number.isNaN(parsed)) {
        warnings.push(
          entryInvalid(
            index,
            "the entry has an unparseable resetsAt",
            "Set resetsAt to an ISO timestamp such as 2026-10-01T04:00:00Z.",
          ),
        );
        continue;
      }
    }
    if ("note" in entry && typeof entry.note !== "string") {
      warnings.push(
        entryInvalid(
          index,
          `the entry has a note of type ${typeof entry.note}`,
          "Set note to a string, or remove the field.",
        ),
      );
      continue;
    }
    const built: {
      meter: string;
      status: AvailabilityEntryStatus;
      percentRemaining?: number;
      resetsAt?: string;
      note?: string;
    } = { meter: entry.meter, status: entry.status as AvailabilityEntryStatus };
    if (typeof entry.percentRemaining === "number") built.percentRemaining = entry.percentRemaining;
    if (typeof entry.resetsAt === "string") built.resetsAt = entry.resetsAt;
    if (typeof entry.note === "string") built.note = entry.note;
    kept.push(built);
  }
  return { entries: kept, note: null, warnings };
}

function entryInvalid(index: number, message: string, fix: string): Coded {
  return {
    code: "availability-entry-invalid",
    field: `$.entries[${index}]`,
    fix,
    message,
  };
}

export function readAvailabilityFile(
  path: string,
  options: { readonly maxAgeSeconds: number; readonly now?: Date; readonly clock?: () => Date },
): AvailabilityLoad {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : "";
    if (code === "ENOENT") {
      return {
        entries: [],
        note: note(
          "availability-file-unreadable",
          `the availability file at ${path} does not exist`,
          `Make the file ${path} readable, or pass a different --availability-file path.`,
        ),
        warnings: [],
      };
    }
    return {
      entries: [],
      note: note(
        "availability-file-unreadable",
        `the availability file at ${path} could not be read`,
        "Make the file " +
          path +
          " readable as a regular file, or pass a different --availability-file path.",
      ),
      warnings: [],
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
        `the availability file at ${path} is not valid JSON`,
        "Replace the file with valid JSON such as the document a user converter writes.",
      ),
      warnings: [],
    };
  }
  return parseAvailabilityDocument(raw, {
    maxAgeSeconds: options.maxAgeSeconds,
    now: options.now ?? options.clock?.() ?? new Date(),
  });
}

export function runAvailabilityCommand(
  command: readonly string[],
  options: {
    readonly maxAgeSeconds: number;
    readonly timeoutSeconds: number;
    readonly maxBuffer?: number;
    readonly now?: Date;
    readonly clock?: () => Date;
  },
): AvailabilityLoad {
  if (command.length === 0) {
    return {
      entries: [],
      note: note(
        "availability-command-missing",
        "the availability command was empty",
        "Set availability.command in config.json to a non-empty argv array.",
      ),
      warnings: [],
    };
  }
  const [bin, ...argvRest] = command as [string, ...string[]];
  const maxBuffer = options.maxBuffer ?? EIGHT_MIB;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, argvRest, {
      encoding: "utf8",
      timeout: options.timeoutSeconds * 1000,
      maxBuffer,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      entries: [],
      note: note(
        "availability-command-failed",
        `the availability command failed to run: ${reason}`,
        "Adjust the command in config.json, or use --availability-file.",
      ),
      warnings: [],
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
          `the availability command failed to run: ${bin} was not found`,
          "Adjust the command in config.json, or use --availability-file.",
        ),
        warnings: [],
      };
    }
    if (code === "ETIMEDOUT") {
      const unit = options.timeoutSeconds === 1 ? "second" : "seconds";
      return {
        entries: [],
        note: note(
          "availability-command-failed",
          `the availability command was killed after ${options.timeoutSeconds} ${unit}`,
          "Lower the work the command does, raise availability.timeoutSeconds in config.json, or use --availability-file.",
        ),
        warnings: [],
      };
    }
    if (code === "ENOBUFS") {
      return {
        entries: [],
        note: note(
          "availability-command-failed",
          "the availability command output exceeded 8 MiB",
          "Lower the size of the document or use --availability-file.",
        ),
        warnings: [],
      };
    }
    return {
      entries: [],
      note: note(
        "availability-command-failed",
        `the availability command failed to run: ${errResult.error.message}`,
        "Adjust the command in config.json, or use --availability-file.",
      ),
      warnings: [],
    };
  }
  if (result.signal !== null && result.signal !== undefined) {
    const signal = result.signal;
    return {
      entries: [],
      note: note(
        "availability-command-failed",
        `the availability command was killed by signal ${signal}`,
        "Lower the work the command does, raise availability.timeoutSeconds in config.json, or use --availability-file.",
      ),
      warnings: [],
    };
  }
  if (result.status !== 0) {
    const stderrText = typeof result.stderr === "string" ? result.stderr : "";
    return {
      entries: [],
      note: note(
        "availability-command-failed",
        "the availability command exited with code " +
          (result.status ?? "null") +
          " (stderr: " +
          stderrText.trim() +
          ")",
        "Adjust the command in config.json.",
      ),
      warnings: [],
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
      warnings: [],
    };
  }
  return parseAvailabilityDocument(raw, {
    maxAgeSeconds: options.maxAgeSeconds,
    now: options.now ?? options.clock?.() ?? new Date(),
  });
}

export interface AvailabilityCliSource {
  readonly command: boolean;
  readonly config: RouterConfigAvailability | undefined;
  readonly file: string | undefined;
}

export function loadAvailabilityForCli(source: AvailabilityCliSource): AvailabilityLoad {
  const maxAgeSeconds = source.config?.maxAgeSeconds ?? 300;
  const timeoutSeconds = source.config?.timeoutSeconds ?? 10;
  // The readers call this only after the source returns. Reuse that
  // reading for expiry so staleness and resetsAt share one instant.
  let now: Date | undefined;
  const clock = (): Date => (now ??= new Date());
  if (source.command) {
    if (source.config?.command === undefined) {
      return {
        entries: [],
        note: note(
          "availability-command-missing",
          "--availability was given but availability.command is not set in config.json",
          "Add availability.command to config.json, or use --availability-file path.",
        ),
        warnings: [],
      };
    }
    const load = runAvailabilityCommand(source.config.command, {
      maxAgeSeconds,
      timeoutSeconds,
      clock,
    });
    return dropExpiredLoad(load, clock());
  }
  if (source.file !== undefined) {
    const load = readAvailabilityFile(source.file, { maxAgeSeconds, clock });
    return dropExpiredLoad(load, clock());
  }
  return { entries: [], note: null, warnings: [] };
}

/** A successful load's expired entries are dropped before the engine
 * sees them; a load with a note is returned unchanged so the caller can
 * still report the failure. The note and warnings survive the drop. */
function dropExpiredLoad(load: AvailabilityLoad, now: Date): AvailabilityLoad {
  if (load.note !== null) return load;
  return { ...load, entries: dropExpired(load.entries, now) };
}
