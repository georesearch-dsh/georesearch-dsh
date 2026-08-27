# Phase 5 Gate: Geospatial and Experiment

Phase 5 adds a persistent Python geospatial Provider, deterministic dataset inspection,
frozen experiment protocols, amendments, formal-run binding, and authoritative result
registration.

## Authority boundaries

- The Experiment role may inspect registered geospatial Artifacts and propose an
  `ExperimentSpecCandidate`.
- Only the root Coordinator may freeze an `ExperimentSpec`, commit an Amendment, or
  register results.
- `result_commit` accepts only `expectedGeneration` and `runId`. Metric values are
  parsed from the single `GEORESEARCH_RESULT_V1` envelope in a succeeded formal Run.
- Dataset manifests, experiment specs, amendments, and result records live in Project
  state outside the research workspace.
- Session Telemetry remains disabled during all real-data activation probes.

## Deterministic checks

The Python Provider reports CRS, extent, raster alignment, NoData, band and label
schema, classification resampling, spatial/temporal leakage, and spatial-statistical
configuration. Mandatory failures block protocol freezing.

## Verification

Run the local boundary gate:

```powershell
pnpm run phase5:gate
```

Run the public Natural Earth case separately when network access is available:

```powershell
$env:DSH_TELEMETRY_DISABLED = '1'
pnpm run probe:phase5-live
```

The live report is written to `dist/reports/phase5-live-activation.json`. The case
must recognize RFC 7946 as `OGC:CRS84` and reject a deliberately leaked spatial split
with `SPATIAL_LEAKAGE_DETECTED`.
