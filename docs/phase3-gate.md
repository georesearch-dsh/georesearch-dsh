# Phase 3 Literature / Evidence Gate

Status: Phase 3 implementation and live activation complete. The reproducible
fixture/distribution gate, the external live activation, and the final Harness
upgrade are recorded separately so provider availability does not make the
offline gate nondeterministic.

Historical snapshot recorded on 2026-08-18 (not current acceptance evidence;
rerun the deterministic and live gates below for the current tree):

- 42 test files and 191 tests passed.
- 18 tarballs, 24 packed imports, and 12 bundled schemas passed isolated
  verification without a package-manager install or workspace links.
- The Phase 3 boundary reported six Literature tools, eight Phase 3 schemas,
  Crossref capability, Host-only evidence commit, and disabled telemetry.
- Final Installer verification passed on installation generation 26 with
  `dumpConfigVerified: true`, `runtimeProbeVerified: true`, and all four
  runtime reports bound to generation 26.
- The live report used Crossref Provider `1.1.0`, advanced generation 1 to 2,
  replayed the consumed continuation exactly with no additional Provider
  request, downloaded the 15-page arXiv PDF, committed Source and Evidence
  records, returned a valid citation, and used real Windows CurrentUser DPAPI.

Run the complete Windows gate from the workspace root:

```powershell
pnpm run phase3:gate
pnpm run probe:phase3-live
```

The first command reruns every earlier foundation. The second writes
`dist/reports/phase3-live-activation.json` and requires Crossref, arXiv, and a
real interactive Windows user profile for DPAPI. Together they prove these
Phase 3 boundaries:

- `literature_search` creates a fixed Crossref Search Chain from normalized
  query and filters. `literature_continue` accepts only an opaque continuation
  ID and cannot override provider, credential binding, query, filters, page,
  offset, or upstream state.
- Continuations bind Project, Workspace binding, root Session, operator scope,
  Profile, required Literature role, Provider version, continuation format,
  and credential epoch. Private upstream state is encrypted and never returned
  to the model.
- Advance state persists `dispatched-unknown` before Provider dispatch, fences
  reservations by epoch, records an immutable Outcome, and atomically consumes
  the token with its exact result and successor. Recovery replays the original
  read only when no Outcome exists; consumed retries never access the Provider.
- Empty and duplicate-only pages advance transparently, Provider item IDs are
  deduplicated across the whole chain, unchanged upstream states revoke the
  continuation, and chain/page/result limits remain bounded.
- Crossref requests share rate limits, honor bounded Retry-After handling,
  propagate cancellation and timeout through response reads, close rejected
  response bodies, and participate in admission, drain, and disposal. The
  Provider uses a bounded stateless offset rather than Crossref's stateful
  scroll cursor, so crash replay reissues the same immutable read request.
- Ordinary uploaded PDF understanding remains on `attachment_read`.
  `paper_read` accepts only a current committed PDF Artifact and uses the same
  verified file handle for digest validation and parsing. Receipts bind PDF
  digest, exact pages, page-text digests, root Session, operator scope, and
  parser lineage.
- `source_resolve` deterministically commits a SourceRecord from an owned Search
  Chain item. `evidence_candidate` re-reads the same Artifact and verifies the
  source, receipt, page range, page digests, quotation, and lineage without
  committing state.
- The Literature child has six model tools and no commit tool. When its final
  structured output is a strict Evidence Candidate, the `delegate_literature`
  Host wrapper revalidates it under the root Coordinator identity and commits
  the authoritative EvidenceRecord. Generic literature candidates remain
  uncommitted.
- `citation_check` traces committed Evidence to SourceRecord, Search Chain,
  Provider trace, PDF digest, page receipt, and parser lineage.
- Eight standalone Phase 3 JSON Schemas match their runtime contracts. The
  Installer requires both Phase 3 packages, the Evidence Service composition,
  the normally disabled Phase 3 probe, packed imports, and all four runtime
  reports before publishing a generation.
- Session Telemetry remains absent during fixture, staged runtime, live
  Provider, registered PDF, and final Harness verification.

The shipped runtime configuration is:

```yaml
strictCatalog: true
capabilityStage: phase3
```

WAV, MP4, CDF-5, 7Z, and RAR remain outside this phase. They continue to fail
closed before Artifact publication rather than becoming metadata-only uploads.
