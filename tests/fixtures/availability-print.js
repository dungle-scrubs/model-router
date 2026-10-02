#!/usr/bin/env node
// A small availability-document writer used by tests that need to run
// the configured availability command. When invoked with a path, it
// prints the JSON document at that path on stdout. Without a path it
// prints a single-entry ok reading at the current time.

import { readFileSync } from "node:fs";

if (process.argv[2] === undefined) {
  const fallback = {
    format: 1,
    generatedAt: new Date().toISOString(),
    entries: [{ meter: "meter-a", status: "ok" }],
  };
  process.stdout.write(`${JSON.stringify(fallback)}\n`);
} else {
  const text = readFileSync(process.argv[2], "utf8");
  process.stdout.write(text);
}
