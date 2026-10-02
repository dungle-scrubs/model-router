import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  defaultConfig,
  loadConfig,
  loadConfigFromPath,
  validateConfigObjectInput,
  xdgConfigPath,
} from "../src/config.js";
import { RouterError, rank } from "../src/index.js";
import {
  expectValidAnswer,
  fixturePath,
  loadLoaded,
  withEnv,
  withTempDir,
  writeJson,
} from "./helpers.js";

const FULL = fixturePath("full.json");

function full() {
  return loadLoaded(FULL);
}

describe("validateConfigObjectInput", () => {
  test("an empty object returns the default config", () => {
    expect(validateConfigObjectInput({})).toEqual(defaultConfig());
  });

  test("undefined returns the default config", () => {
    expect(validateConfigObjectInput(undefined)).toEqual(defaultConfig());
  });

  test("an explicit default and ceiling apply", () => {
    expect(validateConfigObjectInput({ effort: { ceiling: "high", default: "low" } })).toEqual({
      effort: { ceiling: "high", default: "low" },
    });
  });

  test("a default above the ceiling fails", () => {
    try {
      validateConfigObjectInput({ effort: { ceiling: "low", default: "high" } });
      throw new Error("expected validateConfigObjectInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("config-invalid");
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-effort-default-above-ceiling");
    }
  });

  test("an unknown top-level key fails", () => {
    try {
      validateConfigObjectInput({ mystery: true });
      throw new Error("expected validateConfigObjectInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("config-invalid");
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-key-unknown");
    }
  });

  test("$schema is allowed", () => {
    expect(
      validateConfigObjectInput({
        $schema: "https://example.invalid/config.schema.json",
      }),
    ).toEqual(defaultConfig());
  });

  test("an off-ladder ceiling fails", () => {
    try {
      validateConfigObjectInput({ effort: { ceiling: "warp-nine" } });
      throw new Error("expected validateConfigObjectInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-effort-ceiling-invalid");
    }
  });

  test("an off-ladder default fails", () => {
    try {
      validateConfigObjectInput({ effort: { default: "warp-nine" } });
      throw new Error("expected validateConfigObjectInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-effort-default-invalid");
    }
  });

  test("an unknown key under effort fails", () => {
    try {
      validateConfigObjectInput({ effort: { ceiling: "xhigh", default: "medium", mystery: 1 } });
      throw new Error("expected validateConfigObjectInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-effort-key-unknown");
    }
  });

  test("a non-object effort section fails", () => {
    try {
      validateConfigObjectInput({ effort: "oops" });
      throw new Error("expected validateConfigObjectInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-effort-not-object");
    }
  });
});

describe("loadConfigFromPath", () => {
  test("an empty file returns the default config with the resolved path", async () => {
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "config.json", {});
      const loaded = loadConfigFromPath(path);
      expect(loaded.config).toEqual(defaultConfig());
      expect(loaded.configPath).toBe(path);
    });
  });

  test("a missing file fails config-invalid", () => {
    expect(() => loadConfigFromPath("/nonexistent/path/config.json")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    );
  });

  test("a file with invalid JSON fails config-invalid", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "bad.json");
      // Use the lower-level fs API to bypass json: { assemble } which would
      // refuse to write it.
      await import("node:fs").then((fs) => fs.writeFileSync(path, "{not json"));
      expect(() => loadConfigFromPath(path)).toThrowError(
        expect.objectContaining({ code: "config-invalid" }),
      );
    });
  });
});

describe("xdgConfigPath", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    expect(xdgConfigPath({ XDG_CONFIG_HOME: "/tmp/example" })).toBe(
      "/tmp/example/model-router/config.json",
    );
  });

  test("uses $HOME/.config when XDG_CONFIG_HOME is empty", () => {
    const home = require("node:os").homedir();
    expect(xdgConfigPath({ XDG_CONFIG_HOME: "" })).toBe(
      join(home, ".config", "model-router", "config.json"),
    );
  });
});

describe("loadConfig path order", () => {
  test("MODEL_ROUTER_CONFIG wins over the XDG path", async () => {
    await withEnv({ MODEL_ROUTER_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, async () => {
      await withTempDir(async (dir) => {
        const envConfig = writeJson(dir, "env.json", { effort: { default: "low" } });
        const xdgHome = join(dir, "xdg");
        mkdirSync(xdgHome, { recursive: true });
        const xdgConfig = writeJson(xdgHome, "config.json", {
          effort: { default: "high" },
        });
        const envLoad = loadConfig({
          env: {
            MODEL_ROUTER_CONFIG: envConfig,
            XDG_CONFIG_HOME: xdgHome,
          },
        });
        expect(envLoad.configPath).toBe(envConfig);
        expect(envLoad.config.effort.default).toBe("low");
        // The XDG file is not consulted when the env var is set.
        void xdgConfig;
      });
    });
  });

  test("XDG applies when the env var is absent", async () => {
    await withEnv({ MODEL_ROUTER_CONFIG: undefined }, async () => {
      await withTempDir(async (dir) => {
        const xdgHome = join(dir, "xdg");
        const xdgConfigDir = join(xdgHome, "model-router");
        mkdirSync(xdgConfigDir, { recursive: true });
        writeJson(xdgConfigDir, "config.json", { effort: { default: "high" } });
        const loaded = loadConfig({ env: { XDG_CONFIG_HOME: xdgHome } });
        expect(loaded.configPath).toBe(join(xdgHome, "model-router", "config.json"));
        expect(loaded.config.effort.default).toBe("high");
      });
    });
  });

  test("absent XDG path returns defaults with configPath null, no warning", async () => {
    await withEnv({ MODEL_ROUTER_CONFIG: undefined }, async () => {
      await withTempDir(async (dir) => {
        const loaded = loadConfig({ env: { XDG_CONFIG_HOME: join(dir, "empty") } });
        expect(loaded.configPath).toBeNull();
        expect(loaded.config).toEqual(defaultConfig());
      });
    });
  });

  test("an explicit path that does not exist is config-invalid", () => {
    expect(() => loadConfig({ explicitPath: "/nonexistent/path/config.json" })).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    );
  });

  test("a malformed file at the XDG path is config-invalid", async () => {
    await withTempDir(async (dir) => {
      const xdgConfigDir = join(dir, "model-router");
      mkdirSync(xdgConfigDir, { recursive: true });
      await import("node:fs").then((fs) =>
        fs.writeFileSync(join(xdgConfigDir, "config.json"), "{not json"),
      );
      expect(() => loadConfig({ env: { XDG_CONFIG_HOME: dir } })).toThrowError(
        expect.objectContaining({ code: "config-invalid" }),
      );
    });
  });
});

describe("rank accepts a config object or path", () => {
  test("a config object validates the same way as a file", () => {
    const loaded = full();
    const objectAnswer = rank(
      { minimums: { coding: 5 } },
      { registry: loaded, config: { effort: { ceiling: "high", default: "low" } } },
    );
    expectValidAnswer(objectAnswer);
    for (const route of objectAnswer.routes) {
      expect(route.effort).toBe("low");
    }
  });

  test("a config path and an object both lower a ceiling request", async () => {
    const loaded = full();
    const objectAnswer = rank(
      { effort: "max", minimums: { coding: 5 } },
      { registry: loaded, config: { effort: { ceiling: "high", default: "medium" } } },
    );
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "config.json", {
        effort: { ceiling: "high", default: "medium" },
      });
      const pathAnswer = rank(
        { effort: "max", minimums: { coding: 5 } },
        { registry: loaded, config: path },
      );
      expectValidAnswer(pathAnswer);
      expect(pathAnswer.routes.map((route) => route.effort)).toEqual(
        objectAnswer.routes.map((route) => route.effort),
      );
    });
  });

  test("a default above the ceiling in an object is config-invalid", () => {
    const loaded = full();
    expect(() =>
      rank(
        { minimums: { coding: 5 } },
        { registry: loaded, config: { effort: { ceiling: "low", default: "high" } } },
      ),
    ).toThrowError(expect.objectContaining({ code: "config-invalid" }));
  });

  test("an unknown key in an object is config-invalid", () => {
    const loaded = full();
    expect(() =>
      rank({ minimums: { coding: 5 } }, { registry: loaded, config: { mystery: true } }),
    ).toThrowError(expect.objectContaining({ code: "config-invalid" }));
  });

  test("an explicit config path that does not exist is config-invalid", () => {
    const loaded = full();
    expect(() =>
      rank({ minimums: { coding: 5 } }, { registry: loaded, config: "./nope.json" }),
    ).toThrowError(expect.objectContaining({ code: "config-invalid" }));
  });
});
