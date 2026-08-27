import { defineConfig, type UserConfig } from 'tsdown'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { clientBundle } from '../../scripts/tsdown.client.ts'

const require = createRequire(import.meta.url)
const canvasNativePackage = canvasNativePackageName()
const canvasNativeRoot = dirname(require.resolve(`${canvasNativePackage}/package.json`))
const tesseractPackageRoot = dirname(require.resolve('tesseract.js/package.json'))
const tesseractRequire = createRequire(join(tesseractPackageRoot, 'package.json'))
const tesseractRuntimePackageRoots = [
  'tesseract.js',
  'tesseract.js-core',
  'bmp-js',
  'idb-keyval',
  'is-url',
  'node-fetch',
  'regenerator-runtime',
  'tr46',
  'wasm-feature-detect',
  'webidl-conversions',
  'whatwg-url',
  'zlibjs',
].map(packageName => dirname(tesseractRequire.resolve(`${packageName}/package.json`)))
const tesseractEnglishRoot = dirname(require.resolve('@tesseract.js-data/eng/package.json'))
const tesseractChineseRoot = dirname(require.resolve('@tesseract.js-data/chi_sim/package.json'))

const hostBundle: UserConfig = {
  name: '@georesearch/dsh-file-service/host',
  entry: {
    index: 'src/index.ts',
    pdf: 'src/pdf.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  dts: false,
  sourcemap: true,
  clean: false,
  copy: options => [
    {
      from: join(canvasNativeRoot, 'icudtl.dat'),
      to: join(options.outDir, 'assets'),
    },
    ...tesseractRuntimePackageRoots.map(from => ({
      from,
      to: join(options.outDir, 'assets', 'ocr', 'node_modules'),
    })),
    {
      from: join(tesseractEnglishRoot, '4.0.0_best_int', 'eng.traineddata.gz'),
      to: join(options.outDir, 'assets', 'ocr', 'lang'),
    },
    {
      from: join(tesseractChineseRoot, '4.0.0_best_int', 'chi_sim.traineddata.gz'),
      to: join(options.outDir, 'assets', 'ocr', 'lang'),
    },
  ],
  deps: {
    alwaysBundle: [
      '@napi-rs/canvas',
      /^pdfjs-dist(?:\/|$)/u,
      'saxes',
      'tar-stream',
      'yauzl',
      'bmp-js',
      'h5wasm',
      /^h5wasm(?:\/|$)/u,
      'hyparquet',
      'hyparquet-compressors',
      'netcdfjs',
      'ppt-to-text',
      'utif2',
      'word-extractor',
      'xlsx',
    ],
    neverBundle: ['tesseract.js-core', /^@deepseek-ai\//u, /^@georesearch\//u],
  },
  outputOptions: { entryFileNames: '[name].js' },
}

const ocrWorkerBundle: UserConfig = {
  name: '@georesearch/dsh-file-service/ocr-worker',
  entry: { worker: 'src/ocr-worker.ts' },
  outDir: 'lib/assets/ocr',
  format: 'cjs',
  platform: 'node',
  target: 'node22.19',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    alwaysBundle: [
      /^tesseract\.js(?:\/|$)/u,
      'bmp-js',
      'is-url',
      'node-fetch',
      'wasm-feature-detect',
      'zlibjs',
    ],
    neverBundle: ['tesseract.js-core'],
  },
  outputOptions: { entryFileNames: '[name].cjs' },
}

function canvasNativePackageName(): string {
  if (process.platform === 'win32' && process.arch === 'x64') return '@napi-rs/canvas-win32-x64-msvc'
  throw new Error(`@georesearch/dsh-file-service: unsupported PDF renderer target ${process.platform}-${process.arch}`)
}

export default defineConfig([
  hostBundle,
  ocrWorkerBundle,
  clientBundle('@georesearch/dsh-file-service', 'src/client/index.tsx'),
])
