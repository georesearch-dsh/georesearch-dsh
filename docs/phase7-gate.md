# Phase 7 Gate: Release

Phase 7 closes the GeoResearch v1 implementation. Release acceptance requires
both the deterministic Windows gate and the normally disabled public activation
case; neither substitutes for the other.

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm run phase7:gate
$env:DSH_TELEMETRY_DISABLED = '1'
pnpm run probe:phase7-live
```

`phase7:gate` reruns the complete Phase 1 through Phase 6 chain, builds and packs
the distribution, then explicitly runs the self-contained installer tarball
against a clean home, Windows-native functional probes, TypeScript and Python
scientific golden suites, and the Phase 7 boundary verifier. The explicit
tarball rerun prevents a clean checkout from silently skipping the test before
the tarball exists. `release-metadata.json` pins the versioned distribution
creation time, so repeated builds produce the same manifest digest instead of
embedding the wall clock.

`probe:phase7-live` writes `dist/reports/phase7-live-e2e.json`. It clones the
pinned Rasterio repository, reads the public Rasterio documentation PDF,
registers the public `RGB.byte.tif` GeoTIFF, performs a source-tree-bound
reproduction test, runs geospatial checks and a frozen formal experiment,
commits a ResultRecord, validates citation/geodata/experiment domains, obtains
independently checked and user-approved Claims, builds a complete WritingPacket,
and passes manuscript traceability. Session Telemetry remains disabled and all
Providers are drained and disposed before temporary state is removed.

## DeepSeek Visual Extension

The 2026-08-21 visual-model extension remains inside the completed Phase 7
release boundary. `@georesearch/dsh-file-service` calls the official
`deepseek-v4-flash-vision-exp` Chat Completions route for direct images,
rendered PDF pages, and every approved embedded document image within the byte
and archive safety envelopes, without a plugin-defined image-count cap. PPTX
package thumbnails are excluded and slide relationships attach content images
to bounded slide text and speaker-note context. It resolves the managed
`DEEPSEEK_API_KEY` per request, rejects provider error-body reflection, bounds
request and response sizes, retries transient failures under one timeout,
preserves caller cancellation, and falls back to selected-model native vision
and local OCR.

The deterministic suite mocks the HTTPS boundary and covers success metadata,
missing credentials, HTTP failure, timeout, cancellation, response limits,
TIFF/BMP transcoding, PDF multi-page analysis, PPTX thumbnail exclusion,
slide-linked Office multi-image analysis beyond the native four-image limit,
transient transport/503 recovery, XML escaping, and pure-image full-page drop
routing. Official facts and local
policy are recorded in `deepseek-vision.md`; the release boundary verifies both
the implementation constants and that document.

## Release Evidence

The 44 release criteria in the development guide are covered as follows:

| Criteria | Evidence |
| --- | --- |
| 1-6 | Tree-external managed distribution, source-tree immutability, Profile order, staged and real Home patch probes, generation journal, activation marker, fault injection, and recovery tests. |
| 7-18 | Preset/Skill discovery, Service/Provider/Consumer layering, packed runtime assets, pinned upstream identity, fixed child roles and schemas, delegated-session rejection, live Coordinator identity, formal-run authority, Experiment restrictions, and bounded PromptContext. |
| 19-28 | Workspace-external authority, exact cwd binding, Windows mutex and abandoned-owner recovery, crash-recoverable state, operation replay protection, Artifact snapshot hashing, stale propagation, formal Run isolation, and Python Provider lifecycle. |
| 29-35 | Artifact-only PDF access, owner-bound atomic Continuations, deterministic pagination transitions, credential epoch invalidation, and fail-closed Session Telemetry. |
| 36-42 | CRS/alignment/NoData/leakage checks, mandatory Validators, immutable Reviewer records, WritingPacket-only Writing role, preserved negative results, and complete numeric and literature traceability. |
| 43 | The public Rasterio repository/PDF/GeoTIFF end-to-end activation report. |
| 44 | Performance, trajectory anchoring, and model comparison remain explicitly outside the release gate. |

## Release Documents

- `installation-and-operations.md` covers install, upgrade, verify, recovery,
  reconciliation, and uninstall.
- `provider-extension.md` defines Provider lifecycle, security, authority, and
  integration requirements.
- `compatibility-matrix.md` pins the supported runtime and attachment formats.
- `deepseek-vision.md` pins the official visual-model facts, request envelope,
  credential handling, fallback order, and untrusted-image boundary.

The Phase 7 boundary fails if any of these documents, release scripts, package
versions, compatibility peers, tarball evidence, Windows tests, golden cases,
or live-probe invariants drift.

## Historical Execution Record

The following values are a dated deployment snapshot, not proof for the
current source tree. Current release acceptance requires fresh successful
`phase7:gate`, `pack`, and, when public activation is being claimed,
`probe:phase7-live` outputs.

The final Windows release run completed on 2026-08-21 (Asia/Shanghai) with 63
test files and 297 tests passing. The distribution contained 26 package
tarballs, 35 isolated package imports, 34 bundle schemas, the clean-home
installer case, Windows DPAPI coverage, and both TypeScript and Python
scientific golden suites. All 44 Phase 7 release criteria passed, including the
automatic DeepSeek visual-understanding boundary.

The production Home was upgraded to product version `0.1.0`, installation
generation 31. A post-upgrade installer verification passed with both
`dumpConfigVerified` and `runtimeProbeVerified` set to `true`. Its dependency
lock exactly matches the final distribution for all 25 runtime packages and the
Python tree digest; the installer tarball is intentionally excluded from the
runtime lock.

A post-install live provider smoke test called
`deepseek-v4-flash-vision-exp` through the installed file-service and correctly
transcribed the test labels `VISION 42` and `RED SQUARE` while identifying the
red square. The request completed with 303 prompt tokens and 25 completion
tokens. This network smoke supplements the deterministic mocked API boundary;
it is not required for offline release-gate reproducibility.

The final public end-to-end run completed at `2026-08-18T18:19:15.573Z`
(`2026-08-19 02:19:15` Asia/Shanghai). All 17 business checks and all seven
Provider lifecycle checks passed, including real-current-user Windows DPAPI,
and the temporary public-test state was removed.

The final regression set also proves that:

- Coordinator report verification uses a host-only geospatial inspection path
  without widening the public Experiment identity boundary.
- Python worker shutdown tolerates a closed subprocess pipe without an
  unhandled `EPIPE`.
- legacy Project snapshots receive every Phase 6 map through additive
  migration.
- authenticated maintenance activation probes do not recover Evidence or
  reconcile Runs before `active.json` commits.
- a real Harness failure after `activation-probed` leaves a legacy Project
  snapshot byte-for-byte unchanged before and after transaction recovery.
