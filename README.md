# GeoResearch for DeepSeek Harness

Out-of-tree GeoResearch plugin workspace targeting DeepSeek Harness `0.1.0-rc.5`
and Cordis `4.0.1`.

The release package also exposes a DSH Standard Community v0.15 component
boundary. A package-root `dsh-plugin.json` is activated through an embedded,
pinned `@dsh-std/adapter-dsh` product adapter; the standard facet owns the
existing GeoResearch tool surface without changing its rc.5 role, approval,
sandbox, or scientific-authority behavior. See
`docs/dsh-standard-conformance.md` for the exact claims and non-claims.

This repository implements the complete Phase 1 through Phase 7 GeoResearch
product: the managed plugin foundation, Project/Run core, universal attachment
layer, Literature/Evidence workflow, Repository/Reproduction workflow,
Geospatial/Experiment workflow, Validation/Claim/Writing authority chain, and
the release gates. In addition to compatibility, installation, role,
delegation, Preset/Skill, lifecycle, and Python worker probes, it includes authoritative Workspace
bindings, persistent Project state and operations, a content-addressed Artifact
Store, Project tools, a sandboxed Run Service, a restart-aware Run Supervisor
with persisted terminal reconciliation and fail-closed orphan handling, mixed
multi-file full-page upload, safe archive inspection,
path-free Agent attachment references, bounded PDF text/page-image reading,
modern and legacy Office/OpenDocument/EPUB extraction, Jupyter Notebook
normalization, SQLite/HDF5/NetCDF/Parquet schema and bounded sample reading,
TIFF/BMP image transcoding, automatic semantic image/PDF-page/document-image
analysis through `deepseek-v4-flash-vision-exp`, credential-safe native/OCR
fallbacks, an Agent-scoped workspace `read_image` route that works with
text-only primary models, and broad source-code text support through the common attachment
tools. Existing attachment sidecars are lazily reclassified
after identity and Artifact-integrity checks, so files stored before a reader
was added gain the new capability without re-uploading. Successful uploads
must have an approved content reader; unsupported archives, CDF-5, audio/video,
executables, and unknown binaries fail before Artifact publication. Phase 3
adds a replay-safe Crossref Provider, owner-bound encrypted continuations,
crash recovery with exact replay, evidence-grade PDF receipts, deterministic
SourceRecord registration, Host-validated Evidence Candidates, authoritative
Coordinator commits, and citation checks. Crossref pagination uses a bounded,
stateless offset held only in the encrypted Host continuation; the upstream
service's stateful scroll cursor is deliberately not used because reissuing the
same cursor can return a different page.

Phase 4 adds a bounded read-only Git Provider, immutable RepositoryAudit and
method/code delta records, baseline-bound ReproductionPlans, later-audit
Project TestSpecs, source-tree-bound local runs, Host-committed JSON
ReproductionReports, and Reviewer Artifact access. Experiment children receive
only candidate tools; the root delegation wrapper revalidates and commits a
strict report. Dynamic smoke and generic shell entrypoints remain unavailable.

Phase 5 adds a persistent bounded Python geospatial Provider, deterministic
DatasetManifest inspection, frozen ExperimentSpecs and Amendments, formal Runs,
and Host-derived ResultRecords. Phase 6 adds mandatory ValidationPlans,
immutable Reviewer records, user-approved Claims, complete WritingPackets, an
isolated Writing role, and deterministic manuscript traceability audits. Phase
7 closes the product with a self-contained installer tarball test, Windows
functional probes, scientific golden cases, release documentation, a strict
compatibility matrix, and a public Rasterio/GeoTIFF end-to-end activation case.

The upstream baseline is pinned to the official DeepSeek Harness GitHub source
archive at commit `47f943859bef60e4160492346772ded9b24f765a`. The archive,
source tree, and upstream lockfile are verified before the local development
mirror is checked against the fixed structured-output patch manifest in
`docs/harness-local-patch.json`. `pnpm run baseline` records the proof, and the
test suite rejects any local Harness difference outside that manifest.

## Scientific Skill Library

The GeoResearch preset ships DeepSeek Harness-native Skills through
`@deepseek-ai/dsh-skill-filesystem`. The Harness publishes only each Skill's
`name` and `description` in the model catalog, then loads the full
`SKILL.md` body on demand. Supporting references remain relative to the loaded
Skill directory and are read only when the workflow needs them.

The library treats a Skill as a versioned expert research protocol rather than
as an autonomous authority:

- `georesearch` coordinates the complete research lifecycle and role routing;
- `literature-review` covers search, screening, evidence extraction, and
  synthesis;
- `geospatial-data` covers spatial identity, compatibility, scale, masks,
  labels, and leakage;
- `remote-sensing-experiment` covers hypotheses, sensor-aware experiment
  design, execution candidates, and result analysis;
- `spatial-statistics` covers spatial sampling, dependence, validation,
  inference, map accuracy, and uncertainty;
- `paper-reproduction` covers paper, repository, environment, and result
  reproduction;
- `scientific-validation` covers independent deterministic and methodological
  review;
- `manuscript-writing` drafts only from an approved WritingPacket.

The Skills use only tools visible in the current `georesearch:runtime`
snapshot. Specialist output remains a candidate, while Host services retain
authoritative commit, run, validation, claim, and writing eligibility.

Managed specialist delegations use explicit task types and role charters. The
Host derives the core Skills for each task, restricts optional Skills by role,
and keeps the dynamic task contract outside the child's cache-sensitive first
request. Each child first calls the fixed `delegation_bootstrap` tool exactly
once, then loads all Host-required Skills through the Harness `skill` tool.
Other child tools remain blocked until both steps complete. Delegation results
report the Host-observed Skill loads and accept only task-compatible output
kinds.

## Local development

```powershell
pnpm install
pnpm run build
pnpm dsh-std:check
pnpm run phase7:gate
pnpm run probe:phase7-live
node packages/installer/lib/cli.js install --dsh-home <dsh-home> --distribution-dir dist\distribution --harness-root <harness-root>
```

`dist/distribution` and `dist/tarballs` are generated release evidence, not
source authority. A publishable set exists only after the current workspace
passes `pnpm run pack`; the verifier rejects stale package trees, manifest
drift, missing or extra archives, and an installer whose embedded distribution
differs from the freshly generated distribution.

The installer never uses `postinstall` and never modifies the Harness source
tree. The Phase 7 gate reruns all deterministic Phase 1 through Phase 6 foundations,
verifies every packed tarball in an isolated temporary project without package
manager installation or workspace links, performs a real Harness boot with all
seven runtime probes, verifies the Project/Run, attachment, continuation,
Provider, PDF lineage, Evidence, Repository, Experiment, Validation, Claim, and
Writing boundaries, probes the Python worker, runs scientific golden cases, and
verifies real Windows DPAPI nonce protection. The Phase 3 live probe performs a
real Crossref/PDF/Evidence workflow. The Phase 4 live probe clones a public
repository, records its exact commit and source-tree digest, and commits a
Reviewer-readable reproduction diagnosis. The Phase 5 probe checks public
Natural Earth data, and the Phase 7 probe carries a public Rasterio repository,
documentation PDF, and GeoTIFF through the complete scientific authority chain.
See `docs/phase1-gate.md` through `docs/phase7-gate.md` for the recorded boundaries,
plus `docs/installation-and-operations.md`, `docs/provider-extension.md`, and
`docs/compatibility-matrix.md` for release operations. The verified DeepSeek
visual-model facts, request policy, local bounds, fallback order, and image
prompt-injection boundary are recorded in `docs/deepseek-vision.md`.

## Run from a Web Profile

```powershell
dsh --profile web
```

The installer discovers every existing Profile whose bundle list contains
`@deepseek-ai/dsh-web-app`, appends `@georesearch/dsh-bundle`, and publishes the
runtime packages under `$DSH_HOME/profiles/node_modules/@georesearch`. Package
resolution therefore does not depend on a port, workspace path, Profile name,
username, or checkout location. A later `upgrade` also integrates Web Profiles
created after the original installation.

The managed `georesearch` Profile remains the integrity-checked installation
carrier and a diagnostic launch target, but it is no longer the only supported
host. The installer never writes a global `agent-presets.default` setting.
