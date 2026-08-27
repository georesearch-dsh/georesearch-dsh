# @georesearch/dsh-project-service

The Phase 2 Project Service resolves authority from an exact live Agent and its
durable Session `cwd`, verifies the Host Workspace binding, and exposes bounded
project status, ResearchBrief, Artifact, and read operations.

`deliverable_publish` is the Coordinator's only final text-file publication
path. It accepts bounded UTF-8 content, confines materialization below
`deliverables/`, binds the file to a content-addressed Artifact, requires an
exact old digest for replacement, and recovers interrupted publication through
the Project operation journal. It does not expose generic `write` or `edit`.

Model tools never accept a `projectId` or arbitrary `cwd`. Rebind remains a
Host API that requires an explicit confirmation fact.

Phase 4 authoritative commits revalidate RepositoryAudit, ReproductionPlan,
dynamic TestSpec, Run, diagnostic Artifact, and ReproductionReport references.
Audit, plan, and TestSpec timestamps do not break exact semantic replay, while
content changes under the same identifier fail closed.
