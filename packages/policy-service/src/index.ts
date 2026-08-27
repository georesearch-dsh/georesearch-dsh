import { AsyncLocalStorage } from 'node:async_hooks'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import {
  durablePreset,
  livePreset,
  onAgentCreated,
  onAgentDisposed,
  onAgentInboxClaimed,
  onAgentPreStep,
  onAgentStatus,
  parentSessionId,
  registerToolGuard,
  restrictAgentTools,
  roleOf,
  sessionOrigin,
  visibleToolNames,
  type Agent,
  type PreStepDecision,
  type ToolExecution,
  type UserMessage,
} from '@georesearch/dsh-compat-rc5'
import {
  DELEGATION_BOOTSTRAP_TOOL,
  DELEGATION_TOOL_NAMES,
  GeoResearchError,
  PRESET_ID,
  REQUIRED_SKILLS,
  STRUCTURED_OUTPUT_TOOL,
  allowedSkillsForRole,
  allowlistFor,
  completionCriteriaForTask,
  isSpecialistTaskType,
  outputKindsForTask,
  requiredSkillsForTask,
  requiredToolsFor,
  type ArtifactRef,
  type CapabilityStage,
  type GeoResearchActor,
  type GeoResearchRole,
  type GeoResearchSkillName,
  type RunKind,
  type SpecialistOutputKind,
  type SpecialistTaskType,
  type ValidationSubjectRef,
} from '@georesearch/dsh-contracts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchPolicy: GeoResearchPolicy
  }
}

export const name = 'georesearch-policy'
export const inject = ['geoResearchInstallation', 'tools', 'agents', 'agentPresets']

export interface Config {
  readonly strictCatalog?: boolean
  readonly capabilityStage?: CapabilityStage
}

export interface ManagedDelegationContract {
  readonly role: GeoResearchRole
  readonly taskType: SpecialistTaskType
  readonly requiredSkills: readonly GeoResearchSkillName[]
  readonly bootstrapPayload: DelegationBootstrapPayload
}

export interface DelegationBootstrapAuthority {
  readonly projectId: string
  readonly generation: number
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly subjectRefs: readonly ValidationSubjectRef[]
  readonly artifactRefs: readonly ArtifactRef[]
}

export interface DelegationBootstrapPayload {
  readonly schemaVersion: 1
  readonly role: GeoResearchRole
  readonly taskType: SpecialistTaskType
  readonly requiredSkills: readonly GeoResearchSkillName[]
  readonly completionCriteria: readonly string[]
  readonly allowedOutputKinds: readonly SpecialistOutputKind[]
  readonly authority: DelegationBootstrapAuthority
  readonly researchQuestion: string | null
  readonly constraints: readonly string[]
  readonly task: string
}

interface PendingDelegation extends ManagedDelegationContract {
  readonly parent: Agent
}

interface ManagedChildLease {
  readonly parentId: string
  readonly role: GeoResearchRole
  readonly taskType: SpecialistTaskType
  readonly requiredSkills: readonly GeoResearchSkillName[]
  readonly loadedSkills: Set<GeoResearchSkillName>
  readonly bootstrap: ManagedDelegationBootstrap
  readonly toolBudget: SpecialistToolBudgetState
  readonly budgetedExecutions: Set<unknown>
}

export interface SpecialistToolBudgetState {
  literatureProviderCalls: number
  webSearchCalls: number
  sourceResolveCalls: number
}

export interface SpecialistSkillState {
  readonly role: GeoResearchRole
  readonly taskType: SpecialistTaskType
  readonly requiredSkills: readonly GeoResearchSkillName[]
  readonly loadedSkills: readonly GeoResearchSkillName[]
  readonly missingSkills: readonly GeoResearchSkillName[]
}

export type SpecialistRuntimeState = {
  readonly role: GeoResearchRole
  readonly bootstrapTool: typeof DELEGATION_BOOTSTRAP_TOOL
  readonly bootstrapStatus: 'required'
} | {
  readonly role: GeoResearchRole
  readonly bootstrapTool: typeof DELEGATION_BOOTSTRAP_TOOL
  readonly bootstrapStatus: 'delivered'
  readonly loadedSkills: readonly GeoResearchSkillName[]
  readonly missingSkills: readonly GeoResearchSkillName[]
}

export class ManagedDelegationBootstrap {
  private readonly payload: DelegationBootstrapPayload
  private delivered = false

  constructor(payload: DelegationBootstrapPayload) {
    this.payload = cloneBootstrapPayload(payload)
  }

  get isDelivered(): boolean {
    return this.delivered
  }

  deliver(): DelegationBootstrapPayload {
    if (this.delivered) {
      throw new GeoResearchError(
        'GEORESEARCH_DELEGATION_BOOTSTRAP_ALREADY_DELIVERED',
        'the managed specialist task contract was already delivered',
      )
    }
    this.delivered = true
    return cloneBootstrapPayload(this.payload)
  }
}

export interface GeoResearchIdentityFacts {
  readonly durablePreset: string | undefined
  readonly livePreset: string | undefined
  readonly origin: 'subagent' | undefined
  readonly role: GeoResearchRole | undefined
  readonly managedChild: boolean
}

export type GeoResearchSessionEvent = Agent['session']['events'][number]
export type GeoResearchDirectUserDirective = 'granted' | 'revoked' | 'none'
export type GeoResearchAutonomySource = 'danger-full-access' | 'direct-user' | 'none'

export interface GeoResearchAutonomyState {
  readonly enabled: boolean
  readonly source: GeoResearchAutonomySource
  readonly directUserDirective: GeoResearchDirectUserDirective
  readonly fullAccessPermission: boolean
}

const GRANT_PATTERNS: readonly RegExp[] = [
  /(?:全程|全流程|整个(?:课题|项目|研究|流程)|完整(?:课题|项目|研究|流程)|后续(?:全部|所有)?(?:步骤|节点|流程|过程)|所有(?:步骤|节点|流程)|任何(?:步骤|节点))[^。！？\n]{0,40}(?:无需|无须|不用|不必|不需要|不要)(?:再|继续)?[^。！？\n]{0,18}(?:授权|批准|审批|确认|同意)/giu,
  /(?:不要|无需|无须|不用|不必|不需要)(?:再|继续)(?:(?:向|像)(?:我|用户))?(?:请求|征求|获得)?(?:任何|额外|进一步|后续)?(?:授权|批准|审批|确认|同意)(?:或(?:授权|批准|审批|确认|同意))?/giu,
  /(?:不要|无需|无须|不用|不必|不需要)(?:再|继续)?(?:向|像)(?:我|用户)(?:请求|征求|获得)?(?:任何|额外|进一步|后续)?(?:授权|批准|审批|确认|同意)(?:或(?:授权|批准|审批|确认|同意))?/giu,
  /我(?:已经|已)?(?:完全|全权|明确)?授权你[^。！？\n]{0,30}(?:独立|自主|自行|全程|完整|完成|推进|执行)/giu,
  /(?:你拥有|授予你|给你)(?:完全|全部|全权)?(?:授权|自主权|决定权)/giu,
  /(?:开启|启用|进入)(?:完全|全流程)?(?:自主|自治)(?:模式)?/giu,
  /\b(?:do not|don't|dont|need not|no need to)\s+(?:ask|request|seek|obtain)\s+(?:me\s+)?(?:again\s+)?(?:for\s+)?(?:any\s+|further\s+|additional\s+)?(?:approval|authorization|confirmation|consent)\b/giu,
  /\bno\s+(?:further|additional|more)\s+(?:approval|authorization|confirmation|consent)\s+(?:is\s+)?(?:needed|required)\b/giu,
  /\b(?:i\s+(?:fully|completely|explicitly)\s+authorize\s+you|you\s+have\s+(?:my\s+)?full\s+(?:authorization|authority|autonomy))\b/giu,
  /\b(?:complete|run|handle|finish|execute)\s+(?:the\s+)?(?:entire|full|whole)\s+(?:research\s+|project\s+)?(?:workflow|process)\s+(?:autonomously|without\s+(?:asking|approval|confirmation))\b/giu,
  /\bproceed\s+(?:autonomously|without\s+(?:asking\s+me|further\s+(?:approval|confirmation)))\b/giu,
]

const REVOCATION_PATTERNS: readonly RegExp[] = [
  /(?:撤销|取消|收回)(?:之前|此前|刚才|全部|完全|全流程|对你的)?(?:的)?(?:授权|全权授权|自主权|自治权|自主模式|自治模式)/giu,
  /(?:恢复|重新启用|改回)(?:逐步|人工|用户)?(?:授权|批准|审批|确认)(?:流程|模式|要求)?/giu,
  /(?:需要|必须)(?:先)?(?:向我|跟我)(?:请求|征求|确认|获得)?(?:授权|批准|审批|确认|同意)/giu,
  /不要(?:再)?(?:自行|自主)(?:决定|继续|执行|推进)/giu,
  /请(?:在[^。！？\n]{0,16}之前)?(?:先)?(?:问我|向我确认|征得我的同意)/giu,
  /\b(?:revoke|withdraw|cancel)\s+(?:the\s+|my\s+|your\s+)?(?:full\s+)?(?:authorization|autonomy|authority)\b/giu,
  /\b(?:ask|check\s+with|confirm\s+with)\s+me\s+before\s+(?:proceeding|continuing|each|any|making)\b/giu,
  /\b(?:approval|authorization|confirmation|consent)\s+(?:is|will\s+be)\s+(?:required|needed)\s+(?:again|from\s+now\s+on)\b/giu,
  /\bdo\s+not\s+proceed\s+without\s+(?:my\s+)?(?:approval|authorization|confirmation|consent)\b/giu,
  /\b(?:require|request)\s+(?:my\s+)?(?:approval|authorization|confirmation|consent)\s+(?:again|for\s+each\s+step)\b/giu,
]

const GEORESEARCH_FILE_REFERENCE = /<georesearch-file\b[^>]*\/?\s*>/giu

export function deriveGeoResearchAutonomy(
  events: readonly GeoResearchSessionEvent[],
  claimedMessages: readonly UserMessage[] = [],
): GeoResearchAutonomyState {
  let directUserDirective: GeoResearchDirectUserDirective = 'none'
  let sandboxMode: string | undefined
  let approvalPolicy: string | undefined

  for (const rawEvent of events) {
    const event = structuralRecord(rawEvent)
    const type = event?.type
    const data = structuralRecord(event?.data)
    if (type === 'sandbox/mode' && typeof data?.mode === 'string') sandboxMode = data.mode
    if (type === 'approval/policy' && typeof data?.policy === 'string') approvalPolicy = data.policy
    if (type !== 'user/message') continue
    const directive = directUserDirectiveFromMessage(data)
    if (directive !== 'none') directUserDirective = directive
  }

  for (const message of claimedMessages) {
    const directive = directUserDirectiveFromMessage(structuralRecord(message))
    if (directive !== 'none') directUserDirective = directive
  }

  const fullAccessPermission = sandboxMode === 'danger-full-access' && approvalPolicy === 'never'
  if (fullAccessPermission) {
    return {
      enabled: true,
      source: 'danger-full-access',
      directUserDirective,
      fullAccessPermission,
    }
  }
  if (directUserDirective === 'granted') {
    return {
      enabled: true,
      source: 'direct-user',
      directUserDirective,
      fullAccessPermission,
    }
  }
  return {
    enabled: false,
    source: 'none',
    directUserDirective,
    fullAccessPermission,
  }
}

export function actorFromIdentity(
  facts: Pick<GeoResearchIdentityFacts, 'livePreset' | 'origin' | 'role' | 'managedChild'>,
): GeoResearchActor | undefined {
  if (facts.livePreset !== PRESET_ID) return undefined
  if (facts.origin === 'subagent') {
    return facts.role !== undefined && facts.managedChild ? facts.role : undefined
  }
  return facts.role === undefined ? 'coordinator' : undefined
}

export function preStepDecisionFromIdentity(facts: GeoResearchIdentityFacts): PreStepDecision | undefined {
  if (facts.durablePreset !== PRESET_ID && facts.livePreset !== PRESET_ID) return undefined
  return actorFromIdentity(facts) === undefined ? { kind: 'reject' } : undefined
}

export function guardActorTool(actor: GeoResearchActor, toolName: string): string | undefined {
  return allowlistFor(actor).includes(toolName as never)
    ? undefined
    : `GEORESEARCH_TOOL_FORBIDDEN: ${toolName} is not allowed for ${actor}`
}

export function guardSpecialistSkillProtocol(
  role: GeoResearchRole,
  bootstrapDelivered: boolean,
  requiredSkills: readonly GeoResearchSkillName[],
  loadedSkills: ReadonlySet<GeoResearchSkillName>,
  toolName: string,
  toolArguments: unknown,
): string | undefined {
  if (!bootstrapDelivered) {
    return toolName === DELEGATION_BOOTSTRAP_TOOL
      ? undefined
      : `GEORESEARCH_DELEGATION_BOOTSTRAP_REQUIRED: call ${DELEGATION_BOOTSTRAP_TOOL} before ${toolName}`
  }
  if (toolName === DELEGATION_BOOTSTRAP_TOOL) {
    return 'GEORESEARCH_DELEGATION_BOOTSTRAP_ALREADY_DELIVERED: the managed task contract is already available'
  }
  if (toolName === 'skill') {
    const requested = skillNameFromArguments(toolArguments)
    if (requested === undefined || !allowedSkillsForRole(role).includes(requested as never)) {
      return `GEORESEARCH_SPECIALIST_SKILL_FORBIDDEN: requested Skill is not allowed for ${role}`
    }
    return undefined
  }
  const missing = requiredSkills.filter(skill => !loadedSkills.has(skill))
  return missing.length === 0
    ? undefined
    : `GEORESEARCH_SPECIALIST_SKILL_REQUIRED: load ${missing.join(', ')} before ${toolName}`
}

export function guardAndConsumeSpecialistToolBudget(
  role: GeoResearchRole,
  taskType: SpecialistTaskType,
  state: SpecialistToolBudgetState,
  toolName: string,
): string | undefined {
  if (role !== 'literature' || taskType !== 'discovery') return undefined
  const budget = toolName === 'literature_search' || toolName === 'literature_continue'
    ? { field: 'literatureProviderCalls' as const, limit: 2, label: 'combined literature_search + literature_continue' }
    : toolName === 'web_search'
      ? { field: 'webSearchCalls' as const, limit: 1, label: 'web_search' }
      : toolName === 'source_resolve'
        ? { field: 'sourceResolveCalls' as const, limit: 4, label: 'source_resolve' }
        : undefined
  if (budget === undefined) return undefined
  if (state[budget.field] >= budget.limit) {
    return `GEORESEARCH_TOOL_FORBIDDEN: literature discovery ${budget.label} budget of ${budget.limit} call(s) is exhausted`
  }
  state[budget.field] += 1
  return undefined
}

export function guardCoordinatorSkillProtocol(
  georesearchLoaded: boolean,
  toolName: string,
  toolArguments: unknown,
): string | undefined {
  if (toolName === 'skill') {
    return skillNameFromArguments(toolArguments) === 'georesearch'
      ? undefined
      : 'GEORESEARCH_SPECIALIST_SKILL_FORBIDDEN: coordinator may load only the georesearch Skill'
  }
  return georesearchLoaded
    ? undefined
    : `GEORESEARCH_SPECIALIST_SKILL_REQUIRED: load georesearch before ${toolName}`
}

export class GeoResearchPolicy extends Service {
  private readonly pending = new AsyncLocalStorage<PendingDelegation>()
  private readonly managedChildren = new WeakMap<Agent, ManagedChildLease>()
  private readonly managedChildrenById = new Map<string, ManagedChildLease>()
  private readonly coordinatorSkillLoaded = new WeakSet<Agent>()
  private readonly claimedMessages = new WeakMap<Agent, { turn: number; messages: UserMessage[] }>()
  private readonly warnedActors = new Set<GeoResearchActor>()
  readonly strictCatalog: boolean
  readonly capabilityStage: CapabilityStage

  constructor(ctx: Context, config: Config) {
    super(ctx, 'geoResearchPolicy')
    this.strictCatalog = config.strictCatalog ?? false
    this.capabilityStage = parseCapabilityStage(config.capabilityStage)
    registerToolGuard(ctx, execution => this.guard(execution))
    ctx.on('tools/result', (execution, result) => {
      this.onToolResult(execution, result)
      return undefined
    })
    onAgentCreated(ctx, agent => this.onCreated(agent))
    onAgentDisposed(ctx, agent => {
      this.managedChildrenById.delete(String(agent.id))
      this.managedChildren.delete(agent)
      this.claimedMessages.delete(agent)
    })
    onAgentInboxClaimed(ctx, (agent, message, turn) => this.onInboxClaimed(agent, message, turn))
    onAgentStatus(ctx, (agent, status) => {
      if (status === 'idle') this.claimedMessages.delete(agent)
    })
    onAgentPreStep(ctx, agent => this.preStep(agent))
  }

  withManagedDelegation<T>(
    parent: Agent,
    contract: ManagedDelegationContract,
    operation: () => T,
  ): T {
    this.ctx.geoResearchInstallation.assertCurrent()
    if (!this.isCoordinator(parent)) {
      throw new GeoResearchError(
        'GEORESEARCH_ROLE_MISMATCH',
        `only a GeoResearch coordinator may create a ${contract.role} child`,
      )
    }
    if (!isSpecialistTaskType(contract.role, contract.taskType)) {
      throw new GeoResearchError(
        'GEORESEARCH_SPECIALIST_TASK_INVALID',
        `${contract.taskType} is not a valid ${contract.role} task`,
      )
    }
    const allowed = allowedSkillsForRole(contract.role)
    const required = [...new Set(contract.requiredSkills)]
    const baseline = requiredSkillsForTask(contract.role, contract.taskType)
    if (baseline.some(skill => !required.includes(skill))) {
      throw new GeoResearchError(
        'GEORESEARCH_SPECIALIST_SKILL_REQUIRED',
        `${contract.role}:${contract.taskType} omitted a required Skill`,
      )
    }
    const forbidden = required.filter(skill => !allowed.includes(skill as never))
    if (forbidden.length > 0) {
      throw new GeoResearchError(
        'GEORESEARCH_SPECIALIST_SKILL_FORBIDDEN',
        `${forbidden.join(', ')} cannot be loaded by ${contract.role}`,
      )
    }
    assertBootstrapPayloadMatches(contract.bootstrapPayload, contract.role, contract.taskType, required)
    return this.pending.run({
      parent,
      role: contract.role,
      taskType: contract.taskType,
      requiredSkills: required,
      bootstrapPayload: cloneBootstrapPayload(contract.bootstrapPayload),
    }, operation)
  }

  isManagedChild(agent: Agent): boolean {
    return this.managedChildren.has(agent)
  }

  specialistSkillStateById(id: string): SpecialistSkillState | undefined {
    const lease = this.managedChildrenById.get(id)
    if (lease === undefined) return undefined
    const allowed = allowedSkillsForRole(lease.role)
    const loadedSkills = allowed.filter(skill => lease.loadedSkills.has(skill))
    return {
      role: lease.role,
      taskType: lease.taskType,
      requiredSkills: [...lease.requiredSkills],
      loadedSkills,
      missingSkills: lease.requiredSkills.filter(skill => !lease.loadedSkills.has(skill)),
    }
  }

  specialistRuntimeStateById(id: string): SpecialistRuntimeState | undefined {
    const lease = this.managedChildrenById.get(id)
    if (lease === undefined) return undefined
    if (!lease.bootstrap.isDelivered) {
      return {
        role: lease.role,
        bootstrapTool: DELEGATION_BOOTSTRAP_TOOL,
        bootstrapStatus: 'required',
      }
    }
    const allowed = allowedSkillsForRole(lease.role)
    return {
      role: lease.role,
      bootstrapTool: DELEGATION_BOOTSTRAP_TOOL,
      bootstrapStatus: 'delivered',
      loadedSkills: allowed.filter(skill => lease.loadedSkills.has(skill)),
      missingSkills: lease.requiredSkills.filter(skill => !lease.loadedSkills.has(skill)),
    }
  }

  consumeDelegationBootstrap(agent: Agent): DelegationBootstrapPayload {
    this.ctx.geoResearchInstallation.assertCurrent()
    const actor = this.actorFor(agent)
    const lease = this.managedChildren.get(agent)
    if (actor === undefined || actor === 'coordinator' || lease === undefined || lease.role !== actor) {
      throw new GeoResearchError(
        'GEORESEARCH_ROLE_MISMATCH',
        'delegation bootstrap requires an exact managed specialist',
      )
    }
    return lease.bootstrap.deliver()
  }

  actorFor(agent: Agent): GeoResearchActor | undefined {
    return actorFromIdentity({
      livePreset: livePreset(this.ctx, agent.ctx),
      origin: sessionOrigin(agent),
      role: roleOf(agent),
      managedChild: this.managedChildren.has(agent),
    })
  }

  autonomyFor(agent: Agent): GeoResearchAutonomyState {
    this.ctx.geoResearchInstallation.assertCurrent()
    if (this.actorFor(agent) === undefined) {
      return {
        enabled: false,
        source: 'none',
        directUserDirective: 'none',
        fullAccessPermission: false,
      }
    }
    return deriveGeoResearchAutonomy(
      agent.session.events,
      this.claimedMessages.get(agent)?.messages,
    )
  }

  availableAllowlist(agent: Agent, actor: GeoResearchActor): string[] {
    const allowed = new Set(allowlistFor(actor))
    return visibleToolNames(this.ctx, agent.ctx).filter(toolName => allowed.has(toolName))
  }

  missingRoleCapabilities(agent: Agent, actor: GeoResearchActor): string[] {
    const present = new Set(visibleToolNames(this.ctx, agent.ctx))
    return allowlistFor(actor).filter(toolName => !present.has(toolName))
  }

  missingRequiredCapabilities(agent: Agent, actor: GeoResearchActor): string[] {
    const present = new Set(visibleToolNames(this.ctx, agent.ctx))
    return requiredToolsFor(actor, this.capabilityStage).filter(toolName => !present.has(toolName))
  }

  authorizeExecution(agent: Agent, kind: RunKind): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    const actor = this.actorFor(agent)
    if ((kind === 'formal' && actor !== 'coordinator')
      || (kind === 'local-test' && actor !== 'experiment')) {
      throw new GeoResearchError(
        'GEORESEARCH_ROLE_MISMATCH',
        `${kind} execution is not authorized for ${actor ?? 'an unbound actor'}`,
      )
    }
  }

  private onCreated(agent: Agent): void {
    const composed = livePreset(this.ctx, agent.ctx)
    const durable = durablePreset(agent.session)
    if (composed !== PRESET_ID) {
      if (durable === PRESET_ID && sessionOrigin(agent) === 'subagent') {
        throw new GeoResearchError(
          'GEORESEARCH_UNMANAGED_DELEGATED_SESSION',
          'a delegated GeoResearch session was published without the managed preset',
        )
      }
      return
    }

    this.ctx.geoResearchInstallation.assertCurrent()
    const role = roleOf(agent)
    let actor: GeoResearchActor
    if (sessionOrigin(agent) === 'subagent') {
      const pending = this.pending.getStore()
      const parentId = parentSessionId(agent)
      if (role === undefined || pending === undefined
        || pending.role !== role || parentId !== pending.parent.id) {
        throw new GeoResearchError(
          'GEORESEARCH_UNMANAGED_DELEGATED_SESSION',
          'delegated session publication was not covered by the current managed one-shot lease',
        )
      }
      const lease: ManagedChildLease = {
        parentId: pending.parent.id,
        role,
        taskType: pending.taskType,
        requiredSkills: [...pending.requiredSkills],
        loadedSkills: new Set(),
        bootstrap: new ManagedDelegationBootstrap(pending.bootstrapPayload),
        toolBudget: { literatureProviderCalls: 0, webSearchCalls: 0, sourceResolveCalls: 0 },
        budgetedExecutions: new Set(),
      }
      this.managedChildren.set(agent, lease)
      this.managedChildrenById.set(String(agent.id), lease)
      actor = role
    } else {
      if (role !== undefined) {
        throw new GeoResearchError(
          'GEORESEARCH_ROLE_MISMATCH',
          `top-level GeoResearch agent cannot carry specialist role ${role}`,
        )
      }
      actor = 'coordinator'
    }

    const available = this.availableAllowlist(agent, actor)
    const present = new Set(visibleToolNames(this.ctx, agent.ctx))
    const missingFoundation = requiredToolsFor(actor, 'phase1')
      .filter(toolName => !present.has(toolName))
    if (missingFoundation.length > 0) {
      throw new GeoResearchError(
        'GEORESEARCH_ROLE_CAPABILITY_UNAVAILABLE',
        `${actor} is missing Phase 1 tools: ${missingFoundation.join(', ')}`,
      )
    }

    const missing = this.missingRoleCapabilities(agent, actor)
    const missingRequired = this.missingRequiredCapabilities(agent, actor)
    if (this.strictCatalog && missingRequired.length > 0) {
      throw new GeoResearchError(
        'GEORESEARCH_ROLE_CAPABILITY_UNAVAILABLE',
        `${actor} ${this.capabilityStage} catalog is incomplete: ${missingRequired.join(', ')}`,
      )
    }
    if (missing.length > 0 && !this.warnedActors.has(actor)) {
      this.warnedActors.add(actor)
      this.ctx.logger.warn(
        `GeoResearch ${actor} is running the Phase 1 capability subset; unavailable names: ${missing.join(', ')}`,
      )
    }
    restrictAgentTools(
      agent.ctx,
      available.filter(toolName => toolName !== STRUCTURED_OUTPUT_TOOL),
    )
  }

  private preStep(agent: Agent): PreStepDecision | undefined {
    try {
      this.ctx.geoResearchInstallation.assertCurrent()
      return preStepDecisionFromIdentity({
        durablePreset: durablePreset(agent.session),
        livePreset: livePreset(this.ctx, agent.ctx),
        origin: sessionOrigin(agent),
        role: roleOf(agent),
        managedChild: this.managedChildren.has(agent),
      })
    } catch {
      return { kind: 'reject' }
    } finally {
      // System-prompt assembly has already consumed this step's claimed messages.
      this.claimedMessages.delete(agent)
    }
  }

  private onInboxClaimed(agent: Agent, message: UserMessage, turn: number): void {
    const current = this.claimedMessages.get(agent)
    if (current?.turn === turn) {
      current.messages.push(message)
      return
    }
    this.claimedMessages.set(agent, { turn, messages: [message] })
  }

  private onToolResult(
    execution: Readonly<ToolExecution>,
    result: Readonly<{ readonly isError: boolean; readonly value?: unknown }>,
  ): void {
    const agent = execution.agent
    if (agent === undefined || execution.name !== 'skill' || result.isError) return
    if (this.actorFor(agent) === 'coordinator') {
      const requested = skillNameFromArguments(execution.arguments)
      const returned = structuralRecord(result.value)?.name
      if (requested === 'georesearch' && returned === requested) this.coordinatorSkillLoaded.add(agent)
      return
    }
    const lease = this.managedChildren.get(agent)
    if (lease === undefined) return
    const requested = skillNameFromArguments(execution.arguments)
    const returned = structuralRecord(result.value)?.name
    if (requested === undefined || returned !== requested) return
    if (!allowedSkillsForRole(lease.role).includes(requested as never)) return
    lease.loadedSkills.add(requested)
  }

  private guard(execution: Readonly<ToolExecution>): string | undefined {
    const agent = execution.agent
    if (agent === undefined) {
      return isManagedDelegationTool(execution.name)
        ? 'GEORESEARCH_TOOL_FORBIDDEN: GeoResearch tools require an exact live agent'
        : undefined
    }

    const composed = livePreset(this.ctx, agent.ctx)
    if (composed !== PRESET_ID) {
      return isManagedDelegationTool(execution.name)
        ? 'GEORESEARCH_PRESET_REQUIRED: GeoResearch delegation requires the live georesearch preset'
        : undefined
    }

    try {
      this.ctx.geoResearchInstallation.assertCurrent()
      const actor = this.actorFor(agent)
      if (actor === undefined) return 'GEORESEARCH_ROLE_MISMATCH: no valid GeoResearch actor is bound'
      const actorDenial = guardActorTool(actor, execution.name)
      if (actorDenial !== undefined) return actorDenial
      if (actor === 'coordinator') {
        return guardCoordinatorSkillProtocol(
          this.coordinatorSkillLoaded.has(agent),
          execution.name,
          execution.arguments,
        )
      }
      const lease = this.managedChildren.get(agent)
      if (lease === undefined || lease.role !== actor) {
        return 'GEORESEARCH_ROLE_MISMATCH: specialist lease is unavailable'
      }
      const protocolDenial = guardSpecialistSkillProtocol(
        actor,
        lease.bootstrap.isDelivered,
        lease.requiredSkills,
        lease.loadedSkills,
        execution.name,
        execution.arguments,
      )
      if (protocolDenial !== undefined) return protocolDenial
      if (lease.budgetedExecutions.has(execution.token)) return undefined
      const budgetDenial = guardAndConsumeSpecialistToolBudget(
        actor,
        lease.taskType,
        lease.toolBudget,
        execution.name,
      )
      if (budgetDenial !== undefined) return budgetDenial
      lease.budgetedExecutions.add(execution.token)
      return undefined
    } catch (error) {
      return error instanceof GeoResearchError ? `${error.code}: policy denied execution` : 'GEORESEARCH_TOOL_FORBIDDEN'
    }
  }

  private isCoordinator(agent: Agent): boolean {
    return this.actorFor(agent) === 'coordinator'
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new GeoResearchPolicy(ctx, config)
}

function parseCapabilityStage(value: CapabilityStage | undefined): CapabilityStage {
  if (value === undefined) return 'phase1'
  if (value !== 'phase1' && value !== 'phase2' && value !== 'phase3'
    && value !== 'phase4' && value !== 'phase5' && value !== 'phase6' && value !== 'full') {
    throw new TypeError(`unsupported capability stage: ${String(value)}`)
  }
  return value
}

function directUserDirectiveFromMessage(
  message: Record<string, unknown> | undefined,
): GeoResearchDirectUserDirective {
  if (message?.role !== 'user') return 'none'
  const source = structuralRecord(message.source)
  if (source?.kind !== 'user') return 'none'
  if (!Array.isArray(message.content)) return 'none'
  const text = message.content
    .map(block => structuralRecord(block))
    .filter((block): block is Record<string, unknown> => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .replace(GEORESEARCH_FILE_REFERENCE, ' ')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
  const grantIndex = lastPatternIndex(text, GRANT_PATTERNS)
  const revocationIndex = lastPatternIndex(text, REVOCATION_PATTERNS)
  if (grantIndex < 0 && revocationIndex < 0) return 'none'
  return revocationIndex > grantIndex ? 'revoked' : 'granted'
}

function lastPatternIndex(text: string, patterns: readonly RegExp[]): number {
  let last = -1
  for (const pattern of patterns) {
    const matcher = new RegExp(pattern.source, pattern.flags)
    for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
      last = Math.max(last, match.index)
    }
  }
  return last
}

function structuralRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function skillNameFromArguments(value: unknown): GeoResearchSkillName | undefined {
  const name = structuralRecord(value)?.name
  return typeof name === 'string' && (REQUIRED_SKILLS as readonly string[]).includes(name)
    ? name as GeoResearchSkillName
    : undefined
}

function isManagedDelegationTool(toolName: string): boolean {
  return toolName === DELEGATION_BOOTSTRAP_TOOL || DELEGATION_TOOL_NAMES.includes(toolName as never)
}

function assertBootstrapPayloadMatches(
  payload: DelegationBootstrapPayload,
  role: GeoResearchRole,
  taskType: SpecialistTaskType,
  requiredSkills: readonly GeoResearchSkillName[],
): void {
  const valid = payload.schemaVersion === 1
    && payload.role === role
    && payload.taskType === taskType
    && sameStrings(payload.requiredSkills, requiredSkills)
    && sameStrings(payload.completionCriteria, completionCriteriaForTask(role, taskType))
    && sameStrings(payload.allowedOutputKinds, outputKindsForTask(role, taskType))
    && typeof payload.task === 'string'
    && payload.task.trim().length > 0
    && (payload.researchQuestion === null
      || (typeof payload.researchQuestion === 'string' && payload.researchQuestion.trim().length > 0))
  if (!valid) {
    throw new GeoResearchError(
      'GEORESEARCH_SPECIALIST_TASK_INVALID',
      'delegation bootstrap payload does not match the managed specialist contract',
    )
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function cloneBootstrapPayload(payload: DelegationBootstrapPayload): DelegationBootstrapPayload {
  return structuredClone(payload)
}
