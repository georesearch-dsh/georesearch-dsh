import {
  PROJECT_READINESS_DOMAINS,
  type ArtifactRecord,
  type ProjectEvent,
  type ProjectReadiness,
  type ProjectReadinessDomain,
  type ProjectReducerState,
  type ProjectSnapshot,
  type ProjectStateFile,
  type ResearchBrief,
  type RunRecord,
  type SourceRecord,
  type EvidenceRecord,
  type RepositoryAudit,
  type ReproductionPlan,
  type ReproductionReport,
  type ReproductionTestSpecRecord,
  type DatasetManifest,
  type ExperimentAmendment,
  type ExperimentSpec,
  type GeodataInspectionReport,
  type ResultRecord,
  type ValidationPlan,
  type ValidationReport,
  type ReviewRecord,
  type ClaimRecord,
  type WritingPacket,
  type ManuscriptRecord,
  type ManuscriptAudit,
  type WorkspaceBinding,
} from '@georesearch/dsh-contracts'

export type ProjectEventData =
  | { readonly projectBinding: ProjectReducerState['projectBinding']; readonly workspaceBinding: WorkspaceBinding }
  | { readonly workspaceBinding: WorkspaceBinding }
  | { readonly brief: ResearchBrief }
  | { readonly artifact: ArtifactRecord }
  | { readonly attachmentId: string; readonly artifactId: string; readonly digest: string; readonly workspaceId: string }
  | { readonly artifactIds: readonly string[]; readonly indicators: readonly string[] }
  | { readonly run: RunRecord }
  | { readonly source: SourceRecord }
  | { readonly evidence: EvidenceRecord }
  | { readonly repositoryAudit: RepositoryAudit }
  | { readonly reproductionPlan: ReproductionPlan }
  | { readonly reproductionTestSpec: ReproductionTestSpecRecord }
  | { readonly reproductionReport: ReproductionReport }
  | {
      readonly geodataReports: readonly GeodataInspectionReport[]
      readonly datasetManifests: readonly DatasetManifest[]
      readonly experimentSpec: ExperimentSpec
      readonly amendment: ExperimentAmendment | null
    }
  | { readonly run: RunRecord; readonly results: readonly ResultRecord[] }
  | { readonly validationPlan: ValidationPlan; readonly validationReport: ValidationReport }
  | { readonly reviewRecord: ReviewRecord }
  | { readonly claim: ClaimRecord }
  | { readonly writingPacket: WritingPacket }
  | { readonly manuscript: ManuscriptRecord; readonly manuscriptAudit: ManuscriptAudit }
  | { readonly blockers: readonly string[] }

export function reduceProjectEvent(
  current: ProjectReducerState | undefined,
  event: ProjectEvent,
): ProjectReducerState {
  const data = event.data as unknown as ProjectEventData
  switch (event.type) {
    case 'project.created': {
      if (current !== undefined) throw new Error('project.created may only be the first event')
      const created = data as Extract<ProjectEventData, { readonly projectBinding: ProjectReducerState['projectBinding'] }>
      return {
        schemaVersion: 1,
        projectId: created.projectBinding.projectId,
        projectBinding: created.projectBinding,
        workspaceBindings: { [created.workspaceBinding.workspaceId]: created.workspaceBinding },
        artifacts: {},
        runs: {},
        sources: {},
        evidence: {},
        repositoryAudits: {},
        reproductionPlans: {},
        reproductionTestSpecs: {},
        reproductionReports: {},
        geodataReports: {},
        datasetManifests: {},
        experimentSpecs: {},
        experimentAmendments: {},
        results: {},
        validationPlans: {},
        validationReports: {},
        reviewRecords: {},
        claims: {},
        writingPackets: {},
        manuscripts: {},
        manuscriptAudits: {},
        activeTaskIds: [],
        blockers: [],
        staleIndicators: [],
      }
    }
    case 'workspace.attached':
    case 'workspace.rebound': {
      const state = requireState(current, event.type)
      const binding = (data as { readonly workspaceBinding: WorkspaceBinding }).workspaceBinding
      const workspaceIds = [...new Set([...state.projectBinding.workspaceIds, binding.workspaceId])].sort()
      return {
        ...state,
        projectBinding: { ...state.projectBinding, workspaceIds, updatedAt: event.time },
        workspaceBindings: { ...state.workspaceBindings, [binding.workspaceId]: binding },
      }
    }
    case 'research-brief.committed': {
      const state = requireState(current, event.type)
      return { ...state, researchBrief: (data as { readonly brief: ResearchBrief }).brief }
    }
    case 'artifact.committed': {
      const state = requireState(current, event.type)
      const artifact = (data as { readonly artifact: ArtifactRecord }).artifact
      return { ...state, artifacts: { ...state.artifacts, [artifact.artifactId]: artifact } }
    }
    case 'deliverable.published': {
      const state = requireState(current, event.type)
      const artifact = (data as { readonly artifact: ArtifactRecord }).artifact
      if (artifact.sourceRelativePath === undefined) {
        throw new Error('deliverable.published requires an Artifact sourceRelativePath')
      }
      const artifacts = Object.fromEntries(Object.entries(state.artifacts).map(([artifactId, currentArtifact]) => [
        artifactId,
        currentArtifact.workspaceId === artifact.workspaceId
          && currentArtifact.sourceRelativePath === artifact.sourceRelativePath
          && currentArtifact.artifactId !== artifact.artifactId
          && currentArtifact.validity === 'current'
          ? { ...currentArtifact, validity: 'superseded' as const }
          : currentArtifact,
      ]))
      return { ...state, artifacts: { ...artifacts, [artifact.artifactId]: artifact } }
    }
    case 'artifacts.staled': {
      const state = requireState(current, event.type)
      const stale = data as { readonly artifactIds: readonly string[]; readonly indicators: readonly string[] }
      const artifacts = { ...state.artifacts }
      for (const artifactId of stale.artifactIds) {
        const artifact = artifacts[artifactId]
        if (artifact !== undefined && artifact.validity === 'current') {
          artifacts[artifactId] = { ...artifact, validity: 'stale' }
        }
      }
      return {
        ...state,
        artifacts,
        staleIndicators: [...new Set([...state.staleIndicators, ...stale.indicators])].sort(),
      }
    }
    case 'artifact.upload.rolled-back': {
      const state = requireState(current, event.type)
      const rollback = data as { readonly artifactId: string }
      if (state.artifacts[rollback.artifactId] === undefined) return state
      const artifacts = { ...state.artifacts }
      delete artifacts[rollback.artifactId]
      return { ...state, artifacts }
    }
    case 'run.recorded':
    case 'run.updated': {
      const state = requireState(current, event.type)
      const run = (data as { readonly run: RunRecord }).run
      return { ...state, runs: { ...state.runs, [run.runId]: run } }
    }
    case 'source.recorded': {
      const state = requireState(current, event.type)
      const source = (data as { readonly source: SourceRecord }).source
      return { ...state, sources: { ...(state.sources ?? {}), [source.sourceId]: source } }
    }
    case 'evidence.recorded': {
      const state = requireState(current, event.type)
      const evidence = (data as { readonly evidence: EvidenceRecord }).evidence
      return { ...state, evidence: { ...(state.evidence ?? {}), [evidence.evidenceId]: evidence } }
    }
    case 'repository.audit.recorded': {
      const state = requireState(current, event.type)
      const repositoryAudit = (data as { readonly repositoryAudit: RepositoryAudit }).repositoryAudit
      return {
        ...state,
        repositoryAudits: {
          ...(state.repositoryAudits ?? {}),
          [repositoryAudit.auditId]: repositoryAudit,
        },
      }
    }
    case 'reproduction.plan.recorded': {
      const state = requireState(current, event.type)
      const reproductionPlan = (data as { readonly reproductionPlan: ReproductionPlan }).reproductionPlan
      return {
        ...state,
        reproductionPlans: {
          ...(state.reproductionPlans ?? {}),
          [reproductionPlan.planId]: reproductionPlan,
        },
      }
    }
    case 'reproduction.test-spec.recorded': {
      const state = requireState(current, event.type)
      const reproductionTestSpec = (
        data as { readonly reproductionTestSpec: ReproductionTestSpecRecord }
      ).reproductionTestSpec
      return {
        ...state,
        reproductionTestSpecs: {
          ...(state.reproductionTestSpecs ?? {}),
          [reproductionTestSpec.spec.testSpecId]: reproductionTestSpec,
        },
      }
    }
    case 'reproduction.report.recorded': {
      const state = requireState(current, event.type)
      const reproductionReport = (
        data as { readonly reproductionReport: ReproductionReport }
      ).reproductionReport
      return {
        ...state,
        reproductionReports: {
          ...(state.reproductionReports ?? {}),
          [reproductionReport.reportId]: reproductionReport,
        },
      }
    }
    case 'experiment.spec.committed': {
      const state = requireState(current, event.type)
      const committed = data as Extract<ProjectEventData, { readonly experimentSpec: ExperimentSpec }>
      const geodataReports = { ...(state.geodataReports ?? {}) }
      const datasetManifests = { ...(state.datasetManifests ?? {}) }
      for (const report of committed.geodataReports) geodataReports[report.reportId] = report
      for (const manifest of committed.datasetManifests) datasetManifests[manifest.datasetId] = manifest
      return {
        ...state,
        geodataReports,
        datasetManifests,
        experimentSpecs: {
          ...(state.experimentSpecs ?? {}),
          [committed.experimentSpec.specId]: committed.experimentSpec,
        },
        experimentAmendments: committed.amendment === null
          ? (state.experimentAmendments ?? {})
          : {
              ...(state.experimentAmendments ?? {}),
              [committed.amendment.amendmentId]: committed.amendment,
            },
      }
    }
    case 'result.records.committed': {
      const state = requireState(current, event.type)
      const committed = data as { readonly run: RunRecord; readonly results: readonly ResultRecord[] }
      const results = { ...(state.results ?? {}) }
      for (const result of committed.results) {
        results[result.resultId] = result
      }
      return {
        ...state,
        runs: { ...state.runs, [committed.run.runId]: committed.run },
        results,
      }
    }
    case 'validation.completed': {
      const state = requireState(current, event.type)
      const completed = data as { readonly validationPlan: ValidationPlan; readonly validationReport: ValidationReport }
      const results = { ...(state.results ?? {}) }
      for (const subject of completed.validationReport.subjects) {
        if (subject.kind !== 'result') continue
        const result = results[subject.subjectId]
        if (result?.digest === subject.digest) {
          results[subject.subjectId] = { ...result, validationStatus: completed.validationReport.overall }
        }
      }
      return {
        ...state,
        results,
        validationPlans: {
          ...(state.validationPlans ?? {}),
          [completed.validationPlan.planId]: completed.validationPlan,
        },
        validationReports: {
          ...(state.validationReports ?? {}),
          [completed.validationReport.reportId]: completed.validationReport,
        },
      }
    }
    case 'review.recorded': {
      const state = requireState(current, event.type)
      const reviewRecord = (data as { readonly reviewRecord: ReviewRecord }).reviewRecord
      const reviewStatus = reviewRecord.recommendation === 'accept'
        ? 'accepted' as const
        : reviewRecord.recommendation === 'reject'
          ? 'rejected' as const
          : 'needs-review' as const
      const evidence = { ...(state.evidence ?? {}) }
      const reproductionReports = { ...(state.reproductionReports ?? {}) }
      for (const subject of reviewRecord.subjectRefs) {
        if (subject.kind === 'evidence') {
          const record = evidence[subject.subjectId]
          if (record?.digest === subject.digest) evidence[subject.subjectId] = { ...record, reviewStatus }
        }
        if (subject.kind === 'reproduction-report') {
          const record = reproductionReports[subject.subjectId]
          if (record?.digest === subject.digest) reproductionReports[subject.subjectId] = { ...record, reviewStatus }
        }
      }
      return {
        ...state,
        evidence,
        reproductionReports,
        reviewRecords: { ...(state.reviewRecords ?? {}), [reviewRecord.reviewId]: reviewRecord },
      }
    }
    case 'claim.recorded': {
      const state = requireState(current, event.type)
      const claim = (data as { readonly claim: ClaimRecord }).claim
      return { ...state, claims: { ...(state.claims ?? {}), [claim.claimId]: claim } }
    }
    case 'writing-packet.recorded': {
      const state = requireState(current, event.type)
      const writingPacket = (data as { readonly writingPacket: WritingPacket }).writingPacket
      return {
        ...state,
        writingPackets: { ...(state.writingPackets ?? {}), [writingPacket.packetId]: writingPacket },
      }
    }
    case 'manuscript.audited': {
      const state = requireState(current, event.type)
      const completed = data as { readonly manuscript: ManuscriptRecord; readonly manuscriptAudit: ManuscriptAudit }
      return {
        ...state,
        manuscripts: { ...(state.manuscripts ?? {}), [completed.manuscript.manuscriptId]: completed.manuscript },
        manuscriptAudits: {
          ...(state.manuscriptAudits ?? {}),
          [completed.manuscriptAudit.auditId]: completed.manuscriptAudit,
        },
      }
    }
    case 'project.blockers.updated': {
      const state = requireState(current, event.type)
      return { ...state, blockers: [...(data as { readonly blockers: readonly string[] }).blockers] }
    }
    default:
      throw new Error(`unsupported reducer v1 event type: ${event.type}`)
  }
}

export function projectSnapshot(stateFile: ProjectStateFile, workspaceId: string): ProjectSnapshot {
  if (stateFile.state.workspaceBindings[workspaceId] === undefined) {
    throw new Error(`workspace ${workspaceId} is not bound to project ${stateFile.projectId}`)
  }
  const readiness = Object.fromEntries(PROJECT_READINESS_DOMAINS.map(domain => [
    domain,
    readinessFor(domain, stateFile.state),
  ])) as unknown as Record<ProjectReadinessDomain, ProjectReadiness>
  const visibleArtifacts = Object.values(stateFile.state.artifacts)
    .filter(artifact => artifact.materialization === 'committed' && artifact.integrity !== 'missing')
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    .map(({ artifactId, digest, kind }) => ({ artifactId, digest, kind }))
  return {
    schemaVersion: 1,
    projectId: stateFile.projectId,
    generation: stateFile.generation,
    stateDigest: stateFile.digest,
    workspaceId,
    readiness,
    activeTaskIds: [...stateFile.state.activeTaskIds],
    visibleArtifacts,
    blockers: [...stateFile.state.blockers],
    staleIndicators: [...stateFile.state.staleIndicators],
  }
}

export function downstreamArtifactIds(
  artifacts: Readonly<Record<string, ArtifactRecord>>,
  changedDigests: ReadonlySet<string>,
): string[] {
  const stale = new Set<string>()
  const frontier = new Set(changedDigests)
  let changed = true
  while (changed) {
    changed = false
    for (const artifact of Object.values(artifacts)) {
      if (stale.has(artifact.artifactId)) continue
      if (artifact.lineage.inputDigests.some(digest => frontier.has(digest))) {
        stale.add(artifact.artifactId)
        frontier.add(artifact.digest)
        changed = true
      }
    }
  }
  return [...stale].sort()
}

function requireState(state: ProjectReducerState | undefined, eventType: string): ProjectReducerState {
  if (state === undefined) throw new Error(`${eventType} cannot precede project.created`)
  return state
}

function readinessFor(domain: ProjectReadinessDomain, state: ProjectReducerState): ProjectReadiness {
  if (state.blockers.length > 0 && domain !== 'scope') return 'blocked'
  if (state.staleIndicators.length > 0 && domain !== 'scope') return 'stale'
  switch (domain) {
    case 'scope':
      return state.researchBrief === undefined ? 'missing' : 'ready'
    case 'runs': {
      const runs = Object.values(state.runs)
      if (runs.some(run => run.state === 'running' || run.state === 'starting' || run.state === 'collecting')) return 'in-progress'
      return runs.some(run => run.state === 'succeeded') ? 'ready' : 'missing'
    }
    case 'evidence':
      return Object.keys(state.evidence ?? {}).length > 0 ? 'ready' : 'missing'
    case 'reproduction': {
      const reports = Object.values(state.reproductionReports ?? {})
      if (reports.length > 0) {
        return reports.some(report => report.status.startsWith('blocked-') || report.status === 'failed-with-diagnosis')
          ? 'blocked'
          : 'ready'
      }
      if (Object.keys(state.reproductionPlans ?? {}).length > 0
        || Object.keys(state.repositoryAudits ?? {}).length > 0) return 'in-progress'
      return 'missing'
    }
    case 'protocol':
      return Object.keys(state.experimentSpecs ?? {}).length > 0 ? 'ready' : 'missing'
    case 'implementation':
      return Object.keys(state.datasetManifests ?? {}).length > 0 ? 'ready' : 'missing'
    default:
      return Object.values(state.artifacts).some(artifact => artifact.validity === 'current') ? 'in-progress' : 'missing'
  }
}
