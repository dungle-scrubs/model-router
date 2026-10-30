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
  // The library entries build together so they share one copy of each
  // module: an error thrown from ./t3 is the same RouterError class the
  // package entry exports.
  build({
    ...common,
    entryPoints: [join(rootDir, "src/index.ts"), join(rootDir, "src/t3.ts")],
    outdir: join(rootDir, "dist"),
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
  }),
  build({
    ...common,
    entryPoints: [join(rootDir, "src/cli.ts")],
    outfile: join(rootDir, "dist/cli.js"),
  }),
  build({
    ...common,
    entryPoints: [join(rootDir, "src/t3-cli.ts")],
    outfile: join(rootDir, "dist/t3-cli.js"),
  }),
]);

chmodSync(join(rootDir, "dist/cli.js"), 0o755);
chmodSync(join(rootDir, "dist/t3-cli.js"), 0o755);
