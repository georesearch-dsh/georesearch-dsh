import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  canonicalJson,
  digestTree,
  PRODUCT_VERSION,
} from '@georesearch/dsh-contracts'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { expectedDistributionPackageDigest } from './distribution-integrity.ts'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fileServiceRequire = createRequire(join(root, 'packages', 'file-service', 'package.json'))
const { encode: encodeBmp } = fileServiceRequire('bmp-js') as typeof import('bmp-js')
const UTIF = fileServiceRequire('utif2') as typeof import('utif2')
const XLSX = fileServiceRequire('xlsx') as typeof import('xlsx')
const tarballRoot = join(root, 'dist', 'tarballs')
const distributionRoot = join(root, 'dist', 'distribution')
const upstreamModulesRoot = resolve(root, '..', '.dsh', 'profiles', 'node_modules')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'georesearch-packed-install-'))
const workspacePackageNames = new Set(WORKSPACE_PACKAGES.map(entry => entry.name))
const bundledFileServiceDependencies = new Set([
  '@napi-rs/canvas',
  '@napi-rs/canvas-win32-x64-msvc',
  '@tesseract.js-data/chi_sim',
  '@tesseract.js-data/eng',
  'b4a',
  'bmp-js',
  'buffer-crc32',
  'cfb',
  'codepage',
  'events-universal',
  'fast-fifo',
  'fd-slicer',
  'fzstd',
  'h5wasm',
  'hysnappy',
  'hyparquet',
  'hyparquet-compressors',
  'iobuffer',
  'lucide-react',
  'netcdfjs',
  'pako',
  'pend',
  'pdfjs-dist',
  'ppt-to-text',
  'saxes',
  'streamx',
  'tar-stream',
  'tesseract.js',
  'tesseract.js-core',
  'text-decoder',
  'utif2',
  'word-extractor',
  'xlsx',
  'xmlchars',
  'yauzl',
])

try {
  const distributionManifest = parseDistributionManifest(JSON.parse(
    await readFile(join(distributionRoot, 'distribution-manifest.json'), 'utf8'),
  ))
  if (distributionManifest.productVersion !== PRODUCT_VERSION) {
    throw new Error('distribution manifest product version does not match the runtime contracts')
  }
  const distributionPackages = new Map(distributionManifest.packages.map(entry => [entry.name, entry]))
  const expectedTarballs = new Set<string>()
  if (distributionPackages.size !== WORKSPACE_PACKAGES.length) {
    throw new Error('distribution manifest package count does not match the workspace package catalog')
  }
  const peerNames = new Set<string>()
  const packedPackages: {
    readonly folder: string
    readonly name: string
    readonly tarball: string
    readonly manifest: PackedManifest
    readonly distribution: DistributionPackageEntry
  }[] = []
  for (const entry of WORKSPACE_PACKAGES) {
    const manifest = JSON.parse(
      await readFile(join(root, 'packages', entry.folder, 'package.json'), 'utf8'),
    ) as Record<string, unknown> & { version?: unknown; peerDependencies?: Record<string, string> }
    if (typeof manifest.version !== 'string') {
      throw new Error(`${entry.name} has no package version`)
    }
    const filename = packedFilename(entry.name, manifest.version)
    expectedTarballs.add(filename)
    const tarball = join(tarballRoot, filename)
    await assertFile(tarball, `packed tarball for ${entry.name}`)
    const distribution = distributionPackages.get(entry.name)
    if (distribution === undefined) {
      throw new Error(`distribution manifest is missing ${entry.name}`)
    }
    const expectedDirectory = `packages/${entry.name.split('/')[1] as string}`
    if (distribution.version !== manifest.version || distribution.directory !== expectedDirectory) {
      throw new Error(`distribution manifest identity mismatch for ${entry.name}`)
    }
    const distributionPackageRoot = join(distributionRoot, ...distribution.directory.split('/'))
    const distributionTree = await digestTree(distributionPackageRoot)
    if (distributionTree.digest !== distribution.treeDigest) {
      throw new Error(`distribution tree digest mismatch for ${entry.name}`)
    }
    const sourceTreeDigest = await expectedDistributionPackageDigest(
      root,
      entry.folder,
      manifest,
      PRODUCT_VERSION,
    )
    if (sourceTreeDigest !== distribution.treeDigest) {
      throw new Error(`distribution package is stale relative to the built workspace for ${entry.name}`)
    }
    const distributionPackageManifest = JSON.parse(
      await readFile(join(distributionPackageRoot, 'package.json'), 'utf8'),
    ) as PackedManifest
    const packedManifest = JSON.parse(
      runChecked('tar', ['-xOf', tarball, 'package/package.json'], root).stdout,
    ) as PackedManifest
    if (packedManifest.name !== entry.name || packedManifest.version !== manifest.version) {
      throw new Error(`packed manifest identity mismatch for ${entry.name}`)
    }
    if (canonicalJson(packedManifest) !== canonicalJson(distributionPackageManifest)) {
      throw new Error(`packed manifest differs from the distribution manifest for ${entry.name}`)
    }
    assertNoWorkspaceRanges(packedManifest, entry.name)
    for (const peerName of Object.keys(manifest.peerDependencies ?? {})) peerNames.add(peerName)
    packedPackages.push({ ...entry, tarball, manifest: packedManifest, distribution })
  }
  const actualTarballs = (await readdir(tarballRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.tgz'))
    .map(entry => entry.name)
    .sort()
  if (canonicalJson(actualTarballs) !== canonicalJson([...expectedTarballs].sort())) {
    throw new Error('dist/tarballs contains missing or unexpected package archives')
  }

  const modulesRoot = join(temporaryRoot, 'node_modules')
  const extractionRoot = join(temporaryRoot, '.extracted')
  await mkdir(modulesRoot, { recursive: true })
  await mkdir(extractionRoot, { recursive: true })
  for (const packed of packedPackages) {
    const extracted = join(extractionRoot, packed.folder)
    await mkdir(extracted, { recursive: true })
    runChecked('tar', ['-xf', packed.tarball, '-C', extracted], root)
    const destination = join(modulesRoot, ...packed.name.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(extracted, 'package'), destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
    const packedTree = packed.name === '@georesearch/dsh-installer'
      ? await digestTree(destination, { exclude: new Set(['distribution.tar']) })
      : await digestTree(destination)
    if (packedTree.digest !== packed.distribution.treeDigest) {
      throw new Error(`packed tree differs from the distribution tree for ${packed.name}`)
    }
    if (packed.name === '@georesearch/dsh-installer') {
      const embeddedRoot = join(extracted, '.embedded-distribution')
      await mkdir(embeddedRoot, { recursive: true })
      runChecked('tar', ['-xf', join(destination, 'distribution.tar'), '-C', embeddedRoot], root)
      const embeddedDistribution = join(embeddedRoot, 'distribution')
      const [embeddedTree, currentTree] = await Promise.all([
        digestTree(embeddedDistribution),
        digestTree(distributionRoot),
      ])
      if (embeddedTree.digest !== currentTree.digest) {
        throw new Error('installer distribution.tar differs from dist/distribution')
      }
    }
    const externalDependencies = {
      ...(packed.manifest.dependencies ?? {}),
      ...(packed.manifest.optionalDependencies ?? {}),
    }
    for (const dependencyName of Object.keys(externalDependencies).sort()) {
      if (workspacePackageNames.has(dependencyName)
        || bundledFileServiceDependencies.has(dependencyName)) continue
      const source = await resolveDependencyDirectory(packed.folder, dependencyName)
      await linkDirectory(source, join(destination, 'node_modules', ...dependencyName.split('/')))
    }
  }

  for (const peerName of [...peerNames].sort()) {
    const peerRoot = join(upstreamModulesRoot, ...peerName.split('/'))
    await assertDirectory(peerRoot, `upstream peer ${peerName}`)
    await linkDirectory(peerRoot, join(modulesRoot, ...peerName.split('/')))
  }

  const pdfProbePath = join(temporaryRoot, 'packed-probe.pdf')
  const pdfProbeBytes = minimalPdf()
  await writeFile(pdfProbePath, pdfProbeBytes)
  const docxProbePath = join(temporaryRoot, 'packed-probe.docx')
  const docxProbeBytes = minimalDocx()
  await writeFile(docxProbePath, docxProbeBytes)
  const xlsProbePath = join(temporaryRoot, 'packed-probe.xls')
  const xlsProbeBytes = minimalXls()
  await writeFile(xlsProbePath, xlsProbeBytes)
  const hdf5ProbePath = join(temporaryRoot, 'packed-probe.h5')
  await writeMinimalHdf5(hdf5ProbePath)
  const hdf5ProbeBytes = await readFile(hdf5ProbePath)
  const netcdfProbePath = join(temporaryRoot, 'packed-probe.nc')
  const netcdfProbeBytes = minimalNetcdf()
  await writeFile(netcdfProbePath, netcdfProbeBytes)
  const parquetProbePath = join(temporaryRoot, 'packed-probe.parquet')
  const parquetProbeBytes = minimalParquet()
  await writeFile(parquetProbePath, parquetProbeBytes)
  const tiffProbePath = join(temporaryRoot, 'packed-probe.tiff')
  const tiffProbeBytes = minimalTiff()
  await writeFile(tiffProbePath, tiffProbeBytes)
  const bmpProbePath = join(temporaryRoot, 'packed-probe.bmp')
  const bmpProbeBytes = minimalBmp()
  await writeFile(bmpProbePath, bmpProbeBytes)

  const importTargets = [
    ...WORKSPACE_PACKAGES.map(entry => entry.name),
    '@georesearch/dsh-bundle/phase1-probe',
    '@georesearch/dsh-bundle/phase2-probe',
    '@georesearch/dsh-bundle/phase25-probe',
    '@georesearch/dsh-bundle/phase3-probe',
    '@georesearch/dsh-bundle/phase4-probe',
    '@georesearch/dsh-bundle/phase5-probe',
    '@georesearch/dsh-bundle/phase6-probe',
    '@georesearch/dsh-bundle/standard-adapter',
    '@georesearch/dsh-bundle/standard-catalog',
    '@georesearch/dsh-bundle/standard-facet',
    '@georesearch/dsh-installation-guard/validation',
    '@georesearch/dsh-installation-guard/nonce-protection',
  ]
const probeSource = `
import { readFile } from 'node:fs/promises'
for (const target of ${JSON.stringify(importTargets)}) await import(target)
const {
  DSH_STANDARD_ADAPTER_VERSION,
  DSH_STANDARD_SCHEMA_URI,
} = await import('@georesearch/dsh-bundle/standard-catalog')
const packageUrl = import.meta.resolve('@georesearch/dsh-bundle/package.json')
const standardManifest = JSON.parse(await readFile(new URL('./dsh-plugin.json', packageUrl), 'utf8'))
if (standardManifest.manifestVersion !== '0.15'
  || standardManifest.id !== 'org.deepseek.georesearch'
  || standardManifest.$schema !== DSH_STANDARD_SCHEMA_URI
  || standardManifest.facets?.host?.entry !== 'lib/standard-facet.js'
  || !standardManifest.compat?.hosts?.includes('@dsh-std/adapter-dsh@' + DSH_STANDARD_ADAPTER_VERSION)) {
  throw new Error('packed DSH Standard manifest is invalid')
}
const standardAdapterSource = await readFile(
  new URL(import.meta.resolve('@georesearch/dsh-bundle/standard-adapter')),
  'utf8',
)
const standardFacetSource = await readFile(
  new URL(import.meta.resolve('@georesearch/dsh-bundle/standard-facet')),
  'utf8',
)
const unresolvedStandardImport = /(?:from\\s*|import\\s*\\(|require\\s*\\()\\s*["']@dsh-std\\//u
if (unresolvedStandardImport.test(standardAdapterSource)
  || unresolvedStandardImport.test(standardFacetSource)) {
  throw new Error('packed standard entries depend on external @dsh-std packages')
}
const clientBundleSource = await readFile(
  new URL(import.meta.resolve('@georesearch/dsh-file-service/client')),
  'utf8',
)
if (!clientBundleSource.includes('require("@deepseek-ai/dsh-client-ui-attachment")')
  || !clientBundleSource.includes('require("@deepseek-ai/dsh-client-ui-primitives")')
  || clientBundleSource.includes('MessageImage_module_css_default = {}')
  || clientBundleSource.includes('require("@georesearch/dsh-compat-rc5/client")')) {
  throw new Error('packed client bundle violates the rc.5 platform-module boundary')
}
const { CrossrefLiteratureProvider } = await import('@georesearch/dsh-evidence-providers')
const phase3Provider = new CrossrefLiteratureProvider()
if (phase3Provider.capability.providerId !== 'crossref'
  || phase3Provider.capability.replaySemantics !== 'replay-safe-read') {
  throw new Error('packed Phase 3 provider capability is invalid')
}
await phase3Provider.dispose()
const { GitRepositoryProvider } = await import('@georesearch/dsh-repository-providers')
const phase4Provider = new GitRepositoryProvider()
if (phase4Provider.capability.providerId !== 'git-cli'
  || phase4Provider.capability.shell !== false
  || phase4Provider.capability.readOnlyCommands !== true) {
  throw new Error('packed Phase 4 repository capability is invalid')
}
await phase4Provider.dispose()
const { fileTools, DEEPSEEK_VISION_MODEL, DeepSeekVisionError } = await import('@georesearch/dsh-file-service')
if (DEEPSEEK_VISION_MODEL !== 'deepseek-v4-flash-vision-exp') {
  throw new Error('packed DeepSeek vision capability is invalid')
}
let savedImages = 0
const fileService = {
  maxDirectReadBytes: 512 * 1024,
  imageUnderstandingAnalyzer: {
    analyze: async () => {
      throw new DeepSeekVisionError('MISSING_CREDENTIAL', 'packed probe intentionally has no visual credential')
    },
  },
  requireRecord: async () => ({
    path: ${JSON.stringify(pdfProbePath)},
    record: {
      attachmentId: '00000000-0000-4000-8000-000000000099',
      name: 'packed-probe.pdf',
      size: ${pdfProbeBytes.byteLength},
      mediaType: 'application/pdf',
      contentKind: 'document',
      readStrategy: 'document',
    },
  }),
}
const fileContext = {
  get(name) {
    if (name === 'attachments') return {
      imageLimits: {
        mediaTypes: ['image/jpeg', 'image/png'],
        maxImagesPerMessage: 4,
        maxImageBytes: 5 * 1024 * 1024,
        maxMessageImageBytes: 20 * 1024 * 1024,
        maxImagePixels: 4_000_000,
      },
      saveImage: async input => {
        savedImages += 1
        return {
          attachmentId: 'packed-page-image',
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 200,
          height: 200,
        }
      },
    }
    if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
    return undefined
  },
}
const pdfTool = fileTools(fileContext, fileService).find(tool => tool.name === 'attachment_read')
const pdfValue = await pdfTool.execute(
  { attachmentId: '00000000-0000-4000-8000-000000000099', page: 1, maxPages: 1 },
  {
    agent: {
      id: 'packed-agent',
      options: { provider: 'packed-provider', model: 'packed-vision' },
      session: { id: 'packed-session', requestHeader: () => undefined },
    },
    signal: new AbortController().signal,
  },
)
if (pdfValue.kind !== 'pdf' || !pdfValue.pages[0]?.text.includes('GeoResearch packed PDF') || savedImages !== 1) {
  throw new Error('self-contained PDF text/image probe failed')
}
fileService.requireRecord = async () => ({
  path: ${JSON.stringify(docxProbePath)},
  record: {
    attachmentId: '00000000-0000-4000-8000-000000000098',
    name: 'packed-probe.docx',
    size: ${docxProbeBytes.byteLength},
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    contentKind: 'document',
    readStrategy: 'document',
  },
})
const docxValue = await pdfTool.execute(
  { attachmentId: '00000000-0000-4000-8000-000000000098', byteOffset: 0 },
  {
    agent: { id: 'packed-agent', session: { id: 'packed-session' } },
    signal: new AbortController().signal,
  },
)
if (docxValue.kind !== 'structured' || docxValue.format !== 'docx' || !docxValue.text.includes('GeoResearch packed DOCX')) {
  throw new Error('self-contained structured document probe failed')
}
fileService.requireRecord = async () => ({
  path: ${JSON.stringify(xlsProbePath)},
  record: {
    attachmentId: '00000000-0000-4000-8000-000000000097',
    name: 'packed-probe.xls',
    size: ${xlsProbeBytes.byteLength},
    mediaType: 'application/vnd.ms-excel',
    contentKind: 'document',
    readStrategy: 'document',
  },
})
const xlsValue = await pdfTool.execute(
  { attachmentId: '00000000-0000-4000-8000-000000000097', byteOffset: 0 },
  {
    agent: { id: 'packed-agent', session: { id: 'packed-session' } },
    signal: new AbortController().signal,
  },
)
if (xlsValue.kind !== 'structured' || xlsValue.format !== 'xls' || !xlsValue.text.includes('Packed station') || !xlsValue.text.includes('18.5')) {
  throw new Error('self-contained legacy XLS probe failed')
}
for (const probe of [
  {
    path: ${JSON.stringify(hdf5ProbePath)},
    id: '00000000-0000-4000-8000-000000000096',
    name: 'packed-probe.h5',
    size: ${hdf5ProbeBytes.byteLength},
    mediaType: 'application/x-hdf5',
    format: 'hdf5',
    expected: 'Packed HDF5 observations',
  },
  {
    path: ${JSON.stringify(netcdfProbePath)},
    id: '00000000-0000-4000-8000-000000000095',
    name: 'packed-probe.nc',
    size: ${netcdfProbeBytes.byteLength},
    mediaType: 'application/x-netcdf',
    format: 'netcdf',
    expected: '19.25',
  },
  {
    path: ${JSON.stringify(parquetProbePath)},
    id: '00000000-0000-4000-8000-000000000094',
    name: 'packed-probe.parquet',
    size: ${parquetProbeBytes.byteLength},
    mediaType: 'application/vnd.apache.parquet',
    format: 'parquet',
    expected: 'Packed station',
  },
]) {
  fileService.requireRecord = async () => ({
    path: probe.path,
    record: {
      attachmentId: probe.id,
      name: probe.name,
      size: probe.size,
      mediaType: probe.mediaType,
      contentKind: 'data',
      readStrategy: 'data',
    },
  })
  const value = await pdfTool.execute(
    { attachmentId: probe.id, byteOffset: 0 },
    {
      agent: { id: 'packed-agent', session: { id: 'packed-session' } },
      signal: new AbortController().signal,
    },
  )
  if (value.kind !== 'structured' || value.format !== probe.format || !value.text.includes(probe.expected)) {
    throw new Error('self-contained ' + probe.format + ' probe failed')
  }
}
const imageTool = fileTools(fileContext, fileService).find(tool => tool.name === 'attachment_read_image')
for (const probe of [
  {
    path: ${JSON.stringify(tiffProbePath)},
    id: '00000000-0000-4000-8000-000000000093',
    name: 'packed-probe.tiff',
    size: ${tiffProbeBytes.byteLength},
    mediaType: 'image/tiff',
  },
  {
    path: ${JSON.stringify(bmpProbePath)},
    id: '00000000-0000-4000-8000-000000000092',
    name: 'packed-probe.bmp',
    size: ${bmpProbeBytes.byteLength},
    mediaType: 'image/bmp',
  },
]) {
  fileService.requireRecord = async () => ({
    path: probe.path,
    record: {
      attachmentId: probe.id,
      name: probe.name,
      size: probe.size,
      mediaType: probe.mediaType,
      contentKind: 'image',
      readStrategy: 'image',
    },
  })
  const value = await imageTool.execute(
    { attachmentId: probe.id, page: 1 },
    {
      agent: {
        id: 'packed-agent',
        options: { provider: 'packed-provider', model: 'packed-vision' },
        session: { id: 'packed-session', requestHeader: () => undefined },
      },
      signal: new AbortController().signal,
    },
  )
  if (value.sourceMediaType !== probe.mediaType || value.mediaType !== 'image/png' || value.page !== 1) {
    throw new Error('self-contained ' + probe.mediaType + ' probe failed')
  }
}
if (savedImages !== 3) throw new Error('packed image probes emitted an unexpected image count')
const schemaTitles = []
for (const file of [
  'delegated-candidate.schema.json',
  'research-brief.schema.json',
  'project-snapshot.schema.json',
  'run-record.schema.json',
  'literature-search-request.schema.json',
  'literature-search-result.schema.json',
  'literature-continuation.schema.json',
  'continuation-advance-outcome.schema.json',
  'paper-read-result.schema.json',
  'source-record.schema.json',
  'evidence-candidate.schema.json',
  'evidence-record.schema.json',
  'repository-audit.schema.json',
  'reproduction-plan.schema.json',
  'reproduction-test-spec.schema.json',
  'reproduction-report-candidate.schema.json',
  'reproduction-report.schema.json',
  'geodata-inspection-report.schema.json',
  'dataset-manifest.schema.json',
  'experiment-spec-candidate.schema.json',
  'experiment-spec.schema.json',
  'experiment-amendment.schema.json',
  'result-envelope.schema.json',
  'result-record.schema.json',
  'validation-plan.schema.json',
  'validation-report.schema.json',
  'review-proposal.schema.json',
  'review-record.schema.json',
  'claim-proposal.schema.json',
  'claim-record.schema.json',
  'writing-packet.schema.json',
  'manuscript-candidate.schema.json',
  'manuscript-record.schema.json',
  'manuscript-audit.schema.json',
]) {
  const schema = JSON.parse(await readFile(new URL('./schemas/' + file, packageUrl), 'utf8'))
  schemaTitles.push(schema.title)
}
if (schemaTitles.some(title => typeof title !== 'string' || !title.startsWith('GeoResearch '))) {
  throw new Error('bundle schema assets are missing')
}
process.stdout.write(JSON.stringify({ imported: ${importTargets.length}, schemas: schemaTitles.length }))
`
  const probe = runChecked(
    process.execPath,
    ['--input-type=module', '--eval', probeSource],
    temporaryRoot,
  )
  const result = JSON.parse(probe.stdout) as { imported?: unknown; schemas?: unknown }
  if (result.imported !== importTargets.length || result.schemas !== 34) {
    throw new Error(`packed import probe returned an invalid result: ${probe.stdout}`)
  }

  process.stdout.write(`${JSON.stringify({
    tarballs: WORKSPACE_PACKAGES.length,
    isolatedInstall: true,
    workspaceLinks: false,
    packageManagerInstall: false,
    imports: importTargets.length,
    bundleSchemas: 34,
    clientBundle: true,
    clientBundlePlatformExternals: true,
    externalCanvasPackage: false,
    externalXmlParserPackages: false,
    externalStructuredReaderPackages: false,
    pdfTextAndImageProbe: true,
    structuredDocumentProbe: true,
    legacyOfficeProbe: true,
    scientificDataProbes: 3,
    transcodedImageProbes: 2,
    phase3ProviderCapability: true,
    phase4RepositoryCapability: true,
    phase5RuntimeSurface: true,
    phase6RuntimeSurface: true,
  }, undefined, 2)}\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

interface PackedManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
}

interface DistributionPackageEntry {
  readonly name: string
  readonly version: string
  readonly directory: string
  readonly treeDigest: string
}

interface DistributionManifest {
  readonly schemaVersion: 1
  readonly productVersion: string
  readonly packages: readonly DistributionPackageEntry[]
}

function parseDistributionManifest(value: unknown): DistributionManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('distribution manifest must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || typeof record.productVersion !== 'string' || !Array.isArray(record.packages)) {
    throw new Error('distribution manifest header is invalid')
  }
  const packages = record.packages.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`distribution manifest package ${index} is invalid`)
    }
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.name !== 'string'
      || typeof candidate.version !== 'string'
      || typeof candidate.directory !== 'string'
      || typeof candidate.treeDigest !== 'string') {
      throw new Error(`distribution manifest package ${index} has an invalid identity or digest`)
    }
    return {
      name: candidate.name,
      version: candidate.version,
      directory: candidate.directory,
      treeDigest: candidate.treeDigest,
    }
  })
  if (new Set(packages.map(entry => entry.name)).size !== packages.length) {
    throw new Error('distribution manifest contains duplicate package names')
  }
  return { schemaVersion: 1, productVersion: record.productVersion, packages }
}


function minimalPdf(): Uint8Array {
  const stream = 'BT /F1 12 Tf 20 100 Td (GeoResearch packed PDF) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const chunks = [Buffer.from('%PDF-1.4\n', 'ascii')]
  const offsets = [0]
  let length = chunks[0]!.byteLength
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length)
    const chunk = Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, 'ascii')
    chunks.push(chunk)
    length += chunk.byteLength
  }
  const xrefOffset = length
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('')
  chunks.push(Buffer.from(xref, 'ascii'))
  return Uint8Array.from(Buffer.concat(chunks))
}

function minimalDocx(): Uint8Array {
  return zipBytes([{
    name: 'word/document.xml',
    data: '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>GeoResearch packed DOCX</w:t></w:r></w:p></w:body></w:document>',
  }])
}

function minimalXls(): Uint8Array {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Station', 'Temperature'],
    ['Packed station', 18.5],
  ]), 'Observations')
  return Uint8Array.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }) as Uint8Array)
}

async function writeMinimalHdf5(path: string): Promise<void> {
  await writeFile(path, Buffer.alloc(0))
  const h5Root = await resolveDependencyDirectory('file-service', 'h5wasm')
  const h5 = await import(pathToFileURL(join(h5Root, 'dist', 'node', 'hdf5_hl.js')).href) as typeof import('h5wasm/node')
  await h5.ready
  const file = new h5.File(path, 'w')
  try {
    const group = file.create_group('observations')
    group.create_attribute('title', 'Packed HDF5 observations')
    group.create_dataset({ name: 'temperature', data: new Float64Array([18.5, 19.25]), shape: [2] })
  } finally {
    file.close()
  }
}

function minimalNetcdf(): Uint8Array {
  const dimensions = Buffer.concat([uint32(10), uint32(1), ncString('observation'), uint32(2)])
  const variable = Buffer.concat([
    ncString('temperature'),
    uint32(1),
    uint32(0),
    absentNetcdfList(),
    uint32(5),
    uint32(8),
    uint32(0),
  ])
  const header = Buffer.concat([
    Buffer.from([0x43, 0x44, 0x46, 0x01]),
    uint32(0),
    dimensions,
    absentNetcdfList(),
    uint32(11),
    uint32(1),
    variable,
  ])
  header.writeUInt32BE(header.byteLength, header.byteLength - 4)
  const values = Buffer.alloc(8)
  values.writeFloatBE(18.5, 0)
  values.writeFloatBE(19.25, 4)
  return Uint8Array.from(Buffer.concat([header, values]))
}

function minimalParquet(): Uint8Array {
  return new Uint8Array(parquetWriteBuffer({
    codec: 'UNCOMPRESSED',
    columnData: [
      { name: 'station', data: ['Packed station'], type: 'STRING' },
      { name: 'temperature', data: [18.5], type: 'DOUBLE' },
    ],
  }))
}

function minimalTiff(): Uint8Array {
  return new Uint8Array(UTIF.encodeImage(Uint8Array.from([255, 0, 0, 255]), 1, 1))
}

function minimalBmp(): Uint8Array {
  return Uint8Array.from(encodeBmp({ data: Buffer.from([0, 0, 255, 0]), width: 1, height: 1 }).data)
}

function absentNetcdfList(): Buffer {
  return Buffer.concat([uint32(0), uint32(0)])
}

function ncString(value: string): Buffer {
  const bytes = Buffer.from(value, 'ascii')
  return Buffer.concat([bytes.length === 0 ? uint32(0) : uint32(bytes.byteLength), bytes, Buffer.alloc((4 - (bytes.byteLength % 4)) % 4)])
}

function uint32(value: number): Buffer {
  const output = Buffer.alloc(4)
  output.writeUInt32BE(value)
  return output
}

function zipBytes(entries: readonly { readonly name: string; readonly data: string }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.byteLength, 18)
    localHeader.writeUInt32LE(data.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    local.push(localHeader, name, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x0314, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(data.byteLength, 20)
    centralHeader.writeUInt32LE(data.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.byteLength + name.byteLength + data.byteLength
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function packedFilename(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`
}

function assertNoWorkspaceRanges(value: unknown, packageName: string): void {
  if (typeof value === 'string') {
    if (value.startsWith('workspace:')) {
      throw new Error(`${packageName} tarball retained a workspace dependency range`)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) assertNoWorkspaceRanges(child, packageName)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      assertNoWorkspaceRanges(child, packageName)
    }
  }
}

async function assertFile(path: string, label: string): Promise<void> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`)
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
}

async function linkDirectory(source: string, destination: string): Promise<void> {
  await assertDirectory(source, `dependency source for ${destination}`)
  await mkdir(dirname(destination), { recursive: true })
  await symlink(await realpath(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

async function resolveDependencyDirectory(packageFolder: string, dependencyName: string): Promise<string> {
  const candidates = [
    join(root, 'packages', packageFolder, 'node_modules', ...dependencyName.split('/')),
    join(root, 'node_modules', ...dependencyName.split('/')),
  ]
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(`dependency source is missing for ${dependencyName} (consumer: ${packageFolder})`)
}

function runChecked(
  command: string,
  args: readonly string[],
  cwd: string,
): { readonly stdout: string; readonly stderr: string } {
  const windowsCommand = process.env.ComSpec ?? 'cmd.exe'
  const result = spawnSync(
    process.platform === 'win32' && command === 'pnpm' ? windowsCommand : command,
    process.platform === 'win32' && command === 'pnpm'
      ? ['/d', '/c', 'pnpm', ...args]
      : [...args],
    {
      cwd,
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  if ((result.status ?? 1) !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
