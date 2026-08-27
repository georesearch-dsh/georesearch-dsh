# @georesearch/dsh-policy

Implements the three GeoResearch policy layers:

- per-agent catalog restriction;
- a monotonic execution guard;
- exact `toolFilter.allow` materialization for managed children;
- Host-observed specialist Skill readiness.

The full contractual allowlists are retained in `@georesearch/dsh-contracts`.
The shipped `capabilityStage: phase6` and `strictCatalog: true` configuration
fails closed unless every implemented role capability is present. Each managed
delegation also carries a role-specific task type and required Skill set.
The dynamic contract is held in a one-use bootstrap lease. Before
`delegation_bootstrap`, every other specialist tool is denied. After bootstrap,
specialists may load only Skills approved for their role, and role tools remain
blocked until every required Skill call has completed successfully.

Specialist roles may call the scope-local `structured_output` tool injected by
the one-shot output schema. It is the only additional return channel and is not
part of the Coordinator allowlist. The execution guard authorizes it, while the
global catalog restriction omits the scope-local name as required by rc.5.
