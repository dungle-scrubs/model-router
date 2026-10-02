import { chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies ?? {});

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  logLevel: "info",
  define: {
    "process.env.MODEL_ROUTER_VERSION": JSON.stringify(pkg.version),
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [join(rootDir, "src/index.ts")],
    outfile: join(rootDir, "dist/index.js"),
  }),
  build({
    ...common,
    entryPoints: [join(rootDir, "src/cli.ts")],
    outfile: join(rootDir, "dist/cli.js"),
  }),
]);

chmodSync(join(rootDir, "dist/cli.js"), 0o755);
