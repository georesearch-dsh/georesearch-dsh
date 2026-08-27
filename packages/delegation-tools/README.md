# @georesearch/dsh-delegation-tools

Registers four Coordinator tools, `delegate_literature`,
`delegate_experiment`, `delegate_review`, and `delegate_writing`, plus the
specialist-only `delegation_bootstrap` tool.

Every call fixes the label, persona, `geoResearchRole`, one-shot `spawn`
provider, depth cap, structured output schema, and role allowlist. The first
child request is byte-identical for different task types within the same role.
The Host stores the dynamic task type, required Skill set, completion criteria,
allowed output kinds, authority, question, constraints, and task until the
child calls `delegation_bootstrap`. Harness rc.5 itself pins
delegated approval policy to `never` when the approval service is present.
Missing future domain tools are not stubbed. The shipped configuration uses
`strictRoleCapabilities: true` with `capabilityStage: phase6`, so the complete
implemented specialist catalog is mandatory. It also caps each specialist
request at `specialistMaxTokens: 16384`; a lower parent request cap remains
authoritative.

Managed children must call `delegation_bootstrap` exactly once, then
successfully call the `skill` tool for every core and selected supporting Skill
before any role tool or `structured_output`. The Policy service records both
protocol stages and the delegation result exposes the Host-observed
`requiredSkills` and `loadedSkills` lists. Completed children must return a
role- and task-compatible `outputKind` plus a candidate.

The role contract includes the scope-local `structured_output` tool guaranteed
by the output schema. The global `toolFilter.allow` list deliberately omits it
because Harness rc.5 rejects scope-local names in global restrictions.

Harness rc.5 requires one-shot structured output to have an explicit object
root. Every task receives a compact `{ result: <completed-or-decision> }`
schema containing only that task's allowed completed output kinds plus the
bounded decision branch. Generic reports carry exact item and text limits in
the tool schema, and the bootstrap result repeats the four-finding hard limit
as the last Host constraint. The Host unwraps the transport envelope and
applies the authoritative task/output-kind check, role-specific candidate
parser, reviewer subject check, and commit validation before reporting success
or committing any record.

The cache-sensitive first request keeps stable role policy and the fixed
bootstrap protocol. Dynamic task JSON appears in the bootstrap tool result on
the second turn. The structured-output schema varies by task so the model does
not receive unrelated large candidate contracts; role policy and bootstrap
prefixes remain reusable across tasks.

Child provider/model routing is taken from the parent's latest persisted
`request/header`, not only from the Agent's creation-time options. This keeps a
session-level model switch authoritative for delegated work and prevents a
Flash parent from silently spawning Pro children. The configured specialist
output cap is applied after routing so a larger parent allowance cannot reopen
an unbounded child response.
