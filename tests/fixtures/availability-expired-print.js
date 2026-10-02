#!/usr/bin/env node
// A small availability-document writer used by tests that need a command
// source whose single entry has already expired. The CLI is supposed to
// drop this entry before the engine sees it, so the metered route stays
// in place. The document is stamped at print time; the CLI reads its
// clock after the command returns.

const generatedAt = new Date().toISOString();
process.stdout.write(
  JSON.stringify({
    format: 1,
    generatedAt,
    entries: [{ meter: "meter-a", status: "exhausted", resetsAt: "2000-01-01T00:00:00Z" }],
  }),
);
