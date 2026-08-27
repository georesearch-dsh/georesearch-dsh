# Prompt Cache Diagnosis

## Outcome

The approximately 70 percent task-wide cache rate is not caused by a broken
DeepSeek usage mapping or random request-header drift. Two independent request
boundary effects produced it.

For durable Coordinator sessions, upgrades changed the exact request header
while the conversation history kept growing. For delegated work, fresh one-shot
children placed the dynamic task in their first request. Flash children often
ended after one or two calls, so that first call dominated their aggregate
rate. Captured Flash children included 20.9 percent for a one-call run and 55.2
percent for a two-call run whose second request alone reached 97.8 percent.
Longer Pro children commonly stabilized around 89 to 94 percent.

Generation 41 removed the known specialist schema and header drift. Two
different Literature children then produced byte-identical 18,134-character
request headers with SHA-256
`7873ff97547eeaa05b1c6a43456b889d8331a8af6102cd372f8c1ddfecbd5d8b`.
Despite that, the first `discovery` and `evidence-synthesis` calls had zero cache
reads, an exact repeat reached 99.8 percent, and a later
`citation-verification` task reused 4,608 of 6,551 input tokens, or 70.3
percent. This isolated the remaining defect to DeepSeek cache construction at
request boundaries rather than plugin nondeterminism.

The strongest captured session contained 47 model calls:

| Metric | Value |
| --- | ---: |
| Task-wide hit rate | 72.3% |
| Request-header snapshots | 12 |
| Distinct header changes | 9 |
| Uncached input tokens | 922,960 |
| Uncached tokens on cold/changed-header first calls | 777,971 |
| Share of misses attributable to those calls | 84.3% |
| Same-header-epoch hit rate | 94.0% |

A separate three-call GeoResearch session had a 67.3 percent aggregate rate,
but its two requests after the cold first call reached 95.9 percent. The first
request alone contributed 91.3 percent of that session's uncached input.

## Root Cause

DeepSeek caching reuses an exact request prefix. The Harness persists the model
route, rendered system prompt, and model-visible tool schemas as a
`request/header`. A resumed agent uses the current composed header.

DeepSeek's documented Sliding Window rule stores complete cache prefix units at
request boundaries: <https://api-docs.deepseek.com/guides/kv_cache>. If the
first request is `A+B`, a later `A+C` request cannot immediately hit a stored
`A+B` unit; it causes the shorter common prefix `A` to be persisted for a later
request. Cache construction also takes time. This explains the observed
sequence of two cold differing tasks, one near-perfect exact repeat, and a later
70 percent partial-prefix hit.

During the captured long session, plugin upgrades changed that header. The
first request after each incompatible resume had only 0.3 to 1.6 percent cache
reuse in the worst cases and reprocessed up to 152,988 uncached input tokens.
The next requests under the same header immediately returned to 94 to 99
percent hits.

Two implementation choices increased the blast radius:

1. The early `georesearch:integrity` system section contained 7,971 characters
   of frequently changing capability, attachment, vision, and workflow detail.
2. The Coordinator-visible `experiment_spec_commit` tool copied a 9,380
   character specialist candidate schema into every request. The complete tool
   entry occupied 9,531 characters.

For delegated children, task-specific output-schema generation was the first
defect. Generation 41 replaced it with one shared schema and proved the request
headers were byte-identical. The remaining defect was that the complete dynamic
task contract still formed the child's first user request. Every new task thus
created a distinct first request boundary even though its header was stable.
Reordering fields enlarged the later shared prefix but could not make a second
different task hit the complete first request already stored for the first.

The latest captured GeoResearch system plus tool prefix occupied 39,995
characters before conversation history and runtime context.

A later live route probe exposed a separate model-selection defect. A parent
whose current request route was `deepseek-v4-flash` created a Literature child
whose recorded source model was `deepseek-v4-pro`. Harness session model
selection is installed as a mutable per-session request route and persisted in
the latest `request/header`, while in-process child creation inherits the
parent's creation-time `agent.options` unless the caller supplies an override.
GeoResearch supplied only `geoResearchRole`, so a model switch made after Agent
creation did not reach delegated children. This fragmented model-specific
cache accounting and prevented Flash specialist traffic from warming a Flash
specialist prefix.

Visual analysis had an independent concurrency gap. Completed exact requests
were cached in-process, but two identical reads arriving before the first
provider response each issued their own `deepseek-v4-flash-vision-exp` call.
Parallel delegated readers could therefore duplicate the most expensive cold
vision request even though later sequential reads were local hits.

## Ruled Out

- Usage mapping: the DeepSeek adapter subtracts cache reads from uncached input,
  and all 30 adapter translation tests pass.
- Tool ordering: Harness sorts visible tools lexicographically. Captured resumes
  of the same build produced byte-identical header hashes.
- Runtime context churn: Harness appends a runtime snapshot only when its text
  changes. Stable steps do not append duplicate snapshots.
- Random capability ordering: GeoResearch obtains visible tool names in sorted
  order, and the same-build header evidence is deterministic across restarts.

## Implemented Changes

- Reduced the static integrity section from 7,971 to 2,301 characters and moved
  it from order `-20` to order `900`, after the stable Harness, persona, and tool
  guidance prefix.
- Removed volatile model, format, attachment, and workflow implementation detail
  from the static section. Those facts remain in the bounded
  `georesearch:runtime` snapshot, tool schemas, and Skills.
- Replaced the Coordinator-facing nested `experiment_spec_commit` candidate
  schema with a 346-character opaque pass-through schema. The Host still calls
  `parseExperimentSpecCandidate` and revalidates the full protocol and
  provenance before commit.
- Reduced the complete `experiment_spec_commit` tool entry from 9,531 to 580
  characters.
- Added prompt and schema size regression tests, strict Host-validation coverage,
  multi-frame session decoding tests, and a session cache analyzer.
- Replaced every delegated task-specific output schema with one byte-identical
  compact envelope shared by all roles and task types. Exact output-kind,
  candidate, reviewer-subject, and commit validation remains Host-side.
- Reordered delegated Host task JSON so the stable role contract and task-type
  contract precede authority, question, constraints, and free-form task text.
- Bounded Skill catalog descriptions at 128 characters to reduce the
  unavoidable catalog suffix that Harness rc.5 appends after a new child task.
- Placed vision image content before the variable question and added a bounded
  exact in-process result cache for repeated image requests.
- Added the fixed `delegation_bootstrap` specialist tool. The first child
  request is now task-independent for a given role; task type, required Skills,
  completion criteria, allowed outputs, authority, question, constraints, and
  task text are returned only in the bootstrap tool result.
- Added a one-use Host bootstrap lease and monotonic policy stages. Before
  bootstrap, Skills and role tools are denied. After bootstrap, only
  role-approved Skills are allowed until every required Skill has loaded.
- Added a compact specialist runtime snapshot. Before bootstrap it exposes no
  task type, required Skills, authority, attachment, vision, execution, or
  deliverable detail.
- Delegated children now inherit provider, model, and maximum-token routing from
  the parent's latest `request/header`, falling back to creation-time Agent
  options only before a request header exists. A live Flash parent therefore
  creates Flash children instead of silently reverting to the old Pro default.
- Exact visual-analysis requests now coalesce while the first provider call is
  in flight. Concurrent duplicate readers share one result; followers report a
  local exact hit and issue no second provider request.

Generation 41 reduced the captured system plus tool prefix from 39,995 to
25,374 characters, a 36.6 percent reduction. The bootstrap change addresses a
different boundary problem: after the first role/model prefix is constructed,
later differing tasks can reuse that complete stable first request instead of
waiting for a third request to materialize a shorter common prefix. Provider
tokenization and cache eviction still determine the final billed-token
reduction.

## Operations

Any real static prompt or tool-schema change still creates a new exact-prefix
cache epoch. After installing or upgrading GeoResearch:

1. Close running Harness processes and perform the managed upgrade.
2. Start a new GeoResearch task instead of sending the first post-upgrade request
   through a long task created by the previous build.
3. For each routed model and specialist role under evaluation, run at least
   three different representative tasks. The first role/model child may be
   cold; later differing children should reuse the stable bootstrap request.
4. Confirm every child `assistant/message.source.model` matches the parent route
   that created it. A selected Flash parent must not produce a Pro child.
5. Analyze the new task with:

```powershell
pnpm run cache:analyze -- D:\path\to\.dsh\sessions --json
```

Use `sameEpochHitPct` for steady-state behavior. `cacheEpochChanges` should stay
at zero for a task that has not crossed an upgrade or agent composition change.
The UI task-wide percentage is not a valid before/after comparison when the task
contains historical cache epochs.

## Residual Risk

- Provider-side cache eviction, retention, account scope, and traffic pressure
  remain outside the plugin's control.
- Prompt caches are model-specific. A prefix warmed on `deepseek-v4-pro` cannot
  warm `deepseek-v4-flash` or `deepseek-v4-flash-vision-exp`; each routed model
  needs its own repeated stable prefix.
- The first child for each role/model/cache-retention window can still be cold.
  The plugin can stabilize request construction but cannot pre-populate or
  retain provider-side cache units indefinitely.
- Unique images contain unique base64 tokens and therefore naturally produce a
  low provider prompt-cache percentage. Exact local reuse avoids a second call,
  but unrelated images cannot be made cache hits by prompt reordering.
- Large new tool results, attachments, time snapshots, and user messages are
  legitimate uncached suffixes and lower hit rate for that request.
- Future changes to any Coordinator-visible tool schema can still invalidate a
  long history. Keep coordinator contracts stable and move evolving structured
  candidates to specialist validation plus Host-side parsing where the workflow
  permits it.
