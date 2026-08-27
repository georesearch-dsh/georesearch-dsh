# @georesearch/dsh-installer

Explicit CLI implementing `install`, `upgrade`, `verify`, `uninstall`, and
`recover`. It writes generation markers and journals, publishes `active.json`
as the final commit point with write-through replacement, and uses a Windows
named mutex. It never mutates `$DSH_HOME` from `postinstall`.

Harness owns the runtime contents of each Profile's `cordis.yml` anchor, so new
installation generations exclude that file from the managed Profile digest.
Legacy manifests that recorded it remain verifiable. Recovery keeps its journal
and backups until the restored generation validates successfully.

Mutating commands hold both the installer mutex and the cross-process runtime
lease. On Windows they also request delete access to the managed Profile and
shared package and Preset directories before creating a journal, producing a
clear preflight failure when another Harness process has a non-share-delete
watcher open.

Installation discovers every Profile whose bundle list contains
`@deepseek-ai/dsh-web-app`. It preserves user-owned manifest fields, adds pinned
GeoResearch dependencies and the bundle layer, and places one runtime package
tree at `$DSH_HOME/profiles/node_modules/@georesearch`, where Node's normal
parent lookup serves any Profile name. The journal snapshots every changed
Profile file. Recovery restores those exact bytes; uninstall removes only the
GeoResearch-owned dependencies and bundle while retaining later user changes.

The current development distribution is supplied with `--distribution-dir`.
The maintenance nonce is single-use, digest-only on disk, and passed to the
activation child as a DPAPI CurrentUser-protected blob bound to the exact
transaction, generation, executable, and deadline. Candidate and published
generations run `--dump-config` and real ESM imports from every integrated Web
Profile. Before `active.json` commits, a temporary real Harness boot verifies
the Phase 1 through Phase 6 runtime probes. This includes strict policy, spawn
provider, sandbox, delegation tools, Project, File, Evidence, Repository,
Reproduction, Geospatial, Experiment, Validation, Claim, Writing, and Run
services; role-scoped tool catalogs; Crossref replay capability; PDF parser
lineage; Preset resolution; schema strictness; Host-only authoritative commits;
and telemetry absence.

Each integrated Web Profile sets `georesearch` as its composition default
through the appended bundle. The installer does not write a cross-profile
`agent-presets.default` user setting.

Release installation, verification, reconciliation, upgrade, recovery, and
uninstall procedures are documented in `docs/installation-and-operations.md`.
