# DSH Standard Conformance

GeoResearch was audited against `Yan-Zero/dsh-std` commit
`bb194ad53a72f4fa7da1286c88dcebb488b43eb9` on 2026-08-25. The protocol and
reference packages are early drafts. This document therefore records exact
claims instead of treating repository adoption as blanket conformance.

## Implemented boundary

| Area | Status | GeoResearch implementation |
| --- | --- | --- |
| Community Manifest v0.15 | Conforming | Package-root `dsh-plugin.json`, static JSON, `v1alpha1` Host facet, package-contained entry |
| Audited reference packages | Conforming | `adapter-dsh`, `manifest`, `sdk`, and `tool` are pinned to `0.1.1-rc.1`; the installed v0.15 schema's canonical JSON digest is checked against the audited commit |
| Manifest projection | Conforming | Parsed and validated with `@dsh-std/manifest@0.1.1-rc.1` and the DSH adapter catalogs |
| Component lifecycle | Conforming adapter path | `FacetModule` activation, publication barrier, owner-scoped cleanup, runtime snapshot |
| Tool extension ownership | Conforming local mapping | 46 execution-only `tools.dsh/v1alpha1 ToolOverride` resources preserve existing tool schemas and execution behavior |
| Adapter bootstrap | Product-specific and declared | `@dsh-std/adapter-dsh@0.1.1-rc.1` is embedded in the rc.5 bundle and started through the formal Cordis bundle layer |
| Permission requests | Declared, not claimed as protocol-complete | Manifest lists the runtime's bounded storage, message, workspace, network, process, and credential needs |
| Harness mutations | Declared for provenance | Profile composition, agent-scoped tool policy, and telemetry disablement appear in `overrides` |

All directly used standard packages are pinned to the audited repository's
`0.1.1-rc.1` release line. The Manifest `$schema` URI points at the immutable
schema file in the audited Git commit; activation remains offline because the
parser never fetches that URI. The verifier also checks the installed schema's
canonical JSON SHA-256 digest before accepting the boundary, so CRLF/LF package
normalization does not create a false mismatch.

## Deliberate compatibility layer

The mature Project, Artifact, Run, Evidence, Repository, Geospatial,
Validation, Claim, Writing, and delegation services remain Cordis product
implementations. This is allowed by the standard's adapter boundary: portable
facets must not import raw Harness APIs, while the DSH product adapter may map
those APIs.

The standard facet therefore publishes execution-only ownership around the
existing tool definitions. The DSH adapter preserves each original schema and
delegates execution back through Harness, so role restrictions, approvals,
sandbox policy, session records, and scientific authority checks remain
authoritative. GeoResearch's specialized `read_image` replacement stays a
declared product override because the current ToolOverride protocol cannot
express the plugin's role-scoped activation predicate.

## Non-claims

GeoResearch does not currently claim independent conformance for Connection,
Agent, Session, Workspace, Model, Presentation, browser UI, or remote Tool
execution protocols. The upstream Tool v1alpha1 proposal explicitly limits its
handler to same-process activation and leaves cross-runtime execution for a
future protocol.

The permission proposal is exploratory and the published DSH adapter does not
replace GeoResearch's existing enforcement. Runtime authorization continues to
be checked at the actual side-effect boundaries by the installation guard,
strict role policy, sandbox, provider limits, DPAPI nonce protection, and Host
commit services.

## Verification

```powershell
pnpm dsh-std:check
pnpm run pack
```

`dsh-std:check` verifies manifest determinism, official parser/projection
acceptance, adapter definition acceptance, complete tool-catalog coverage,
self-contained adapter output, FacetModule publication, and rc.5 module loading.
The packed-tarball verifier repeats the package-root manifest and external
runtime import checks. The Phase 1 live probe requires the standard Host facet
to be active before an installation generation can commit.
