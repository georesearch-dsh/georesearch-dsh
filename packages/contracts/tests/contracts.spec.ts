import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COORDINATOR_ALLOWLIST,
  DELEGATED_CANDIDATE_OUTPUT_SCHEMA,
  DELEGATION_BOOTSTRAP_TOOL,
  DELEGATION_TOOL_NAMES,
  ROLE_SKILL_ALLOWLISTS,
  ROLE_ALLOWLISTS,
  PHASE1_REQUIRED_TOOLS,
  SPECIALIST_TASK_TYPES,
  canonicalJson,
  completionCriteriaForTask,
  digestJson,
  digestTree,
  outputKindsForTask,
  parseDelegatedCandidate,
  parseInstallationManifest,
  parseMaintenanceNonceRecord,
  parseProfileIntegrationsRecord,
  requiredSkillsForTask,
  requiredToolsFor,
  specialistSkillsForTask,
} from '../src/index.js'

const temporaryRoots: string[] = []
const digest = `sha256:${'0'.repeat(64)}`

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('canonical contracts', () => {
  it('canonicalizes plain JSON deterministically', () => {
    expect(canonicalJson({ z: [3, 2, 1], a: -0 })).toBe('{"a":0,"z":[3,2,1]}')
    expect(digestJson({ b: 2, a: 1 })).toBe(digestJson({ a: 1, b: 2 }))
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/non-finite/)
    expect(() => canonicalJson({ bad: undefined })).toThrow(/undefined/)
  })

  it('digests trees independently of creation order', async () => {
    const left = await temporaryRoot('contracts-left-')
    const right = await temporaryRoot('contracts-right-')
    await mkdir(join(left, 'nested'))
    await writeFile(join(left, 'z.txt'), 'z')
    await writeFile(join(left, 'nested', 'a.txt'), 'a')
    await mkdir(join(right, 'nested'))
    await writeFile(join(right, 'nested', 'a.txt'), 'a')
    await writeFile(join(right, 'z.txt'), 'z')
    expect((await digestTree(left)).digest).toBe((await digestTree(right)).digest)
  })

  it('validates delegated candidate variants', () => {
    expect(parseDelegatedCandidate({
      status: 'completed',
      summary: 'done',
      outputKind: 'literature-search-report',
      candidate: { artifactId: 'a-1' },
    }, 'literature', 'discovery')).toEqual({
      status: 'completed',
      summary: 'done',
      outputKind: 'literature-search-report',
      candidate: { artifactId: 'a-1' },
    })
    expect(parseDelegatedCandidate({
      status: 'needs-user-decision',
      summary: 'blocked',
      questionCode: 'CHOOSE_DATASET',
      subjectRefs: [{ kind: 'dataset-manifest', subjectId: 'dataset-1', digest }],
      artifactRefs: [{ artifactId: 'a-1', digest, kind: 'dataset-manifest' }],
      question: 'Which dataset?',
      options: ['A', 'B'],
    }).status).toBe('needs-user-decision')
    expect(() => parseDelegatedCandidate({
      status: 'completed',
      summary: '',
      outputKind: 'literature-search-report',
      candidate: {},
    })).toThrow(/summary/)
    expect(() => parseDelegatedCandidate({
      status: 'completed',
      summary: 'reviewed',
      outputKind: 'review-assessment',
      candidate: { recommendation: 'support-with-changes' },
    }, 'reviewer', 'proposal-review')).toThrow(/accept, revise, or reject/)
  })

  it('binds specialist task types to Skills, outputs, and completion criteria', () => {
    expect(SPECIALIST_TASK_TYPES.experiment).toContain('experiment-design')
    expect(requiredSkillsForTask('experiment', 'experiment-design')).toEqual([
      'remote-sensing-experiment', 'geospatial-data', 'spatial-statistics',
    ])
    expect(specialistSkillsForTask('literature', 'evidence-synthesis', ['spatial-statistics'])).toEqual([
      'literature-review', 'spatial-statistics',
    ])
    expect(() => specialistSkillsForTask('writing', 'revision', ['literature-review'])).toThrow(/not allowed/)
    expect(outputKindsForTask('reviewer', 'proposal-review')).toEqual([
      'review-assessment', 'review-record',
    ])
    expect(completionCriteriaForTask('reviewer', 'proposal-review').join(' ')).toContain('falsifiability')
    const discoveryCriteria = completionCriteriaForTask('literature', 'discovery').join(' ')
    expect(discoveryCriteria).toMatch(/literature_search.*literature_continue.*two times combined/iu)
    expect(discoveryCriteria).toMatch(/web_search no more than once/iu)
    expect(discoveryCriteria).toMatch(/source_resolve no more than four times/iu)
    expect(discoveryCriteria).toMatch(/same actual provider page.*never reuse an earlier page generation/iu)
    expect(discoveryCriteria).toMatch(/at most four methods.*four findings.*eight basisRefs/iu)
    expect(discoveryCriteria).toMatch(/under 1000 characters.*basisRef under 400 characters/iu)
    expect(completionCriteriaForTask('experiment', 'data-assessment').join(' ')).toMatch(/at most four methods.*four findings/iu)
    expect(completionCriteriaForTask('experiment', 'data-assessment').join(' ')).toMatch(/under 1000 characters.*basisRef under 400 characters/iu)
    expect(completionCriteriaForTask('experiment', 'reproduction').join(' ')).toMatch(/needs-user-decision/iu)
    expect(completionCriteriaForTask('experiment', 'reproduction').join(' ')).toMatch(/invent.*identifier/iu)
    expect(completionCriteriaForTask('reviewer', 'proposal-review').join(' ')).toMatch(/authority\.generation/iu)
    expect(completionCriteriaForTask('reviewer', 'proposal-review').join(' ')).toMatch(/offline/iu)
    expect(ROLE_SKILL_ALLOWLISTS.writing).toEqual(['manuscript-writing'])
  })

  it('keeps the bundled delegated-candidate schema in parity with TypeScript', async () => {
    const bundled = JSON.parse(await readFile(resolve(
      import.meta.dirname,
      '..',
      '..',
      'bundle',
      'schemas',
      'delegated-candidate.schema.json',
    ), 'utf8')) as Record<string, unknown>
    const { $schema, $id, title, ...runtimeSchema } = bundled
    expect($schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect($id).toBe('https://georesearch.local/schemas/delegated-candidate.schema.json')
    expect(title).toBe('GeoResearch Delegated Candidate')
    expect(runtimeSchema).toEqual(DELEGATED_CANDIDATE_OUTPUT_SCHEMA)
  })

  it('rejects managed paths that escape their root', () => {
    expect(() => parseInstallationManifest({
      schemaVersion: 1,
      installationId: 'installation',
      generation: 1,
      productVersion: '0.1.0',
      profileId: 'georesearch',
      presetId: 'georesearch',
      profileTreeDigest: digest,
      presetTreeDigest: digest,
      skillsTreeDigest: digest,
      profileDependencyLockDigest: digest,
      homePatchDigest: digest,
      managedFiles: [{ root: 'profile', path: '../outside', digest, size: 0 }],
      createdAt: '2026-08-15T00:00:00.000Z',
    })).toThrow(/contained relative path/)
  })

  it('validates maintenance nonce protection metadata', () => {
    expect(parseMaintenanceNonceRecord({
      schemaVersion: 1,
      transactionId: 'transaction',
      generation: 1,
      nonceDigest: digest,
      protection: 'dpapi-current-user',
      executable: process.execPath,
      deadline: '2026-08-16T12:00:00.000Z',
    }).protection).toBe('dpapi-current-user')
    expect(() => parseMaintenanceNonceRecord({
      schemaVersion: 1,
      transactionId: 'transaction',
      generation: 1,
      nonceDigest: digest,
      protection: 'plaintext',
      executable: process.execPath,
      deadline: '2026-08-16T12:00:00.000Z',
    })).toThrow(/protection/)
  })

  it('accepts portable profile names and rejects duplicate or escaping integrations', () => {
    expect(parseProfileIntegrationsRecord({
      schemaVersion: 1,
      productVersion: '0.1.0',
      sharedPackagesTreeDigest: digest,
      profiles: [{ profileName: 'web' }, { profileName: 'research-web' }],
    }).profiles.map(profile => profile.profileName)).toEqual(['web', 'research-web'])
    expect(() => parseProfileIntegrationsRecord({
      schemaVersion: 1,
      productVersion: '0.1.0',
      sharedPackagesTreeDigest: digest,
      profiles: [{ profileName: '../web' }],
    })).toThrow(/contained Harness profile name/)
    expect(() => parseProfileIntegrationsRecord({
      schemaVersion: 1,
      productVersion: '0.1.0',
      sharedPackagesTreeDigest: digest,
      profiles: [{ profileName: 'web' }, { profileName: 'web' }],
    })).toThrow(/duplicated/)
  })

  it('keeps coordinator and specialist authority separated while Harness owns workspace permissions', () => {
    expect(DELEGATION_TOOL_NAMES).toEqual([
      'delegate_literature',
      'delegate_experiment',
      'delegate_review',
      'delegate_writing',
    ])
    expect(COORDINATOR_ALLOWLIST).toContain('skill')
    expect(COORDINATOR_ALLOWLIST).toContain('deliverable_publish')
    expect(COORDINATOR_ALLOWLIST).not.toContain('write')
    expect(COORDINATOR_ALLOWLIST).not.toContain('edit')
    expect(COORDINATOR_ALLOWLIST).not.toContain('web_search')
    expect(COORDINATOR_ALLOWLIST).not.toContain('web_fetch')
    expect(COORDINATOR_ALLOWLIST).not.toContain('pwsh')
    expect(COORDINATOR_ALLOWLIST).not.toContain('bash')
    expect(COORDINATOR_ALLOWLIST).not.toContain('job_output')
    expect(COORDINATOR_ALLOWLIST).not.toContain('structured_output')
    expect(ROLE_ALLOWLISTS.experiment).toContain('write')
    expect(ROLE_ALLOWLISTS.experiment).not.toContain('formal_run_submit')
    expect(ROLE_ALLOWLISTS.reviewer).toContain('structured_output')
    for (const role of Object.keys(ROLE_ALLOWLISTS) as Array<keyof typeof ROLE_ALLOWLISTS>) {
      expect(ROLE_ALLOWLISTS[role]).toContain(DELEGATION_BOOTSTRAP_TOOL)
      expect(PHASE1_REQUIRED_TOOLS[role]).toContain(DELEGATION_BOOTSTRAP_TOOL)
    }
    expect(ROLE_ALLOWLISTS.writing).toEqual([
      'skill', 'writing_packet_read', 'manuscript_candidate', 'manuscript_validate',
      DELEGATION_BOOTSTRAP_TOOL, 'structured_output',
    ])
    expect(requiredToolsFor('literature', 'phase1')).toBe(PHASE1_REQUIRED_TOOLS.literature)
    expect(requiredToolsFor('coordinator', 'phase3')).not.toContain('write')
    expect(requiredToolsFor('coordinator', 'phase3')).not.toContain('edit')
    expect(requiredToolsFor('coordinator', 'phase3')).toContain('deliverable_publish')
    expect(requiredToolsFor('coordinator', 'phase3')).not.toContain('web_search')
    expect(requiredToolsFor('coordinator', 'phase3')).not.toContain('web_fetch')
    expect(requiredToolsFor('literature', 'full')).toBe(ROLE_ALLOWLISTS.literature)
  })
})

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}
