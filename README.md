# model-router

[![CI](https://github.com/dungle-scrubs/model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/dungle-scrubs/model-router/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@dungle-scrubs/model-router.svg)](https://www.npmjs.com/package/@dungle-scrubs/model-router) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

One place for model routing across your agents and applications.

model-router picks the model for each job your agents and applications hand out. You describe the job by its task, its stakes and whether it is private, and model-router ranks the routes in your [model registry](https://github.com/dungle-scrubs/model-registry). A route is one model reached through one harness, such as Claude Code or pi, at one effort level. Routes whose ratings meet the floors you set for that task and stakes come first, cheapest first, so simple work lands on a cheap model and hard work on a strong one. Private work keeps only the routes you marked as safe for it. The routes after the first are fallbacks. Without a router, the usual setup is Claude Code on its default model: one expensive model for every job, switched by hand.

```console
$ model-router '{"task":"explore","stakes":"low"}' | jq -c '.routes[0] | {label, effort}'
{"label":"glm-5.3@pi","effort":"xhigh"}

$ model-router '{"task":"design","stakes":"high"}' | jq -c '.routes[0] | {label, effort}'
{"label":"opus-5.5@claude","effort":"high"}

$ model-router '{"task":"implement","privacy":"secret"}' | jq -c '.routes[0] | {label, effort}'
{"label":"qwen3.8-27b@pi/lmstudio","effort":"medium"}
```

A label reads `model@harness`, plus `/provider` when the harness reaches the model through a named provider. Low-stakes exploration goes to GLM through pi, high-stakes design to Opus through Claude Code, and secret work to a Qwen model running locally in LM Studio. The tasks, ratings and routes come from your registry, so yours will differ. To run a route, hand it to [hcn](https://github.com/dungle-scrubs/harness-cli-normalizer), as described in [How the three packages fit](#how-the-three-packages-fit).

## Install

model-router needs Node 22.14 or newer.

```sh
npm install -g @dungle-scrubs/model-router
```

model-router reads your registry from `~/.config/model-registry/registry.json`. The [model-registry README](https://github.com/dungle-scrubs/model-registry) describes the file and how to write one. The router also needs a `router` section in that file, naming the ratings that order routes:

```json
"router": { "rank": ["coding"] }
```

Then check the registry:

```console
$ model-router check
{"configPath":null,"registryDigest":"sha256:...","registryPath":".../model-registry/registry.json","warnings":[]}
```

`check` exits 0 when the registry, its router section and any `config.json` are valid. Otherwise it prints a JSON error on stderr whose `fix` field says what to change.

## Usage

### Rank routes for a job

```console
$ model-router '{"task":"implement","stakes":"normal"}' | jq -c '.routes[:3][] | {label, effort, floor}'
{"label":"glm-5.3@pi","effort":"xhigh","floor":"clears"}
{"label":"gpt-6.1-sol@pi/openai-codex","effort":"medium","floor":"clears"}
{"label":"mimo-v2.6-pro@pi/opencode-go","effort":"medium","floor":"clears"}
```

A query names a `task` from your registry (`model-router tasks` lists them) or gives its own rating floors in `minimums`. `stakes` is `low`, `normal` or `high` and picks which of the task's floors apply. `floor: "clears"` means the model meets every floor; routes that miss one follow with `floor: "below"`. The answer also lists the routes a hard limit removed, under `removed`, and any `warnings`.

### Keep private work on routes you trust

```console
$ model-router '{"task":"implement","privacy":"secret"}' | jq -c '{routes: [.routes[].label], removed: (.removed | length)}'
{"routes":["qwen3.8-27b@pi/lmstudio","qwen3.6-35b-a3b@pi/lmstudio","qwen3.6-35b-a3b@pi/lmstudio-mini"],"removed":17}
```

`privacy: "secret"` keeps only the routes your registry marks `privacyEligible`, here three local models. If none survive, the answer has no routes and a `local-or-nothing` warning, and model-router exits 3.

### Get a reviewer from another model family

```console
$ model-router '{"task":"code-review","excludeFamilies":["glm"]}' | jq -c '.routes[:2][] | {label, placedBy}'
{"label":"opus-5.5@claude","placedBy":"rank"}
{"label":"gpt-6.1-sol@pi/openai-codex","placedBy":"rank"}
```

When GLM wrote the code, excluding the `glm` family keeps it from reviewing its own work. This registry has a policy that puts `glm-5.3@pi` first for code review. The exclusion removes that route anyway and adds a `policy-route-removed` warning.

### Skip routes that are running out of quota

Point `availability.command` in `~/.config/model-router/config.json` at a script that prints your current quota readings, in the shape of [`availability.schema.json`](availability.schema.json):

```json
{ "availability": { "command": ["node", "/path/to/quota-reading.js"] } }
```

```console
$ model-router '{"task":"implement"}' --availability | jq -c '.routes[:3][] | {label, availability}'
{"label":"glm-5.3@pi","availability":"ok"}
{"label":"gpt-6.1-sol@pi/openai-codex","availability":"ok"}
{"label":"muse-spark-1.3-contributor@pi/meta","availability":"unknown"}
```

A route whose quota is `projected` to run out moves below the healthy routes. `mimo-v2.6-pro@pi/opencode-go`, third in the first example, moved down this way. An `exhausted` route is removed. `--availability-file <path>` reads a saved reading instead of running the command.

### Limit a job to a set of routes

```console
$ MODEL_ROUTER_PROFILE=computer-use model-router '{"task":"computer-use"}' | jq -c '[.routes[].label]'
["gpt-6.1-sol@codex","opus-5.5@claude","sonnet-5.5@claude"]
```

A profile is a named set of routes in your registry, and only its routes are ranked. Choose one with the query's `profile` field or `MODEL_ROUTER_PROFILE`. The `default` profile holds every route unless the registry declares its own.

### Run the top route with hcn

```console
$ model-router '{"task":"code-review","stakes":"normal","privacy":"normal"}' \
    | jq -c '.routes[0] | {harness, modelId, effort}'
{"harness":"pi","modelId":"zai/glm-5.3","effort":"xhigh"}
$ hcn run pi --model zai/glm-5.3 --effort xhigh --access read "review the diff on this branch"
```

Pass a route's harness, `modelId`, `effort` and, when it has one, `provider` to `hcn run`. If the run fails with `retryable: true`, run the next route in `.routes`.

### Rank routes from your application

```ts
import { rank } from "@dungle-scrubs/model-router";

const answer = rank({ task: "research", stakes: "normal" });
for (const route of answer.routes.slice(0, 2)) {
  console.log(route.harness, route.modelId, route.effort, route.placedBy);
}
```

```text
pi zai/glm-5.3 xhigh policy
pi gpt-6.1-sol high rank
```

`rank` is synchronous and finds the registry and `config.json` the same way the CLI does. To name them, pass `{ registry, config }` as the second argument. `registry` also accepts a registry already loaded with model-registry's `loadRegistry`, so several calls share one load.

## Concepts

### How the three packages fit

```text
task ──▶ model-router ──▶ routes, best first ──▶ hcn run <harness> --model <id> --effort <level>
              ▲                                              │
              │                                              └─ retryable failure: next route
       model-registry
```

Together, the three packages route each job to a model and harness automatically, following your preferences. [model-registry](https://github.com/dungle-scrubs/model-registry) defines the registry file: the models you can use, the harnesses that reach them, and ratings for each. model-router reads the registry, takes a task, and returns routes ranked best first. Each route is a harness, a model, and an effort. [hcn](https://github.com/dungle-scrubs/harness-cli-normalizer) runs the route. If the run fails with `retryable: true`, run the next route. [popeye](https://github.com/dungle-scrubs/popeye) is a harness built for hcn to drive, and a registry can list routes through it like any other harness. Each package also works on its own. hcn runs any harness and model you give it, and model-router ranks routes without running anything.

### How routes are ranked

1. Only the selected profile's routes are candidates.
2. Hard limits remove routes: `privacy: "secret"` keeps only privacy-eligible routes, `excludeFamilies` removes those families, and `needs` removes routes that lack a capability. Each removed route lands in `removed` with its reason.
3. A `pin` in the query goes first if it survived. Then come the routes of a matching policy: your own fixed order for a task and stakes, such as "plan on Opus, then GPT".
4. The remaining routes that meet every floor follow, cheapest first. With `prefer: "speed"`, the fastest come first instead. Routes below a floor come last.
5. Each route gets an effort: the policy's, else the query's, else the task's, else `effort.default`. The model's fixed or maximum effort and `effort.ceiling` can lower it, with a warning.
6. With an availability reading, `exhausted` routes are removed and `projected` ones move below the healthy routes.

The same registry, query and reading always give the same answer.

## Reference

### Commands

```text
model-router '<query>' [--registry <path>] [--config <path>] [--availability | --availability-file <path>]
model-router -                                read the query from stdin
model-router --describe <file> '<query>'      fill task and needs from a work description, then rank
model-router tasks [--registry <path>]        list the registry's tasks
model-router check [--registry <path>] [--config <path>]   validate registry, config and profile coverage
```

The answer is one JSON line on stdout, also when no route survives. It carries `contract` (1), `routerVersion`, `registryDigest`, the `query` as applied, `pin`, `routes`, `removed`, `warnings`, `availabilityNote` and `describe`. Each route carries `label`, `model`, `harness`, `modelId`, `provider`, `effort`, `hosted`, `family`, `meter`, `placedBy`, `policy`, `floor`, `availability` and `reasons`. An error is one JSON line on stderr: `{"error":{"code","message","fix","field","problems"}}`.

### Query fields

| Field | Values | Default | Effect |
|---|---|---|---|
| `task` | a task in the registry | none | sets the floors, rank order, needs and effort |
| `minimums` | rating name to number | none | floors that replace the task's, or stand alone without a task |
| `stakes` | `low`, `normal`, `high` | `normal` | picks which of the task's floors apply |
| `privacy` | `normal`, `secret` | `normal` | `secret` keeps only `privacyEligible` routes |
| `excludeFamilies` | list of families | `[]` | removes routes in those model families |
| `needs` | list of capabilities | `[]` | removes routes that lack one; adds to the task's needs |
| `prefer` | `cost`, `speed` | `cost` | orders the routes that meet the floors |
| `effort` | an effort level | the task's, then `effort.default` | the requested level; model limits and `effort.ceiling` can lower it |
| `pin` | a route label | none | puts that route first if it survives the hard limits |
| `spec` | `open`, `settled` | `open` | `settled` lets a policy for settled specs match |
| `profile` | a profile name | `MODEL_ROUTER_PROFILE`, then `default` | ranks only that profile's routes |

A query needs `task` or `minimums`. A field not in this table is `query-invalid`.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | an answer with at least one route, the task list printed, or `check` passed |
| 1 | an internal fault (`internal-error`) |
| 2 | invalid query, flag or subcommand (`query-invalid`), unknown profile (`profile-unknown`), or the describe step refusing secret work (`describe-private`) |
| 3 | an answer with no route; the answer is still printed |
| 4 | the registry, its router section or `config.json` failed to load, or declared-profile coverage failed (`profile-gap-unrecorded`) |
| 5 | the describe step needed a Jev answer and the call failed (`describe-failed`) |

### Config

The registry path is `--registry`, then `MODEL_REGISTRY_FILE`, then `$XDG_CONFIG_HOME/model-registry/registry.json`, then `~/.config/model-registry/registry.json`. `config.json` is `--config`, then `MODEL_ROUTER_CONFIG`, then `$XDG_CONFIG_HOME/model-router/config.json` (`~/.config/model-router/config.json` when `XDG_CONFIG_HOME` is unset). With no config file, every default applies. Every key is optional, and an unknown key is `config-invalid`.

```json
{
  "effort": { "default": "medium", "ceiling": "high" },
  "availability": { "command": ["node", "/path/to/quota-reading.js"], "maxAgeSeconds": 300 }
}
```

| Key | Default | Rule |
|---|---|---|
| `effort.ceiling` | `xhigh` | a ladder level |
| `effort.default` | `medium` | a ladder level, not above `effort.ceiling` |
| `describe.taskGate` | `0.85` | a probability; Jev's task is taken at or above it |
| `describe.capabilityThreshold` | `0.5` | a probability; a capability answer at or above it is added to `needs` |
| `describe.jevModel` | `jev-1.13.0` | a versioned Jev model name |
| `availability.command` | none | an argv array, run with no shell |
| `availability.timeoutSeconds` | `10` | a positive number |
| `availability.maxAgeSeconds` | `300` | how old a reading may be, from the command or a file |

The package ships JSON schemas for each document it reads or writes: `query.schema.json`, `answer.schema.json`, `availability.schema.json`, `error.schema.json`, `config.schema.json` and `router-sections.schema.json`.

### Security

- Ranking reads only local files. The CLI runs `availability.command` only when you pass `--availability`, as an argv array with no shell, and stops it after `availability.timeoutSeconds`.
- `--describe` sends the work description to the hosted Jev API at `api.typesafe.ai`, using the key in `TYPESAFE_API_KEY`. The query must state `privacy`, and `privacy: "secret"` is refused before any request leaves the machine (`describe-private`).
- `config.json` holds no key and no registry path.

[docs/reference.md](docs/reference.md) holds the full contract: every query rule, each ranking step, the describe step and Jev client, every warning, reason and error code, and the library API.

## Contributing

```sh
pnpm install --frozen-lockfile
pnpm hooks:install     # lefthook: Biome and tsc on commit
pnpm verify            # lint, typecheck, build, tests
pnpm test:mutation     # Stryker; fails below a 75% mutation score
```

Tests use placeholder registries in `tests/fixtures/`, with model keys like `model-a`, harnesses like `harness-x` and tasks like `task-a`. CI installs model-registry from npm. Commits follow [Conventional Commits](https://www.conventionalcommits.org/), which release-please reads to cut releases.

## Status

model-router is before 1.0. The answer format is contract version 1, and each answer records it in `contract`. If you already have a routing setup, you probably don't need this. model-router picks a model and fallbacks for a job; running the job is hcn's part. The describe step depends on the hosted Jev API and has no local fallback, so secret work must state its own `task` or `minimums`.

## License

MIT
