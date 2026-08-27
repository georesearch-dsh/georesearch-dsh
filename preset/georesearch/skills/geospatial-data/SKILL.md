---
name: geospatial-data
description: Inspect and plan work with vector, raster, Earth-observation, and spatial datasets in DeepSeek Harness, including CRS, grids, scale, NoData, geometry, labels, temporal coverage, and leakage.
---

# Geospatial Data

Use this skill before analysis whenever spatial identity, scale, alignment, or
lineage could change the scientific meaning of the data.

This is a core Skill for Experiment `data-assessment` and a supporting Skill
for Literature, Experiment, and Reviewer tasks. Return spatial observations and
method consequences to the owning role. Do not convert a data diagnosis into a
literature conclusion, frozen experiment protocol, or independent review unless
the active specialist task owns that decision.

## Establish the data role

Identify whether each dataset is an outcome, predictor, label, covariate,
mask, sampling frame, validation reference, or contextual layer. Record its
source, version, acquisition period, processing level, license, lineage, and
known limitations.

Use `attachment_list`, `attachment_inspect`, and `attachment_read` only when actual uploaded material is identified by the task or Host authority. Workspace paths
such as `inputs/...` are files: inspect them with `read` or `read_image` and do
not probe attachment tools merely because they are visible. Use `read_image` or
`attachment_read_image` for visual inspection when the scientific question
depends on image content. Treat visual interpretation as an observation with
uncertainty, not a substitute for metadata or quantitative analysis.

## Inspect before comparing

For every spatial asset, identify as applicable:

- horizontal and vertical CRS, datum, axis order, coordinate units, and epoch;
- spatial and temporal extent, resolution, support, and sampling unit;
- raster dimensions, affine transform, grid origin, band meaning, data type,
  scale, offset, NoData, masks, and pixel-is-area or pixel-is-point semantics;
- vector geometry type, validity, multipart behavior, topology, and attribute
  definitions;
- antimeridian, polar, wraparound, and geodesic-versus-planar consequences;
- label provenance, class definitions, class imbalance, and reference quality.

Never compare coordinates, areas, distances, pixels, or cell values until the
relevant properties are compatible.

For a detailed diagnostic sequence and resampling choices, read
`references/geospatial-diagnostics.md`.

## Diagnose analytical risks

Check for:

- missing or ambiguous CRS and transformations;
- grid misalignment, unequal support, and unintended resampling;
- invalid geometries, duplicate features, topology errors, and slivers;
- NoData values treated as valid observations;
- scale or offset ignored during numeric interpretation;
- spatial or temporal overlap between training, validation, and testing units;
- samples that share source scenes, tiles, objects, households, plots, or time
  windows across evaluation roles;
- resolution or aggregation choices that change the estimand;
- coverage gaps and selection mechanisms that limit external validity.

When registered Artifact identifiers and required metadata are available, use
`geodata_inspect` for deterministic CRS, alignment, NoData, leakage, optical,
and declared spatial-statistical checks. Its report is authoritative for the
checks it performs; it does not replace scientific interpretation.

## Plan corrections explicitly

Separate observations from proposed corrections. For every proposed
reprojection, resampling, clipping, aggregation, imputation, geometry repair,
or label transformation, state:

- why it is necessary;
- the algorithm and parameters;
- which variables it is valid for;
- how it changes spatial support or uncertainty;
- what artifact and lineage record should be produced.

Do not mutate source data, silently select a CRS, or use interpolation designed
for continuous values on categorical labels.

## Return a data-readiness assessment

Return the observed metadata, compatibility findings, scientific risks,
proposed preprocessing, unresolved decisions, and whether the data are ready
for descriptive analysis, inference, prediction, or formal experimentation.
Use `blocked` when essential CRS, lineage, labels, sampling units, or temporal
identity cannot be established.
