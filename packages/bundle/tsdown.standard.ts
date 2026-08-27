import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@georesearch/dsh-bundle/dsh-standard',
  entry: {
    'standard-adapter': 'src/standard-adapter.ts',
    'standard-facet': 'src/standard-facet.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    alwaysBundle: [/^@dsh-std(?:\/|$)/u, 'zod'],
    neverBundle: [/^@deepseek-ai(?:\/|$)/u, /^@georesearch(?:\/|$)/u, 'react', 'react/jsx-runtime'],
  },
  outputOptions: { entryFileNames: '[name].js' },
})
