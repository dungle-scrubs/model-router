import { describe, expect, test, vi } from "vitest";

const RACED_PATH = "/raced/model-router/config.json";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      path === RACED_PATH || actual.existsSync(path),
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (path === RACED_PATH) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${RACED_PATH}'`), {
          code: "ENOENT",
        });
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

const { loadConfigFromPath } = await import("../src/config.js");

describe("loadConfigFromPath when the file disappears after the existence check", () => {
  test("the failed read is config-invalid, not internal-error", () => {
    expect(() => loadConfigFromPath(RACED_PATH)).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    );
  });
});
