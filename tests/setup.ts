import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Default isolation: route the router's config path order to a temp dir so
// no test reads the operator's home config. The temp dir has no
// model-router/ subdir, so XDG_CONFIG_HOME points at nothing useful, and
// MODEL_ROUTER_CONFIG is cleared so the loader falls through to XDG and
// then to the router's defaults. Tests that need a specific config
// resolution override these in their own setup.
const tempDir = mkdtempSync(join(tmpdir(), "model-router-vitest-"));
process.env.XDG_CONFIG_HOME = tempDir;
delete process.env.MODEL_ROUTER_CONFIG;
delete process.env.MODEL_ROUTER_PROFILE;
// No test reads the operator's Jev key: a test outside withEnv would
// otherwise inherit it and could send it to the hosted endpoint.
delete process.env.TYPESAFE_API_KEY;

// No test makes a network request by construction: fetch is replaced with
// a guard that rejects. A test that needs fetch stubs it with a spy; plain
// assignment keeps the property a plain value, so mockRestore on that spy
// returns to the guard instead of the real fetch. Built-CLI child processes
// never see a key (it is deleted above), so they never call fetch either.
const fetchGuard: typeof globalThis.fetch = () =>
  Promise.reject(new Error("tests make no network request; stub fetch in the test"));
globalThis.fetch = fetchGuard;

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
