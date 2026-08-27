# Phase 2.5 Universal Attachment Gate

Status: Phase 2.5 universal readable attachments remain complete under the
strict Phase 3 runtime.

Historical snapshot recorded on 2026-08-18 (not current acceptance evidence;
rerun the gate below for the current tree):

- 42 test files and 191 tests passed.
- 18 package tarballs passed isolated verification without package-manager
  installation or workspace links.
- 24 packed package and subpath imports, the Web client bundle, and 12 bundled
  schemas passed from the isolated materialization.
- The isolated install removed every bundled Host parsing dependency and still
  passed PDF text/page-image, DOCX, legacy XLS, HDF5, NetCDF, Parquet, TIFF,
  and BMP tool probes.
- Python hello/deadline/cancel and Windows DPAPI CurrentUser round-trip and
  binding-rejection probes passed.
- The boundary report returned `phase2Complete: true`,
  `phase2_5Complete: true`, and `phase3Started: true`.
- Final Installer verification passed on installation generation 26 with all
  four runtime reports current and Session Telemetry absent.

Run the complete Windows gate from the workspace root:

```powershell
pnpm run phase2.5:gate
```

The gate reruns the complete Phase 2 foundation and then verifies these Phase
2.5 boundaries:

- A capture-phase document drop handler accepts mixed multi-file batches from
  the full Web page. PNG, JPEG, WebP, and GIF-only batches use the same
  GeoResearch upload path so automatic visual analysis cannot be bypassed.
- The file picker accepts multiple files. One batch is limited to 32 files and
  512 MiB, with a 256 MiB per-file ceiling and four concurrent browser
  uploads. The Composer keeps one persistent row per file with its own icon,
  name, format, progress/result status, retry, and exact-reference delete.
- A reference chip is inserted immediately. Message serialization waits for
  the matching upload promise, rejects a failed upload, and resolves persisted
  references through the Host after a page reload.
- Browser media types are advisory only. The Host derives the media type from
  bounded leading bytes, records detector provenance, streams SHA-256 while
  writing a private temporary file, and publishes an immutable
  content-addressed Artifact without a Workspace source path.
- Artifact publication is limited to byte-derived formats with an approved
  content reader. Recognized but unreadable binaries fail before commit rather
  than producing a metadata-only attachment.
- Sidecar records bind each attachment to the exact live Agent, Session,
  Project, and Workspace. GET, tool reads, and archive reads reauthorize that
  identity and revalidate Artifact digest, size, media type, and Workspace.
- Direct text reading covers common text, structured/tabular/geospatial text,
  logs, TeX, BibTeX, RIS, and mainstream source formats including C/C++, C#,
  Java/Kotlin, Go, Rust, Swift, MATLAB, Fortran, R, Julia, Python, JavaScript/
  TypeScript, PHP, Ruby, Perl, Lua, Shell/PowerShell, HDL, CUDA/OpenCL, Web
  components, query languages, and configuration files. Unknown extensions
  remain readable when their bounded bytes are valid UTF-8 or UTF-16 text.
  Native PNG/JPEG/WebP/GIF files are automatically analyzed with
  `deepseek-v4-flash-vision-exp`. TIFF and BMP are decoded under input, pixel,
  page, and output-byte limits and transcoded to PNG before analysis;
  multi-page TIFF uses a 1-based page cursor. Provider failure retains native
  Harness vision and local OCR fallbacks.
- PDF uses the same `attachment_read` tool as other readable attachments. It
  accepts a 1-based page cursor, returns bounded page text and pagination, and
  renders and automatically interprets every selected page as JPEG. Whole-page
  rendering covers scanned pages, vector charts, and embedded images.
- DOC, DOCX, XLS, XLSX, PPT, PPTX, ODT, ODS, ODP, EPUB, Jupyter Notebook,
  SQLite, HDF5, NetCDF classic/64-bit-offset, and Parquet use the same
  `attachment_read` tool with bounded text windows. The readers preserve
  document sections, slides and notes, stored worksheet/cell values, chapters,
  Notebook cell types and stored text outputs, database schemas and sample
  rows, scientific-data dimensions/attributes/schema, and bounded values.
  Bounded embedded PNG/JPEG/WebP/GIF content is automatically interpreted by
  the DeepSeek visual model on the first read window. Formulas, macros,
  Notebook code, database
  extensions, external HDF5 links/virtual sources, and uploaded source files
  are never executed or followed.
- Existing sidecar records classified before these readers were installed are
  lazily upgraded only after Agent/Session/Workspace identity and Artifact
  digest, size, media type, and location checks pass.
- CDF-5, audio, video, executables, unknown binaries, and untyped OLE
  containers are recognized but rejected before Artifact commit. A successful
  upload is never retained as `provider-required` or `metadata-only`.
- ZIP, TAR, and TAR.GZ can be listed and read without extracting into the
  Workspace. Absolute paths, traversal, NTFS alternate streams, duplicate
  paths, links, devices, encrypted ZIP entries, excessive entry counts,
  excessive expansion, oversized entries, deep/long paths, and abnormal
  compression ratios fail closed. Nested archive traversal is disabled.
- TAR.BZ2, TAR.XZ, 7Z, and RAR are recognized but rejected at upload because no
  approved bounded parser exists. ZIP, TAR, and TAR.GZ are the stored readable
  archive formats.
- `attachment_list`, `attachment_inspect`, `attachment_read`, `archive_list`,
  `archive_read`, and `attachment_read_image` are available to the coordinator,
  literature, experiment, and reviewer actors. The writing role remains bound
  to approved writing packets.
- Installer verification requires the File Service between Project and Run,
  verifies its Web client bundle, imports its packed Host and client entries,
  and reads Phase 1, Phase 2, and Phase 2.5 reports from one bounded Harness
  boot.

The runtime configuration deliberately remains:

```yaml
strictCatalog: true
capabilityStage: phase3
```

No separate Office, Notebook, or scientific-data model tool is present:
bounded content reading belongs to the universal attachment service. Phase 3
adds `paper_read` only for evidence-grade reads of registered PDF Artifacts;
ordinary PDF understanding remains on `attachment_read`.
