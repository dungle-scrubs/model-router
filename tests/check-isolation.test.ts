import * as childProcess from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { runCli } from "../src/cli-run.js";
import { captureStream, fixturePath, withTempDir, writeJson } from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec),
    execSync: vi.fn(actual.execSync),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
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
      for (const fn of [
        childProcess.spawn,
        childProcess.spawnSync,
        childProcess.exec,
        childProcess.execSync,
        childProcess.execFile,
        childProcess.execFileSync,
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  },
);
