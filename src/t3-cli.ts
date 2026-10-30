#!/usr/bin/env node
import { runT3Cli } from "./t3-cli-run.js";

process.exitCode = runT3Cli(process.argv.slice(2), {
  stderr: process.stderr,
  stdout: process.stdout,
});
