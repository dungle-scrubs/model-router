// Copy this script into the bf93b1f checkout, install its frozen lockfile,
// build that router, then run this script there. Never refresh with new code.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "@dungle-scrubs/model-registry";
import { defaultConfig, dropExpired, rank } from "../dist/index.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "tests", "fixtures");
const cases = [];
const sourceFixtures = ["availability-print.js", "availability-expired-print.js"].map((name) => {
  const result = spawnSync(process.execPath, [join(fixtures, name)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not run fixture ${name}.`);
  const document = JSON.parse(result.stdout);
  return { name, entries: dropExpired(document.entries, new Date(document.generatedAt)) };
});
for (const fixture of readdirSync(fixtures)
  .filter((name) => name.endsWith(".json") && name !== "pre-profile-goldens.json")
  .sort()) {
  const registry = join(fixtures, fixture);
  let raw;
  try {
    raw = JSON.parse(readFileSync(registry, "utf8"));
  } catch {
    raw = {};
  }
  if (raw.profiles !== undefined) throw new Error("Capture only pre-profile fixtures.");
  const queries = [
    { minimums: {} },
    { task: "task-a" },
    { task: "task-a", stakes: "high", minimums: { coding: 8 } },
    { minimums: { coding: 8, taste: 5 }, prefer: "speed" },
    { minimums: {}, privacy: "secret" },
    { minimums: {}, excludeFamilies: ["family-a"], needs: ["browser"] },
    { task: "task-a", spec: "open" },
    { task: "task-a", spec: "settled", effort: "max" },
    { minimums: {}, pin: "model-missing@harness-x" },
    ...Object.keys(raw.tasks ?? {}).map((task) => ({ task })),
  ];
  let labels = [];
  try {
    labels = Object.keys(loadRegistry({ path: registry }).routes);
  } catch {}
  queries.push(...labels.map((pin) => ({ minimums: {}, pin })));
  const meters = Object.keys(raw.meters ?? {});
  const inputs = queries.map((query) => ({ query }));
  for (const status of ["ok", "projected", "exhausted"]) {
    inputs.push({
      query: { minimums: {}, pin: labels[0] ?? "model-missing@harness-x" },
      availability: meters.map((meter) => ({ meter, status })),
    });
  }
  inputs.push({ query: { task: "task-a" }, availability: [] });
  if (fixture === "full.json") {
    inputs.push(
      ...sourceFixtures.map(({ name, entries }) => ({
        query: { minimums: {} },
        availability: entries,
        sourceFixture: name,
      })),
    );
  }
  for (const input of inputs) {
    let answer;
    try {
      answer = rank(input.query, {
        registry,
        config: defaultConfig(),
        ...(input.availability === undefined ? {} : { availability: input.availability }),
      });
    } catch (error) {
      const envelope = error.toJSON();
      delete envelope.path;
      envelope.message = envelope.message.replaceAll(registry, "<registry>");
      cases.push({ fixture, ...input, error: envelope });
      continue;
    }
    if (answer.query.profile !== undefined) throw new Error("Use the pre-profile router.");
    cases.push({ fixture, ...input, answer });
  }
}
writeFileSync(
  join(fixtures, "pre-profile-goldens.json"),
  `${JSON.stringify({ baseline: "bf93b1f", routerVersion: "0.1.0", cases }, null, 2)}\n`,
);
console.log(`Captured ${cases.length} cases from the pre-profile router.`);
