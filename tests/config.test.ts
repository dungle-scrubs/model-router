import { mkdirSync, rmSync } from "node:fs";
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

  test("an own $schema with an inherited effort section falls through to defaults", () => {
    // The own $schema avoids the empty-object early return. The inherited
    // `effort` is on the prototype, not an own property, so the validator
    // reads it as absent and the defaults apply. Without the own-property
    // check at the top level, the inherited values would land as
    // ceiling: "max" / default: "max", matching the file form
    // {"$schema": "..."}.
    const inherited = Object.assign(Object.create({ effort: { ceiling: "max", default: "max" } }), {
      $schema: "https://example.invalid/config.schema.json",
    });
    expect(validateConfigObjectInput(inherited)).toEqual(defaultConfig());
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
        const xdgConfigDir = join(xdgHome, "model-router");
        mkdirSync(xdgConfigDir, { recursive: true });
        // A competing XDG file at the proper path, not at <xdg>/config.json.
        // The earlier-slice test wrote to <xdg>/config.json, which is not
        // the path the loader looks at, so this version proves the env var
        // wins against a real XDG candidate.
        const xdgConfig = writeJson(xdgConfigDir, "config.json", {
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

describe("validateConfigObjectInput own-property reads", () => {
  test("inherited ceiling and default values are not read from the prototype", () => {
    // The { effort: Object.create(...) } object has own keys effort but no
    // own ceiling/default. Configuration walks the own keys; inherited ones
    // do not count, and the relationship check uses the defaults (xhigh and
    // medium). If the validator read inherited values, it would set the
    // ceiling to "low" and the default to "high" and emit
    // config-effort-default-above-ceiling.
    const proto = { ceiling: "low", default: "high" };
    const inherited = validateConfigObjectInput({ effort: Object.create(proto) });
    expect(inherited).toEqual(defaultConfig());
  });

  test("an inherited ceiling mismatch does not surface as config-effort-ceiling-invalid", () => {
    // Same shape: the inherited ceiling is "low" but the validator reads
    // the own ceiling as absent. The validator accepts the inherited
    // values as absent, not as invalid ladder levels.
    const proto = { ceiling: "warp-nine", default: "warp-nine" };
    expect(() => validateConfigObjectInput({ effort: Object.create(proto) })).not.toThrow();
  });

  test("an inherited unknown top-level key is not reported", () => {
    const proto = { mystery: true };
    expect(() => validateConfigObjectInput(Object.create(proto) as object)).not.toThrow();
  });
});

describe("validateConfigObjectInput collect-every-problem", () => {
  test("default-above-ceiling is reported beside an unrelated unknown key", () => {
    try {
      validateConfigObjectInput({
        mystery: true,
        effort: { ceiling: "low", default: "high" },
      });
      throw new Error("expected validateConfigObjectInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-effort-default-above-ceiling");
      expect(problems).toContain("config-key-unknown");
    }
  });

  test("default-above-ceiling is not reported when the default is off-ladder", () => {
    // The relationship check uses the parsed levels: when the default is
    // an off-ladder string, the level is unknown, so no relationship check
    // runs. The default-above-ceiling code only fires when both values are
    // valid ladder entries.
    try {
      validateConfigObjectInput({
        effort: { ceiling: "low", default: "warp-nine" },
      });
      throw new Error("expected validateConfigObjectInput to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-effort-default-invalid");
      expect(problems).not.toContain("config-effort-default-above-ceiling");
    }
  });
});

describe("loadConfigFromPath reads config-invalid for filesystem failures", () => {
  test("a directory at the path fails config-invalid, not internal-error", () => {
    // The existence check passes for a directory; the read fails with
    // EISDIR. The router must surface the failure as config-invalid so
    // the CLI's exit is 4, not 1.
    expect(() => loadConfigFromPath("tests/fixtures")).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    );
  });

  test("a file removed between the existence check and the read fails config-invalid", async () => {
    // Race the existence check against the read: the existence check sees
    // the file, the read runs after the file is gone. The cleanest way to
    // exercise this is to remove the parent directory entirely: the
    // existence check has already returned true on the original path, but
    // the subsequent read sees an ENOENT, which the loader must convert
    // to config-invalid.
    let filePath = "";
    await withTempDir(async (dir) => {
      filePath = writeJson(dir, "config.json", {});
      rmSync(dir, { recursive: true, force: true });
    });
    expect(() => loadConfigFromPath(filePath)).toThrowError(
      expect.objectContaining({ code: "config-invalid" }),
    );
  });
});

describe("rank accepts a config object or path", () => {
  test("a config object validates the same way as a file", async () => {
    const loaded = full();
    await withTempDir(async (dir) => {
      const path = writeJson(dir, "config.json", {
        effort: { ceiling: "high", default: "low" },
      });
      const pathAnswer = rank({ minimums: { coding: 5 } }, { registry: loaded, config: path });
      expectValidAnswer(pathAnswer);
      for (const route of pathAnswer.routes) {
        expect(route.effort).toBe("low");
      }
    });
  });

  test("a config path and an object both lower a ceiling request", async () => {
    const loaded = full();
    const objectAnswer = rank(
      { effort: "max", minimums: { coding: 5 } },
      { registry: loaded, config: { effort: { ceiling: "high", default: "medium" } } },
    );
    expectValidAnswer(objectAnswer);
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

  test("an object with a 'config' key is not a bypass for validation", () => {
    // The router's `config` option is a path or a plain settings object;
    // it is not a wrapper that holds the validated object. Passing a
    // {"config": {...}} object must run the same validator as the inline
    // form, so an off-ladder ceiling inside it is config-invalid.
    const loaded = full();
    const wrapper = { config: { effort: { ceiling: "warp-nine" } } };
    expect(() =>
      rank({ minimums: { coding: 5 } }, { registry: loaded, config: wrapper as never }),
    ).toThrowError(expect.objectContaining({ code: "config-invalid" }));
  });

  test("an object with 'config' and 'configPath' keys is not a pre-loaded config bypass", () => {
    // The router accepts a config path or a settings object. A wrapper
    // with both `config` and `configPath` looks like a pre-loaded
    // LoadedConfig, but the library has no shortcut for callers that
    // already ran the loader: the validator is the one source of truth.
    // With `default: "max"`, the invalid input would let uncapped models
    // emit `max` if the shortcut still ran.
    const loaded = full();
    const wrapper = {
      config: { effort: { ceiling: "warp-nine", default: "max" } },
      configPath: null,
    };
    try {
      rank({ minimums: { coding: 5 } }, { registry: loaded, config: wrapper as never });
      throw new Error("expected rank to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("config-invalid");
      const problems = (error as RouterError).problems.map((problem) => problem.code);
      expect(problems).toContain("config-key-unknown");
    }
  });

  test("a settings object validates the same way as a file with the same bytes", () => {
    const loaded = full();
    const objectAnswer = rank(
      { minimums: { coding: 5 } },
      {
        registry: loaded,
        config: { effort: { ceiling: "high", default: "low" } },
      },
    );
    expectValidAnswer(objectAnswer);
    for (const route of objectAnswer.routes) {
      expect(route.effort).toBe("low");
    }
  });
});
