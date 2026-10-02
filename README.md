# model-router

Rank model routes for a structured query against the shared model registry.

A route is one model reached through one harness. The caller states what the work needs; the router orders the registry's routes into one ranked list, contract version 1. This package is the router half of the design in the model-registry RFC; the loader and validator half is [`@dungle-scrubs/model-registry`](https://github.com/dungle-scrubs/model-registry). Development release: the package is private and unpublished.

This release implements issue #28: tasks and policies. Inline `minimums`, pins, effort levels, `config.json`, availability and the describe step arrive in later issues.

## CLI

```console
$ model-router '{"task":"task-a","stakes":"normal"}' --registry registry.json
{"availabilityNote":null,"contract":1,...,"routes":[...]}

$ model-router tasks --registry registry.json
[{"name":"task-a","description":"..."}]
```

The query is the positional JSON argument, or `-` to read it from stdin. `--registry <path>` names the registry file; without it the loader's path order applies (`MODEL_REGISTRY_FILE`, then `$XDG_CONFIG_HOME/model-registry/registry.json`, then `~/.config/model-registry/registry.json`).

A first argument that starts with `{` or `-` is the ranking call. Any other word is `tasks`. An unknown word is `query-invalid`; the `fix` says to run `model-router tasks` or `model-router '<query>'`. The `check` subcommand arrives in a later release.

The answer is one JSON line on stdout, also when no route survives. `model-router tasks` prints one JSON line: the task list, or `[]` when the registry has none. Errors print as one JSON line on stderr: `{"error":{"code":"...","message":"...","fix":"...","field":"...","problems":[]}}`. A loader error keeps model-registry's own envelope, with `path` instead of `field`.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | an answer with at least one route, or the task list printed |
| 2 | invalid query, flag or subcommand (`query-invalid`) |
| 3 | an answer with no route; the answer is still printed |
| 4 | the registry cannot be loaded, or its router section is invalid |
| 1 | an internal fault (`internal-error`) |

## The query

| Field | Type | Default | Notes |
|---|---|---|---|
| `task` | string | none | a name declared in `registry.tasks`; a task the registry does not declare warns `task-unranked` and ranks by `router.rank` |
| `minimums` | rating name to number | none | inline floors that replace per rating at the query's stakes; `minimums: {}` states no floor explicitly |
| `needs` | list of strings | `[]` | adds to the task's needs when a task is named |
| `effort` | string | none | parses; this release does not resolve effort levels. Without a task it warns `effort-unapplied`; with a task the query's effort replaces the task's level when effort resolution ships |
| `pin` | route label | none | parses; this release warns `pin-unapplied` |
| `stakes` | `low`, `normal`, `high` | `normal` | selects the task's floor set; no effect on an inline-only need |
| `prefer` | `cost`, `speed` | `cost` | how clearing routes are ordered |
| `privacy` | `normal`, `secret` | `normal` | `secret` keeps only `privacyEligible` routes |
| `excludeFamilies` | list of strings | `[]` | families removed as a hard limit |
| `spec` | `open`, `settled` | `open` | `settled` matches a policy whose `spec` is `settled` (or unset); an unset policy `spec` matches any query, and a policy's `spec` accepts only `settled`. A query that states `spec` and matches no policy warns `policy-none`; a query without `spec` stays silent |

A query must carry `task` or `minimums` (a `pin` alone is invalid), and input is strict: a field the contract does not define is `query-invalid`. A check against registry content is a warning, never a failure: a minimum naming an undeclared rating makes every route count as below that floor, a need naming an undeclared capability removes every route lacking it, and an unknown family excludes nothing.

### Resolving the task

A named task whose name is in `registry.tasks` resolves the query against the task's floors at the query's stakes, its `rank` and its `needs`. Inline fields apply over them:

- `minimums` replaces the task's floor for each rating it names, at the query's stakes.
- `needs` adds to the task's needs.
- `effort` is parsed and echoed on the applied query; this release resolves no effort levels, so neither the task's level nor the query's reaches a route.

The order list is the task's `rank`. A misspelled task in the registry falls through to `router.rank` and adds the `task-unranked` warning.

### Resolving the policy

At most one policy applies to a query. A policy is a candidate when its `task` is the query's task, its `stakes` include the query's, and its `spec` condition holds: a policy without `spec` applies whatever the query's `spec` is, and a policy with `spec: "settled"` applies only to a `spec: "settled"` query. A policy's `spec` accepts only `settled`. When a specless policy and a settled policy are both candidates for a settled query, the settled one wins. Two policies that could match the same query at the same level - the same task, an overlapping stakes level, the same spec condition (both specless, or both settled) - make the file invalid (`policy-tie`).

The policy's routes follow the rank in written order, with `placedBy: "policy"` and `floor: "skipped"`. No route appears twice. A policy route that a hard limit removed stays in `removed` with its hard-limit reason, and a `policy-route-removed` warning names the policy.

## The ranking

1. Load the registry and validate the router sections: `router`, `tasks`, `policy`. `router.rank` is required, `tasks` and `policy` are optional. Any problem is `registry-sections-invalid`.
2. Validate the query.
3. Resolve the task. Apply inline `minimums` over the task's floor at the query's stakes. Apply inline `needs` over the task's needs. Inline `effort` replaces the task's level.
4. Apply the hard limits in order: `privacy: secret` (routes without `privacyEligible: true`), `excludeFamilies`, `needs`. A removed route lands in `removed` with one reason.
5. Place the policy routes. A route that a hard limit removed stays in `removed` with its hard-limit reason, and a `policy-route-removed` warning names the policy. No route appears twice.
6. Apply the floors: a route whose model meets every floor in `minimums` clears; everything else is below. A model with no value for a floor's rating counts as below.
7. Sort. Clearing routes order by cost (higher rating, so cheaper, first), then the rank in force (the task's `rank` or `router.rank` when no task resolves), then the model's route order, then file order; with `prefer: speed`, response time comes first. Routes below a floor order by the rank in force, then cost, then route order, then file order. `minimums: {}` states no floor explicitly: every route clears and orders by that clearing order. A query naming a task the registry does not declare, with no floor, orders every route most capable first, never cheapest first; with `minimums` floors, it uses the orders above. A missing value sorts below every route that has it.
8. Build the answer: `contract`, `routerVersion`, `registryDigest`, the query as applied, `pin: null`, the ordered `routes`, `removed`, `warnings`, `availabilityNote: null`, `describe: null`.

Each answer route carries `label`, `model`, `harness`, `modelId`, `provider` (when set), `hosted`, `family`, `meter` (when set), `placedBy` (`"pin"`, `"policy"` or `"rank"`), `policy` (the policy's name, only when `placedBy` is `"policy"`), `floor` (`"clears"`, `"below"` or `"skipped"`), `availability` (`unknown` for metered routes, `unmetered` otherwise, because this release reads no availability document) and `reasons`. Routes below a floor carry one `floor-not-met` reason per failed floor.

The same registry and the same query always give the same answer.

## Codes this package chose

The RFC names the error codes; these warning and reason codes are this package's choice:

| Code | Where | Meaning |
|---|---|---|
| `task-unranked` | warnings | the query names a task the registry's tasks section does not declare; ranking falls through to `router.rank` |
| `rating-unknown` | warnings | a minimum names a rating the registry does not declare |
| `capability-unknown` | warnings | a need names a capability the registry does not declare |
| `family-unknown` | warnings | an excluded family is not in the registry |
| `effort-unapplied` | warnings | the query names an effort without a task; this release does not resolve effort levels |
| `pin-unapplied` | warnings | the query names a pin this release does not place |
| `policy-none` | warnings | the query stated a `spec` (`open` or `settled`) and no policy matched |
| `local-or-nothing` | warnings | `privacy: secret` removed every route; the work runs locally or not at all |
| `policy-route-removed` | warnings | a hard limit removed a route the matching policy names; the warning names the policy and the route |
| `privacy-secret-not-eligible` | removed reasons | the route is not `privacyEligible` under `privacy: secret` |
| `family-excluded-by-query` | removed reasons | the route's family is in `excludeFamilies` |
| `needs-not-satisfied` | removed reasons | the route lacks a needed capability |
| `floor-not-met` | route reasons | the model's rating is below a floor, or absent |

## Registry-section problem codes

A `registry-sections-invalid` error carries one problem per finding in `problems[]`. These are the codes this package emits:

| Code | Cause |
|---|---|
| `router-section-missing` | the registry file has no `router` section, which model-router requires |
| `router-section-not-object` | the `router` section is not a JSON object |
| `router-rank-missing` | the `router` section has no `rank` list |
| `router-rank-invalid` | `router.rank` is not a non-empty array |
| `router-rank-entry-not-string` | a `router.rank` entry is not a string |
| `router-rank-unknown` | a `router.rank` entry names a rating the registry does not declare |
| `router-questions-not-object` | `router.questions` is not a JSON object |
| `router-question-capability-unknown` | a `router.questions` key names a capability the registry does not declare |
| `router-question-not-string` | a `router.questions` value is not a string |
| `router-field-unknown` | the `router` section carries a field other than `rank` and `questions` |
| `tasks-section-not-object` | the `tasks` section is not a JSON object |
| `tasks-entry-not-object` | a `tasks` entry is not a JSON object |
| `tasks-description-missing` | a `tasks` entry has no `description` |
| `tasks-description-not-string` | a `tasks` entry's `description` is not a string |
| `tasks-minimums-missing` | a `tasks` entry has no `minimums` |
| `tasks-minimums-not-object` | a `tasks` entry's `minimums` is not an object |
| `tasks-minimums-stake-missing` | a `tasks` entry's `minimums` is missing a stakes level |
| `tasks-minimums-stake-not-object` | a `tasks` entry's `minimums.<stakes>` is not an object |
| `tasks-minimums-stake-unknown` | a `tasks` entry's `minimums` carries a stakes key other than low, normal and high |
| `tasks-minimums-rating-unknown` | a `tasks` entry's `minimums.<stakes>` names a rating the registry does not declare |
| `tasks-minimums-rating-not-number` | a `tasks` entry's `minimums.<stakes>` floor is not a finite number |
| `tasks-rank-missing` | a `tasks` entry has no `rank` |
| `tasks-rank-invalid` | a `tasks` entry's `rank` is not a non-empty array |
| `tasks-rank-entry-not-string` | a `tasks` entry's `rank` entry is not a string |
| `tasks-rank-rating-unknown` | a `tasks` entry's `rank` names a rating the registry does not declare |
| `tasks-needs-not-array` | a `tasks` entry's `needs` is not an array |
| `tasks-needs-entry-not-string` | a `tasks` entry's `needs` entry is not a string |
| `tasks-needs-capability-unknown` | a `tasks` entry's `needs` names a capability the registry does not declare |
| `tasks-effort-invalid` | a `tasks` entry's `effort` is not on the ladder |
| `tasks-field-unknown` | a `tasks` entry carries a field other than the task fields |
| `policy-section-not-object` | the `policy` section is not a JSON object |
| `policy-entry-not-object` | a `policy` entry is not a JSON object |
| `policy-task-missing` | a `policy` entry has no `task` |
| `policy-task-unknown` | a `policy` entry's `task` is not declared in the `tasks` section |
| `policy-stakes-missing` | a `policy` entry has no `stakes` |
| `policy-stakes-invalid` | a `policy` entry's `stakes` is not a non-empty array |
| `policy-stakes-entry-invalid` | a `policy` entry's `stakes` entry is not low, normal or high |
| `policy-routes-missing` | a `policy` entry has no `routes` |
| `policy-routes-invalid` | a `policy` entry's `routes` is not a non-empty array |
| `policy-route-not-object` | a `policy` route is not a JSON object |
| `policy-route-label-missing` | a `policy` route has no `route` label |
| `policy-route-label-unknown` | a `policy` route names a label the registry does not declare |
| `policy-route-effort-not-string` | a `policy` route's `effort` is not a string |
| `policy-route-effort-invalid` | a `policy` route's `effort` is not on the ladder |
| `policy-route-effort-fixed-mismatch` | a `policy` route's `effort` differs from the model's `fixedEffort` |
| `policy-route-effort-above-max` | a `policy` route's `effort` is above the model's `maxEffort` |
| `policy-route-field-unknown` | a `policy` route carries a field other than `route` and `effort` |
| `policy-reason-missing` | a `policy` entry has no `reason` |
| `policy-reason-not-string` | a `policy` entry's `reason` is not a string |
| `policy-spec-invalid` | a `policy` entry's `spec` is not `settled` |
| `policy-since-not-string` | a `policy` entry's `since` is not a string |
| `policy-field-unknown` | a `policy` entry carries a field other than the policy fields |
| `policy-tie` | two policy entries match the same query at the same level |

## Library

```ts
import { listTasks, rank, RouterError } from "@dungle-scrubs/model-router";

const answer = rank({ task: "task-a", stakes: "normal" }, { registry: "registry.json" });
answer.routes[0]?.label;       // "model-c@harness-x"
answer.routes[0]?.placedBy;    // "policy"
answer.routes[0]?.policy;      // "policy-a"
answer.routes[0]?.floor;       // "skipped"
answer.registryDigest;         // "sha256:<hex>"

const tasks = listTasks({ registry: "registry.json" });
// [{ name, description }, ...] in file order, or []

// A path, or a LoadedRegistry from model-registry's loadRegistry, so several
// calls share one load and one digest:
const loaded = loadRegistry({ path: "registry.json" });
rank({ task: "task-a", stakes: "normal" }, { registry: loaded });
listTasks({ registry: loaded });
```

`rank` and `listTasks` are synchronous and pure over their inputs. They throw `RouterError` (`query-invalid`, exit 2; `registry-sections-invalid`, exit 4) and rethrow model-registry's `RegistryError` unchanged. The loader and the label builder are not re-exported; import them from `@dungle-scrubs/model-registry`. The package ships `query.schema.json` and `answer.schema.json`: the query schema rejects undefined fields, the answer schema allows them.

## Development

```console
$ pnpm install --frozen-lockfile
$ pnpm verify          # lint, typecheck, build, tests
$ pnpm test:mutation   # mutation score, break at 75
```

Tests use placeholder registries only (`tests/fixtures/`): model keys like `model-a`, harnesses like `harness-x`, families like `family-a`, tasks like `task-a`. CI installs the private `model-registry` git dependency over SSH with a read-only deploy key held in the `MODEL_REGISTRY_DEPLOY_KEY` secret.