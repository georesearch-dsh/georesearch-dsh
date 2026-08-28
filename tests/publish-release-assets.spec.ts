import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assertAssetDigests,
  hasNpmProvenance,
  parseSha256Sums,
  type ReleaseManifest,
  validateReleaseManifest,
} from '../scripts/publish-release-assets.ts'

describe('release asset publication', () => {
  it('accepts the exact v-prefixed SemVer release identity', () => {
    const manifest = createManifest()
    expect(validateReleaseManifest(manifest, 'v0.1.0').productVersion).toBe('0.1.0')
    expect(() => validateReleaseManifest(manifest, 'dsh-v0.1.0')).toThrow('release tag must be v0.1.0')
  })

  it('rejects altered release assets before publication', () => {
    const bytes = new TextEncoder().encode('verified package')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const sha512 = createHash('sha512').update(bytes).digest('base64')
    const manifest = createManifest({
      bytes: bytes.byteLength,
      sha256: `sha256:${sha256}`,
      integrity: `sha512-${sha512}`,
    }, 1)
    const checksums = parseSha256Sums(`${sha256}  georesearch-dsh-contracts-0.1.0.tgz\n`)
    const assets = new Map([['georesearch-dsh-contracts-0.1.0.tgz', bytes]])
    expect(() => assertAssetDigests(manifest, checksums, assets)).not.toThrow()
    assets.set('georesearch-dsh-contracts-0.1.0.tgz', new TextEncoder().encode('altered package'))
    expect(() => assertAssetDigests(manifest, checksums, assets)).toThrow('release asset size differs')
  })

  it('requires the npm SLSA provenance predicate', () => {
    expect(hasNpmProvenance({
      dist: { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } },
    })).toBe(true)
    expect(hasNpmProvenance({ dist: { integrity: 'sha512-example' } })).toBe(false)
  })
})

function createManifest(
  overrides: Partial<ReleaseManifest['packages'][number]> = {},
  packageCount = 26,
): ReleaseManifest {
  const first = {
    name: '@georesearch/dsh-contracts',
    version: '0.1.0',
    filename: 'georesearch-dsh-contracts-0.1.0.tgz',
    bytes: 16,
    sha256: `sha256:${'0'.repeat(64)}`,
    integrity: `sha512-${'A'.repeat(86)}==`,
    ...overrides,
  }
  const packages = Array.from({ length: packageCount }, (_, index) => index === 0 ? first : {
    name: `@georesearch/dsh-test-${index}`,
    version: '0.1.0',
    filename: `georesearch-dsh-test-${index}-0.1.0.tgz`,
    bytes: index,
    sha256: `sha256:${index.toString(16).padStart(64, '0')}`,
    integrity: `sha512-${'A'.repeat(86)}==`,
  })
  return {
    schemaVersion: 1,
    productVersion: '0.1.0',
    createdAt: '2026-08-27T10:30:00.611Z',
    source: {
      repository: 'git+https://github.com/georesearch-dsh/georesearch-dsh.git',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      clean: true,
    },
    publish: {
      registry: 'https://registry.npmjs.org/',
      access: 'public',
      provenanceRequired: true,
      stagingTag: 'candidate-0-1-0',
      finalTag: 'latest',
      order: packages.map(entry => entry.name),
    },
    packages,
  }
}
