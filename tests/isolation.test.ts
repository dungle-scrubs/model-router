import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "@dungle-scrubs/model-registry";
import { describe, expect, test } from "vitest";
import { defaultConfig, loadConfig, xdgConfigPath } from "../src/config.js";
import { rank } from "../src/index.js";
import { expectValidAnswer, fixturePath, withEnv } from "./helpers.js";

const FULL = fixturePath("full.json");

// The vitest setup file routes MODEL_ROUTER_CONFIG and XDG_CONFIG_HOME to
// a temp dir. These tests pin the isolation so a future change to the
// setup cannot silently let the operator's home config leak into the suite.

describe("vitest isolation", () => {
  test("the test environment never sees the operator's home config", () => {
    // The operator's real config would surface a non-default default and a
    // non-null configPath. The setup makes sure defaults apply and the
    // resolved path comes from the XDG temp dir, not the home directory.
    const xdg = xdgConfigPath();
    expect(xdg.startsWith(tmpdir())).toBe(true);
    expect(xdg).toContain("model-router-vitest-");
    const loaded = loadConfig();
    expect(loaded.config).toEqual(defaultConfig());
  });

  test("the operator's MODEL_ROUTER_CONFIG cannot leak into a default test", async () => {
    // Set MODEL_ROUTER_CONFIG to a real-looking config the test would
    // notice. With proper setup, the path-order test overrides it.
    let filePath = "";
    await withEnv({ MODEL_ROUTER_CONFIG: undefined }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "model-router-leak-"));
      filePath = join(dir, "leak.json");
      writeFileSync(filePath, '{"effort":{"default":"low"}}');
      // outside the withEnv block, the setup file set MODEL_ROUTER_CONFIG
      // to undefined: the loader falls through to XDG.
      const insideEnv = loadConfig({
        env: { MODEL_ROUTER_CONFIG: filePath, XDG_CONFIG_HOME: dir },
      });
      expect(insideEnv.configPath).toBe(filePath);
      expect(insideEnv.config.effort.default).toBe("low");
    });
    // After withEnv, the test process reverts to the setup's defaults.
    expect(filePath).not.toBe("");
    expect(existsSync(filePath)).toBe(true);
    const afterWithEnv = loadConfig();
    expect(afterWithEnv.configPath).toBeNull();
    expect(afterWithEnv.config.effort.default).toBe(defaultConfig().effort.default);
  });

  test("rank uses the isolated default when no config option is given", () => {
    // A rank call with no config option should land on the default
    // effort. If the setup leaks the operator's home config, this would
    // change to the operator's default.
    const loaded = loadRegistry({ path: FULL });
    const answer = rank({ minimums: { coding: 5 } }, { registry: loaded });
    expectValidAnswer(answer);
    for (const route of answer.routes) {
      expect(route.effort).toBe(defaultConfig().effort.default);
    }
  });
});
