import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import {
  operationIdentity,
  registerTool,
  resolveDshHome,
  sessionCwd,
  type Agent,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  GeoResearchError,
  PROJECT_SNAPSHOT_SCHEMA,
  RESEARCH_BRIEF_SCHEMA,
  canonicalJson,
  digestJson,
  nowUtc,
  operationKeyFor,
  parseRunRecord,
  parseSourceRecord,
  parseEvidenceRecord,
  parseRepositoryAudit,
  parseReproductionPlan,
  parseReproductionReport,
  parseReproductionTestSpecRecord,
  parseDatasetManifest,
  parseExperimentAmendment,
  parseExperimentSpec,
  parseGeodataInspectionReport,
  parseResultRecord,
  parseValidationPlan,
  parseValidationReport,
  parseReviewRecord,
  parseClaimRecord,
  parseWritingPacket,
  parseManuscriptRecord,
  parseManuscriptAudit,
  deriveValidationOverall,
  parseResearchBriefBody,
  reproductionReportOutcomeViolation,
  requestDigestFor,
  type ArtifactRecord,
  type ArtifactRef,
  type JsonValue,
  type ProjectSnapshot,
  type ProjectStateFile,
  type ResearchBrief,
  type RunRecord,
  type RunState,
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
  type ClaimProposal,
  type ClaimRecord,
  type ClaimCalculation,
  type ClaimSupportState,
  type WritingPacket,
  type ManuscriptRecord,
  type ManuscriptAudit,
  type ValidationSubjectRef,
  type ProjectReducerState,
  type Sha256Digest,
  type WorkspaceBinding,
} from '@georesearch/dsh-contracts'
import {
  ArtifactFileStore,
  ProjectFileStore,
  downstreamArtifactIds,
  exactWorkspaceMatch,
  inspectWorkspace,
  movedWorkspaceMatch,
  projectSnapshot,
  readProjectRefHint,
  sameGitCommonDirectory,
  workspaceBinding,
  type ArtifactCommitInput,
  type ArtifactStreamOptions,
  type InspectedWorkspace,
  type OperationExecutionOptions,
  type VerifiedReadLeaseOptions,
} from '@georesearch/dsh-project-provider-files'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchProjects: GeoResearchProjectService
  }
}

export const name = 'georesearch-project-service'
export const inject = ['geoResearchInstallation', 'geoResearchPolicy', 'tools']

export interface Config {
  readonly home?: string
  readonly lockTimeoutMs?: number
  readonly orphanGraceMs?: number
}

export interface ResolvedProject {
  readonly stateFile: ProjectStateFile
  readonly binding: WorkspaceBinding
  readonly workspace: InspectedWorkspace
}

export interface ResolveProjectOptions {
  readonly attachIfMissing?: boolean
  readonly confirmRebind?: boolean
}

export interface ArtifactCommitRequest {
  readonly expectedGeneration: number
  readonly sourceRelativePath: string
  readonly kind: string
  readonly mediaType: string
  readonly transformationType: string
  readonly inputDigests?: readonly Sha256Digest[]
  readonly codeDigest?: Sha256Digest
  readonly configDigest?: Sha256Digest
}

export interface DeliverablePublishRequest {
  readonly expectedGeneration: number
  readonly relativePath: string
  readonly content: string
  readonly kind: string
  readonly mediaType: string
  readonly expectedDigest?: Sha256Digest
  readonly inputDigests?: readonly Sha256Digest[]
}

export interface DeliverablePublishResult {
  readonly projectId: string
  readonly workspaceId: string
  readonly generation: number
  readonly relativePath: string
  readonly digest: Sha256Digest
  readonly artifact: ArtifactRecord
}

export interface UploadedArtifactCommitRequest {
  readonly attachmentId: string
  readonly source: AsyncIterable<Uint8Array>
  readonly maxBytes: number
  readonly mediaType: string
  readonly signal?: AbortSignal
}

export interface UploadedArtifactCommitResult {
  readonly projectId: string
  readonly workspaceId: string
  readonly generation: number
  readonly artifact: ArtifactRecord
}

export interface UploadedArtifactRollbackRequest {
  readonly attachmentId: string
  readonly expectedGeneration: number
  readonly artifact: ArtifactRef
}

export interface UploadedArtifactRollbackResult {
  readonly projectId: string
  readonly generation: number
  readonly rolledBack: boolean
}

export interface GeneratedArtifactCommitRequest {
  readonly source: AsyncIterable<Uint8Array>
  readonly maxBytes: number
  readonly kind: string
  readonly mediaType: string
  readonly transformationType: string
  readonly inputDigests?: readonly Sha256Digest[]
  readonly codeDigest?: Sha256Digest
  readonly configDigest?: Sha256Digest
  readonly signal?: AbortSignal
}

export interface ResolvedArtifactFile {
  readonly projectId: string
  readonly workspaceId: string
  readonly artifact: ArtifactRecord
  readonly path: string
}

export interface ResolvedArtifactReadLease {
  readonly projectId: string
  readonly workspaceId: string
  readonly artifact: ArtifactRecord
  readonly bytes: Uint8Array
  readonly digest: Sha256Digest
  readonly size: number
}

export interface RunRecordCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly run: RunRecord
  readonly initial: boolean
}

export interface SourceRecordCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly source: SourceRecord
}

export interface EvidenceRecordCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly evidence: EvidenceRecord
}

export interface RepositoryAuditCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly repositoryAudit: RepositoryAudit
}

export interface ReproductionPlanCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly reproductionPlan: ReproductionPlan
}

export interface ReproductionTestSpecCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly reproductionTestSpec: ReproductionTestSpecRecord
}

export interface ReproductionReportCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly reproductionReport: ReproductionReport
}

export interface ExperimentSpecCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly geodataReports: readonly GeodataInspectionReport[]
  readonly datasetManifests: readonly DatasetManifest[]
  readonly experimentSpec: ExperimentSpec
  readonly amendment: ExperimentAmendment | null
}

export interface ResultRecordsCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly run: RunRecord
  readonly results: readonly ResultRecord[]
}

export interface ValidationCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly validationPlan: ValidationPlan
  readonly validationReport: ValidationReport
}

export interface ReviewRecordCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly reviewRecord: ReviewRecord
}

export interface ClaimRecordCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly claim: ClaimRecord
}

export interface WritingPacketCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly writingPacket: WritingPacket
}

export interface ManuscriptCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly manuscript: ManuscriptRecord
  readonly manuscriptAudit: ManuscriptAudit
}

export class ProjectCoordinator {
  readonly store: ProjectFileStore
  readonly artifacts: ArtifactFileStore
  private readonly clock: () => string

  constructor(config: Config & { readonly now?: () => string }) {
    const home = resolveDshHome(config.home)
    this.clock = config.now ?? nowUtc
    this.store = new ProjectFileStore({
      home,
      ...(config.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: config.lockTimeoutMs }),
      ...(config.orphanGraceMs === undefined ? {} : { orphanGraceMs: config.orphanGraceMs }),
      now: this.clock,
    })
    this.artifacts = new ArtifactFileStore({ home })
  }

  async resolveAgent(agent: Agent, options: ResolveProjectOptions = {}): Promise<ResolvedProject> {
    const workspace = await inspectWorkspace(sessionCwd(agent))
    const states = await this.store.listProjectStates()
    const hint = await readProjectRefHint(workspace.canonicalPath)
    if (hint !== undefined) {
      const hinted = states.find(state => state.projectId === hint.projectId)
      const binding = hinted?.state.workspaceBindings[hint.workspaceId]
      if (hinted !== undefined && binding !== undefined && exactWorkspaceMatch(binding, workspace)) {
        return { stateFile: hinted, binding, workspace }
      }
    }
    const exact = matchingBindings(states, binding => exactWorkspaceMatch(binding, workspace))
    if (exact.length > 1) throw new GeoResearchError('PROJECT_BINDING_MISMATCH', 'multiple projects claim the same workspace identity')
    if (exact[0] !== undefined) return { ...exact[0], workspace }

    const moved = matchingBindings(states, binding => movedWorkspaceMatch(binding, workspace))
    if (moved.length > 1) throw new GeoResearchError('PROJECT_BINDING_MISMATCH', 'multiple projects claim the moved workspace identity')
    if (moved[0] !== undefined) {
      if (options.confirmRebind !== true) {
        throw new GeoResearchError(
          'PROJECT_REBIND_CONFIRMATION_REQUIRED',
          `workspace moved from ${moved[0].binding.canonicalPath} to ${workspace.canonicalPath}`,
        )
      }
      const rebound = workspaceBinding(
        moved[0].stateFile.projectId,
        workspace,
        moved[0].binding.bindingVersion + 1,
        this.clock(),
      )
      const operation = hostOperation(
        moved[0].stateFile.projectId,
        'workspace.rebind',
        { workspaceId: workspace.workspaceId, bindingVersion: rebound.bindingVersion },
      )
      const stateFile = await this.store.commit(moved[0].stateFile.projectId, {
        expectedGeneration: moved[0].stateFile.generation,
        ...operation,
        type: 'workspace.rebound',
        data: { workspaceBinding: rebound } as unknown as JsonValue,
      })
      return { stateFile, binding: rebound, workspace }
    }

    const sameRepository = matchingBindings(states, binding => sameGitCommonDirectory(binding, workspace))
      .filter(match => match.stateFile.state.workspaceBindings[workspace.workspaceId] === undefined)
    if (sameRepository.length > 1) {
      throw new GeoResearchError('PROJECT_BINDING_MISMATCH', 'multiple projects claim the same Git common directory')
    }
    if (sameRepository[0] !== undefined) {
      const attached = workspaceBinding(sameRepository[0].stateFile.projectId, workspace, 1, this.clock())
      const operation = hostOperation(
        sameRepository[0].stateFile.projectId,
        'workspace.attach-worktree',
        { workspaceId: workspace.workspaceId },
      )
      const stateFile = await this.store.commit(sameRepository[0].stateFile.projectId, {
        expectedGeneration: sameRepository[0].stateFile.generation,
        ...operation,
        type: 'workspace.attached',
        data: { workspaceBinding: attached } as unknown as JsonValue,
      })
      return { stateFile, binding: attached, workspace }
    }

    if (options.attachIfMissing !== true) {
      throw new GeoResearchError('PROJECT_NOT_ATTACHED', 'the live Agent workspace has no authoritative Project binding')
    }
    const projectId = projectIdFor(workspace)
    const binding = workspaceBinding(projectId, workspace, 1, this.clock())
    const operation = hostOperation(projectId, 'project.attach', { workspaceId: workspace.workspaceId })
    try {
      const stateFile = await this.store.createProject(
        projectId,
        binding,
        operation.operationKey,
        operation.requestDigest,
      )
      return { stateFile, binding, workspace }
    } catch (error) {
      if (!(error instanceof GeoResearchError) || error.code !== 'PROJECT_BINDING_MISMATCH') throw error
      const stateFile = await this.store.load(projectId)
      const existing = stateFile.state.workspaceBindings[workspace.workspaceId]
      if (existing === undefined || !exactWorkspaceMatch(existing, workspace)) throw error
      return { stateFile, binding: existing, workspace }
    }
  }

  async status(agent: Agent): Promise<ProjectSnapshot> {
    const resolved = await this.resolveAgent(agent, { attachIfMissing: true })
    return projectSnapshot(resolved.stateFile, resolved.binding.workspaceId)
  }

  async commitResearchBrief(
    execution: ToolExecution,
    expectedGeneration: number,
    rawBrief: unknown,
  ): Promise<{ readonly projectId: string; readonly generation: number; readonly brief: ResearchBrief }> {
    const agent = exactAgent(execution, 'research_brief_commit')
    const resolved = await this.resolveAgent(agent, { attachIfMissing: true })
    const body = parseResearchBriefBody(rawBrief)
    const operation = 'research_brief_commit'
    const identity = operationIdentity(execution, resolved.stateFile.projectId, operation)
    const operationKey = operationKeyFor(identity)
    const request = { expectedGeneration, brief: body } as unknown as JsonValue
    const requestDigest = requestDigestFor(operation, request)
    return await this.store.executeOperation(
      resolved.stateFile.projectId,
      operationKey,
      requestDigest,
      operation,
      async () => {
        const committedAt = this.clock()
        const brief: ResearchBrief = {
          ...body,
          committedAt,
          digest: digestJson({ ...body, committedAt }),
        }
        const stateFile = await this.store.commit(resolved.stateFile.projectId, {
          expectedGeneration,
          operationKey,
          requestDigest,
          type: 'research-brief.committed',
          data: { brief } as unknown as JsonValue,
        })
        return { projectId: stateFile.projectId, generation: stateFile.generation, brief } as unknown as JsonValue
      },
    ) as unknown as { readonly projectId: string; readonly generation: number; readonly brief: ResearchBrief }
  }

  async commitArtifact(
    execution: ToolExecution,
    request: ArtifactCommitRequest,
  ): Promise<{ readonly projectId: string; readonly generation: number; readonly artifact: ArtifactRecord }> {
    const agent = exactAgent(execution, 'artifact_commit')
    const resolved = await this.resolveAgent(agent, { attachIfMissing: true })
    const operation = 'artifact_commit'
    const identity = operationIdentity(execution, resolved.stateFile.projectId, operation)
    const operationKey = operationKeyFor(identity)
    const canonicalRequest = request as unknown as JsonValue
    const requestDigest = requestDigestFor(operation, canonicalRequest)
    return await this.store.executeOperation(
      resolved.stateFile.projectId,
      operationKey,
      requestDigest,
      operation,
      async () => {
        const artifactInput: ArtifactCommitInput = {
          projectId: resolved.stateFile.projectId,
          binding: resolved.binding,
          sourceRelativePath: request.sourceRelativePath,
          kind: request.kind,
          mediaType: request.mediaType,
          transformationType: request.transformationType,
          ...(request.inputDigests === undefined ? {} : { inputDigests: request.inputDigests }),
          ...(request.codeDigest === undefined ? {} : { codeDigest: request.codeDigest }),
          ...(request.configDigest === undefined ? {} : { configDigest: request.configDigest }),
          committedAt: this.clock(),
        }
        const artifact = await this.artifacts.snapshot(artifactInput)
        const stateFile = await this.store.commit(resolved.stateFile.projectId, {
          expectedGeneration: request.expectedGeneration,
          operationKey,
          requestDigest,
          type: 'artifact.committed',
          data: { artifact } as unknown as JsonValue,
        })
        return { projectId: stateFile.projectId, generation: stateFile.generation, artifact } as unknown as JsonValue
      },
    ) as unknown as { readonly projectId: string; readonly generation: number; readonly artifact: ArtifactRecord }
  }

  async publishDeliverable(
    execution: ToolExecution,
    rawRequest: DeliverablePublishRequest,
  ): Promise<DeliverablePublishResult> {
    const request = normalizedDeliverablePublishRequest(rawRequest)
    const agent = exactAgent(execution, 'deliverable_publish')
    const resolved = await this.resolveAgent(agent, { attachIfMissing: true })
    const operation = 'deliverable_publish'
    const identity = operationIdentity(execution, resolved.stateFile.projectId, operation)
    const operationKey = operationKeyFor(identity)
    const requestDigest = requestDigestFor(operation, request as unknown as JsonValue)
    const targetRelativePath = `deliverables/${request.relativePath}`
    const configDigest = digestJson({
      domain: 'georesearch.deliverable-publish/v1',
      relativePath: targetRelativePath,
      mediaType: request.mediaType,
    })
    let mutationMayRequireRecovery = false

    const complete = async (recovering: boolean): Promise<JsonValue> => this.store.withMutationLease(
      resolved.stateFile.projectId,
      async lease => {
        if (!recovering && lease.current.generation !== request.expectedGeneration) {
          throw new GeoResearchError(
            'PROJECT_GENERATION_CONFLICT',
            `expected generation ${request.expectedGeneration}, found ${lease.current.generation}`,
          )
        }
        const candidate = await this.artifacts.ingestStream({
          projectId: lease.current.projectId,
          binding: resolved.binding,
          sourceRelativePath: targetRelativePath,
          kind: request.kind,
          mediaType: request.mediaType,
          transformationType: 'georesearch.deliverable-publish/v1',
          ...(request.inputDigests === undefined ? {} : { inputDigests: request.inputDigests }),
          configDigest,
          committedAt: this.clock(),
        }, textByteStream(request.content), { maxBytes: DELIVERABLE_MAX_BYTES })
        const existing = lease.current.state.artifacts[candidate.artifactId]
        if (existing !== undefined && (existing.digest !== candidate.digest
          || existing.kind !== candidate.kind
          || existing.mediaType !== candidate.mediaType
          || existing.workspaceId !== candidate.workspaceId
          || existing.sourceRelativePath !== candidate.sourceRelativePath
          || existing.lineage.configDigest !== candidate.lineage.configDigest)) {
          throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `deliverable Artifact collision for ${candidate.artifactId}`)
        }
        const alreadyCurrent = existing?.validity === 'current'
        const artifact = alreadyCurrent
          ? await this.artifacts.verifyForProject(lease.current.projectId, existing)
          : candidate
        mutationMayRequireRecovery = true
        await this.artifacts.materializeDeliverable({
          projectId: lease.current.projectId,
          binding: resolved.binding,
          artifact,
          targetRelativePath,
          maxBytes: DELIVERABLE_MAX_BYTES,
          ...(request.expectedDigest === undefined ? {} : { expectedDigest: request.expectedDigest }),
        })

        let generation = lease.current.generation
        if (!alreadyCurrent) {
          const committed = await lease.commit({
            expectedGeneration: recovering ? lease.current.generation : request.expectedGeneration,
            operationKey,
            requestDigest,
            type: 'deliverable.published',
            data: { artifact } as unknown as JsonValue,
          })
          generation = committed.generation
        }
        return {
          projectId: lease.current.projectId,
          workspaceId: resolved.binding.workspaceId,
          generation,
          relativePath: targetRelativePath,
          digest: artifact.digest,
          artifact,
        } as unknown as JsonValue
      },
    )

    return await this.store.executeOperation(
      resolved.stateFile.projectId,
      operationKey,
      requestDigest,
      operation,
      () => complete(false),
      {
        recover: () => complete(true),
        classifyError: error => {
          if (error instanceof GeoResearchError
            && (error.code === 'DELIVERABLE_OVERWRITE_REQUIRES_DIGEST'
              || error.code === 'DELIVERABLE_PRECONDITION_FAILED')) {
            return { state: 'failed-final', code: error.code, message: error.message, retryable: false }
          }
          if (mutationMayRequireRecovery) {
            return {
              state: 'recovery-required',
              code: 'OPERATION_RECOVERY_REQUIRED',
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            }
          }
          if (error instanceof GeoResearchError) {
            return { state: 'failed-final', code: error.code, message: error.message, retryable: false }
          }
          return {
            state: 'recovery-required',
            code: 'OPERATION_RECOVERY_REQUIRED',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          }
        },
      },
    ) as unknown as DeliverablePublishResult
  }

  async readArtifact(agent: Agent, artifactId: string): Promise<ArtifactRecord> {
    const resolved = await this.resolveAgent(agent)
    const record = resolved.stateFile.state.artifacts[artifactId]
    if (record === undefined) throw new GeoResearchError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} is not visible in this project`)
    const verified = await this.artifacts.verifyForProject(resolved.stateFile.projectId, record)
    if (verified.integrity !== 'verified') {
      throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `artifact ${artifactId} is ${verified.integrity}`)
    }
    return verified
  }

  async readArtifactForTool(agent: Agent, artifactId: string): Promise<{
    readonly artifact: ArtifactRecord
    readonly contentStatus: 'included' | 'binary' | 'too-large' | 'not-utf8'
    readonly content?: { readonly encoding: 'utf-8'; readonly text: string }
  }> {
    const resolved = await this.resolveAgent(agent)
    const record = resolved.stateFile.state.artifacts[artifactId]
    if (record === undefined) throw new GeoResearchError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} is not visible in this project`)
    const verified = await this.artifacts.verifyForProject(resolved.stateFile.projectId, record)
    if (verified.integrity !== 'verified') {
      throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `artifact ${artifactId} is ${verified.integrity}`)
    }
    if (!textualArtifact(verified.mediaType)) return { artifact: verified, contentStatus: 'binary' }
    const maxBytes = 512 * 1024
    if (verified.size > maxBytes) return { artifact: verified, contentStatus: 'too-large' }
    return this.artifacts.withVerifiedReadLease(
      resolved.stateFile.projectId,
      verified,
      { maxBytes },
      lease => {
        try {
          return {
            artifact: lease.artifact,
            contentStatus: 'included' as const,
            content: {
              encoding: 'utf-8' as const,
              text: new TextDecoder('utf-8', { fatal: true }).decode(lease.bytes),
            },
          }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          return { artifact: lease.artifact, contentStatus: 'not-utf8' as const }
        }
      },
    )
  }

  async commitUploadedArtifact(
    agent: Agent,
    request: UploadedArtifactCommitRequest,
  ): Promise<UploadedArtifactCommitResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(request.attachmentId)) {
      throw new GeoResearchError('ATTACHMENT_INVALID', 'attachmentId must be a lowercase UUID v4')
    }
    const resolved = await this.resolveAgent(agent, { attachIfMissing: true })
    const streamOptions: ArtifactStreamOptions = {
      maxBytes: request.maxBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    const artifact = await this.artifacts.ingestStream({
      projectId: resolved.stateFile.projectId,
      binding: resolved.binding,
      kind: 'uploaded-file',
      mediaType: request.mediaType,
      transformationType: 'user-upload',
      configDigest: uploadedAttachmentConfigDigest(request.attachmentId),
      committedAt: this.clock(),
    }, request.source, streamOptions)

    const operation = hostOperation(resolved.stateFile.projectId, 'attachment.upload', {
      attachmentId: request.attachmentId,
      artifactId: artifact.artifactId,
      digest: artifact.digest,
      workspaceId: resolved.binding.workspaceId,
    })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.load(resolved.stateFile.projectId)
      const existing = current.state.artifacts[artifact.artifactId]
      if (existing !== undefined) {
        if (existing.digest !== artifact.digest || existing.workspaceId !== artifact.workspaceId) {
          throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `artifact identity collision for ${artifact.artifactId}`)
        }
        return {
          projectId: current.projectId,
          workspaceId: resolved.binding.workspaceId,
          generation: current.generation,
          artifact: await this.artifacts.verifyForProject(current.projectId, existing),
        }
      }
      try {
        const committed = await this.store.commit(current.projectId, {
          expectedGeneration: current.generation,
          ...operation,
          type: 'artifact.committed',
          data: { artifact } as unknown as JsonValue,
        })
        return {
          projectId: committed.projectId,
          workspaceId: resolved.binding.workspaceId,
          generation: committed.generation,
          artifact,
        }
      } catch (error) {
        if (!(error instanceof GeoResearchError) || error.code !== 'PROJECT_GENERATION_CONFLICT') throw error
      }
    }
    throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', 'uploaded artifact could not acquire a current project generation')
  }

  async rollbackUploadedArtifact(
    agent: Agent,
    request: UploadedArtifactRollbackRequest,
  ): Promise<UploadedArtifactRollbackResult> {
    assertUploadedAttachmentId(request.attachmentId)
    if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 1) {
      throw new TypeError('expectedGeneration must be a positive safe integer')
    }
    const resolved = await this.resolveAgent(agent)
    const current = await this.store.load(resolved.stateFile.projectId)
    const artifact = current.state.artifacts[request.artifact.artifactId]
    if (artifact === undefined) {
      return { projectId: current.projectId, generation: current.generation, rolledBack: false }
    }
    if (current.generation !== request.expectedGeneration) {
      throw new GeoResearchError(
        'PROJECT_GENERATION_CONFLICT',
        `expected generation ${request.expectedGeneration}, found ${current.generation}`,
      )
    }
    if (artifact.digest !== request.artifact.digest || artifact.kind !== request.artifact.kind
      || artifact.kind !== 'uploaded-file' || artifact.workspaceId !== resolved.binding.workspaceId
      || artifact.lineage.configDigest !== uploadedAttachmentConfigDigest(request.attachmentId)) {
      throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', 'uploaded Artifact rollback identity is invalid')
    }
    const rollback = {
      attachmentId: request.attachmentId,
      artifactId: artifact.artifactId,
      digest: artifact.digest,
      workspaceId: artifact.workspaceId,
    }
    const committed = await this.store.commit(current.projectId, {
      expectedGeneration: request.expectedGeneration,
      ...hostOperation(current.projectId, 'attachment.upload.rollback', rollback),
      type: 'artifact.upload.rolled-back',
      data: rollback as unknown as JsonValue,
    })
    return { projectId: committed.projectId, generation: committed.generation, rolledBack: true }
  }

  async commitGeneratedArtifact(
    agent: Agent,
    request: GeneratedArtifactCommitRequest,
  ): Promise<UploadedArtifactCommitResult> {
    const resolved = await this.resolveAgent(agent, { attachIfMissing: true })
    const streamOptions: ArtifactStreamOptions = {
      maxBytes: request.maxBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    const artifact = await this.artifacts.ingestStream({
      projectId: resolved.stateFile.projectId,
      binding: resolved.binding,
      kind: request.kind,
      mediaType: request.mediaType,
      transformationType: request.transformationType,
      ...(request.inputDigests === undefined ? {} : { inputDigests: request.inputDigests }),
      ...(request.codeDigest === undefined ? {} : { codeDigest: request.codeDigest }),
      ...(request.configDigest === undefined ? {} : { configDigest: request.configDigest }),
      committedAt: this.clock(),
    }, request.source, streamOptions)

    const operation = hostOperation(resolved.stateFile.projectId, 'artifact.generated', {
      artifactId: artifact.artifactId,
      digest: artifact.digest,
      workspaceId: resolved.binding.workspaceId,
      kind: artifact.kind,
    })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.load(resolved.stateFile.projectId)
      const existing = current.state.artifacts[artifact.artifactId]
      if (existing !== undefined) {
        if (existing.digest !== artifact.digest || existing.workspaceId !== artifact.workspaceId) {
          throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `artifact identity collision for ${artifact.artifactId}`)
        }
        return {
          projectId: current.projectId,
          workspaceId: resolved.binding.workspaceId,
          generation: current.generation,
          artifact: await this.artifacts.verifyForProject(current.projectId, existing),
        }
      }
      try {
        const committed = await this.store.commit(current.projectId, {
          expectedGeneration: current.generation,
          ...operation,
          type: 'artifact.committed',
          data: { artifact } as unknown as JsonValue,
        })
        return {
          projectId: committed.projectId,
          workspaceId: resolved.binding.workspaceId,
          generation: committed.generation,
          artifact,
        }
      } catch (error) {
        if (!(error instanceof GeoResearchError) || error.code !== 'PROJECT_GENERATION_CONFLICT') throw error
      }
    }
    throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', 'generated artifact could not acquire a current project generation')
  }

  async resolveArtifactFile(agent: Agent, artifactId: string): Promise<ResolvedArtifactFile> {
    const resolved = await this.resolveAgent(agent)
    const artifact = resolved.stateFile.state.artifacts[artifactId]
    if (artifact === undefined) throw new GeoResearchError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} is not visible in this project`)
    return {
      projectId: resolved.stateFile.projectId,
      workspaceId: resolved.binding.workspaceId,
      artifact: await this.artifacts.verifyForProject(resolved.stateFile.projectId, artifact),
      path: await this.artifacts.verifiedObjectPath(resolved.stateFile.projectId, artifact),
    }
  }

  async withVerifiedReadLease<T>(
    agent: Agent,
    artifactId: string,
    options: VerifiedReadLeaseOptions,
    use: (lease: ResolvedArtifactReadLease) => T | Promise<T>,
  ): Promise<T> {
    const resolved = await this.resolveAgent(agent)
    const artifact = resolved.stateFile.state.artifacts[artifactId]
    if (artifact === undefined) {
      throw new GeoResearchError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} is not visible in this project`)
    }
    return this.artifacts.withVerifiedReadLease(
      resolved.stateFile.projectId,
      artifact,
      options,
      lease => use({
        projectId: resolved.stateFile.projectId,
        workspaceId: resolved.binding.workspaceId,
        ...lease,
      }),
    )
  }

  async markDrift(
    agent: Agent,
    changedDigests: readonly Sha256Digest[],
    indicators: readonly string[],
  ): Promise<ProjectStateFile> {
    const resolved = await this.resolveAgent(agent)
    const artifactIds = downstreamArtifactIds(resolved.stateFile.state.artifacts, new Set(changedDigests))
    const operation = hostOperation(resolved.stateFile.projectId, 'project.drift', { changedDigests, indicators })
    return this.store.commit(resolved.stateFile.projectId, {
      expectedGeneration: resolved.stateFile.generation,
      ...operation,
      type: 'artifacts.staled',
      data: { artifactIds, indicators: [...new Set(indicators)].sort() } as unknown as JsonValue,
    })
  }

  loadProject(projectId: string): Promise<ProjectStateFile> {
    return this.store.load(projectId)
  }

  listProjectStates(): Promise<ProjectStateFile[]> {
    return this.store.listProjectStates()
  }

  recoverProject(projectId: string) {
    return this.store.recover(projectId)
  }

  executeOperation<T extends JsonValue>(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    operation: string,
    action: () => Promise<T>,
    options: OperationExecutionOptions<T> = {},
  ): Promise<T> {
    return this.store.executeOperation(projectId, operationKey, requestDigest, operation, action, options)
  }

  async commitRunRecord(projectId: string, request: RunRecordCommitRequest): Promise<ProjectStateFile> {
    const run = parseRunRecord(request.run)
    if (run.projectId !== projectId) throw new TypeError('RunRecord projectId does not match project')
    const current = await this.store.load(projectId)
    const existing = current.state.runs[run.runId]
    if (request.initial) {
      if (existing !== undefined) throw new GeoResearchError('RUN_STATE_CONFLICT', `run ${run.runId} already exists`)
      if (run.state !== 'starting') {
        throw new GeoResearchError('RUN_STATE_CONFLICT', 'an initial RunRecord must be starting')
      }
      if (run.kind === 'formal') assertFormalRunBinding(current, run)
    } else {
      if (existing === undefined) throw new GeoResearchError('RUN_NOT_FOUND', `run ${run.runId} does not exist`)
      if (runIdentityDigest(existing) !== runIdentityDigest(run)) {
        throw new GeoResearchError('RUN_STATE_CONFLICT', `run ${run.runId} immutable identity changed`)
      }
      if (!validRunTransition(existing.state, run.state)) {
        throw new GeoResearchError(
          'RUN_STATE_CONFLICT',
          `run ${run.runId} cannot transition from ${existing.state} to ${run.state}`,
        )
      }
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: request.initial ? 'run.recorded' : 'run.updated',
      data: { run } as unknown as JsonValue,
    })
  }

  async verifyRunInputDigests(projectId: string, digests: readonly Sha256Digest[]): Promise<void> {
    const state = await this.store.load(projectId)
    const artifacts = Object.values(state.state.artifacts)
    for (const digest of digests) {
      const record = artifacts
        .filter(candidate => candidate.digest === digest
          && candidate.materialization === 'committed'
          && candidate.validity === 'current')
        .sort((left, right) => left.artifactId.localeCompare(right.artifactId))[0]
      if (record === undefined) {
        throw new GeoResearchError('ARTIFACT_NOT_FOUND', `run input digest ${digest} is not a current committed Artifact`)
      }
      const verified = await this.artifacts.verifyForProject(projectId, record)
      if (verified.integrity !== 'verified') {
        throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `run input digest ${digest} is ${verified.integrity}`)
      }
    }
  }

  async commitSourceRecord(projectId: string, request: SourceRecordCommitRequest): Promise<ProjectStateFile> {
    const source = parseSourceRecord(request.source)
    const current = await this.store.load(projectId)
    const existing = current.state.sources?.[source.sourceId]
    if (existing !== undefined) {
      if (existing.digest !== source.digest) {
        throw new GeoResearchError('SOURCE_INVALID', `source ${source.sourceId} already has another digest`)
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'source.recorded',
      data: { source } as unknown as JsonValue,
    })
  }

  async commitEvidenceRecord(projectId: string, request: EvidenceRecordCommitRequest): Promise<ProjectStateFile> {
    const evidence = parseEvidenceRecord(request.evidence)
    const current = await this.store.load(projectId)
    if (current.state.sources?.[evidence.sourceId] === undefined) {
      throw new GeoResearchError('EVIDENCE_SOURCE_NOT_FOUND', `source ${evidence.sourceId} is not registered`)
    }
    const artifact = current.state.artifacts[evidence.artifactId]
    if (artifact === undefined || artifact.digest !== evidence.artifactDigest
      || artifact.materialization !== 'committed' || artifact.validity !== 'current') {
      throw new GeoResearchError(
        'EVIDENCE_READ_RECEIPT_MISMATCH',
        `evidence artifact ${evidence.artifactId} is not the current committed digest`,
      )
    }
    const existing = current.state.evidence?.[evidence.evidenceId]
    if (existing !== undefined) {
      if (existing.digest !== evidence.digest) {
        throw new GeoResearchError('EVIDENCE_CANDIDATE_INVALID', `evidence ${evidence.evidenceId} already differs`)
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'evidence.recorded',
      data: { evidence } as unknown as JsonValue,
    })
  }

  async commitRepositoryAudit(projectId: string, request: RepositoryAuditCommitRequest): Promise<ProjectStateFile> {
    const repositoryAudit = parseRepositoryAudit(request.repositoryAudit)
    assertRecordDigest(repositoryAudit, 'RepositoryAudit')
    if (repositoryAudit.projectId !== projectId) throw new TypeError('RepositoryAudit projectId does not match project')
    const current = await this.store.load(projectId)
    const source = current.state.sources?.[repositoryAudit.sourceId]
    if (source === undefined || source.digest !== repositoryAudit.sourceDigest) {
      throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', 'RepositoryAudit source is not current')
    }
    const binding = current.state.workspaceBindings[repositoryAudit.workspaceId]
    if (binding === undefined || binding.bindingVersion !== repositoryAudit.workspaceBindingVersion) {
      throw new GeoResearchError('PROJECT_BINDING_MISMATCH', 'RepositoryAudit workspace binding is not current')
    }
    const existing = current.state.repositoryAudits?.[repositoryAudit.auditId]
    if (existing !== undefined) {
      if (!sameRepositoryAuditSnapshot(existing, repositoryAudit)) {
        throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `repository audit ${repositoryAudit.auditId} already differs`)
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'repository.audit.recorded',
      data: { repositoryAudit } as unknown as JsonValue,
    })
  }

  async commitReproductionPlan(projectId: string, request: ReproductionPlanCommitRequest): Promise<ProjectStateFile> {
    const reproductionPlan = parseReproductionPlan(request.reproductionPlan)
    assertRecordDigest(reproductionPlan, 'ReproductionPlan')
    if (reproductionPlan.projectId !== projectId) throw new TypeError('ReproductionPlan projectId does not match project')
    const current = await this.store.load(projectId)
    const audit = current.state.repositoryAudits?.[reproductionPlan.repositoryAuditId]
    if (audit === undefined || audit.digest !== reproductionPlan.repositoryAuditDigest
      || audit.sourceTreeDigest !== reproductionPlan.sourceTreeDigest
      || audit.sourceId !== reproductionPlan.sourceId
      || audit.workspaceId !== reproductionPlan.workspaceId
      || audit.workspaceBindingVersion !== reproductionPlan.workspaceBindingVersion) {
      throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', 'ReproductionPlan repository audit is not current')
    }
    if (reproductionPlan.targetRepository.commit !== audit.repository.targetCommit
      || !sameNullableRepositoryUrl(reproductionPlan.targetRepository.remoteUrl, audit.repository.remoteUrl)) {
      throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', 'ReproductionPlan target repository differs from its audit')
    }
    if (reproductionPlan.scope === 'exact' && (audit.repository.dirty || !audit.repository.targetMatchesHead)) {
      throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', 'exact reproduction requires a clean checkout at the audited target commit')
    }
    for (const target of reproductionPlan.targetResults) {
      if (target.evidenceId !== null
        && current.state.evidence?.[target.evidenceId]?.sourceId !== reproductionPlan.sourceId) {
        throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', `target result ${target.resultId} evidence is not current`)
      }
    }
    const existing = current.state.reproductionPlans?.[reproductionPlan.planId]
    if (existing !== undefined) {
      if (!sameReproductionPlanSnapshot(existing, reproductionPlan)) {
        throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', `reproduction plan ${reproductionPlan.planId} already differs`)
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'reproduction.plan.recorded',
      data: { reproductionPlan } as unknown as JsonValue,
    })
  }

  async commitReproductionTestSpec(
    projectId: string,
    request: ReproductionTestSpecCommitRequest,
  ): Promise<ProjectStateFile> {
    const reproductionTestSpec = parseReproductionTestSpecRecord(request.reproductionTestSpec)
    assertRecordDigest(reproductionTestSpec, 'ReproductionTestSpecRecord')
    if (reproductionTestSpec.projectId !== projectId) throw new TypeError('ReproductionTestSpecRecord projectId does not match project')
    if (digestJson(reproductionTestSpec.spec) !== reproductionTestSpec.specDigest) {
      throw new GeoResearchError('TEST_SPEC_INVALID', 'Reproduction TestSpec digest does not match its spec')
    }
    if (reproductionTestSpec.spec.runner === 'smoke') {
      throw new GeoResearchError('TEST_SPEC_INVALID', 'dynamic Reproduction TestSpecs cannot register smoke entrypoints')
    }
    const current = await this.store.load(projectId)
    const plan = current.state.reproductionPlans?.[reproductionTestSpec.planId]
    const audit = current.state.repositoryAudits?.[reproductionTestSpec.repositoryAuditId]
    if (plan === undefined || audit === undefined
      || plan.sourceId !== audit.sourceId
      || plan.workspaceId !== audit.workspaceId
      || plan.workspaceBindingVersion !== audit.workspaceBindingVersion
      || audit.sourceTreeDigest !== reproductionTestSpec.sourceTreeDigest
      || reproductionTestSpec.workspaceId !== audit.workspaceId
      || reproductionTestSpec.workspaceBindingVersion !== audit.workspaceBindingVersion) {
      throw new GeoResearchError(
        'TEST_SPEC_INVALID',
        'Reproduction TestSpec is not bound to the plan workspace and selected repository audit',
      )
    }
    const testSpecId = reproductionTestSpec.spec.testSpecId
    const existing = current.state.reproductionTestSpecs?.[testSpecId]
    if (existing !== undefined) {
      if (!sameReproductionTestSpecSnapshot(existing, reproductionTestSpec)) {
        throw new GeoResearchError('TEST_SPEC_INVALID', `TestSpec ${testSpecId} already differs`)
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'reproduction.test-spec.recorded',
      data: { reproductionTestSpec } as unknown as JsonValue,
    })
  }

  async commitReproductionReport(projectId: string, request: ReproductionReportCommitRequest): Promise<ProjectStateFile> {
    const reproductionReport = parseReproductionReport(request.reproductionReport)
    assertLifecycleRecordDigest(reproductionReport, 'reviewStatus', 'ReproductionReport')
    if (reproductionReport.projectId !== projectId) throw new TypeError('ReproductionReport projectId does not match project')
    const current = await this.store.load(projectId)
    const plan = current.state.reproductionPlans?.[reproductionReport.planId]
    const baseline = current.state.repositoryAudits?.[reproductionReport.baselineAuditId]
    const final = current.state.repositoryAudits?.[reproductionReport.finalAuditId]
    const artifact = current.state.artifacts[reproductionReport.reportArtifact.artifactId]
    if (plan === undefined || plan.digest !== reproductionReport.planDigest
      || baseline === undefined || baseline.digest !== reproductionReport.baselineAuditDigest
      || final === undefined || final.digest !== reproductionReport.finalAuditDigest
      || baseline.auditId !== plan.repositoryAuditId
      || baseline.sourceTreeDigest !== plan.sourceTreeDigest
      || baseline.workspaceId !== plan.workspaceId
      || baseline.workspaceBindingVersion !== plan.workspaceBindingVersion
      || final.sourceId !== plan.sourceId
      || final.workspaceId !== plan.workspaceId
      || final.workspaceBindingVersion !== plan.workspaceBindingVersion
      || reproductionReport.workspaceId !== plan.workspaceId
      || reproductionReport.workspaceBindingVersion !== plan.workspaceBindingVersion
      || artifact === undefined || artifact.digest !== reproductionReport.reportArtifact.digest
      || artifact.kind !== reproductionReport.reportArtifact.kind
      || artifact.materialization !== 'committed'
      || artifact.integrity !== 'verified'
      || artifact.validity !== 'current') {
      throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', 'ReproductionReport references are not current')
    }
    const reportedRunIds = new Set(reproductionReport.runIds)
    for (const diagnosis of reproductionReport.diagnostics) {
      if (diagnosis.relatedRunIds.some(runId => !reportedRunIds.has(runId))) {
        throw new GeoResearchError(
          'REPRODUCTION_REPORT_INVALID',
          `diagnosis ${diagnosis.code} references an unreported run`,
        )
      }
      if (diagnosis.relatedArtifactIds.some(artifactId => {
        const related = current.state.artifacts[artifactId]
        return related === undefined || related.materialization !== 'committed'
          || related.integrity !== 'verified' || related.validity !== 'current'
      })) {
        throw new GeoResearchError(
          'REPRODUCTION_REPORT_INVALID',
          `diagnosis ${diagnosis.code} references a non-current Artifact`,
        )
      }
    }
    const runs: RunRecord[] = []
    for (const runId of reproductionReport.runIds) {
      const run = current.state.runs[runId]
      if (run === undefined) {
        throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `ReproductionReport run ${runId} is unknown`)
      }
      runs.push(run)
      if (run.projectId !== projectId
        || run.workspaceId !== plan.workspaceId
        || run.workspaceBindingVersion !== plan.workspaceBindingVersion
        || run.sourceTreeDigest !== final.sourceTreeDigest) {
        throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `ReproductionReport run ${runId} is not bound to the final audit`)
      }
      if (run.kind === 'local-test') {
        const bound = Object.values(current.state.reproductionTestSpecs ?? {})
          .some(testSpec => testSpec.planId === plan.planId
            && testSpec.repositoryAuditId === final.auditId
            && testSpec.sourceTreeDigest === final.sourceTreeDigest
            && testSpec.specDigest === run.experimentSpecDigest)
        if (!bound) {
          throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `ReproductionReport run ${runId} has no final-audit TestSpec`)
        }
      } else if (run.experimentSpecDigest !== plan.digest) {
        throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `formal run ${runId} is not bound to the ReproductionPlan`)
      }
    }
    const violation = reproductionReportOutcomeViolation(
      reproductionReport,
      plan,
      baseline,
      final,
      runs,
      Object.values(current.state.reproductionTestSpecs ?? {}),
    )
    if (violation !== undefined) throw new GeoResearchError(violation.code, violation.message)
    const existing = current.state.reproductionReports?.[reproductionReport.reportId]
    if (existing !== undefined) {
      if (existing.digest !== reproductionReport.digest) {
        throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `reproduction report ${reproductionReport.reportId} already differs`)
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'reproduction.report.recorded',
      data: { reproductionReport } as unknown as JsonValue,
    })
  }

  async commitExperimentSpec(projectId: string, request: ExperimentSpecCommitRequest): Promise<ProjectStateFile> {
    const geodataReports = request.geodataReports.map(parseGeodataInspectionReport)
    const datasetManifests = request.datasetManifests.map(parseDatasetManifest)
    const experimentSpec = parseExperimentSpec(request.experimentSpec)
    const amendment = request.amendment === null ? null : parseExperimentAmendment(request.amendment)
    for (const [field, value] of [
      ...geodataReports.map(value => ['GeodataInspectionReport', value] as const),
      ...datasetManifests.map(value => ['DatasetManifest', value] as const),
      ['ExperimentSpec', experimentSpec] as const,
      ...(amendment === null ? [] : [['ExperimentAmendment', amendment] as const]),
    ]) assertRecordDigest(value, field)
    if (experimentSpec.projectId !== projectId) throw new TypeError('ExperimentSpec projectId does not match project')
    const current = await this.store.load(projectId)
    const binding = current.state.workspaceBindings[experimentSpec.workspaceId]
    if (binding === undefined || binding.bindingVersion !== experimentSpec.workspaceBindingVersion) {
      throw new GeoResearchError('PROJECT_BINDING_MISMATCH', 'ExperimentSpec workspace binding is not current')
    }
    if (current.state.researchBrief?.digest !== experimentSpec.researchBriefDigest) {
      throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'ExperimentSpec ResearchBrief is not current')
    }
    const audit = current.state.repositoryAudits?.[experimentSpec.repositoryAuditId]
    if (audit === undefined || audit.digest !== experimentSpec.repositoryAuditDigest
      || audit.sourceTreeDigest !== experimentSpec.sourceTreeDigest
      || audit.workspaceId !== experimentSpec.workspaceId
      || audit.workspaceBindingVersion !== experimentSpec.workspaceBindingVersion) {
      throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'ExperimentSpec RepositoryAudit is not current')
    }
    const reportByDigest = new Map(geodataReports.map(report => [report.digest, report]))
    const manifestById = new Map(datasetManifests.map(manifest => [manifest.datasetId, manifest]))
    if (reportByDigest.size !== geodataReports.length || manifestById.size !== datasetManifests.length) {
      throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'ExperimentSpec contains duplicate geodata records')
    }
    for (const report of geodataReports) {
      if (report.projectId !== projectId || report.workspaceId !== experimentSpec.workspaceId
        || report.workspaceBindingVersion !== experimentSpec.workspaceBindingVersion) {
        throw new GeoResearchError('GEODATA_INVALID', `report ${report.reportId} belongs to another project binding`)
      }
      for (const inspected of report.assets) assertCurrentArtifact(current, inspected.artifactRef, `report ${report.reportId}`)
    }
    for (const manifest of datasetManifests) {
      if (manifest.projectId !== projectId || manifest.workspaceId !== experimentSpec.workspaceId
        || manifest.workspaceBindingVersion !== experimentSpec.workspaceBindingVersion
        || !reportByDigest.has(manifest.inspectionReportDigest)) {
        throw new GeoResearchError('DATASET_MANIFEST_INVALID', `manifest ${manifest.datasetId} is not bound to an inspection report`)
      }
      if (manifest.status !== 'verified') {
        throw new GeoResearchError('GEODATA_MANDATORY_CHECK_BLOCKED', `manifest ${manifest.datasetId} is blocked`)
      }
      for (const artifactRef of manifest.assetRefs) assertCurrentArtifact(current, artifactRef, `manifest ${manifest.datasetId}`)
    }
    if (experimentSpec.datasets.length !== datasetManifests.length
      || experimentSpec.datasets.some(reference => manifestById.get(reference.datasetId)?.digest !== reference.datasetDigest)) {
      throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'ExperimentSpec dataset refs differ from committed manifests')
    }
    if (amendment === null) {
      if (experimentSpec.revision !== 1 || experimentSpec.parentSpecDigest !== null
        || experimentSpec.amendmentIds.length !== 0) {
        throw new GeoResearchError('EXPERIMENT_AMENDMENT_INVALID', 'initial ExperimentSpec contains amendment state')
      }
    } else {
      const parent = current.state.experimentSpecs?.[amendment.fromSpecId]
      if (parent === undefined || parent.digest !== amendment.fromSpecDigest
        || parent.digest !== experimentSpec.parentSpecDigest
        || amendment.projectId !== projectId || amendment.experimentId !== experimentSpec.experimentId
        || amendment.toSpecId !== experimentSpec.specId || amendment.toSpecDigest !== experimentSpec.digest
        || experimentSpec.revision !== parent.revision + 1
        || !experimentSpec.amendmentIds.includes(amendment.amendmentId)) {
        throw new GeoResearchError('EXPERIMENT_AMENDMENT_INVALID', 'ExperimentAmendment lineage is invalid')
      }
      if (amendment.resultsSeenRunIds.some(runId => current.state.runs[runId] === undefined)) {
        throw new GeoResearchError('EXPERIMENT_AMENDMENT_INVALID', 'ExperimentAmendment references an unknown viewed Run')
      }
    }
    const existing = current.state.experimentSpecs?.[experimentSpec.specId]
    if (existing !== undefined) {
      if (existing.digest !== experimentSpec.digest) {
        throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', `ExperimentSpec ${experimentSpec.specId} already differs`)
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'experiment.spec.committed',
      data: { geodataReports, datasetManifests, experimentSpec, amendment } as unknown as JsonValue,
    })
  }

  async commitResultRecords(projectId: string, request: ResultRecordsCommitRequest): Promise<ProjectStateFile> {
    const run = parseRunRecord(request.run)
    const results = request.results.map(parseResultRecord)
    if (results.length === 0) throw new GeoResearchError('RESULT_INVALID', 'result commit must not be empty')
    if (new Set(results.map(result => result.resultId)).size !== results.length) {
      throw new GeoResearchError('RESULT_INVALID', 'result IDs must be unique')
    }
    for (const result of results) assertLifecycleRecordDigest(result, 'validationStatus', 'ResultRecord')
    const current = await this.store.load(projectId)
    const storedRun = current.state.runs[run.runId]
    if (run.projectId !== projectId || storedRun === undefined || storedRun.kind !== 'formal'
      || storedRun.state !== 'succeeded' || run.state !== 'succeeded'
      || canonicalJson(withoutRunOutputs(storedRun)) !== canonicalJson(withoutRunOutputs(run))) {
      throw new GeoResearchError('RESULT_INVALID', `RunRecord ${run.runId} is not a valid succeeded output update`)
    }
    const expectedOutputRefs = uniqueArtifactRefs(results.flatMap(result => result.artifactRefs))
    if (canonicalJson(run.outputArtifactRefs) !== canonicalJson(expectedOutputRefs)) {
      throw new GeoResearchError('RESULT_INVALID', `RunRecord ${run.runId} output Artifacts differ from its Results`)
    }
    for (const artifactRef of run.outputArtifactRefs) assertCurrentArtifact(current, artifactRef, `run ${run.runId}`)
    for (const result of results) {
      if (result.projectId !== projectId) throw new TypeError('ResultRecord projectId does not match project')
      const spec = current.state.experimentSpecs?.[result.experimentSpecId]
      if (result.runId !== run.runId || digestJson(run) !== result.runDigest
        || run.experimentSpecDigest !== result.experimentSpecDigest
        || spec === undefined || spec.digest !== result.experimentSpecDigest
        || run.workspaceId !== result.workspaceId || run.workspaceBindingVersion !== result.workspaceBindingVersion
        || JSON.stringify(run.datasetDigests) !== JSON.stringify(result.datasetDigests)) {
        throw new GeoResearchError('RESULT_INVALID', `ResultRecord ${result.resultId} is not bound to its succeeded formal Run`)
      }
      const metric = spec.metrics.find(candidate => candidate.metricId === result.metricId)
      if (metric === undefined || metric.unit !== result.unit || metric.aggregation !== result.aggregation) {
        throw new GeoResearchError('RESULT_INVALID', `ResultRecord ${result.resultId} does not match its frozen metric`)
      }
      if (!spec.datasets.some(dataset => dataset.datasetId === result.scope.datasetId)) {
        throw new GeoResearchError('RESULT_INVALID', `ResultRecord ${result.resultId} references an undeclared dataset`)
      }
      for (const artifactRef of result.artifactRefs) assertCurrentArtifact(current, artifactRef, `result ${result.resultId}`)
      const existing = current.state.results?.[result.resultId]
      if (existing !== undefined && existing.digest !== result.digest) {
        throw new GeoResearchError('RESULT_INVALID', `ResultRecord ${result.resultId} already differs`)
      }
    }
    if (digestJson(storedRun) === digestJson(run)
      && results.every(result => current.state.results?.[result.resultId]?.digest === result.digest)) return current
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'result.records.committed',
      data: { run, results } as unknown as JsonValue,
    })
  }

  async commitValidation(projectId: string, request: ValidationCommitRequest): Promise<ProjectStateFile> {
    const validationPlan = parseValidationPlan(request.validationPlan)
    const validationReport = parseValidationReport(request.validationReport)
    assertRecordDigest(validationPlan, 'ValidationPlan')
    assertRecordDigest(validationReport, 'ValidationReport')
    if (validationPlan.projectId !== projectId || validationReport.projectId !== projectId) {
      throw new TypeError('Validation projectId does not match project')
    }
    const current = await this.store.load(projectId)
    assertCurrentBinding(current, validationPlan.workspaceId, validationPlan.workspaceBindingVersion, 'ValidationPlan')
    if (validationReport.workspaceId !== validationPlan.workspaceId
      || validationReport.workspaceBindingVersion !== validationPlan.workspaceBindingVersion
      || validationReport.planId !== validationPlan.planId
      || validationReport.planDigest !== validationPlan.digest
      || JSON.stringify(validationReport.subjects) !== JSON.stringify(validationPlan.subjects)
      || deriveValidationOverall(validationPlan, validationReport.validatorResults) !== validationReport.overall) {
      throw new GeoResearchError('VALIDATION_REPORT_INVALID', 'ValidationReport differs from its Host plan')
    }
    for (const subject of validationPlan.subjects) assertCurrentSubject(current, subject)
    const existingPlan = current.state.validationPlans?.[validationPlan.planId]
    const existingReport = current.state.validationReports?.[validationReport.reportId]
    if (existingPlan !== undefined || existingReport !== undefined) {
      if (existingPlan?.digest !== validationPlan.digest || existingReport?.digest !== validationReport.digest) {
        throw new GeoResearchError('VALIDATION_REPORT_INVALID', 'validation identity already differs')
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'validation.completed',
      data: { validationPlan, validationReport } as unknown as JsonValue,
    })
  }

  async commitReviewRecord(projectId: string, request: ReviewRecordCommitRequest): Promise<ProjectStateFile> {
    const reviewRecord = parseReviewRecord(request.reviewRecord)
    assertRecordDigest(reviewRecord, 'ReviewRecord')
    if (reviewRecord.projectId !== projectId) throw new TypeError('ReviewRecord projectId does not match project')
    const current = await this.store.load(projectId)
    assertCurrentBinding(current, reviewRecord.workspaceId, reviewRecord.workspaceBindingVersion, 'ReviewRecord')
    assertReviewRecordAuthority(current.state, reviewRecord)
    if (reviewRecord.supersedesReviewIds.includes(reviewRecord.reviewId)) {
      throw new GeoResearchError('REVIEW_INVALID', 'a review cannot supersede itself')
    }
    const existing = current.state.reviewRecords?.[reviewRecord.reviewId]
    if (existing !== undefined) {
      if (existing.digest !== reviewRecord.digest) throw new GeoResearchError('REVIEW_INVALID', 'review identity already differs')
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'review.recorded',
      data: { reviewRecord } as unknown as JsonValue,
    })
  }

  async commitClaimRecord(projectId: string, request: ClaimRecordCommitRequest): Promise<ProjectStateFile> {
    const claim = parseClaimRecord(request.claim)
    assertRecordDigest(claim, 'ClaimRecord')
    if (claim.projectId !== projectId) throw new TypeError('ClaimRecord projectId does not match project')
    const current = await this.store.load(projectId)
    assertCurrentBinding(current, claim.workspaceId, claim.workspaceBindingVersion, 'ClaimRecord')
    const assessment = assessClaimSupport(current.state, claim)
    const expectedSupport = claim.approvalState === 'rejected' ? 'rejected' : assessment.supportState
    if (claim.supportState !== expectedSupport
      || claim.integrity !== assessment.integrity
      || claim.validity !== assessment.validity
      || JSON.stringify(claim.calculation) !== JSON.stringify(assessment.calculation)) {
      throw new GeoResearchError('CLAIM_INVALID', 'ClaimRecord differs from Host support assessment')
    }
    if (claim.approvalState === 'approved'
      && (claim.approval.outcome !== 'approved' || claim.approval.source !== 'user'
        || !claimEligibleForWriting(claim, current.state))) {
      throw new GeoResearchError('CLAIM_APPROVAL_REQUIRED', 'approved Claim lacks user approval or minimum support')
    }
    if (claim.approvalState === 'rejected' && claim.approval.outcome !== 'rejected') {
      throw new GeoResearchError('CLAIM_INVALID', 'rejected Claim lacks a rejection outcome')
    }
    const existing = current.state.claims?.[claim.claimId]
    if (existing !== undefined) {
      if (existing.digest !== claim.digest) throw new GeoResearchError('CLAIM_INVALID', 'claim identity already differs')
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'claim.recorded',
      data: { claim } as unknown as JsonValue,
    })
  }

  async commitWritingPacket(projectId: string, request: WritingPacketCommitRequest): Promise<ProjectStateFile> {
    const writingPacket = parseWritingPacket(request.writingPacket)
    assertRecordDigest(writingPacket, 'WritingPacket')
    if (writingPacket.projectId !== projectId) throw new TypeError('WritingPacket projectId does not match project')
    const current = await this.store.load(projectId)
    assertCurrentBinding(current, writingPacket.workspaceId, writingPacket.workspaceBindingVersion, 'WritingPacket')
    if (current.state.researchBrief?.digest !== writingPacket.researchBrief.digest) {
      throw new GeoResearchError('WRITING_PACKET_INVALID', 'WritingPacket ResearchBrief is not current')
    }
    const claims = Object.values(current.state.claims ?? {}).sort((left, right) => left.claimId.localeCompare(right.claimId))
    const eligible = claims.filter(claim => claimEligibleForWriting(claim, current.state))
    const expectedForbidden = claims.filter(claim => !eligible.includes(claim)).map(claim => claim.claimId).sort()
    if (JSON.stringify(writingPacket.claims.map(claim => claim.claimId).sort())
      !== JSON.stringify(eligible.map(claim => claim.claimId).sort())
      || JSON.stringify([...writingPacket.forbiddenClaimIds].sort()) !== JSON.stringify(expectedForbidden)
      || writingPacket.claims.some(claim => current.state.claims?.[claim.claimId]?.digest !== claim.digest)) {
      throw new GeoResearchError('WRITING_PACKET_INVALID', 'WritingPacket Claim filter is incomplete or forged')
    }
    const closure = collectWritingInputs(current.state, eligible)
    assertExactRecordArray(writingPacket.sources, closure.sources, 'WritingPacket sources')
    assertExactRecordArray(writingPacket.evidence, closure.evidence, 'WritingPacket evidence')
    assertExactRecordArray(writingPacket.experimentSpecs, closure.experimentSpecs, 'WritingPacket ExperimentSpecs')
    assertExactRunArray(writingPacket.runs, closure.runs, 'WritingPacket Runs')
    assertExactRecordArray(writingPacket.results, closure.results, 'WritingPacket results')
    assertExactRecordArray(writingPacket.validationReports, closure.validationReports, 'WritingPacket validations')
    if (JSON.stringify(writingPacket.artifactRefs) !== JSON.stringify(closure.artifactRefs)
      || JSON.stringify(writingPacket.limitations) !== JSON.stringify(closure.limitations)) {
      throw new GeoResearchError('WRITING_PACKET_INVALID', 'WritingPacket closure differs from approved Claim inputs')
    }
    const existing = current.state.writingPackets?.[writingPacket.packetId]
    if (existing !== undefined) {
      if (existing.digest !== writingPacket.digest) throw new GeoResearchError('WRITING_PACKET_INVALID', 'packet identity already differs')
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'writing-packet.recorded',
      data: { writingPacket } as unknown as JsonValue,
    })
  }

  async commitManuscript(projectId: string, request: ManuscriptCommitRequest): Promise<ProjectStateFile> {
    const manuscript = parseManuscriptRecord(request.manuscript)
    const manuscriptAudit = parseManuscriptAudit(request.manuscriptAudit)
    assertRecordDigest(manuscript, 'ManuscriptRecord')
    assertRecordDigest(manuscriptAudit, 'ManuscriptAudit')
    if (manuscript.projectId !== projectId || manuscriptAudit.projectId !== projectId) {
      throw new TypeError('Manuscript projectId does not match project')
    }
    const current = await this.store.load(projectId)
    assertCurrentBinding(current, manuscript.workspaceId, manuscript.workspaceBindingVersion, 'ManuscriptRecord')
    const packet = current.state.writingPackets?.[manuscript.packetId]
    if (packet === undefined || packet.digest !== manuscript.packetDigest
      || manuscriptAudit.packetId !== manuscript.packetId
      || manuscriptAudit.packetDigest !== manuscript.packetDigest
      || manuscriptAudit.manuscriptId !== manuscript.manuscriptId
      || manuscriptAudit.auditId !== manuscript.auditId
      || (manuscript.status === 'validated') !== (manuscriptAudit.overall === 'passed')
      || (manuscriptAudit.overall === 'passed' && Object.values(manuscriptAudit.checks).some(value => !value))) {
      throw new GeoResearchError('MANUSCRIPT_INVALID', 'Manuscript and audit authority chain is invalid')
    }
    const existing = current.state.manuscripts?.[manuscript.manuscriptId]
    const existingAudit = current.state.manuscriptAudits?.[manuscriptAudit.auditId]
    if (existing !== undefined || existingAudit !== undefined) {
      if (existing?.digest !== manuscript.digest || existingAudit?.digest !== manuscriptAudit.digest) {
        throw new GeoResearchError('MANUSCRIPT_INVALID', 'manuscript identity already differs')
      }
      return current
    }
    return this.store.commit(projectId, {
      expectedGeneration: request.expectedGeneration,
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: 'manuscript.audited',
      data: { manuscript, manuscriptAudit } as unknown as JsonValue,
    })
  }
}

export class GeoResearchProjectService extends Service {
  readonly coordinator: ProjectCoordinator

  constructor(ctx: Context, config: Config) {
    super(ctx, 'geoResearchProjects')
    this.coordinator = new ProjectCoordinator(config)
  }

  resolveAgent(agent: Agent, options?: ResolveProjectOptions): Promise<ResolvedProject> {
    return this.coordinator.resolveAgent(agent, options)
  }

  status(agent: Agent): Promise<ProjectSnapshot> {
    return this.coordinator.status(agent)
  }

  commitResearchBrief(
    execution: ToolExecution,
    expectedGeneration: number,
    rawBrief: unknown,
  ): Promise<{ readonly projectId: string; readonly generation: number; readonly brief: ResearchBrief }> {
    return this.coordinator.commitResearchBrief(execution, expectedGeneration, rawBrief)
  }

  commitArtifact(
    execution: ToolExecution,
    request: ArtifactCommitRequest,
  ): Promise<{ readonly projectId: string; readonly generation: number; readonly artifact: ArtifactRecord }> {
    return this.coordinator.commitArtifact(execution, request)
  }

  publishDeliverable(
    execution: ToolExecution,
    request: DeliverablePublishRequest,
  ): Promise<DeliverablePublishResult> {
    return this.coordinator.publishDeliverable(execution, request)
  }

  readArtifact(agent: Agent, artifactId: string): Promise<ArtifactRecord> {
    return this.coordinator.readArtifact(agent, artifactId)
  }

  readArtifactForTool(agent: Agent, artifactId: string) {
    return this.coordinator.readArtifactForTool(agent, artifactId)
  }

  commitUploadedArtifact(agent: Agent, request: UploadedArtifactCommitRequest): Promise<UploadedArtifactCommitResult> {
    return this.coordinator.commitUploadedArtifact(agent, request)
  }

  rollbackUploadedArtifact(
    agent: Agent,
    request: UploadedArtifactRollbackRequest,
  ): Promise<UploadedArtifactRollbackResult> {
    return this.coordinator.rollbackUploadedArtifact(agent, request)
  }

  commitGeneratedArtifact(agent: Agent, request: GeneratedArtifactCommitRequest): Promise<UploadedArtifactCommitResult> {
    return this.coordinator.commitGeneratedArtifact(agent, request)
  }

  resolveArtifactFile(agent: Agent, artifactId: string): Promise<ResolvedArtifactFile> {
    return this.coordinator.resolveArtifactFile(agent, artifactId)
  }

  withVerifiedReadLease<T>(
    agent: Agent,
    artifactId: string,
    options: VerifiedReadLeaseOptions,
    use: (lease: ResolvedArtifactReadLease) => T | Promise<T>,
  ): Promise<T> {
    return this.coordinator.withVerifiedReadLease(agent, artifactId, options, use)
  }

  loadProject(projectId: string): Promise<ProjectStateFile> {
    return this.coordinator.loadProject(projectId)
  }

  listProjectStates(): Promise<ProjectStateFile[]> {
    return this.coordinator.listProjectStates()
  }

  recoverProject(projectId: string) {
    return this.coordinator.recoverProject(projectId)
  }

  executeOperation<T extends JsonValue>(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    operation: string,
    action: () => Promise<T>,
    options: OperationExecutionOptions<T> = {},
  ): Promise<T> {
    return this.coordinator.executeOperation(projectId, operationKey, requestDigest, operation, action, options)
  }

  commitRunRecord(projectId: string, request: RunRecordCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitRunRecord(projectId, request)
  }

  verifyRunInputDigests(projectId: string, digests: readonly Sha256Digest[]): Promise<void> {
    return this.coordinator.verifyRunInputDigests(projectId, digests)
  }

  commitSourceRecord(projectId: string, request: SourceRecordCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitSourceRecord(projectId, request)
  }

  commitEvidenceRecord(projectId: string, request: EvidenceRecordCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitEvidenceRecord(projectId, request)
  }

  commitRepositoryAudit(projectId: string, request: RepositoryAuditCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitRepositoryAudit(projectId, request)
  }

  commitReproductionPlan(projectId: string, request: ReproductionPlanCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitReproductionPlan(projectId, request)
  }

  commitReproductionTestSpec(projectId: string, request: ReproductionTestSpecCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitReproductionTestSpec(projectId, request)
  }

  commitReproductionReport(projectId: string, request: ReproductionReportCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitReproductionReport(projectId, request)
  }

  commitExperimentSpec(projectId: string, request: ExperimentSpecCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitExperimentSpec(projectId, request)
  }

  commitResultRecords(projectId: string, request: ResultRecordsCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitResultRecords(projectId, request)
  }

  commitValidation(projectId: string, request: ValidationCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitValidation(projectId, request)
  }

  commitReviewRecord(projectId: string, request: ReviewRecordCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitReviewRecord(projectId, request)
  }

  commitClaimRecord(projectId: string, request: ClaimRecordCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitClaimRecord(projectId, request)
  }

  commitWritingPacket(projectId: string, request: WritingPacketCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitWritingPacket(projectId, request)
  }

  commitManuscript(projectId: string, request: ManuscriptCommitRequest): Promise<ProjectStateFile> {
    return this.coordinator.commitManuscript(projectId, request)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new GeoResearchProjectService(ctx, config)
  for (const tool of projectTools(ctx)) registerTool(ctx, tool)
}

export function projectTools(ctx: Context): readonly ToolDefinition[] {
  return [
    {
      name: 'research_project_status',
      description: 'Read the authoritative GeoResearch ProjectSnapshot for this exact live Agent workspace.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: PROJECT_SNAPSHOT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(_args, execution) {
        ctx.geoResearchInstallation.assertCurrent()
        return ctx.geoResearchProjects.status(exactAgent(execution, 'research_project_status'))
      },
    },
    {
      name: 'research_brief_commit',
      description: 'Commit one user-confirmed ResearchBrief to authoritative project state.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expectedGeneration: { type: 'integer', minimum: 1 },
          brief: researchBriefBodySchema(),
        },
        required: ['expectedGeneration', 'brief'],
      },
      output: { schema: mutationOutputSchema('brief'), render: renderJson },
      async execute(args, execution) {
        ctx.geoResearchInstallation.assertCurrent()
        const record = objectRecord(args, 'research_brief_commit arguments')
        return ctx.geoResearchProjects.commitResearchBrief(
          execution,
          positiveInteger(record.expectedGeneration, 'expectedGeneration'),
          record.brief,
        )
      },
    },
    {
      name: 'artifact_commit',
      description: 'Snapshot one regular workspace file into the Host content-addressed Artifact Store.',
      parameters: ARTIFACT_COMMIT_PARAMETERS,
      output: { schema: mutationOutputSchema('artifact'), render: renderJson },
      async execute(args, execution) {
        ctx.geoResearchInstallation.assertCurrent()
        return ctx.geoResearchProjects.commitArtifact(execution, parseArtifactCommitRequest(args))
      },
    },
    {
      name: 'deliverable_publish',
      description: 'Publish one bounded UTF-8 text deliverable below deliverables/ and atomically register its Artifact. This is the Coordinator publishing path; it does not grant arbitrary workspace write access.',
      parameters: DELIVERABLE_PUBLISH_PARAMETERS,
      output: { schema: deliverablePublishOutputSchema(), render: renderJson },
      async execute(args, execution) {
        ctx.geoResearchInstallation.assertCurrent()
        return ctx.geoResearchProjects.publishDeliverable(execution, parseDeliverablePublishRequest(args))
      },
    },
    {
      name: 'artifact_read',
      description: 'Read and reverify one committed Artifact record visible to this exact live Agent project.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { artifactId: { type: 'string', minLength: 1 } },
        required: ['artifactId'],
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        ctx.geoResearchInstallation.assertCurrent()
        const record = objectRecord(args, 'artifact_read arguments')
        return ctx.geoResearchProjects.readArtifactForTool(
          exactAgent(execution, 'artifact_read'),
          nonEmptyText(record.artifactId, 'artifactId'),
        )
      },
    },
  ]
}

const DELIVERABLE_MAX_BYTES = 2 * 1024 * 1024
const DELIVERABLE_MEDIA_TYPES = Object.freeze({
  '.bib': 'application/x-bibtex',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.tex': 'application/x-tex',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
} as const)

const ARTIFACT_COMMIT_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    expectedGeneration: { type: 'integer', minimum: 1 },
    sourceRelativePath: { type: 'string', minLength: 1 },
    kind: { type: 'string', minLength: 1 },
    mediaType: { type: 'string', minLength: 1 },
    transformationType: { type: 'string', minLength: 1 },
    inputDigests: { type: 'array', items: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
    codeDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    configDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  },
  required: ['expectedGeneration', 'sourceRelativePath', 'kind', 'mediaType', 'transformationType'],
})

const DELIVERABLE_PUBLISH_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    expectedGeneration: { type: 'integer', description: 'Generation returned by research_project_status.' },
    relativePath: { type: 'string', description: 'Path below the Host-managed deliverables/ directory.' },
    content: { type: 'string', description: 'Complete UTF-8 text content, limited to 2 MiB by the Host.' },
    kind: { type: 'string', description: 'Stable lowercase Artifact kind such as research-report or manuscript.' },
    mediaType: { type: 'string', enum: [...Object.values(DELIVERABLE_MEDIA_TYPES)] },
    expectedDigest: { type: 'string', description: 'Required current SHA-256 digest when replacing a different file.' },
    inputDigests: { type: 'array', items: { type: 'string' } },
  },
  required: ['expectedGeneration', 'relativePath', 'content', 'kind', 'mediaType'],
})

function matchingBindings(
  states: readonly ProjectStateFile[],
  predicate: (binding: WorkspaceBinding) => boolean,
): Array<{ readonly stateFile: ProjectStateFile; readonly binding: WorkspaceBinding }> {
  return states.flatMap(stateFile => Object.values(stateFile.state.workspaceBindings)
    .filter(predicate)
    .map(binding => ({ stateFile, binding })))
}

function projectIdFor(workspace: InspectedWorkspace): string {
  const identity = workspace.gitCommonDirIdentity ?? {
    volumeIdentity: workspace.volumeIdentity,
    fileIdentity: workspace.directoryFileIdentity,
  }
  return `project-${digestJson({ domain: 'georesearch.project-id/v1', identity }).slice('sha256:'.length)}`
}

function hostOperation(projectId: string, operation: string, request: unknown): {
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
} {
  return {
    operationKey: digestJson({ domain: 'georesearch.host-operation-key/v1', projectId, operation, request }),
    requestDigest: digestJson({ domain: 'georesearch.host-operation-request/v1', operation, request }),
  }
}

function assertUploadedAttachmentId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new GeoResearchError('ATTACHMENT_INVALID', 'attachmentId must be a lowercase UUID v4')
  }
}

function uploadedAttachmentConfigDigest(attachmentId: string): Sha256Digest {
  return digestJson({ domain: 'georesearch.uploaded-attachment/v1', attachmentId })
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return execution.agent
}

function researchBriefBodySchema(): Record<string, unknown> {
  const schema = structuredClone(RESEARCH_BRIEF_SCHEMA) as Record<string, unknown>
  const properties = schema.properties as Record<string, unknown>
  const confirmation = objectRecord(properties.userConfirmation, 'ResearchBrief userConfirmation schema')
  const confirmationProperties = objectRecord(confirmation.properties, 'ResearchBrief userConfirmation properties')
  const confirmedAt = objectRecord(confirmationProperties.confirmedAt, 'ResearchBrief confirmedAt schema')
  confirmationProperties.confirmedAt = {
    ...confirmedAt,
    pattern: '^(?:\\d{4}|[+-]\\d{6})-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
    description: 'Canonical UTC timestamp with millisecond precision, exactly as returned by Date.prototype.toISOString().',
    examples: ['2026-08-26T00:00:00.000Z'],
  }
  delete properties.digest
  delete properties.committedAt
  schema.required = (schema.required as string[]).filter(field => field !== 'digest' && field !== 'committedAt')
  return schema
}

function mutationOutputSchema(field: string): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: { type: 'string' },
      generation: { type: 'integer' },
      [field]: { type: 'object' },
    },
    required: ['projectId', 'generation', field],
  }
}

function deliverablePublishOutputSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: { type: 'string' },
      workspaceId: { type: 'string' },
      generation: { type: 'integer' },
      relativePath: { type: 'string' },
      digest: { type: 'string' },
      artifact: { type: 'object', additionalProperties: true },
    },
    required: ['projectId', 'workspaceId', 'generation', 'relativePath', 'digest', 'artifact'],
  }
}

function parseArtifactCommitRequest(value: unknown): ArtifactCommitRequest {
  const record = objectRecord(value, 'artifact_commit arguments')
  return {
    expectedGeneration: positiveInteger(record.expectedGeneration, 'expectedGeneration'),
    sourceRelativePath: nonEmptyText(record.sourceRelativePath, 'sourceRelativePath'),
    kind: nonEmptyText(record.kind, 'kind'),
    mediaType: nonEmptyText(record.mediaType, 'mediaType'),
    transformationType: nonEmptyText(record.transformationType, 'transformationType'),
    ...(record.inputDigests === undefined ? {} : { inputDigests: digestArray(record.inputDigests, 'inputDigests') }),
    ...(record.codeDigest === undefined ? {} : { codeDigest: shaDigest(record.codeDigest, 'codeDigest') }),
    ...(record.configDigest === undefined ? {} : { configDigest: shaDigest(record.configDigest, 'configDigest') }),
  }
}

function parseDeliverablePublishRequest(value: unknown): DeliverablePublishRequest {
  return normalizedDeliverablePublishRequest(value)
}

function normalizedDeliverablePublishRequest(value: unknown): DeliverablePublishRequest {
  const record = objectRecord(value, 'deliverable_publish arguments')
  const expectedGeneration = positiveInteger(record.expectedGeneration, 'expectedGeneration')
  const relativePath = normalizedDeliverableRelativePath(record.relativePath)
  const content = nonEmptyText(record.content, 'content')
  if (content.includes('\0')) throw new GeoResearchError('DELIVERABLE_INVALID', 'deliverable content contains a NUL byte')
  const size = Buffer.byteLength(content, 'utf8')
  if (size > DELIVERABLE_MAX_BYTES) {
    throw new GeoResearchError('DELIVERABLE_TOO_LARGE', `deliverable content exceeds ${DELIVERABLE_MAX_BYTES} bytes`)
  }
  const kind = nonEmptyText(record.kind, 'kind')
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(kind)) {
    throw new GeoResearchError('DELIVERABLE_INVALID', 'deliverable kind must be a stable lowercase identifier')
  }
  const extensionIndex = relativePath.lastIndexOf('.')
  const extension = extensionIndex < 0 ? '' : relativePath.slice(extensionIndex).toLowerCase()
  const expectedMediaType = DELIVERABLE_MEDIA_TYPES[extension as keyof typeof DELIVERABLE_MEDIA_TYPES]
  const mediaType = nonEmptyText(record.mediaType, 'mediaType')
  if (expectedMediaType === undefined || mediaType !== expectedMediaType) {
    throw new GeoResearchError(
      'DELIVERABLE_INVALID',
      `deliverable extension ${extension || '(none)'} requires its registered safe text media type`,
    )
  }
  if (extension === '.json') {
    try {
      JSON.parse(content)
    } catch (error) {
      throw new GeoResearchError('DELIVERABLE_INVALID', 'JSON deliverable content is invalid', { cause: error })
    }
  }
  const inputDigests = record.inputDigests === undefined
    ? undefined
    : digestArray(record.inputDigests, 'inputDigests')
  if ((inputDigests?.length ?? 0) > 256) {
    throw new GeoResearchError('DELIVERABLE_INVALID', 'deliverable inputDigests exceeds 256 entries')
  }
  return {
    expectedGeneration,
    relativePath,
    content,
    kind,
    mediaType,
    ...(record.expectedDigest === undefined ? {} : { expectedDigest: shaDigest(record.expectedDigest, 'expectedDigest') }),
    ...(inputDigests === undefined ? {} : { inputDigests }),
  }
}

function normalizedDeliverableRelativePath(value: unknown): string {
  const raw = nonEmptyText(value, 'relativePath')
  if (raw !== raw.trim() || raw.length > 240 || /^[a-zA-Z]:/u.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new GeoResearchError('DELIVERABLE_INVALID', 'deliverable relativePath must stay below deliverables/')
  }
  const segments = raw.replaceAll('\\', '/').split('/')
  if (segments[0]?.toLowerCase() === 'deliverables') segments.shift()
  if (segments.length === 0 || segments.some(segment => segment.length === 0
    || segment === '.' || segment === '..'
    || /[\u0000-\u001f<>:"|?*]/u.test(segment)
    || segment.endsWith('.') || segment.endsWith(' '))) {
    throw new GeoResearchError('DELIVERABLE_INVALID', 'deliverable relativePath contains an unsafe path component')
  }
  for (const segment of segments) {
    const stem = segment.split('.')[0]?.toUpperCase() ?? ''
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
      throw new GeoResearchError('DELIVERABLE_INVALID', 'deliverable relativePath contains a reserved Windows name')
    }
  }
  return segments.join('/')
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  return value as Record<string, unknown>
}

export interface ClaimSupportAssessment {
  readonly supportState: ClaimSupportState
  readonly integrity: 'verified' | 'failed'
  readonly validity: 'current' | 'stale'
  readonly calculation: ClaimCalculation | null
}

export interface WritingInputClosure {
  readonly sources: readonly SourceRecord[]
  readonly evidence: readonly EvidenceRecord[]
  readonly experimentSpecs: readonly ExperimentSpec[]
  readonly runs: readonly RunRecord[]
  readonly results: readonly ResultRecord[]
  readonly validationReports: readonly ValidationReport[]
  readonly artifactRefs: readonly ArtifactRef[]
  readonly limitations: readonly string[]
}

export function assessClaimSupport(
  state: ProjectReducerState,
  proposal: ClaimProposal,
): ClaimSupportAssessment {
  const validationReports = proposal.validationReportIds.map(reportId => state.validationReports?.[reportId])
  const reviewRecords = proposal.reviewRecordIds.map(reviewId => state.reviewRecords?.[reviewId])
  const claimSubjects = claimReviewSubjectKeys(state, proposal)
  const includedReviewIds = new Set(proposal.reviewRecordIds)
  const activeRelevantReviews = Object.values(state.reviewRecords ?? {}).filter(review => (
    review.projectId === state.projectId
    && !reviewSuperseded(state, review.reviewId)
    && review.subjectRefs.some(subject => claimSubjects.has(validationSubjectKey(subject)))
  ))
  const referencesCurrent = proposal.supportRefs.every(reference => claimSupportRefCurrent(state, reference))
  const reportsCurrent = validationReports.every(report => report !== undefined
    && report.projectId === state.projectId
    && report.subjects.every(subject => currentSubjectDigest(state, subject) === subject.digest))
  const reviewsCurrent = reviewRecords.every(review => review !== undefined
    && review.projectId === state.projectId
    && !reviewSuperseded(state, review.reviewId)
    && review.subjectRefs.every(subject => currentSubjectDigest(state, subject) === subject.digest))
  const reviewsRelevant = reviewRecords.every(review => review !== undefined
    && review.subjectRefs.some(subject => claimSubjects.has(validationSubjectKey(subject))))
  const reviewsComplete = activeRelevantReviews.every(review => includedReviewIds.has(review.reviewId))
  const sectionsValid = claimSectionsValid(proposal)
  const calculation = proposal.calculation === null ? null : calculateClaim(state, proposal.calculation)
  const integrity = referencesCurrent && reportsCurrent && reviewsCurrent
    && reviewsRelevant && reviewsComplete && sectionsValid
    ? 'verified' as const
    : 'failed' as const
  const validity = referencesCurrent && reportsCurrent && reviewsCurrent ? 'current' as const : 'stale' as const
  if (integrity === 'failed') {
    return { supportState: 'insufficient-evidence', integrity, validity, calculation }
  }

  const passedSubjects = new Set(validationReports
    .filter((report): report is ValidationReport => report?.overall === 'passed')
    .flatMap(report => report.subjects.map(subject => `${subject.kind}:${subject.subjectId}:${subject.digest}`)))
  const acceptedSubjects = new Set(reviewRecords.flatMap(review => review === undefined ? [] : review.subjectRefs
    .map(validationSubjectKey)))
  const acceptedReview = claimSubjects.size > 0 && reviewRecords.length > 0 && reviewRecords.every(review => review !== undefined
    && review.recommendation === 'accept'
    && !review.findings.some(finding => finding.severity === 'hard' || finding.severity === 'error'))
    && [...claimSubjects].every(subject => acceptedSubjects.has(subject))
  const evidenceRefs = proposal.supportRefs.filter(reference => reference.kind === 'evidence')
  const resultRefs = proposal.supportRefs.filter(reference => reference.kind === 'result')
  const evidenceValidated = evidenceRefs.length > 0 && evidenceRefs.every(reference => passedSubjects.has(
    `evidence:${reference.recordId}:${reference.digest}`,
  ))
  const resultsValidated = resultRefs.length > 0 && resultRefs.every(reference => passedSubjects.has(
    `result:${reference.recordId}:${reference.digest}`,
  ))

  let supportState: ClaimSupportState
  switch (proposal.claimType) {
    case 'literature-fact': {
      const evidence = evidenceRefs.map(reference => state.evidence?.[reference.recordId])
      if (evidence.some(record => record?.relation === 'contradicts')) supportState = 'contradicted'
      else if (evidence.length === 0 || evidence.some(record => record === undefined
        || (record.relation !== 'supports' && record.relation !== 'partially-supports'))) {
        supportState = 'insufficient-evidence'
      } else supportState = evidenceValidated && acceptedReview ? 'independently-checked' : 'source-backed'
      break
    }
    case 'experimental-observation':
      supportState = resultsValidated
        ? (acceptedReview ? 'independently-checked' : 'experiment-supported')
        : 'insufficient-evidence'
      break
    case 'derived-calculation': {
      const operands = proposal.calculation?.operandResultIds ?? []
      const everyOperandValidated = operands.length > 0 && operands.every(resultId => {
        const result = state.results?.[resultId]
        return result !== undefined && passedSubjects.has(`result:${resultId}:${result.digest}`)
      })
      supportState = calculation !== null && everyOperandValidated && acceptedReview
        ? 'independently-checked'
        : 'insufficient-evidence'
      break
    }
    case 'scientific-inference': {
      if (proposal.supportRefs.length === 0 || proposal.limitations.length === 0) {
        supportState = 'insufficient-evidence'
      } else if (acceptedReview) {
        supportState = 'independently-checked'
      } else if (resultRefs.length > 0 && resultsValidated) {
        supportState = 'experiment-supported'
      } else if (evidenceRefs.length > 0) {
        supportState = 'source-backed'
      } else supportState = 'insufficient-evidence'
      break
    }
    case 'hypothesis':
    case 'speculation':
      supportState = 'proposed'
      break
  }
  return { supportState, integrity, validity, calculation }
}

export function assertReviewRecordAuthority(state: ProjectReducerState, review: ReviewRecord): void {
  const subjectKeys = new Set(review.subjectRefs.map(validationSubjectKey))
  if (subjectKeys.size !== review.subjectRefs.length) {
    throw new GeoResearchError('REVIEW_INVALID', 'ReviewRecord contains duplicate subjects')
  }
  for (const subject of review.subjectRefs) {
    if (currentSubjectDigest(state, subject) !== subject.digest) {
      throw new GeoResearchError('REVIEW_INVALID', `${subject.kind} ${subject.subjectId} is stale or unavailable`)
    }
  }
  const passedSubjects = new Set<string>()
  for (const reportId of review.validationReportIds) {
    const report = state.validationReports?.[reportId]
    if (report === undefined || report.projectId !== review.projectId
      || report.workspaceId !== review.workspaceId
      || report.workspaceBindingVersion !== review.workspaceBindingVersion) {
      throw new GeoResearchError('REVIEW_INVALID', `validation report ${reportId} is unavailable or belongs to another binding`)
    }
    const reportSubjects = report.subjects.map(validationSubjectKey)
    if (!reportSubjects.some(subject => subjectKeys.has(subject))) {
      throw new GeoResearchError('REVIEW_INVALID', `validation report ${reportId} does not cover a reviewed subject`)
    }
    for (const subject of report.subjects) {
      if (currentSubjectDigest(state, subject) !== subject.digest) {
        throw new GeoResearchError('REVIEW_INVALID', `validation report ${reportId} contains a stale subject`)
      }
      if (report.overall === 'passed') passedSubjects.add(validationSubjectKey(subject))
    }
  }
  if (review.recommendation === 'accept'
    && [...subjectKeys].some(subject => !passedSubjects.has(subject))) {
    throw new GeoResearchError('REVIEW_INVALID', 'an accepted Review requires passed validation for every reviewed subject')
  }
  const subjectIds = new Set(review.subjectRefs.map(subject => subject.subjectId))
  if (review.findings.some(finding => finding.subjectIds.some(subjectId => !subjectIds.has(subjectId)))) {
    throw new GeoResearchError('REVIEW_INVALID', 'Review findings reference an object outside the reviewed subjects')
  }
  for (const reviewId of review.supersedesReviewIds) {
    const previous = state.reviewRecords?.[reviewId]
    if (previous === undefined || previous.projectId !== review.projectId
      || previous.workspaceId !== review.workspaceId
      || previous.workspaceBindingVersion !== review.workspaceBindingVersion) {
      throw new GeoResearchError('REVIEW_INVALID', `superseded review ${reviewId} is unavailable or belongs to another binding`)
    }
    const previousSubjects = new Set(previous.subjectRefs.map(validationSubjectKey))
    if (previousSubjects.size !== subjectKeys.size
      || [...subjectKeys].some(subject => !previousSubjects.has(subject))) {
      throw new GeoResearchError('REVIEW_INVALID', `superseded review ${reviewId} covers different subjects`)
    }
  }
}

export function claimEligibleForWriting(claim: ClaimRecord, state: ProjectReducerState): boolean {
  if (claim.approvalState !== 'approved' || claim.approval.outcome !== 'approved'
    || claim.approval.source !== 'user' || claim.integrity !== 'verified' || claim.validity !== 'current') return false
  const assessment = assessClaimSupport(state, claim)
  if (assessment.integrity !== 'verified' || assessment.validity !== 'current'
    || assessment.supportState !== claim.supportState
    || JSON.stringify(assessment.calculation) !== JSON.stringify(claim.calculation)) return false
  if (claim.reviewRecordIds.some(reviewId => activeHardReview(state, reviewId))) return false
  switch (claim.claimType) {
    case 'literature-fact':
      return claim.supportState === 'source-backed' || claim.supportState === 'independently-checked'
    case 'experimental-observation':
      return claim.supportState === 'experiment-supported' || claim.supportState === 'independently-checked'
    case 'derived-calculation':
    case 'scientific-inference':
      return claim.supportState === 'independently-checked'
    case 'hypothesis':
    case 'speculation':
      return claim.supportState === 'proposed'
  }
}

export function collectWritingInputs(
  state: ProjectReducerState,
  claims: readonly ClaimRecord[],
): WritingInputClosure {
  const evidenceIds = new Set<string>()
  const resultIds = new Set<string>()
  const validationIds = new Set<string>()
  const limitations = new Set<string>()
  for (const claim of claims) {
    for (const reference of claim.supportRefs) {
      if (reference.kind === 'evidence') evidenceIds.add(reference.recordId)
      if (reference.kind === 'result') resultIds.add(reference.recordId)
    }
    for (const resultId of claim.calculation?.operandResultIds ?? []) resultIds.add(resultId)
    for (const reportId of claim.validationReportIds) validationIds.add(reportId)
    for (const limitation of claim.limitations) limitations.add(limitation)
  }
  const evidence = [...evidenceIds].map(id => requiredRecord(state.evidence?.[id], `Evidence ${id}`))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
  const sourceIds = new Set(evidence.map(record => record.sourceId))
  const sources = [...sourceIds].map(id => requiredRecord(state.sources?.[id], `Source ${id}`))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
  const results = [...resultIds].map(id => requiredRecord(state.results?.[id], `Result ${id}`))
    .sort((left, right) => left.resultId.localeCompare(right.resultId))
  const runIds = new Set(results.map(result => result.runId))
  const runs = [...runIds].map(id => requiredRecord(state.runs[id], `Run ${id}`))
    .sort((left, right) => left.runId.localeCompare(right.runId))
  const specIds = new Set(results.map(result => result.experimentSpecId))
  const experimentSpecs = [...specIds].map(id => requiredRecord(state.experimentSpecs?.[id], `ExperimentSpec ${id}`))
    .sort((left, right) => left.specId.localeCompare(right.specId))
  const validationReports = [...validationIds]
    .map(id => requiredRecord(state.validationReports?.[id], `ValidationReport ${id}`))
    .sort((left, right) => left.reportId.localeCompare(right.reportId))
  const artifactById = new Map<string, ArtifactRef>()
  for (const result of results) {
    for (const artifactRef of result.artifactRefs) artifactById.set(artifactRef.artifactId, artifactRef)
  }
  return {
    sources,
    evidence,
    experimentSpecs,
    runs,
    results,
    validationReports,
    artifactRefs: [...artifactById.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    limitations: [...limitations].sort(),
  }
}

function assertCurrentBinding(
  current: ProjectStateFile,
  workspaceId: string,
  bindingVersion: number,
  field: string,
): void {
  const binding = current.state.workspaceBindings[workspaceId]
  if (binding === undefined || binding.bindingVersion !== bindingVersion) {
    throw new GeoResearchError('PROJECT_BINDING_MISMATCH', `${field} workspace binding is not current`)
  }
}

function assertCurrentSubject(current: ProjectStateFile, subject: ValidationSubjectRef): void {
  if (currentSubjectDigest(current.state, subject) !== subject.digest) {
    throw new GeoResearchError('VALIDATION_REPORT_INVALID', `${subject.kind} ${subject.subjectId} is stale or unavailable`)
  }
}

function currentSubjectDigest(state: ProjectReducerState, subject: ValidationSubjectRef): Sha256Digest | undefined {
  switch (subject.kind) {
    case 'geodata-report': return state.geodataReports?.[subject.subjectId]?.digest
    case 'dataset-manifest': return state.datasetManifests?.[subject.subjectId]?.digest
    case 'experiment-spec': return state.experimentSpecs?.[subject.subjectId]?.digest
    case 'run': {
      const run = state.runs[subject.subjectId]
      return run === undefined ? undefined : digestJson(run)
    }
    case 'result': return state.results?.[subject.subjectId]?.digest
    case 'evidence': return state.evidence?.[subject.subjectId]?.digest
    case 'reproduction-report': return state.reproductionReports?.[subject.subjectId]?.digest
    case 'claim': return state.claims?.[subject.subjectId]?.digest
    case 'research-brief': {
      const brief = state.researchBrief
      return brief?.briefId === subject.subjectId ? brief.digest : undefined
    }
    case 'manuscript': return state.manuscripts?.[subject.subjectId]?.digest
  }
}

function validationSubjectKey(subject: ValidationSubjectRef): string {
  return `${subject.kind}:${subject.subjectId}:${subject.digest}`
}

function claimReviewSubjectKeys(state: ProjectReducerState, proposal: ClaimProposal): Set<string> {
  const keys = new Set<string>()
  for (const reference of proposal.supportRefs) {
    if (reference.kind === 'evidence' || reference.kind === 'result') {
      keys.add(`${reference.kind}:${reference.recordId}:${reference.digest}`)
    }
  }
  for (const resultId of proposal.calculation?.operandResultIds ?? []) {
    const result = state.results?.[resultId]
    if (result !== undefined) keys.add(`result:${resultId}:${result.digest}`)
  }
  return keys
}

function withoutRunOutputs(run: RunRecord): Omit<RunRecord, 'outputArtifactRefs'> {
  const { outputArtifactRefs, ...rest } = run
  void outputArtifactRefs
  return rest
}

function uniqueArtifactRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>()
  for (const ref of refs) {
    const existing = byId.get(ref.artifactId)
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(ref)) {
      throw new GeoResearchError('RESULT_INVALID', `Artifact ${ref.artifactId} has conflicting Result references`)
    }
    byId.set(ref.artifactId, ref)
  }
  return [...byId.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId))
}

function claimSupportRefCurrent(
  state: ProjectReducerState,
  reference: ClaimProposal['supportRefs'][number],
): boolean {
  switch (reference.kind) {
    case 'evidence': {
      const evidence = state.evidence?.[reference.recordId]
      const artifact = evidence === undefined ? undefined : state.artifacts[evidence.artifactId]
      return evidence?.digest === reference.digest
        && evidence.reviewStatus === 'accepted'
        && state.sources?.[evidence.sourceId] !== undefined
        && artifact?.digest === evidence.artifactDigest
        && artifact.materialization === 'committed'
        && artifact.integrity === 'verified'
        && artifact.validity === 'current'
    }
    case 'result':
      return state.results?.[reference.recordId]?.digest === reference.digest
    case 'claim': {
      const claim = state.claims?.[reference.recordId]
      return claim?.digest === reference.digest
        && claim.approvalState === 'approved'
        && claim.integrity === 'verified'
        && claim.validity === 'current'
    }
    case 'hypothesis':
      return state.researchBrief?.digest === reference.digest
        && state.researchBrief.hypotheses.some(hypothesis => hypothesis.hypothesisId === reference.recordId)
  }
}

function calculateClaim(
  state: ProjectReducerState,
  calculation: NonNullable<ClaimProposal['calculation']>,
): ClaimCalculation {
  const results = calculation.operandResultIds.map(resultId => state.results?.[resultId])
  if (results.some(result => result === undefined)) {
    throw new GeoResearchError('CLAIM_INVALID', 'derived calculation references an unknown ResultRecord')
  }
  const resolved = results as ResultRecord[]
  const values = resolved.map(result => result.value)
  let value: number
  switch (calculation.operation) {
    case 'difference':
      if (values.length !== 2) throw new GeoResearchError('CLAIM_INVALID', 'difference requires two ResultRecords')
      value = values[0]! - values[1]!
      break
    case 'ratio':
      if (values.length !== 2 || values[1] === 0) throw new GeoResearchError('CLAIM_INVALID', 'ratio requires two results and a non-zero denominator')
      value = values[0]! / values[1]!
      break
    case 'percent-change':
      if (values.length !== 2 || values[1] === 0) throw new GeoResearchError('CLAIM_INVALID', 'percent-change requires two results and a non-zero baseline')
      value = ((values[0]! - values[1]!) / values[1]!) * 100
      break
    case 'mean':
      if (values.length === 0) throw new GeoResearchError('CLAIM_INVALID', 'mean requires at least one ResultRecord')
      value = values.reduce((sum, entry) => sum + entry, 0) / values.length
      break
  }
  if (!Number.isFinite(value)) throw new GeoResearchError('CLAIM_INVALID', 'derived calculation is not finite')
  return {
    ...calculation,
    value,
    inputDigests: resolved.map(result => result.digest),
  }
}

function claimSectionsValid(proposal: ClaimProposal): boolean {
  if (proposal.claimType === 'hypothesis') {
    return proposal.intendedSections.every(section => section === 'introduction' || section === 'methods')
  }
  if (proposal.claimType === 'speculation') {
    return proposal.intendedSections.every(section => section === 'discussion' || section === 'future-work')
  }
  return true
}

function reviewSuperseded(state: ProjectReducerState, reviewId: string): boolean {
  return Object.values(state.reviewRecords ?? {}).some(review => review.supersedesReviewIds.includes(reviewId))
}

function activeHardReview(state: ProjectReducerState, reviewId: string): boolean {
  const review = state.reviewRecords?.[reviewId]
  return review !== undefined
    && !reviewSuperseded(state, reviewId)
    && (review.recommendation !== 'accept'
      || review.findings.some(finding => finding.severity === 'hard' || finding.severity === 'error'))
}

function requiredRecord<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new GeoResearchError('WRITING_PACKET_INVALID', `${field} is unavailable`)
  return value
}

function assertExactRecordArray<T extends { readonly digest: Sha256Digest }>(
  actual: readonly T[],
  expected: readonly T[],
  field: string,
): void {
  if (JSON.stringify(actual.map(record => record.digest)) !== JSON.stringify(expected.map(record => record.digest))) {
    throw new GeoResearchError('WRITING_PACKET_INVALID', `${field} differ from the required closure`)
  }
}

function assertExactRunArray(actual: readonly RunRecord[], expected: readonly RunRecord[], field: string): void {
  if (JSON.stringify(actual.map(digestJson)) !== JSON.stringify(expected.map(digestJson))) {
    throw new GeoResearchError('WRITING_PACKET_INVALID', `${field} differ from the required closure`)
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty`)
  return value
}

function shaDigest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`)
  return value as Sha256Digest
}

function digestArray(value: unknown, field: string): Sha256Digest[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((entry, index) => shaDigest(entry, `${field}[${index}]`))
}

async function* textByteStream(content: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(content, 'utf8')
}

function assertRecordDigest<T extends { readonly digest: Sha256Digest }>(value: T, field: string): void {
  const { digest: actual, ...body } = value
  if (digestJson(body as unknown as JsonValue) !== actual) {
    throw new TypeError(`${field}.digest does not match its canonical body`)
  }
}

function assertLifecycleRecordDigest<T extends { readonly digest: Sha256Digest }>(
  value: T,
  statusField: 'reviewStatus' | 'validationStatus',
  field: string,
): void {
  const { digest: actual, ...body } = value
  const stableBody = { ...body } as Record<string, unknown>
  delete stableBody[statusField]
  const legacyPendingBody = { ...stableBody, [statusField]: 'pending' }
  if (digestJson(stableBody as JsonValue) !== actual
    && digestJson(legacyPendingBody as JsonValue) !== actual) {
    throw new TypeError(`${field}.digest does not match its stable canonical body`)
  }
}

function assertCurrentArtifact(
  current: ProjectStateFile,
  reference: { readonly artifactId: string; readonly digest: Sha256Digest; readonly kind: string },
  field: string,
): void {
  const artifact = current.state.artifacts[reference.artifactId]
  if (artifact === undefined || artifact.digest !== reference.digest || artifact.kind !== reference.kind
    || artifact.materialization !== 'committed' || artifact.integrity !== 'verified' || artifact.validity !== 'current') {
    throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `${field} references a non-current Artifact`)
  }
}

function sameRepositoryAuditSnapshot(left: RepositoryAudit, right: RepositoryAudit): boolean {
  const { auditedAt: _leftAuditedAt, digest: _leftDigest, ...leftSnapshot } = left
  const { auditedAt: _rightAuditedAt, digest: _rightDigest, ...rightSnapshot } = right
  return digestJson(leftSnapshot) === digestJson(rightSnapshot)
}

function sameReproductionPlanSnapshot(left: ReproductionPlan, right: ReproductionPlan): boolean {
  const { createdAt: _leftCreatedAt, digest: _leftDigest, ...leftSnapshot } = left
  const { createdAt: _rightCreatedAt, digest: _rightDigest, ...rightSnapshot } = right
  return digestJson(leftSnapshot) === digestJson(rightSnapshot)
}

function sameReproductionTestSpecSnapshot(
  left: ReproductionTestSpecRecord,
  right: ReproductionTestSpecRecord,
): boolean {
  const { registeredAt: _leftRegisteredAt, digest: _leftDigest, ...leftSnapshot } = left
  const { registeredAt: _rightRegisteredAt, digest: _rightDigest, ...rightSnapshot } = right
  return digestJson(leftSnapshot) === digestJson(rightSnapshot)
}

function sameNullableRepositoryUrl(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : normalizeRepositoryUrl(left) === normalizeRepositoryUrl(right)
}

function normalizeRepositoryUrl(value: string): string {
  return value.trim()
    .replace(/^git@([^:]+):/iu, 'https://$1/')
    .replace(/^ssh:\/\/(?:[^@/]+@)?/iu, 'https://')
    .replace(/\.git\/?$/iu, '')
    .replace(/\/$/u, '')
    .toLowerCase()
}

function textualArtifact(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized === 'application/yaml'
    || normalized === 'application/x-yaml'
}

function validRunTransition(current: RunState, next: RunState): boolean {
  switch (current) {
    case 'starting':
      return next === 'running' || next === 'collecting' || next === 'recovery-required'
    case 'running':
      return next === 'collecting' || next === 'recovery-required'
    case 'collecting':
      return next === 'succeeded' || next === 'failed' || next === 'cancelled' || next === 'recovery-required'
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'recovery-required':
      return false
  }
}

function runIdentityDigest(run: RunRecord): Sha256Digest {
  return digestJson({
    runId: run.runId,
    kind: run.kind,
    projectId: run.projectId,
    workspaceId: run.workspaceId,
    workspaceBindingVersion: run.workspaceBindingVersion,
    experimentSpecDigest: run.experimentSpecDigest,
    sourceTreeDigest: run.sourceTreeDigest,
    environmentDigest: run.environmentDigest,
    datasetDigests: run.datasetDigests,
    seed: run.seed ?? null,
    argv: run.argv,
    argvDigest: run.argvDigest,
    cwd: run.cwd,
    launchId: run.launchId,
    resourceLimits: run.resourceLimits,
    stdoutPath: run.stdoutPath,
    stderrPath: run.stderrPath,
    sandbox: run.sandbox,
    approval: run.approval ?? null,
  })
}

function assertFormalRunBinding(current: ProjectStateFile, run: RunRecord): void {
  const reproductionPlan = Object.values(current.state.reproductionPlans ?? {})
    .find(candidate => candidate.digest === run.experimentSpecDigest)
  const experimentSpec = Object.values(current.state.experimentSpecs ?? {})
    .find(candidate => candidate.digest === run.experimentSpecDigest && candidate.status === 'frozen')
  if (reproductionPlan === undefined && experimentSpec === undefined) {
    throw new GeoResearchError(
      'RUN_PLAN_INVALID',
      'formal Run must reference a current ReproductionPlan or frozen ExperimentSpec',
    )
  }
  if (reproductionPlan !== undefined) {
    if (reproductionPlan.workspaceId !== run.workspaceId
      || reproductionPlan.workspaceBindingVersion !== run.workspaceBindingVersion
      || !Object.values(current.state.repositoryAudits ?? {}).some(audit => (
        audit.sourceId === reproductionPlan.sourceId
        && audit.workspaceId === reproductionPlan.workspaceId
        && audit.workspaceBindingVersion === reproductionPlan.workspaceBindingVersion
        && audit.sourceTreeDigest === run.sourceTreeDigest
      ))) {
      throw new GeoResearchError('RUN_PLAN_INVALID', 'formal Run differs from its ReproductionPlan binding')
    }
    return
  }
  if (experimentSpec === undefined || run.seed === undefined
    || experimentSpec.workspaceId !== run.workspaceId
    || experimentSpec.workspaceBindingVersion !== run.workspaceBindingVersion
    || experimentSpec.sourceTreeDigest !== run.sourceTreeDigest
    || !experimentSpec.seeds.includes(run.seed)
    || !sameDigestSet(run.datasetDigests, experimentSpec.datasets.map(reference => reference.datasetDigest))) {
    throw new GeoResearchError('RUN_PLAN_INVALID', 'formal Run differs from its frozen ExperimentSpec')
  }
  for (const reference of experimentSpec.datasets) {
    const manifest = current.state.datasetManifests?.[reference.datasetId]
    if (manifest === undefined || manifest.digest !== reference.datasetDigest || manifest.status !== 'verified') {
      throw new GeoResearchError('RUN_PLAN_INVALID', `dataset ${reference.datasetId} is not the verified frozen manifest`)
    }
  }
}

function sameDigestSet(left: readonly Sha256Digest[], right: readonly Sha256Digest[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return left.every(digest => expected.has(digest))
}
