import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  Agent,
  AgentStatus,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  AgentSetupCommit,
  PreStepDecision,
} from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import {
  credentialRef as harnessCredentialRef,
  type CredentialProvider,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import { resolveDshHome as resolveHarnessDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {
  SessionId as HarnessSessionId,
  type Session,
  type SessionId,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import type {
  SubagentCapabilities,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { AssembleContext, PromptContext, PromptSection } from '@deepseek-ai/dsh-system-prompt'
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type JsonSchemaNode,
  type JsonSchemaType,
  type ObjectJsonSchema,
  type ToolDefinition,
  type ToolExecution,
  type ToolGuard,
  type ToolRestriction,
} from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  GeoResearchError,
  isGeoResearchRole,
  type GeoResearchRole,
} from '@georesearch/dsh-contracts'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    geoResearchRole?: GeoResearchRole
  }
}

export type {
  Agent,
  AgentStatus,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  AgentSetupCommit,
  AssembleContext,
  ContentBlock,
  Context,
  CredentialProvider,
  CredentialRef,
  ImageAttachmentRef,
  ImageMediaType,
  PreStepDecision,
  PromptContext,
  PromptSection,
  SandboxExecutionPolicy,
  SandboxMode,
  Session,
  SessionId,
  SubagentCapabilities,
  SubagentRun,
  SubagentStartRequest,
  SubprocessHandle,
  SubprocessSpawnSpec,
  ToolDefinition,
  ToolExecution,
  ToolGuard,
  ToolRestriction,
  UserMessage,
}

export const HARNESS_VERSION = '0.1.0-rc.5'
export const CORDIS_VERSION = '4.0.1'
export const SPAWN_PROVIDER = 'spawn'

export function resolveDshHome(configuredHome?: string): string {
  return resolveHarnessDshHome(configuredHome)
}

export function sessionId(value: string): SessionId {
  return HarnessSessionId(value)
}

export function credentialReference(value: string): CredentialRef {
  return harnessCredentialRef(value)
}

export function liveAgentForSession(ctx: Context, value: string): Agent | undefined {
  return ctx.agents.get(HarnessSessionId(value))
}

export function registerWebPrefix(
  ctx: Context,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): () => void {
  const webServer = ctx.get('webServer', false)
  return webServer === undefined
    ? () => undefined
    : webServer.register({ kind: 'prefix', path, handler })
}

export interface ResumeThroughHarnessOptions {
  readonly resumeSessionId: SessionId
  readonly agentOptions?: AgentOptions
  readonly setup?: AgentSetup
  readonly signal?: AbortSignal
}

export function durablePreset(session: Session): string | undefined {
  return resolveSessionPreset(session)
}

export function livePreset(ctx: Context, agentContext: Context): string | undefined {
  return ctx.agentPresets.composedPreset(agentContext)
}

export async function mountPreset(ctx: Context, agentContext: Context, presetId: string): Promise<string> {
  const mounted = await ctx.agentPresets.mount(agentContext, presetId)
  return mounted.id
}

export function sessionOrigin(agent: Agent): 'subagent' | undefined {
  return agent.session.header.origin
}

export function parentSessionId(agent: Agent): SessionId | undefined {
  return agent.session.header.parentSession
}

export function roleOf(agent: Agent): GeoResearchRole | undefined {
  const role = agent.options.geoResearchRole
  if (role === undefined) return undefined
  if (!isGeoResearchRole(role)) {
    throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `unsupported role ${JSON.stringify(role)}`)
  }
  return role
}

export function agentFromContext(agentContext: Context): Agent {
  const agent = agentContext.agent
  if (agent === undefined) throw new Error('Harness rc.5 setup context did not expose agentCtx.agent')
  return agent
}

export function sessionCwd(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new GeoResearchError('PROJECT_NOT_ATTACHED', 'the live Agent session has no workspace cwd')
  return cwd
}

export function operationIdentity(
  execution: Pick<ToolExecution, 'agent' | 'rootCallId' | 'callId'>,
  projectId: string,
  operation: string,
): {
  readonly projectId: string
  readonly agentId: string
  readonly sessionId: string
  readonly rootCallId: string
  readonly callId: string
  readonly operation: string
} {
  const agent = execution.agent
  if (agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return {
    projectId,
    agentId: String(agent.id),
    sessionId: String(agent.session.id),
    rootCallId: String(execution.rootCallId),
    callId: String(execution.callId),
    operation,
  }
}

export function promptAgent(context: AssembleContext): Agent | undefined {
  return context.agent
}

export function visibleToolNames(ctx: Context, agentContext: Context): string[] {
  return ctx.tools.schemas(agentFromContext(agentContext)).map(schema => schema.name).sort()
}

export function registeredToolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name).sort()
}

export function restrictAgentTools(agentContext: Context, allow: readonly string[]): () => void {
  return agentContext.tools.restrict({ allow: [...allow] })
}

const HARNESS_SCHEMA_TYPES: readonly JsonSchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]
const HARNESS_SCHEMA_ANNOTATIONS = ['description', 'title', 'default', 'examples'] as const

/**
 * Project a complete JSON Schema into the enforced Harness rc.5 tool subset.
 * Runtime parsers and persisted standalone schemas remain authoritative for
 * constraints the Harness cannot express.
 */
export function toHarnessToolSchema(schema: unknown): JsonSchemaNode & Record<string, unknown> {
  const projected = projectHarnessSchemaNode(schema, 'schema', new Set())
  assertSupportedJsonSchema(projected)
  return projected as JsonSchemaNode & Record<string, unknown>
}

/** Return a ToolDefinition whose model and output schemas use the Harness subset. */
export function toHarnessToolDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    parameters: toHarnessToolSchema(definition.parameters),
    output: {
      ...definition.output,
      schema: toHarnessToolSchema(definition.output.schema),
    },
  }
}

export function registerTool(ctx: Context, definition: ToolDefinition): () => void {
  return ctx.tools.register(toHarnessToolDefinition(definition))
}

export function registerToolGuard(ctx: Context, guard: ToolGuard): () => void {
  return ctx.tools.guard(guard)
}

export function registerPromptSection(ctx: Context, section: PromptSection): () => void {
  return ctx.systemPrompt.section(section)
}

export function registerPromptContext(ctx: Context, promptContext: PromptContext): () => void {
  return ctx.systemPrompt.context(promptContext)
}

export function onAgentCreated(ctx: Context, listener: (agent: Agent) => void): () => void {
  return ctx.on('agent/created', ({ agent }) => listener(agent))
}

export function onAgentDisposed(ctx: Context, listener: (agent: Agent) => void): () => void {
  return ctx.on('agent/disposed', ({ agent }) => listener(agent))
}

export function onAgentInboxClaimed(
  ctx: Context,
  listener: (agent: Agent, message: UserMessage, turn: number) => void,
): () => void {
  return ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => listener(agent, message, turn))
}

export function onAgentStatus(
  ctx: Context,
  listener: (agent: Agent, status: AgentStatus) => void,
): () => void {
  return ctx.on('agent/status', ({ agent, status }) => listener(agent, status))
}

export function onAgentPreStep(
  ctx: Context,
  listener: (
    agent: Agent,
    messages: readonly UserMessage[],
  ) => Promise<PreStepDecision | undefined> | PreStepDecision | undefined,
): () => void {
  return ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await listener(agent, messages)
    return decision ?? next()
  }, { prepend: true })
}

export function hasSessionTelemetry(ctx: Context): boolean {
  return ctx.get('sessionTelemetry', false) !== undefined
}

export function confineArgv(
  ctx: Context,
  argv: readonly string[],
  workspaceRoot: string,
  mode: ConfinedSandboxMode,
  agent?: Agent,
): ConfinedArgv {
  const policy: SandboxPolicy = {
    mode,
    workspaceRoot,
    ...(agent === undefined ? {} : { sessionId: agent.session.id }),
  }
  return ctx.sandbox.confine(argv, policy)
}

export function resolveAgentSandboxPolicy(ctx: Context, agent: Agent): SandboxExecutionPolicy {
  return ctx.sandboxPolicy.resolve({ session: agent.session })
}

export function spawnSubprocess(ctx: Context, spec: SubprocessSpawnSpec): SubprocessHandle {
  return ctx.subprocess.spawn(spec)
}

export async function resolveExecutable(
  ctx: Context,
  command: string,
  env?: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<string> {
  return ctx.subprocess.resolveExecutable(command, env, signal)
}

export async function requestUserApproval(
  ctx: Context,
  agent: Agent,
  toolName: string,
  callId: ToolExecution['callId'],
  reason: string,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  return ctx.approval.request({
    agent,
    toolName,
    callId,
    reason,
    ...(signal === undefined ? {} : { signal }),
  })
}

export function spawnCapabilities(ctx: Context): SubagentCapabilities | undefined {
  return ctx.subagents.getProvider(SPAWN_PROVIDER)?.capabilities
}

export function assertSpawnCapabilities(ctx: Context): SubagentCapabilities {
  const capabilities = spawnCapabilities(ctx)
  if (capabilities === undefined) {
    throw new GeoResearchError('GEORESEARCH_SUBAGENT_CAPABILITY_MISSING', 'spawn provider is unavailable')
  }
  const missing = Object.entries(capabilities)
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new GeoResearchError(
      'GEORESEARCH_SUBAGENT_CAPABILITY_MISSING',
      `spawn provider lacks ${missing.join(', ')}`,
    )
  }
  return capabilities
}

export async function startOneShot(ctx: Context, request: SubagentStartRequest): Promise<SubagentRun> {
  assertSpawnCapabilities(ctx)
  const projectedRequest: SubagentStartRequest = request.outputSchema === undefined
    ? request
    : { ...request, outputSchema: toHarnessObjectSchema(request.outputSchema) }
  return ctx.subagents.start(SPAWN_PROVIDER, projectedRequest)
}

export async function resumeThroughHarness(
  ctx: Context,
  options: ResumeThroughHarnessOptions,
): Promise<AgentHandle> {
  return ctx.agents.resume(options)
}

export function setupCommit(commit: () => void): AgentSetupCommit {
  return { commit }
}

export function toolRestriction(allow: readonly string[]): ToolRestriction {
  return { allow: [...allow] }
}

function projectHarnessSchemaNode(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): Record<string, unknown> {
  const source = schemaRecord(value, path)
  if (ancestors.has(source)) throw new TypeError(`${path} is circular`)
  ancestors.add(source)
  try {
    const projected: Record<string, unknown> = {}
    for (const annotation of HARNESS_SCHEMA_ANNOTATIONS) {
      if (Object.hasOwn(source, annotation)) projected[annotation] = source[annotation]
    }

    if (Array.isArray(source.type)) {
      if (Object.hasOwn(source, 'oneOf')) {
        throw new TypeError(`${path} cannot combine a type union with oneOf`)
      }
      if (source.type.length === 0 || source.type.some(type => !isHarnessSchemaType(type))) {
        throw new TypeError(`${path}.type cannot be projected to the Harness rc.5 subset`)
      }
      if (new Set(source.type).size !== source.type.length) {
        throw new TypeError(`${path}.type must contain unique JSON types`)
      }
      projected.oneOf = source.type.map((type, index) => projectHarnessSchemaNode(
        { ...source, type },
        `${path}.type[${index}]`,
        ancestors,
      ))
      return projected
    }

    if (Object.hasOwn(source, 'oneOf')) {
      const branches = source.oneOf
      if (!Array.isArray(branches) || branches.length < 2) {
        throw new TypeError(`${path}.oneOf must contain at least two schemas`)
      }
      projected.oneOf = branches.map((branch, index) => (
        projectHarnessSchemaNode(branch, `${path}.oneOf[${index}]`, ancestors)
      ))
      return projected
    }

    const type = projectedSchemaType(source, path)
    if (type !== undefined) projected.type = type

    if (type === 'object') {
      if (Object.hasOwn(source, 'properties')) {
        const properties = schemaRecord(source.properties, `${path}.properties`)
        projected.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [
          key,
          projectHarnessSchemaNode(child, `${path}.properties.${key}`, ancestors),
        ]))
      }
      if (Object.hasOwn(source, 'required')) {
        if (!Array.isArray(source.required) || source.required.some(key => typeof key !== 'string')) {
          throw new TypeError(`${path}.required must be an array of strings`)
        }
        projected.required = [...source.required]
      }
      if (Object.hasOwn(source, 'additionalProperties')) {
        if (typeof source.additionalProperties === 'boolean') {
          projected.additionalProperties = source.additionalProperties
        } else {
          schemaRecord(source.additionalProperties, `${path}.additionalProperties`)
          projected.additionalProperties = true
        }
      }
    } else if (type === 'array') {
      if (Object.hasOwn(source, 'items')) {
        projected.items = projectHarnessSchemaNode(source.items, `${path}.items`, ancestors)
      }
      if (Object.hasOwn(source, 'minItems')) projected.minItems = source.minItems
      if (Object.hasOwn(source, 'maxItems')) projected.maxItems = source.maxItems
    } else if (isScalarSchemaType(type)) {
      if (Object.hasOwn(source, 'enum')) projected.enum = source.enum
      if (Object.hasOwn(source, 'const')) projected.const = source.const
    }

    return projected
  } finally {
    ancestors.delete(source)
  }
}

function toHarnessObjectSchema(schema: unknown): ObjectJsonSchema {
  const projected = toHarnessToolSchema(schema)
  assertObjectJsonSchema(projected)
  return projected
}

function projectedSchemaType(source: Record<string, unknown>, path: string): JsonSchemaType | undefined {
  if (Object.hasOwn(source, 'type')) {
    if (!isHarnessSchemaType(source.type)) {
      throw new TypeError(`${path}.type cannot be projected to the Harness rc.5 subset`)
    }
    return source.type
  }
  const structuralType = inferredStructuralType(source, path)
  if (structuralType !== undefined) return structuralType
  if (Object.hasOwn(source, 'const')) return scalarType(source.const, `${path}.const`)
  if (Object.hasOwn(source, 'enum')) return enumType(source.enum, `${path}.enum`)
  return undefined
}

function inferredStructuralType(
  source: Record<string, unknown>,
  path: string,
): 'object' | 'array' | undefined {
  const objectKeywords = ['properties', 'required', 'additionalProperties']
  const hasObjectKeyword = objectKeywords.some(keyword => Object.hasOwn(source, keyword))
  const hasArrayKeyword = ['items', 'minItems', 'maxItems']
    .some(keyword => Object.hasOwn(source, keyword))
  if (hasObjectKeyword && hasArrayKeyword) {
    throw new TypeError(`${path} mixes object and array schema keywords without a type`)
  }
  if (hasObjectKeyword) return 'object'
  if (hasArrayKeyword) return 'array'
  return undefined
}

function enumType(value: unknown, path: string): JsonSchemaType {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path} must be a non-empty array`)
  const types = value.map((entry, index) => scalarType(entry, `${path}[${index}]`))
  const normalized = types.map(type => type === 'integer' ? 'number' : type)
  const first = normalized[0]
  if (first === undefined || normalized.some(type => type !== first)) {
    throw new TypeError(`${path} must contain one scalar JSON type`)
  }
  if (first === 'number' && types.every(type => type === 'integer')) return 'integer'
  return first
}

function scalarType(value: unknown, path: string): Exclude<JsonSchemaType, 'object' | 'array'> {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string': return 'string'
    case 'boolean': return 'boolean'
    case 'number':
      if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${path} is not a JSON number`)
      return Number.isInteger(value) ? 'integer' : 'number'
    default: throw new TypeError(`${path} is not a scalar JSON value`)
  }
}

function isHarnessSchemaType(value: unknown): value is JsonSchemaType {
  return typeof value === 'string' && HARNESS_SCHEMA_TYPES.includes(value as JsonSchemaType)
}

function isScalarSchemaType(
  value: JsonSchemaType | undefined,
): value is Exclude<JsonSchemaType, 'object' | 'array'> {
  return value !== undefined && value !== 'object' && value !== 'array'
}

function schemaRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a schema object`)
  }
  return value as Record<string, unknown>
}
