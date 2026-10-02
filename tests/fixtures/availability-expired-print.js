#!/usr/bin/env node
// A small availability-document writer used by tests that need a command
// source whose single entry has already expired. The CLI is supposed to
// drop this entry before the engine sees it, so the metered route stays
// in place. The generatedAt is set 60 seconds before print time so the
// document is fresh by the parent's clock: the parent reads `now`
// before the child runs, so the child must write a date strictly before
// the parent's `now` to avoid the "in the future" check.

const generatedAt = new Date(Date.now() - 60_000).toISOString();
process.stdout.write(
  JSON.stringify({
    format: 1,
    generatedAt,
    entries: [{ meter: "meter-a", status: "exhausted", resetsAt: "2000-01-01T00:00:00Z" }],
  }),
);
