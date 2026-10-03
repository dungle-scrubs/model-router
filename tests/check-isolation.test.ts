import childProcessDefault, * as childProcess from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { runCli } from "../src/cli-run.js";
import { captureStream, fixturePath, withTempDir, writeJson } from "./helpers.js";

const ENTRY_POINTS = vi.hoisted(
  () => ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"] as const,
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // The namespace and the default export get separate spies, so each
  // assertion below fails on its own when only that binding is called.
  const namespace: Record<string, unknown> = { ...actual };
  const defaultExport: Record<string, unknown> = { ...actual };
  for (const name of ENTRY_POINTS) {
    namespace[name] = vi.fn(actual[name]);
    defaultExport[name] = vi.fn(actual[name]);
  }
  return { ...namespace, default: defaultExport };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

test("node:child_process entry points are fully covered by the isolation wrapper", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const functionKeys = Object.keys(actual)
    .filter(
      (key) =>
        key !== "ChildProcess" &&
        !key.startsWith("_") &&
        typeof actual[key as keyof typeof actual] === "function",
    )
    .sort();
  expect(functionKeys).toEqual([...ENTRY_POINTS].sort());
});

test("the namespace and default spies are independent", () => {
  for (const name of ENTRY_POINTS) {
    expect((childProcessDefault as Record<string, unknown>)[name], `default ${name}`).not.toBe(
      childProcess[name as keyof typeof childProcess],
    );
  }
});

test.each([false, true])(
  "check performs no subprocess or fetch with config=%s",
  async (configured) => {
    await withTempDir(async (dir) => {
      const config = configured
        ? [
            "--config",
            writeJson(dir, "config.json", {
              availability: { command: [process.execPath, "-e", "0"] },
            }),
          ]
        : [];
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const out = captureStream();
      const err = captureStream();
      const exit = await runCli(["check", "--registry", fixturePath("full.json"), ...config], {
        stdout: out.stream,
        stderr: err.stream,
      });
      expect(exit, err.text()).toBe(0);
      for (const name of ENTRY_POINTS) {
        expect(
          childProcess[name as keyof typeof childProcess],
          `namespace ${name}`,
        ).not.toHaveBeenCalled();
        expect(
          (childProcessDefault as Record<string, unknown>)[name],
          `default ${name}`,
        ).not.toHaveBeenCalled();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  },
);
