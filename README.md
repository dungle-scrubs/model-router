# model-router

Rank model routes for a structured query against the shared model registry.

A route is one model reached through one harness. The caller states what the work needs; the router orders the registry's routes into one ranked list, contract version 1. This package is the router half of the design in the model-registry RFC; the loader and validator half is [`@dungle-scrubs/model-registry`](https://github.com/dungle-scrubs/model-registry). Development release: 0.1.0.

This package implements pins, effort resolution, `config.json`, the `check` subcommand, meter availability, the describe step, the Jev client, profile selection, profile coverage checking, and accepted-gap warnings.

## CLI

```console
$ model-router '{"task":"task-a","stakes":"normal"}' --registry registry.json
{"availabilityNote":null,"contract":1,...,"routes":[...]}

$ model-router '{"task":"task-a","stakes":"normal"}' --registry registry.json --availability-file reading.json
{"availabilityNote":null,"contract":1,...,"routes":[...]}

$ model-router tasks --registry registry.json
[{"name":"task-a","description":"..."}]

$ model-router check --registry registry.json
{"configPath":null,"registryDigest":"sha256:...","registryPath":"...","warnings":[]}

$ model-router --describe work.txt --registry registry.json '{"privacy":"normal"}'
{"availabilityNote":null,"contract":1,"describe":{...},"query":{"task":"task-a",...},"routes":[...]}
```

The query is the positional JSON argument, or `-` to read it from stdin. `--registry <path>` names the registry file; without it the loader's path order applies (`MODEL_REGISTRY_FILE`, then `$XDG_CONFIG_HOME/model-registry/registry.json`, then `~/.config/model-registry/registry.json`).

`--availability` runs `availability.command` from `config.json`. `--availability-file <path>` reads a saved document from `<path>`. Both check `generatedAt` against `maxAgeSeconds` and apply `dropExpired`; both together is exit 2. Without either, no availability is read and `availabilityNote` is `null`. `--availability` with no configured command ranks without availability at exit 0 and fills `availabilityNote` with `availability-command-missing`.

A first argument that starts with `{` or `-` is the ranking call. Any other word is `tasks` or `check`. An unknown word is `query-invalid`; the `fix` says to run `model-router tasks`, `model-router check`, or `model-router '<query>'`.

The answer is one JSON line on stdout, also when no route survives. `model-router tasks` prints one JSON line: the task list, or `[]` when the registry has none. Errors print as one JSON line on stderr: `{"error":{"code":"...","message":"...","fix":"...","field":"...","problems":[]}}`. A loader error keeps model-registry's own envelope, with `path` instead of `field`.

### Profiles

A query's optional `profile` selects a named set from the registry. The CLI uses
`query.profile`, then non-empty `MODEL_ROUTER_PROFILE`, then `default`, on both
plain and `--describe` ranking calls. An empty variable is unset; an empty query
profile is an unknown name. The library uses `query.profile ?? "default"` and
never reads the profile environment variable. There is no profile flag, config
key or rank option.

Ranking sees only the selected profile's routes before hard limits, pins and
policies. Non-members appear in neither `routes` nor `removed`. Membership adds
no sort key and does not reorder routes by the profile's written label list.
Availability's exhausted-all rule counts only members that survived hard limits.
An outside pin is unused with reason `pin-outside-profile` and warning
`pin-unused`; an outside policy route is omitted with warning
`policy-route-outside-profile`. Both warnings name the selected profile.

The profile-aware `model-registry` loader supplies `loaded.profiles`. Its implicit
`default` contains every route unless the file declares an explicit `default`.
Without a profiles section the answer is unchanged from 0.1.0 except for
`query.profile: "default"`. `answer.query.profile` always records the name used;
contract stays 1 and labels have no profile suffix. An unknown name throws
`profile-unknown` (exit 2), with a fix listing every profile in loader key order;
it never falls back to `default`. This check follows registry, router-section,
query and config validation. On the describe path it also comes before the Jev
call. `check` and `tasks` do not select a profile.

```console
$ model-router '{"task":"task-a","profile":"budget"}' --registry registry.json
$ MODEL_ROUTER_PROFILE=budget model-router '{"task":"task-a"}' --registry registry.json
```

### Profile coverage and accepted gaps

`check` loads the registry, validates router sections and loads config first, then
checks every profile against every task at low, normal and high stakes. It takes
no profile argument and never reads `MODEL_ROUTER_PROFILE`, runs an availability
command or calls Jev. Successful output always includes `warnings`, empty when
there are none. Unrecorded gaps in declared profiles (including a declared
`default`) fail with `profile-gap-unrecorded`, exit 4 and one coded problem per
finding. The implicit `default` reports the same findings as warnings at exit 0.
Each fix offers a gap record or filling routes. Requirements must clear together
on one member, not through independent maxima on different routes.

For coverage only, recorded capability gaps waive needs and rating gaps cap
floors at `accepts`. Stale records produce `profile-gap-stale` warnings naming the
profile, task, stakes, record and first compatible filling route. A rating record
is stale only where a task floor exceeds `accepts` and a compatible member exceeds
that ceiling. Coverage ignores privacy, family exclusions, pins, policies,
availability and inline needs.

At runtime, `profile-gap-accepted` names the selected profile and record's reason
when the applied query hits the limitation. It considers task plus inline needs,
resolved floors, privacy and family limits. No compatible member means no gap
warning. An undeclared minimum suppresses gap warnings. Warnings follow record
order, after hard limits and before the pin. Records never change floors, needs
or removals: a missing capability still removes the route, and a below-floor
route stays below. Gap warnings never fail a query; exits remain 0 or 3.

### The describe flag

`--describe <file>` reads the work description from the file, calls the describe step, then ranks the filled query and merges the describe block into the answer (see [The describe step](#the-describe-step)). With `--describe` the query MUST state `privacy`; the default does not apply, so a caller that forgets it gets exit 2 and not a hosted call, and `privacy: secret` is refused outright (`describe-private`, exit 2). The description file must hold non-blank text. The same registry and config options apply: `--registry`, `--config`.

When Jev gave no answer and the task was needed (the query stated neither `task` nor `minimums`), the CLI exits 5 with `describe-failed`; when the task was not needed, the answer is built from the caller's own fields with a `capabilities-unasked` warning.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | an answer with at least one route, the task list printed, or check passed |
| 2 | invalid query, flag or subcommand (`query-invalid`); unknown profile (`profile-unknown`); or the describe step refusing to run (`describe-private`) |
| 3 | an answer with no route; the answer is still printed |
| 4 | the registry or its router section, or the config file, failed to load; or declared-profile coverage failed (`profile-gap-unrecorded`) |
| 5 | the describe step needed a Jev answer and the call failed (`describe-failed`) |
| 1 | an internal fault (`internal-error`) |

## The query

| Field | Type | Default | Notes |
|---|---|---|---|
| `profile` | string | `default` | ranks only the selected profile; the CLI checks non-empty `MODEL_ROUTER_PROFILE` when absent; unknown is `profile-unknown` |
| `task` | string | none | a name declared in `registry.tasks`; a task the registry does not declare warns `task-unranked` and ranks by `router.rank` |
| `minimums` | rating name to number | none | inline floors that replace per rating at the query's stakes; `minimums: {}` states no floor explicitly |
| `needs` | list of strings | `[]` | adds to the task's needs when a task is named |
| `effort` | string | `effort.default` in `config.json` (medium) | the requested level. An off-ladder value warns `effort-off-ladder` and the default is used |
| `pin` | route label | none | placed first with `placedBy: "pin"` and `floor: "skipped"` when the label exists and the route passed the hard limits; a non-surviving pin warns `pin-unused` (hard-limit code) or `pin-unknown` (label not in the registry). Needs `task` or `minimums` |
| `stakes` | `low`, `normal`, `high` | `normal` | selects the task's floor set; no effect on an inline-only need |
| `prefer` | `cost`, `speed` | `cost` | how clearing routes are ordered |
| `privacy` | `normal`, `secret` | `normal` | `secret` keeps only `privacyEligible` routes |
| `excludeFamilies` | list of strings | `[]` | families removed as a hard limit |
| `spec` | `open`, `settled` | `open` | `settled` matches a policy whose `spec` is `settled` (or unset); an unset policy `spec` matches any query, and a policy's `spec` accepts only `settled`. A query that states `spec` and matches no policy warns `policy-none`; a query without `spec` stays silent |

A query must carry `task` or `minimums` (a `pin` alone is invalid), and input is strict: a field the contract does not define is `query-invalid`. Except for an unknown profile (`profile-unknown`), a check against registry content is a warning, never a failure: a minimum naming an undeclared rating makes every route count as below that floor, a need naming an undeclared capability removes every route lacking it, and an unknown family excludes nothing.

### Resolving the task

A named task whose name is in `registry.tasks` resolves the query against the task's floors at the query's stakes, its `rank` and its `needs`. Inline fields apply over them:

- `minimums` replaces the task's floor for each rating it names, at the query's stakes.
- `needs` adds to the task's needs.
- `effort` is parsed and echoed on the applied query; effort resolution then applies it (see below).

The order list is the task's `rank`. A misspelled task in the registry falls through to `router.rank` and adds the `task-unranked` warning.

### Resolving effort

The requested level follows this order: a policy route's `effort` when it names one, else the query's `effort`, else the task's `effort`, else `effort.default` in `config.json`. The model then layers its limits on top:

- A model's `fixedEffort` replaces the requested level.
- A model's `maxEffort` caps the level. A lowered level adds the `effort-above-max` warning.
- `effort.ceiling` from `config.json` caps the level last, including a level named by a task, a pin, a policy or a query. A lowered level adds the `effort-ceiling` warning. It is never an error.
- The router never emits `max` under the default ceiling.
- A route carries no `effort` only when no level was known.

### Placing the pin

When the query names a route label, the pin is placed ahead of the policy and ranked routes:

- The pin is used when the label exists in the registry and the route passed every hard limit. The pin route appears first with `placedBy: "pin"` and `floor: "skipped"`, then the rest of the answer follows without it.
- A non-surviving pin keeps the fallback ranking. `pin.used` is `false` and `pin.reason` names the cause: `pin-outside-profile`, a hard-limit code (`privacy-secret-not-eligible`, `family-excluded-by-query`, `needs-not-satisfied`) or `unknown-label`. A `pin-unused` or `pin-unknown` warning names the label.
- The answer's `pin` field is `null` when the query has no pin.

### `config.json`

The router reads its `config.json` for `effort.ceiling`, `effort.default`, the `describe` group, and the optional `availability` source. The path order is `--config <path>`, `MODEL_ROUTER_CONFIG`, then `$XDG_CONFIG_HOME/model-router/config.json`. When no file is at the XDG path, every default applies and no warning is added. An explicit path that does not exist, or an invalid file, is `config-invalid`. Every key is OPTIONAL, and the schema is closed: an unknown key is `config-invalid`; `$schema` is allowed for editor support. A default above the ceiling is `config-invalid`. The file holds no registry path and no Jev key; the key comes from `TYPESAFE_API_KEY`.

| Key | Default | Rule |
|---|---|---|
| `effort.ceiling` | `xhigh` | a ladder level |
| `effort.default` | `medium` | a ladder level, not above `effort.ceiling` |
| `describe.taskGate` | `0.85` | a probability in `[0, 1]`; Jev's task is taken at or above it |
| `describe.capabilityThreshold` | `0.5` | a probability in `[0, 1]`; a capability answer at or above it is added to `needs` |
| `describe.jevModel` | `jev-1.13.0` | a non-empty Jev model name; the package pins a versioned ID, not an alias |
| `availability.command` | `none` | an argv array, run with no shell |
| `availability.timeoutSeconds` | `10` | a positive number |
| `availability.maxAgeSeconds` | `300` | the staleness bound, for command output and for a file |

The CLI does not read the `availability` section unless `--availability` or `--availability-file` is given. The library's `applyAvailability` does not consult the config either: callers pass entries directly.

### Resolving the policy

At most one policy applies to a query. A policy is a candidate when its `task` is the query's task, its `stakes` include the query's, and its `spec` condition holds: a policy without `spec` applies whatever the query's `spec` is, and a policy with `spec: "settled"` applies only to a `spec: "settled"` query. A policy's `spec` accepts only `settled`. When a specless policy and a settled policy are both candidates for a settled query, the settled one wins. Two policies that could match the same query at the same level - the same task, an overlapping stakes level, the same spec condition (both specless, or both settled) - make the file invalid (`policy-tie`).

The policy's routes come before the ranked routes, in written order, with `placedBy: "policy"`, `policy` naming the policy and `floor: "skipped"`. No route appears twice. A policy route that a hard limit removed stays in `removed` with its hard-limit reason, and a `policy-route-removed` warning names the policy.

## The describe step

`describe(text, partialQuery, { registry?, config? })` fills a partial query from a prose work description. `model-router --describe <file> '<partial>'` runs it and then ranks. The checks run in this order:

1. **Privacy gate.** `privacy` absent is `query-invalid` on the `privacy` field; `privacy: secret` is `describe-private`. No request leaves the machine before this gate passes: hosted Jev never receives text from a secret call.
2. **Text gate.** A blank description is `query-invalid`.
3. **Profile check.** After the registry, router sections and config load and validate, the selected profile must be declared. The library selects `query.profile ?? "default"`; the CLI also reads non-empty `MODEL_ROUTER_PROFILE` when the query has no profile. An unknown name is `profile-unknown`, exit 2, and no request leaves the machine. This check also runs when there is nothing to ask.
4. **Ask Jev.** The task question rides only when the partial query has neither `task` nor `minimums`: one choice over the declared tasks, each task's `description` as its criterion, so a task added to the registry is offered with no package change. One noul question per `router.questions` entry rides always, with the registry's own question text. The state is the work description and nothing else. The model is `describe.jevModel` from `config.json`. When nothing is to ask (the query states `task` or `minimums` and the registry declares no `router.questions`), the step makes no request and reads no key: `model` and `usage` are null and no warning is added.
5. **Gate the answers.** A task confidence at or above `describe.taskGate` is used; below it the guess is kept with a `task-uncertain` warning whose fix says to pass `task`. A capability answer at or above `describe.capabilityThreshold` adds the capability to `needs`. Capabilities are escalate-only: an answer never removes a capability the caller named.
6. **Fill.** The returned query carries the caller's fields with the filled `task` and the extended `needs`. Every other field is the caller's. The CLI ranks this query and merges the describe block and the step's warnings into the answer.

When Jev gives no answer (no key, failed request, unusable answer), the task's necessity decides: the task was needed (the query stated neither `task` nor `minimums`) means `describe-failed`, exit 5, carrying Jev's own code; the task was not needed means the caller's query continues with a `capabilities-unasked` warning carrying the code. The step asks no `stakes` question, no question about secret material, and keeps no local-model fallback. The Jev client's missing-key message names only `TYPESAFE_API_KEY`: no credential tool, no path.

The describe block in the answer: `model` (what answered, `null` when Jev failed), `taskGate` and `capabilityThreshold` (the values applied), `task` (`source`: `caller`, `jev`, or `inline-need` when `minimums` was given; `confidence`, `null` when no task question was asked; `candidates`: the choice distribution's tasks with probabilities, highest first), `needsAdded` (each added capability with its probability) and `usage` (Jev's token counts, `null` when Jev failed).

## The Jev client

`askJev(state, questions, options?)` posts one state and a map of typed questions to `https://api.typesafe.ai/v1/systemone` and returns `{ model, answers, usage }`. `JevError` carries a stable `code` and, when one arrived, the HTTP `status`. The client reads `TYPESAFE_API_KEY` from the environment; a missing key throws before any request. An option that is present but invalid, such as `timeoutMs: 0`, throws a `RangeError` naming the option before any request; `timeoutMs` is at most 2147483647, the largest delay a timer holds; `JevError` covers failures of the call itself. Every 200 body is validated against the questions that were sent: a body that does not match is `BAD_RESPONSE`. Each attempt is bounded by a 15 s timeout (`timeoutMs`) that covers the whole attempt, the response body included; a timeout is `UNREACHABLE` naming the limit and is not retried. The client retries `429` and `529` with exponential backoff, honoring `Retry-After`; a delay above 30 s, from `Retry-After` or the backoff, stops the retries at once with `RATE_LIMITED` naming the requested wait. The key and retry helpers stay private to the package.

| JevError code | Cause |
|---|---|
| `MISSING_KEY` | `TYPESAFE_API_KEY` is not set, or holds a character outside printable ASCII |
| `UNREACHABLE` | the request to the endpoint failed at the network level |
| `SERVICE_ERROR` | the endpoint returned a status the client does not retry |
| `RATE_LIMITED` | every retry attempt came back retryable |
| `BAD_RESPONSE` | a 200 body that does not match the questions sent: no answers object, no model or usage, or a missing or malformed answer for an asked question |

## The ranking

1. Load the registry and validate the router sections: `router`, `tasks`, `policy`. `router.rank` is required, `tasks` and `policy` are optional. Any problem is `registry-sections-invalid`.
2. Load `config.json` (or fall through to the documented defaults). An explicit path that does not exist or an invalid file is `config-invalid`.
3. Validate the query, resolve the profile and restrict membership before hard limits. An unknown profile fails `profile-unknown`; non-members are not candidates and produce no removal records.
4. Resolve the task. Apply inline `minimums` over the task's floor at the query's stakes. Apply inline `needs` over the task's needs. The task's effort and the query's effort feed step 7.
5. Apply the hard limits in order: `privacy: secret` (routes without `privacyEligible: true`), `excludeFamilies`, `needs`. A removed route lands in `removed` with one reason. After the hard limits, a query that hits an accepted gap of the selected profile gets one `profile-gap-accepted` warning per record; floors, needs and removals do not change.
6. Place the pin. A used pin goes first with `placedBy: "pin"` and `floor: "skipped"`. A non-surviving pin keeps the fallback ranking with `pin.used: false` and a reason in `pin.reason`.
7. Place the policy routes. A route that a hard limit removed stays in `removed` with its hard-limit reason, and a `policy-route-removed` warning names the policy. No route appears twice.
8. Sort the rest. Clearing routes order by cost (higher rating, so cheaper, first), then the rank in force (the task's `rank` or `router.rank` when no task resolves), then the model's route order, then file order; with `prefer: speed`, response time comes first. Routes below a floor order by the rank in force, then cost, then route order, then file order. `minimums: {}` states no floor explicitly: every route clears and orders by that clearing order. A query naming a task the registry does not declare, with no floor, orders every route most capable first, never cheapest first; with `minimums` floors, it uses the orders above. A missing value sorts below every route that has it.
9. Resolve effort for each route. The requested level is the policy route's `effort` when stated, else the query's, else the task's, else `effort.default`. The model's `fixedEffort` replaces, `maxEffort` caps (with a warning), and `effort.ceiling` caps last (with a warning).
10. Apply availability. The engine calls `applyAvailability` on the full ordered list, after the pin and the policy have placed their routes. `availability` carries entries the caller has gathered; the engine skips entries whose meter is not in the registry's `meters` section (with a `meter-undeclared` warning), then runs the rule. The caller drops expired entries with `dropExpired` before passing them in: `rank` itself does not read the clock. Routes marked `exhausted` move to `removed`; routes marked `projected` move below every healthy route unless the route's meter is `spendToZero: true` in the registry, in which case the route keeps its place. A re-applying call replaces the route's existing `meter-projected`, `meter-projected-spend-to-zero` and `meter-exhausted` reasons with this call's reason. When every route would be removed, none is: each stays with `exhausted`, and the `availability-exhausted-all` warning is added. The engine emits `meter-no-reading` once per meter the routes use with no covering entry, whenever `availability` is passed (an empty array included).
11. Build the answer: `contract`, `routerVersion`, `registryDigest`, the query as applied, `pin`, the ordered `routes`, `removed`, `warnings`, `availabilityNote` (set by the CLI from a failed availability source), `describe: null` (the describe block arrives only through the describe step, which the CLI merges).

Each answer route carries `label`, `model`, `harness`, `modelId`, `provider` (when set), `effort` (when a level is known), `hosted`, `family`, `meter` (when set), `placedBy` (`"pin"`, `"policy"` or `"rank"`), `policy` (the policy's name, only when `placedBy` is `"policy"`), `floor` (`"clears"`, `"below"` or `"skipped"`), `availability` (`ok`, `projected`, `exhausted`, `unknown`, or `unmetered`) and `reasons`. A projected route carries a `meter-projected` reason; a projected route on a spend-to-zero meter keeps its place and carries `meter-projected-spend-to-zero`. Routes below a floor carry one `floor-not-met` reason per failed floor.

The same registry and the same query always give the same answer.

## Codes this package chose

The RFC names the error codes and the profile-specific warning and pin reason codes. The remaining warning and reason codes below are this package's choice:

| Code | Where | Meaning |
|---|---|---|
| `task-unranked` | warnings | the query names a task the registry's tasks section does not declare; ranking falls through to `router.rank` |
| `rating-unknown` | warnings | a minimum names a rating the registry does not declare |
| `capability-unknown` | warnings | a need names a capability the registry does not declare |
| `family-unknown` | warnings | an excluded family is not in the registry |
| `effort-off-ladder` | warnings | the query's `effort` is not on the ladder; the actual fallback source (task effort or `effort.default`) applies |
| `effort-fixed-lowering` | warnings | the requested level was lowered by the model's `fixedEffort` |
| `effort-above-max` | warnings | the requested level was lowered by the model's `maxEffort` |
| `effort-ceiling` | warnings | the requested level was lowered by `effort.ceiling` in `config.json` |
| `pin-unknown` | warnings | the query's pin is not in the registry |
| `pin-unused` | warnings | the query's pin is outside the selected profile, or was removed by a hard limit or availability; the warning names the cause |
| `pin-outside-profile` | pin reason | the declared pin is outside the selected profile |
| `policy-route-outside-profile` | warnings | the matching policy names a route outside the selected profile; it is omitted |
| `profile-gap-unrecorded` | check problems or warnings | declared-profile coverage fails; implicit-default coverage warns |
| `profile-gap-stale` | check warnings | a compatible member fills a recorded limitation for a task and stakes |
| `profile-gap-accepted` | answer warnings | the applied query hits an accepted profile limitation |
| `policy-none` | warnings | the query stated a `spec` (`open` or `settled`) and no policy matched |
| `local-or-nothing` | warnings | `privacy: secret` removed every route; the work runs locally or not at all |
| `policy-route-removed` | warnings | a hard limit removed a route the matching policy names; the warning names the policy and the route |
| `availability-exhausted-all` | warnings | exhaustion would remove every route; none is removed and each carries `exhausted` |
| `availability-entry-invalid` | warnings | the CLI's reader skips any entry the shipped schema rejects, or a `resetsAt` that does not parse; other entries still apply |
| `meter-undeclared` | warnings | an entry names a meter the registry does not declare |
| `meter-no-reading` | warnings | a reading was applied and a meter the routes use has no entry |
| `task-uncertain` | warnings | Jev's task is below `describe.taskGate`; the guess is kept and the fix says to pass `task` |
| `capabilities-unasked` | warnings | Jev gave no answer when the task was not needed; the fix says to add any needed capability to `needs` |
| `privacy-secret-not-eligible` | removed reasons | the route is not `privacyEligible` under `privacy: secret` |
| `family-excluded-by-query` | removed reasons | the route's family is in `excludeFamilies` |
| `needs-not-satisfied` | removed reasons | the route lacks a needed capability |
| `floor-not-met` | route reasons | the model's rating is below a floor, or absent |
| `meter-exhausted` | removed reasons | the route's meter was `exhausted`; the route is removed |
| `meter-projected` | route reasons | the route's meter was `projected`; the route is demoted below the healthy routes |
| `meter-projected-spend-to-zero` | route reasons | the route's meter was `projected`, but the meter is `spendToZero: true`; the route keeps its place |

## Registry-section problem codes

A `registry-sections-invalid` error carries one problem per finding in `problems[]`. These are the codes this package emits for the router sections:

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
| `tasks-description-not-one-line` | a `tasks` entry's `description` contains a line break |
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
| `policy-route-duplicate` | a `policy` route names the same label more than once |
| `policy-reason-missing` | a `policy` entry has no `reason` |
| `policy-reason-not-string` | a `policy` entry's `reason` is not a string |
| `policy-spec-invalid` | a `policy` entry's `spec` is not `settled` |
| `policy-since-not-string` | a `policy` entry's `since` is not a string |
| `policy-field-unknown` | a `policy` entry carries a field other than the policy fields |
| `policy-tie` | two policy entries match the same query at the same level |

## Config problem codes

A `config-invalid` error carries one problem per finding in `problems[]`. These are the codes this package emits for `config.json`:

| Code | Cause |
|---|---|
| `config-not-object` | the file is not a JSON object |
| `config-key-unknown` | a top-level field other than `effort`, `availability`, `describe` and `$schema` |
| `config-effort-not-object` | `effort` is not a JSON object |
| `config-effort-ceiling-invalid` | `effort.ceiling` is not a ladder level |
| `config-effort-default-invalid` | `effort.default` is not a ladder level |
| `config-effort-key-unknown` | a field in `effort` other than `ceiling` and `default` |
| `config-effort-default-above-ceiling` | `effort.default` is above `effort.ceiling` |
| `config-availability-not-object` | `availability` is not a JSON object |
| `config-availability-command-not-array` | `availability.command` is not an array |
| `config-availability-command-empty` | `availability.command` is an empty array |
| `config-availability-command-entry-not-string` | an entry in `availability.command` is not a string |
| `config-availability-timeout-invalid` | `availability.timeoutSeconds` is not a positive number |
| `config-availability-max-age-invalid` | `availability.maxAgeSeconds` is not a positive number |
| `config-availability-key-unknown` | a field in `availability` other than `command`, `timeoutSeconds` and `maxAgeSeconds` |
| `config-describe-not-object` | `describe` is not a JSON object |
| `config-describe-task-gate-invalid` | `describe.taskGate` is not a probability between 0 and 1 |
| `config-describe-capability-threshold-invalid` | `describe.capabilityThreshold` is not a probability between 0 and 1 |
| `config-describe-jev-model-invalid` | `describe.jevModel` is not a non-empty Jev model name |
| `config-describe-key-unknown` | a field in `describe` other than `taskGate`, `capabilityThreshold` and `jevModel` |

## Availability codes

A failed availability source on the CLI does not fail ranking; the CLI fills `availabilityNote` with one of these codes and ranks without availability:

| Code | Cause |
|---|---|
| `availability-command-missing` | `--availability` given and no `availability.command` in `config.json` |
| `availability-command-failed` | the command was not found, exited non-zero, or was killed at `timeoutSeconds`; the `message` says which |
| `availability-file-unreadable` | the `--availability-file` path does not exist or cannot be read |
| `availability-reading-invalid` | not JSON, a wrong top level, an unknown `format`, an unparseable `generatedAt`, or `entries` is not an array |
| `availability-reading-stale` | `generatedAt` older than `maxAgeSeconds`, or in the future |

## Library

```ts
import {
  applyAvailability,
  askJev,
  describe,
  dropExpired,
  JevError,
  listTasks,
  rank,
  RouterError,
  type JevAnswer,
  type JevQuestion,
  type JevResponse,
} from "@dungle-scrubs/model-router";

const answer = rank(
  { task: "task-a", stakes: "normal" },
  { registry: "registry.json", config: "config.json" },
);
answer.routes[0]?.label;       // "model-c@harness-x"
answer.routes[0]?.placedBy;    // "policy"
answer.routes[0]?.policy;      // "policy-a"
answer.routes[0]?.floor;       // "skipped"
answer.routes[0]?.availability; // "ok" | "projected" | "exhausted" | "unknown" | "unmetered"
answer.routes[0]?.effort;      // "high" (resolved through the model limits and config)
answer.pin;                   // null without a pin, else { label, used, reason }
answer.registryDigest;        // "sha256:<hex>"

const tasks = listTasks({ registry: "registry.json" });
// [{ name, description }, ...] in file order, or []

// A path, or a LoadedRegistry from model-registry's loadRegistry, so several
// calls share one load and one digest:
const loaded = loadRegistry({ path: "registry.json" });
rank({ task: "task-a", stakes: "normal" }, { registry: loaded, config: { effort: { default: "low" } } });
listTasks({ registry: loaded });

// The describe step fills a partial query from a work description. The
// partial query must state privacy; Jev's task fills `task` and capability
// answers extend `needs`. The result also carries the describe block and
// the warnings the caller merges into the answer's warnings list.
const described = await describe("implement the feature", { privacy: "normal" }, {
  registry: "registry.json",
});
const describedAnswer = rank(described.query, { registry: "registry.json" });
// described.describe.model, .taskGate, .capabilityThreshold, .task, .needsAdded, .usage

// The Jev client behind the step, for callers with their own questions:
const response = await askJev(
  "the state text",
  { urgent: { type: "noul", instructions: "Is this urgent?" } },
  { model: "jev-1.13.0" },
);
response.answers.urgent satisfies JevAnswer | undefined;
response satisfies JevResponse;

// The library reads availability through the rank option. The caller
// gathers entries (and runs dropExpired) before ranking; the engine
// filters entries whose meter is not in the registry and applies the
// rule. `rank` never reads the clock: a caller that wants stale entries
// dropped runs `dropExpired` first.
const ranked = rank(query, {
  registry: "registry.json",
  availability: dropExpired(reading.entries, new Date()),
});

// graybox and delegate can re-rank a list of routes they already hold,
// passing the registry's spend-to-zero meter names. Routes with no
// covering entry keep their availability and place.
const result = applyAvailability(answer.routes, reading.entries, {
  spendToZero: ["plan-a"],
});
```

`rank` and `listTasks` are synchronous and pure over their inputs. `describe` awaits one Jev call. They throw `RouterError` (`query-invalid`, exit 2; `profile-unknown`, exit 2; `describe-private`, exit 2; `registry-sections-invalid`, exit 4; `config-invalid`, exit 4; `describe-failed`, exit 5) and rethrow model-registry's `RegistryError` unchanged. `applyAvailability` and `dropExpired` are pure over `(routes, entries)` and `(entries, now)`: the same inputs give the same outputs. The loader and the label builder are not re-exported; import them from `@dungle-scrubs/model-registry`. The package ships `query.schema.json`, `answer.schema.json`, `availability.schema.json`, `error.schema.json`, `config.schema.json` and `router-sections.schema.json`: the query schema rejects undefined fields, the answer schema allows them, the availability schema validates the document a user converter writes, the error schema describes the `{"error": ...}` envelope the CLI prints on stderr, the config schema validates `config.json`, and the router-sections schema describes the `router`, `tasks` and `policy` sections of a registry file.

## Development

```console
$ pnpm install --frozen-lockfile
$ pnpm verify          # lint, typecheck, build, tests
$ pnpm test:mutation   # mutation score, break at 75
```

Tests use placeholder registries only (`tests/fixtures/`): model keys like `model-a`, harnesses like `harness-x`, families like `family-a`, tasks like `task-a`. CI installs `model-registry` from npm with the caret dependency `^0.2.0`.