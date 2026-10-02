#!/usr/bin/env node
import { runCli } from "./cli-run.js";

const exitCode = runCli(process.argv.slice(2), {
  stderr: process.stderr,
  stdout: process.stdout,
});
process.exitCode = exitCode;
