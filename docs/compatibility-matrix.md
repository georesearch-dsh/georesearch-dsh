# Compatibility Matrix

GeoResearch `0.1.0` is a pinned Windows release. Compatibility is granted only
for combinations that pass the complete release gate; semver similarity alone
does not imply support.

| Component | Supported | Evidence and boundary |
| --- | --- | --- |
| DeepSeek Harness | `0.1.0-rc.5` plus `structured-output-bounded-recovery-and-array-limits-v2` | Official source archive commit `47f943859bef60e4160492346772ded9b24f765a`; archive and source-tree digests are recorded in `phase0-baseline.json`, and every permitted local difference is fixed by `harness-local-patch.json`. |
| DeepSeek visual model | `deepseek-v4-flash-vision-exp` through the official API | Experimental model released 2026-08-21. GeoResearch uses `https://api.deepseek.com/chat/completions` with the managed `DEEPSEEK_API_KEY`; exact limits and sources are recorded in `deepseek-vision.md`. |
| Cordis | `4.0.1` only | Direct Harness imports are confined to `@georesearch/dsh-compat-rc5`. |
| Node.js | `^22.19.0` or `>=24.0.0` | Enforced by every runtime package engine declaration. |
| pnpm | Workspace declares `11.7.0` | Release builds require an up-to-date frozen lockfile. Later pnpm 11 builds are development-only until the full gate passes. |
| Operating system | Windows 10/11 x64 | Windows named mutex, directory publication preflight, DPAPI CurrentUser protection, clean-home install, and native path tests are release gates. |
| Python | 3.10 or newer | Required for `georesearch-worker/1`; the active version is recorded by live probes. |
| Raster runtime | `rasterio` and `pyproj` available | Required for GeoTIFF inspection and CRS normalization in Phase 5/7. Exact active versions are recorded, not assumed. |
| Git | CLI available on `PATH` | Required for read-only RepositoryAudit and public reproduction probes. |

Linux, macOS, ARM Windows, later Harness release candidates, later Cordis
versions, and alternative package managers are not release-qualified by this
matrix. They may be used for exploratory development only.

## Attachment Content Support

The universal attachment layer accepts multiple mixed files in one full-page
drop and publishes an Artifact only after an approved reader recognizes the
content.

| Category | Supported content understanding |
| --- | --- |
| Text and source | Plain text, Markdown, JSON, JSONL, YAML, XML, HTML, CSV/TSV, logs, diffs, notebooks, and mainstream source-code extensions handled as bounded text. |
| Documents | PDF text plus automatic semantic page analysis; DOCX/XLSX/PPTX, ODT/ODS/ODP, EPUB, and legacy DOC/XLS/PPT text plus bounded embedded-image analysis. |
| Archives | ZIP and bounded TAR/GZIP inspection with path, count, depth, and expanded-byte limits. |
| Images | Uploaded and workspace PNG/JPEG/WebP/GIF use automatic DeepSeek visual analysis; TIFF/TIF and BMP use bounded PNG transcoding first. GeoResearch scopes override `read_image`, so the primary route does not require the selected Harness model to accept images; native-model vision and local OCR remain fallbacks. |
| Scientific data | SQLite schema and bounded rows; HDF5; NetCDF classic formats; Parquet schema and bounded samples. |

WAV, MP4, CDF-5, 7Z/RAR, executables, and unknown binary formats are deliberately
paused or rejected for this release. A filename extension alone never upgrades
an unsupported binary into a readable Artifact.

## Upgrade Rule

Any Harness or Cordis upgrade requires a new baseline capture, Compatibility
Adapter review, Phase 1 contract probe, Installer generation/recovery audit,
Operation and Continuation Store review, telemetry audit, and complete Phase 7
gate. Compatibility branches must remain in the adapter package rather than
spreading through domain Services.
