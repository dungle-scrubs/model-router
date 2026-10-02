import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    "process.env.MODEL_ROUTER_VERSION": JSON.stringify(pkg.version),
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
