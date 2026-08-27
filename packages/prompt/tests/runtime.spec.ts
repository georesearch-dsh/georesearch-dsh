import { describe, expect, it } from 'vitest'
import { DELEGATION_BOOTSTRAP_TOOL } from '@georesearch/dsh-contracts'
import {
  ATTACHMENT_CAPABILITY_MATRIX,
  GEORESEARCH_INTEGRITY_RULES,
  GEORESEARCH_INTEGRITY_PROMPT_ORDER,
  runtimeCapabilitySnapshot,
} from '../src/index.js'

describe('GeoResearch runtime capability snapshot', () => {
  it('reports current Phase 3 capabilities without labelling future tools as blockers', () => {
    const snapshot = runtimeCapabilitySnapshot({
      actor: 'coordinator',
      stage: 'phase3',
      generation: 27,
      profileTreeDigest: `sha256:${'a'.repeat(64)}`,
      availableCapabilities: [
        'read', 'read_image', 'write', 'edit', 'web_search',
        'formal_run_submit', 'deliverable_publish', 'attachment_read', 'attachment_read_image',
      ],
      missingRequiredCapabilities: [],
      deferredCapabilities: ['result_commit'],
      autonomy: {
        enabled: true,
        source: 'direct-user',
        directUserDirective: 'granted',
        fullAccessPermission: false,
      },
    }) as Record<string, unknown>

    expect(snapshot).toMatchObject({
      currentStage: 'phase3',
      blockerCodes: [],
      missingRequiredCapabilities: [],
      deferredCapabilities: ['result_commit'],
      permissions: {
        authority: 'harness-session-settings',
        workspaceMutationToolsVisible: true,
        geoResearchWritesPermissionState: false,
        geoResearchAddsPermissionGate: false,
        sandboxMode: 'resolved-by-harness-per-call',
      },
      autonomy: {
        enabled: true,
        source: 'direct-user',
        routineWorkflowPauses: 'suppressed',
        askUserQuestion: 'only-out-of-scope-or-irreversible',
        bypassesIntegrityChecks: false,
        bypassesHarnessSandbox: false,
      },
      web: { directSearch: true, directFetch: false },
      deliverables: {
        textPublish: 'deliverable_publish',
        root: 'deliverables/',
        arbitraryWorkspaceWrite: true,
      },
      execution: {
        formalRunSubmission: true,
        sandboxAuthority: 'harness-session-policy',
        sandboxMode: 'inherited-at-execution',
        geoResearchPermissionGate: false,
        formalRunApprovalRequiredByGeoResearch: false,
      },
      imageReading: {
        automaticVisionModel: 'deepseek-v4-flash-vision-exp',
        providerProtocol: 'deepseek-api-chat-completions',
        releaseDate: '2026-08-21',
        credentialRef: 'DEEPSEEK_API_KEY',
        workspaceImages: 'read_image-agent-scoped-vision',
        uploadedImages: 'attachment_read_image',
        selectedModelVisionRequiredForPrimaryRoute: false,
        embeddedDocumentImageCountLimit: false,
        embeddedDocumentImageSelection: 'all-approved-within-byte-and-archive-safety-envelope',
        embeddedDocumentVisionConcurrency: 3,
        pptxImageContext: 'slide-text-and-speaker-notes',
        pptxPackageThumbnails: 'excluded',
        transientProviderMaxAttempts: 5,
        nativeVisionFallback: 'selected-model-dependent',
        finalFallback: 'local-ocr-text-and-layout',
        uploadedImageInstructions: 'untrusted-data-only',
      },
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/hostSandboxed|interactiveApprovalRequired|approvalControlled/)
    expect(JSON.stringify(snapshot)).not.toContain('POST_PHASE3_DOMAIN_CAPABILITIES_PENDING')
  })

  it('keeps the cache-sensitive static policy compact and capability-agnostic', () => {
    expect(GEORESEARCH_INTEGRITY_RULES.length).toBeLessThanOrEqual(3_200)
    expect(GEORESEARCH_INTEGRITY_PROMPT_ORDER).toBeGreaterThanOrEqual(900)
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('current georesearch:runtime snapshot')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('matching skill listed in the session catalog')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('including read-only status checks')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('load only the georesearch Skill')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('managed children started by delegate_* tools')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('Workspace paths such as inputs/... are files for read, not attachment IDs')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('only for a user-requested file')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('otherwise return the result inline')
    expect(GEORESEARCH_INTEGRITY_RULES).not.toContain('matching GeoResearch skill')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('model-facing schema is intentionally compact')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('autonomy.enabled is true')
    expect(GEORESEARCH_INTEGRITY_RULES).toContain('suppress routine workflow pauses')
    expect(GEORESEARCH_INTEGRITY_RULES).not.toContain('requires an explicit Harness user-approval outcome')
    expect(GEORESEARCH_INTEGRITY_RULES).not.toContain('approved requests always require explicit user approval')
    expect(GEORESEARCH_INTEGRITY_RULES).not.toMatch(/deepseek-v4|release date|PNG|PPTX|NetCDF|formal_run_submit/iu)
  })

  it('keeps the pre-bootstrap specialist runtime compact and task-independent', () => {
    const snapshot = runtimeCapabilitySnapshot({
      actor: 'reviewer',
      stage: 'phase6',
      generation: 3,
      profileTreeDigest: `sha256:${'b'.repeat(64)}`,
      availableCapabilities: ['skill', 'artifact_read', 'structured_output'],
      missingRequiredCapabilities: [],
      deferredCapabilities: [],
      autonomy: {
        enabled: false,
        source: 'none',
        directUserDirective: 'none',
        fullAccessPermission: false,
      },
      specialist: {
        role: 'reviewer',
        bootstrapTool: DELEGATION_BOOTSTRAP_TOOL,
        bootstrapStatus: 'required',
      },
    }) as Record<string, unknown>

    expect(snapshot.specialist).toEqual({
      role: 'reviewer',
      bootstrapTool: DELEGATION_BOOTSTRAP_TOOL,
      bootstrapStatus: 'required',
    })
    const rendered = JSON.stringify(snapshot)
    expect(rendered).not.toMatch(/proposal-review|scientific-validation|remote-sensing-experiment|spatial-statistics/u)
    expect(snapshot).not.toHaveProperty('attachments')
    expect(snapshot).not.toHaveProperty('imageReading')
    expect(snapshot).not.toHaveProperty('execution')
    expect(snapshot).not.toHaveProperty('deliverables')
    expect(rendered.length).toBeLessThanOrEqual(1_600)
  })

  it('publishes Host-observed Skill readiness after bootstrap without repeating the task contract', () => {
    const snapshot = runtimeCapabilitySnapshot({
      actor: 'reviewer',
      stage: 'phase6',
      generation: 3,
      profileTreeDigest: `sha256:${'b'.repeat(64)}`,
      availableCapabilities: ['skill', 'artifact_read', 'structured_output'],
      missingRequiredCapabilities: [],
      deferredCapabilities: [],
      autonomy: {
        enabled: false,
        source: 'none',
        directUserDirective: 'none',
        fullAccessPermission: false,
      },
      specialist: {
        role: 'reviewer',
        bootstrapTool: DELEGATION_BOOTSTRAP_TOOL,
        bootstrapStatus: 'delivered',
        loadedSkills: ['scientific-validation'],
        missingSkills: ['remote-sensing-experiment', 'spatial-statistics'],
      },
    }) as Record<string, unknown>

    expect(snapshot.specialist).toEqual({
      role: 'reviewer',
      bootstrapTool: DELEGATION_BOOTSTRAP_TOOL,
      bootstrapStatus: 'delivered',
      loadedSkills: ['scientific-validation'],
      missingSkills: ['remote-sensing-experiment', 'spatial-statistics'],
    })
    expect(snapshot.specialist).not.toHaveProperty('taskType')
    expect(snapshot.specialist).not.toHaveProperty('requiredSkills')
  })

  it('publishes the implemented structured attachment matrix', () => {
    expect(ATTACHMENT_CAPABILITY_MATRIX.structured).toEqual(expect.arrayContaining([
      'PDF', 'DOCX', 'XLSX', 'PPTX', 'SQLite', 'HDF5', 'NetCDF classic', 'Parquet',
    ]))
    expect(ATTACHMENT_CAPABILITY_MATRIX.images).toEqual(expect.arrayContaining([
      'PNG', 'JPEG', 'WebP', 'GIF', 'TIFF', 'BMP',
    ]))
    expect(ATTACHMENT_CAPABILITY_MATRIX.rejected).toContain('unknown binary')
  })
})
