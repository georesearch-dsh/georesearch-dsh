# Geospatial Diagnostic Guide

Use this reference when metadata, alignment, geometry, or scale decisions affect
the analysis. Record observed properties before proposing transformations.

## Coordinate reference systems

Establish:

- CRS identifier and full definition;
- horizontal and vertical datum;
- axis order and coordinate units;
- area of use and transformation availability;
- coordinate epoch when time-dependent reference frames matter.

Use a projected CRS suitable for the region and quantity only after the target
operation is known. Distance, area, direction, and shape preservation are
different requirements. For large regions, antimeridian crossings, polar data,
or global work, consider geodesic computation instead of assuming one planar
projection is adequate.

Never assign a CRS to coordinates merely because the values look plausible.
Assignment declares identity; reprojection transforms known identity.

## Raster checks

Record for every band:

- width, height, affine transform, grid origin, pixel size, and orientation;
- CRS, extent, data type, band name, unit, scale, offset, and NoData;
- masks, quality flags, overviews, and processing level;
- pixel-is-area or pixel-is-point interpretation;
- acquisition time or compositing period.

Two rasters with the same nominal resolution are not necessarily aligned.
Check grid origin, transform, dimensions, and extent.

Choose resampling by variable meaning:

| Data type | Typical valid choices | Avoid |
|---|---|---|
| Class, code, mask, identifier | nearest or justified mode | bilinear and cubic interpolation |
| Continuous physical field | bilinear, cubic, area-weighted, or domain method | nearest when discontinuities are not intended |
| Count or total | conservative aggregation preserving totals | interpolation that changes the total |
| Fraction or probability | bounded, support-aware aggregation | values outside the valid range |

Document edge handling and whether the operation changes spatial support.

## Vector checks

Inspect:

- geometry type and dimensionality;
- validity, empty geometries, duplicates, multipart features, and self-crossings;
- topology assumptions such as overlap, adjacency, gaps, or containment;
- feature identifiers and one-to-one or one-to-many joins;
- attribute units, categories, missing values, and temporal validity.

Geometry repair is a scientific transformation. Record the algorithm, affected
features, area or topology change, and whether repaired objects remain suitable
for the analysis.

## Spatial joins and overlays

Define the intended relation: intersects, contains, within, nearest, overlap
fraction, shared boundary, or temporal-spatial match. Boundary points and ties
can change assignments. State the rule and preserve unmatched and multiply
matched cases for review.

Do not perform planar distance joins in geographic degrees unless the method is
explicitly designed for that coordinate system.

## NoData, masks, and missingness

Distinguish:

- file-level NoData sentinels;
- validity or cloud masks;
- algorithmic failure;
- unobserved areas;
- values that are scientifically zero;
- values excluded by the sampling design.

Mask order matters. Applying different masks to predictors, labels, and models
can create incomparable samples. Record the final analysis population and the
reason each observation is absent.

## Scale and support

State whether values represent points, pixels, cells, objects, plots, polygons,
or regional aggregates. Avoid attributing aggregate relationships to
individual units. Examine whether conclusions change under defensible
aggregation, resolution, neighborhood, or zoning choices.

When upscaling or downscaling, state whether the variable is intensive,
extensive, categorical, compositional, or bounded. The valid aggregation rule
depends on that distinction.

## Leakage and dependence

Look beyond identical sample identifiers. Leakage may arise through:

- overlapping tiles or patches;
- adjacent windows from the same scene;
- multiple observations of the same object or plot;
- labels generated from predictors or later dates;
- normalization or feature selection fitted on all data;
- temporal overlap or future information;
- shared source products across split roles.

Choose split units that separate the dependence source relevant to the
generalization claim.

## Readiness decision

Classify the data as:

- ready: identity, compatibility, lineage, and analysis population are clear;
- ready-with-transformations: explicit transformations can make the data fit;
- exploratory-only: limitations prevent confirmatory or generalizable claims;
- blocked: essential identity, lineage, sampling, labels, or coverage is
  missing.

Every transformation plan should name its input artifacts, parameters, output
artifact, and effect on support and uncertainty.
