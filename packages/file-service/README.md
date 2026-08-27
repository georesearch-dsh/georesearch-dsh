# @georesearch/dsh-file-service

Phase 2.5 universal readable attachments for GeoResearch. It provides bounded,
session-bound uploads, immutable Artifact publication, byte-derived media
classification, safe ZIP/TAR inspection, Agent read tools, and a browser
client for mixed multi-file drag/drop and file picking. A new upload is only
accepted when its derived format has an approved content reader.

The browser upload route is registered only when the host provides a
`webServer` service. Headless compositions still activate the file service and
its model-facing read tools; they simply have no HTTP upload surface.

In GeoResearch sessions, common browser image batches use this same upload
path instead of bypassing the service through Harness-native image submission.
This makes automatic visual analysis available for pure image drops as well as
mixed batches.

The composer attachment rail is the authoritative per-file upload surface. It
keeps every queued, uploading, failed, or completed item visible until that
specific attachment is deleted or sent, and gives each item its own format,
status, retry, and delete controls. Uploading a file does not insert a
placeholder, filename, whitespace, or any other character into the editable
Composer draft. The attachment list is persisted independently and hydrated
from Host metadata after a page reload. Legacy placeholder-based drafts are
migrated by removing each owned placeholder and its generated separator.

At submission, the browser waits for the selected uploads and adds their
model-facing XML in the Session log while the Web history projects them as
file cards with the stored name and media format; legacy id-only references
resolve their display metadata through the Host.

`attachment_read` handles byte-window text and source code, page-window PDFs,
modern and legacy Office/OpenDocument/EPUB containers, Jupyter Notebooks,
SQLite, HDF5, NetCDF classic/64-bit-offset, and Parquet. DOC/DOCX body text,
PPT/PPTX slide text and speaker notes, XLS/XLSX/ODS stored sheet values,
ODT/ODP text, EPUB chapters, Notebook cells and stored text outputs, SQLite
schemas and row samples, scientific-data metadata, and bounded dataset/row
samples are normalized into structured text. Every approved embedded
PNG/JPEG/WebP/GIF image within the per-image, cumulative-byte, and archive
safety envelopes is automatically interpreted by
`deepseek-v4-flash-vision-exp` on the first read window with three concurrent
provider calls. There is no plugin-defined image-count cap. PPTX package
thumbnails are excluded; each presentation image
is linked to every slide that uses it, and the vision request includes the
bounded slide text and speaker notes so visual evidence can support, complement,
qualify, or conflict with the surrounding text. Formulas, macros,
Notebook code, database extensions,
external HDF5 links/virtual sources, and uploaded source files are never
executed or followed.

The text reader recognizes mainstream C/C++, C#, Java/Kotlin, Go, Rust, Swift,
MATLAB, Fortran, R, Julia, Python, JavaScript/TypeScript, PHP, Ruby, Perl, Lua,
Shell, PowerShell, HDL, CUDA/OpenCL, functional-language, Web component, query,
configuration, geospatial text, TeX, citation, and documentation formats. Any
otherwise unknown file whose bytes are valid bounded UTF-8 or UTF-16 text is
also directly readable.

For each selected PDF page the reader extracts bounded text and renders the
complete page to JPEG, so scans, charts, vector graphics, and embedded images
receive semantic visual analysis without a separate PDF-only tool. Up to four
selected pages are analyzed concurrently. A failed provider call retains the
existing native-image and local OCR fallbacks.

`attachment_read_image` automatically calls
`deepseek-v4-flash-vision-exp` for PNG/JPEG/WebP/GIF and safely transcodes TIFF
or BMP to bounded PNG first. The optional `question` argument focuses the
analysis. Multi-page TIFF files use a 1-based page cursor; input bytes, page
count, decoded pixels, and output bytes are all capped.

The provider request places the image block before the variable question so a
repeated image can retain the longest possible exact prefix. The long-lived
file service also keeps a 64-entry LRU-style cache of successful analyses keyed
by the exact image bytes, media type, purpose, normalized question, model
policy, output cap, and managed credential. Exact repeats return with
`cache-status="local-exact-hit"` and zero incremental usage without issuing a
provider request. Identical requests that arrive concurrently are coalesced
behind the first in-flight provider call, so parallel specialists do not pay
for duplicate cold reads. Image bytes are hashed for the key and are not
retained by the cache.

The Host resolves the existing managed `DEEPSEEK_API_KEY` credential for each
request and sends it only to the fixed official HTTPS endpoint. Transient
transport failures and HTTP 408/429/500/502/503/504 responses are retried up to
five total attempts under one timeout budget. Missing credentials, terminal
timeouts or HTTP failures, oversized responses, and malformed provider output
are explicit model-visible fallbacks: selected-model
native vision is tried when available, followed by bounded local
English/Simplified-Chinese OCR. Image-visible instructions are untrusted data
and returned provider text is XML escaped. Official capability facts and local
bounds are recorded in `docs/deepseek-vision.md`.

Uploaded content is never executed. Archive links, devices, absolute paths,
path traversal, NTFS alternate streams, excessive expansion, and unsupported
archive encodings are rejected before an entry is exposed. CDF-5, audio/video,
executables, unknown binaries, OLE containers without a matching DOC/XLS/PPT
extension, 7Z, RAR, TAR.XZ, and TAR.BZ2 are recognized but rejected before
Artifact publication because no bounded semantic reader exists. No successful
upload is left in `provider-required` or `metadata-only` state.
