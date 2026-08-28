# GeoResearch for DeepSeek Harness

English | [中文](README.zh.md)

GeoResearch is an evidence-grounded scientific research agent plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It turns a
research question, a set of papers, source repositories, and scientific data
into a persistent, auditable workflow for literature review, reproduction,
geospatial experiments, validation, and manuscript preparation.

> **Current status:** `0.1.0` is a private release candidate. The repository is
> available only to invited collaborators, and the npm packages have not been
> published. The complete local release gate has passed; public distribution
> remains disabled until explicitly authorized.

GeoResearch targets DeepSeek Harness `0.1.0-rc.5` and implements a DSH Standard
Community v0.15 Host component. See the
[compatibility matrix](docs/compatibility-matrix.md) for the exact supported
environment.

## What GeoResearch Does

GeoResearch is designed for research work that must remain inspectable after
the conversation ends. It stores the important parts of a project as typed,
versioned records instead of relying only on chat history.

```text
Research brief
  -> literature, papers, files, and repositories
  -> reproduction plans and experiments
  -> independent validation
  -> user-approved claims
  -> writing packet and manuscript
```

The Coordinator can delegate bounded work to literature, experiment, review,
and writing specialists, but Host services remain responsible for authoritative
project state, formal runs, evidence, validation, claims, and final
deliverables.

## Core Capabilities

| Area | What you can do |
| --- | --- |
| Research projects | Turn a question into a persistent ResearchBrief, track project state, retain artifacts, and resume work across sessions. |
| Literature and evidence | Search Crossref, read papers, register source records, retain evidence-grade PDF receipts, and validate citations. |
| Files and attachments | Inspect mixed uploads including PDF, Office/OpenDocument files, EPUB, notebooks, archives, source code, images, SQLite, HDF5, NetCDF, and Parquet. |
| Repository reproduction | Audit Git repositories through a bounded read-only provider, compare methods with code, define reproduction plans and tests, and retain reproducible reports. |
| Geospatial experiments | Inspect scientific and raster data, validate spatial identity and CRS, create frozen experiment specifications, run approved Python work, and record derived results. |
| Validation and writing | Require independent review before claims are approved, build traceable WritingPackets, and draft manuscripts only from validated project records. |
| Specialist skills | Use built-in protocols for literature review, geospatial data, remote-sensing experiments, spatial statistics, paper reproduction, scientific validation, and manuscript writing. |

Automatic image and document-image understanding uses
`deepseek-v4-flash-vision-exp` when a managed `DEEPSEEK_API_KEY` is available.
Native-model vision and local OCR remain explicit fallbacks. Instructions found
inside uploaded images are always treated as untrusted data.

## Safety and Traceability

- Candidate work and authoritative records are separated. A specialist cannot
  silently turn its own output into accepted evidence, a formal result, or a
  scientific claim.
- Project records, artifacts, runs, evidence, reviews, claims, and writing
  packets are content-bound and checked before downstream use.
- Repository access is read-only. Experiment execution is bounded and runs
  through managed services instead of exposing a generic shell entry point.
- Installation, upgrade, recovery, verification, and uninstall are explicit
  operations. The installer does not use `postinstall` and does not modify the
  DeepSeek Harness source tree.
- Session telemetry is disabled in the managed GeoResearch runtime.

The exact permissions and standard component identity are documented in
[DSH Standard conformance](docs/dsh-standard-conformance.md).

## Requirements

| Component | Supported version |
| --- | --- |
| Operating system | Windows 10 or Windows 11 x64 |
| DeepSeek Harness | `0.1.0-rc.5` with the verified GeoResearch compatibility patch |
| Node.js | `^22.19.0` or `>=24.0.0` |
| pnpm | `11.7.0` for source builds |
| Python | 3.10 or newer for geospatial workflows |
| Python packages | `rasterio` and `pyproj` for raster inspection and CRS normalization |
| Git | Available on `PATH` for repository audit and reproduction workflows |

Close running DeepSeek Harness processes before installing, upgrading,
recovering, or uninstalling GeoResearch. The default Harness home is
`%USERPROFILE%\.dsh`; set `DSH_HOME` or pass `--dsh-home` to use another path.

## Get GeoResearch

### Private preview from source

This is the currently available installation path. You need access to the
private repository and a local checkout of the supported DeepSeek Harness
source.

Clone the repository with GitHub CLI:

```powershell
gh repo clone LYP-PYL/georesearch-dsh
cd georesearch-dsh
```

Or use Git directly after configuring GitHub authentication:

```powershell
git clone https://github.com/LYP-PYL/georesearch-dsh.git
cd georesearch-dsh
```

Prepare the workspace and build the managed distribution:

```powershell
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm run distribution
```

Install and verify the private release candidate:

```powershell
$dshHome = Join-Path $env:USERPROFILE '.dsh'

node packages/installer/lib/cli.js install `
  --dsh-home $dshHome `
  --distribution-dir dist\distribution `
  --harness-root C:\path\to\deepseek-harness

node packages/installer/lib/cli.js verify --dsh-home $dshHome
```

Replace `C:\path\to\deepseek-harness` with the supported Harness source
checkout. The installer integrates GeoResearch into every existing Web Profile
that contains `@deepseek-ai/dsh-web-app` and also creates a managed
`georesearch` diagnostic Profile.

### Published npm package

After public release is authorized, the self-contained installer will be
available through npm. These commands are intentionally **not available yet**:

```powershell
$dshHome = Join-Path $env:USERPROFILE '.dsh'
npx --yes @georesearch/dsh-installer@0.1.0 install --dsh-home $dshHome
npx --yes @georesearch/dsh-installer@0.1.0 verify --dsh-home $dshHome
```

The published installer carries its complete distribution and does not require
a repository checkout or a separate `--distribution-dir`.

## First Run

Start an installed Web Profile:

```powershell
dsh --profile web
```

You can also start the managed diagnostic Profile:

```powershell
dsh --profile georesearch
```

In the Web UI:

1. Open **Settings -> Models**, configure a DeepSeek model and save the API
   credential.
2. Choose the workspace that will contain the research project and its
   deliverables.
3. Start a new session with the **GeoResearch** preset.
4. Describe the research question and attach any papers, datasets, images, or
   repositories that should form the initial evidence base.

Example requests:

```text
Create a research brief for evaluating urban heat-island change from
multi-temporal satellite imagery. Identify the evidence and data still needed.
```

```text
Search the literature for validation strategies for spatially autocorrelated
remote-sensing models, then register the strongest sources in this project.
```

```text
Inspect the attached GeoTIFF files, compare their CRS and resolution, and
propose a reproducible experiment. Do not run it until I approve the plan.
```

```text
Audit this paper and repository, build a reproduction plan, and separate
verified findings from claims that still require review.
```

## Operations

The installer supports `install`, `upgrade`, `verify`, `recover`, and
`uninstall`. Use `verify` after installation, after a Harness repair, and before
an upgrade. Use `recover` after an interrupted mutating operation instead of
manually deleting transaction files.

See [Installation and Operations](docs/installation-and-operations.md) for the
complete procedures and recovery rules.

## Documentation

- [Installation and Operations](docs/installation-and-operations.md)
- [Compatibility Matrix](docs/compatibility-matrix.md)
- [Attachment and visual-model boundary](docs/deepseek-vision.md)
- [DSH Standard conformance](docs/dsh-standard-conformance.md)
- [Provider extension guide](docs/provider-extension.md)
- [Release gate and verification evidence](docs/phase7-gate.md)

## Development

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run dsh-std:check
```

Maintainers can run the complete release-candidate gate from a clean Git
worktree:

```powershell
pnpm run release:gate
```

The gate performs deterministic tests, Windows functional probes, scientific
golden tests, DSH Standard validation, live release evidence, package linting,
and `npm publish --dry-run` for all release packages. It writes the release
manifest and checksums but never publishes or uploads a package.

## License

[MIT](LICENSE)
