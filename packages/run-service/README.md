# @georesearch/dsh-run-service

The Phase 2 Run Service owns the role check, registered TestSpec allowlist,
scientific plan validation, persistent Project transitions, Supervisor launch,
cancellation, timeout, collection, and restart reconciliation boundaries.

Formal and local runs resolve the effective Harness sandbox policy from the
exact live Agent Session. `read-only` and `workspace-write` use the Harness
sandbox provider; `danger-full-access` executes the original argv without a
sandbox wrapper. GeoResearch never writes or switches `permission/preset`,
`sandbox/mode`, or `approval/policy`, and adds no run-specific permission or
approval gate. Scientific input validation still applies in every mode.

Formal runs are Host-owned after submission and do not retain an Agent, Tool,
or tool-call cancellation signal. Model-facing tools never accept `projectId`
or `cwd`; authority comes from the exact live Agent Session.

In Phase 4, the Repository Provider binds a source-tree inspector into this
service. Dynamic TestSpecs fail closed when that inspector is unavailable or
the workspace differs from their selected RepositoryAudit. Formal runs whose
ExperimentSpec digest is a ReproductionPlan are checked before sandbox
resolution and immediately before their RunRecord is committed.
