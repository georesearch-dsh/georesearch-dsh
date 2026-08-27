import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROJECT_SNAPSHOT_SCHEMA,
  RESEARCH_BRIEF_SCHEMA,
  RUN_RECORD_SCHEMA,
  digestJson,
  parseProjectSnapshot,
  parseResearchBrief,
  parseRunExitMarker,
  parseRunRecord,
  type ProjectSnapshot,
  type ResearchBrief,
  type RunRecord,
} from '../src/index.js'

describe('Phase 2 schema parity', () => {
  it.each([
    ['research-brief.schema.json', 'GeoResearch ResearchBrief', RESEARCH_BRIEF_SCHEMA],
    ['project-snapshot.schema.json', 'GeoResearch ProjectSnapshot', PROJECT_SNAPSHOT_SCHEMA],
    ['run-record.schema.json', 'GeoResearch RunRecord', RUN_RECORD_SCHEMA],
  ] as const)('keeps %s byte-independent runtime parity', async (file, title, runtime) => {
    const bundled = JSON.parse(await readFile(resolve(
      import.meta.dirname,
      '..',
      '..',
      'bundle',
      'schemas',
      file,
    ), 'utf8')) as Record<string, unknown>
    const { $schema, $id, title: bundledTitle, ...schema } = bundled
    expect($schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect($id).toBe(`https://georesearch.local/schemas/${file}`)
    expect(bundledTitle).toBe(title)
    expect(schema).toEqual(runtime)
  })

  it('strictly parses ResearchBrief and ProjectSnapshot without schema-only extra fields', () => {
    const brief = researchBrief()
    const snapshot = projectSnapshot()
    expect(parseResearchBrief(brief)).toEqual(brief)
    expect(parseProjectSnapshot(snapshot)).toEqual(snapshot)
    expect(() => parseResearchBrief({ ...brief, unexpected: true })).toThrow(/unsupported fields/)
    expect(() => parseResearchBrief({
      ...brief,
      region: { ...brief.region, unexpected: true },
    })).toThrow(/unsupported fields/)
    expect(() => parseProjectSnapshot({
      ...snapshot,
      readiness: { ...snapshot.readiness, unexpected: 'ready' },
    })).toThrow(/unsupported fields/)
  })

  it('enforces RunRecord digest and state-dependent receipt facts', () => {
    const starting = runRecord()
    expect(parseRunRecord(starting)).toEqual(starting)
    const { approval, ...withoutLegacyApproval } = starting
    expect(approval).toBeDefined()
    expect(parseRunRecord(withoutLegacyApproval)).toEqual(withoutLegacyApproval)
    const fullAccess = {
      ...withoutLegacyApproval,
      sandbox: { mode: 'danger-full-access' as const },
    }
    expect(parseRunRecord(fullAccess)).toEqual(fullAccess)
    expect(() => parseRunRecord({
      ...fullAccess,
      sandbox: { mode: 'danger-full-access', enforcement: 'full' },
    })).toThrow(/cannot report sandbox enforcement/)
    expect(() => parseRunRecord({ ...starting, argvDigest: digestJson(['different']) })).toThrow(/does not match/)
    expect(() => parseRunRecord({ ...starting, state: 'running' })).toThrow(/requires process receipt facts/)
    expect(() => parseRunRecord({
      ...starting,
      state: 'succeeded',
      endedAt: '2026-08-16T00:00:01.000Z',
      exitCode: 1,
    })).toThrow(/must be 0/)
  })

  it('strictly parses persisted Run exit termination authority', () => {
    const marker = {
      schemaVersion: 1 as const,
      projectId: 'project-schema',
      runId: 'run-schema',
      launchId: 'launch-schema',
      exitCode: null,
      signal: 'SIGTERM',
      endedAt: '2026-08-16T00:01:00.000Z',
      stdoutDigest: digestJson({ stdout: '' }),
      stderrDigest: digestJson({ stderr: '' }),
      terminationReason: 'timeout' as const,
    }
    expect(parseRunExitMarker(marker)).toEqual(marker)
    expect(() => parseRunExitMarker({ ...marker, terminationReason: 'unknown' })).toThrow(/terminationReason/)
    expect(() => parseRunExitMarker({ ...marker, unexpected: true })).toThrow(/unsupported fields/)
  })
})

function researchBrief(): ResearchBrief {
  return {
    schemaVersion: 1,
    briefId: 'brief-schema',
    title: 'Schema parity study',
    researchQuestion: 'Are the contracts equivalent?',
    background: 'The Phase 2 host persists structured scientific state.',
    motivation: 'Schema drift must fail before distribution.',
    region: { description: 'Local test region', bbox: [0, 0, 1, 1], crs: 'EPSG:4326' },
    timeRange: { start: '2020-01-01', end: '2020-12-31' },
    researchSubjects: ['contract'],
    dataModalities: ['structured-data'],
    hypotheses: [{ hypothesisId: 'h1', statement: 'Runtime and bundled schemas agree.' }],
    expectedContributions: ['A frozen Phase 2 contract'],
    constraints: ['No Phase 3 provider types'],
    knownAssumptions: ['Canonical JSON'],
    successCriteria: ['Parity tests pass'],
    userConfirmation: {
      confirmed: true,
      confirmedAt: '2026-08-16T00:00:00.000Z',
      confirmedBy: 'user',
      auditNote: 'Confirmed for the Phase 2 fixture.',
    },
    digest: digestJson({ brief: 'schema' }),
    committedAt: '2026-08-16T00:00:00.000Z',
  }
}

function projectSnapshot(): ProjectSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project-schema',
    generation: 4,
    stateDigest: digestJson({ state: 4 }),
    workspaceId: 'workspace-schema',
    readiness: {
      scope: 'ready',
      evidence: 'missing',
      reproduction: 'missing',
      protocol: 'missing',
      implementation: 'in-progress',
      runs: 'ready',
      validation: 'missing',
      claims: 'missing',
      manuscript: 'missing',
    },
    activeTaskIds: [],
    visibleArtifacts: [{ artifactId: 'artifact-schema', digest: digestJson({ artifact: 1 }), kind: 'test' }],
    blockers: [],
    staleIndicators: [],
  }
}

function runRecord(): RunRecord {
  const argv = ['node.exe', 'experiment.js']
  return {
    schemaVersion: 1,
    runId: 'run-schema',
    kind: 'formal',
    projectId: 'project-schema',
    workspaceId: 'workspace-schema',
    workspaceBindingVersion: 1,
    experimentSpecDigest: digestJson({ experiment: 1 }),
    sourceTreeDigest: digestJson({ source: 1 }),
    environmentDigest: digestJson({}),
    datasetDigests: [],
    seed: 42,
    argv,
    argvDigest: digestJson(argv),
    cwd: {
      canonicalPath: 'C:\\workspace',
      volumeIdentity: 'volume-schema',
      fileIdentity: 'file-schema',
    },
    state: 'starting',
    launchId: 'launch-schema',
    resourceLimits: {
      timeoutMs: 60_000,
      graceMs: 1_000,
      stdoutMaxBytes: 1_048_576,
      stderrMaxBytes: 1_048_576,
    },
    stdoutPath: 'runs/run-schema/stdout.log',
    stderrPath: 'runs/run-schema/stderr.log',
    sandbox: { mode: 'workspace-write', enforcement: 'partial' },
    approval: {
      outcome: 'allowed-once',
      callId: 'call-schema',
      approvedAt: '2026-08-16T00:00:00.000Z',
    },
    outputArtifactRefs: [],
  }
}
