# model-router

Rank model routes for a structured query against the shared model registry.

A route is one model reached through one harness. The caller states what the work needs; the router orders the registry's routes into one ranked list, contract version 1. This package is the router half of the design in the model-registry RFC; the loader and validator half is [`@dungle-scrubs/model-registry`](https://github.com/dungle-scrubs/model-registry). Development release: the package is private and unpublished.

This release implements issue #27 only: queries with inline `minimums`. Task names, policies, pins, effort levels, `config.json`, availability, `describe` and the `tasks` and `check` subcommands arrive in later issues.

## CLI

```console
$ model-router '{"minimums":{"coding":5}}' --registry registry.json
{"availabilityNote":null,"contract":1,...,"routes":[...]}
```

The query is the positional JSON argument, or `-` to read it from stdin. `--registry <path>` names the registry file; without it the loader's path order applies (`MODEL_REGISTRY_FILE`, then `$XDG_CONFIG_HOME/model-registry/registry.json`, then `~/.config/model-registry/registry.json`).

A first argument that starts with `{` or `-` is the ranking call. Any other word is an error in this release: the `tasks` and `check` subcommands arrive later.

The answer is one JSON line on stdout, also when no route survives. Errors print as one JSON line on stderr: `{"error":{"code":"...","message":"...","fix":"...","field":"...","problems":[]}}`. A loader error keeps model-registry's own envelope, with `path` instead of `field`.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | an answer with at least one route |
| 2 | invalid query, flag or subcommand (`query-invalid`) |
| 3 | an answer with no route; the answer is still printed |
| 4 | the registry cannot be loaded, or its router section is invalid |
| 1 | an internal fault (`internal-error`) |

## The query

| Field | Type | Default | Notes |
|---|---|---|---|
| `task` | string | none | parses; this release does not rank by task (warning `task-unranked`) |
| `minimums` | rating name to number | none | inline floors; `minimums: {}` states no floor explicitly |
| `needs` | list of strings | `[]` | capabilities every route must list |
| `effort` | string | none | parses; this release applies no effort level (warning `effort-unapplied`) |
| `pin` | route label | none | parses; this release places no pins (warning `pin-unapplied`) |
| `stakes` | `low`, `normal`, `high` | `normal` | selects a task's floor set; no effect while tasks are unranked |
| `prefer` | `cost`, `speed` | `cost` | how clearing routes are ordered |
| `privacy` | `normal`, `secret` | `normal` | `secret` keeps only `privacyEligible` routes |
| `excludeFamilies` | list of strings | `[]` | families removed as a hard limit |
| `spec` | `open`, `settled` | `open` | `settled` with no policy to match warns `policy-none` |

A query must carry `task` or `minimums` (a `pin` alone is invalid), and input is strict: a field the contract does not define is `query-invalid`. A check against registry content is a warning, never a failure: a minimum naming an undeclared rating makes every route count as below that floor, a need naming an undeclared capability removes every route lacking it, and an unknown family excludes nothing.

## The ranking

1. Load the registry and validate the `router` section. `router.rank` is a required, non-empty list of declared rating names; `router.questions` is an optional map of declared capabilities to question sentences. The section is closed. Any problem is `registry-sections-invalid`.
2. Validate the query.
3. Apply the hard limits in order: `privacy: secret` (routes without `privacyEligible: true`), `excludeFamilies`, `needs`. A removed route lands in `removed` with one reason.
4. Apply the floors: a route whose model meets every floor in `minimums` clears; everything else is below. A model with no value for a floor's rating counts as below.
5. Sort. Clearing routes order by cost (higher rating, so cheaper, first), then the `router.rank` ratings in turn, then the model's route order, then file order; with `prefer: speed`, response time comes first. Routes below a floor order by the `router.rank` ratings, then cost, then route order, then file order. `minimums: {}` states no floor explicitly: every route clears and orders by that clearing order. A query naming a task this release does not rank orders every route most capable first, never cheapest first. A missing value sorts below every route that has it.
6. Build the answer: `contract`, `routerVersion`, `registryDigest`, the query as applied, `pin: null`, the ordered `routes`, `removed`, `warnings`, `availabilityNote: null`, `describe: null`.

Each answer route carries `label`, `model`, `harness`, `modelId`, `provider` (when set), `hosted`, `family`, `meter` (when set), `placedBy: "rank"`, `floor`, `availability` (`unknown` for metered routes, `unmetered` otherwise, because this release reads no availability document) and `reasons`. Routes below a floor carry one `floor-not-met` reason per failed floor.

The same registry and the same query always give the same answer.

## Codes this package chose

The RFC names the error codes; these warning and reason codes are this package's choice:

| Code | Where | Meaning |
|---|---|---|
| `task-unranked` | warnings | the query names a task this release does not rank |
| `rating-unknown` | warnings | a minimum names a rating the registry does not declare |
| `capability-unknown` | warnings | a need names a capability the registry does not declare |
| `family-unknown` | warnings | an excluded family is not in the registry |
| `effort-unapplied` | warnings | the query names an effort level this release does not apply |
| `pin-unapplied` | warnings | the query names a pin this release does not place |
| `policy-none` | warnings | `spec: settled` found no matching policy |
| `local-or-nothing` | warnings | `privacy: secret` removed every route; the work runs locally or not at all |
| `privacy-secret-not-eligible` | removed reasons | the route is not `privacyEligible` under `privacy: secret` |
| `family-excluded-by-query` | removed reasons | the route's family is in `excludeFamilies` |
| `needs-not-satisfied` | removed reasons | the route lacks a needed capability |
| `floor-not-met` | route reasons | the model's rating is below a floor, or absent |

## Library

```ts
import { rank, RouterError } from "@dungle-scrubs/model-router";

const answer = rank({ minimums: { coding: 5 } }, { registry: "registry.json" });
answer.routes[0].label; // "model-a@harness-x"
answer.registryDigest; // "sha256:<hex>"

// A path, or a LoadedRegistry from model-registry's loadRegistry, so several
// calls share one load and one digest:
const loaded = loadRegistry({ path: "registry.json" });
rank({ minimums: {} }, { registry: loaded });
```

`rank` is synchronous and pure over its inputs. It throws `RouterError` (`query-invalid`, exit 2; `registry-sections-invalid`, exit 4) and rethrows model-registry's `RegistryError` unchanged. The loader and the label builder are not re-exported; import them from `@dungle-scrubs/model-registry`. The package ships `query.schema.json` and `answer.schema.json`: the query schema rejects undefined fields, the answer schema allows them.

## Development

```console
$ pnpm install --frozen-lockfile
$ pnpm verify          # lint, typecheck, build, tests
$ pnpm test:mutation   # mutation score, break at 75
```

Tests use placeholder registries only (`tests/fixtures/`): model keys like `model-a`, harnesses like `harness-x`, families like `family-a`. CI installs the private `model-registry` git dependency with the `MODEL_REGISTRY_READ_TOKEN` secret.
