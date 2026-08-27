import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GeoResearchError,
  canonicalJson,
  digestPhase3Body,
  isSha256Digest,
  type ContinuationAdvanceOutcome,
  type GeoResearchErrorCode,
  type JsonValue,
  type LiteratureContinuationOwner,
  type LiteratureContinuationProviderBinding,
  type LiteratureContinuationRecord,
  type LiteratureContinuationReservation,
  type LiteratureItem,
  type LiteratureProviderTrace,
  type LiteratureSearchChainRecord,
  type LiteratureSearchResult,
  type PaperReadLineage,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import {
  acquireProjectMutex,
  atomicWriteJson,
  projectPaths,
} from '@georesearch/dsh-project-provider-files'

interface CredentialBindingRecord {
  readonly fingerprint: Sha256Digest
  readonly epoch: number
  readonly updatedAt: string
}

interface ExactLiteratureOperation {
  readonly requestDigest: Sha256Digest
  readonly result: LiteratureSearchResult
  readonly resultDigest: Sha256Digest
}

export interface PaperReadReceipt {
  readonly schemaVersion: 1
  readonly readReceiptId: string
  readonly readReceiptDigest: Sha256Digest
  readonly projectBindingId: string
  readonly rootSessionId: string
  readonly operatorScopeId: string
  readonly artifactId: string
  readonly artifactDigest: Sha256Digest
  readonly pageCount: number
  readonly pageStart: number
  readonly pageEnd: number
  readonly pageTextDigests: Readonly<Record<string, Sha256Digest>>
  readonly lineage: PaperReadLineage
  readonly createdAt: string
}

interface EvidenceStoreFile {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly revision: number
  readonly chains: Readonly<Record<string, LiteratureSearchChainRecord>>
  readonly continuations: Readonly<Record<string, LiteratureContinuationRecord>>
  readonly outcomes: Readonly<Record<string, ContinuationAdvanceOutcome>>
  readonly credentialBindings: Readonly<Record<string, CredentialBindingRecord>>
  readonly initialOperations: Readonly<Record<string, ExactLiteratureOperation>>
  readonly paperReadReceipts: Readonly<Record<string, PaperReadReceipt>>
  readonly updatedAt: string
  readonly digest: Sha256Digest
}

export interface ContinuationStoreConfig {
  readonly home: string
  readonly lockTimeoutMs?: number
  readonly reservationLeaseMs?: number
  readonly now?: () => string
  readonly nonce?: () => string
}

export interface InitialSearchCommit {
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly chain: LiteratureSearchChainRecord
  readonly continuation?: LiteratureContinuationRecord
  readonly result: LiteratureSearchResult
}

export type ReservationResult =
  | { readonly kind: 'reserved'; readonly continuation: LiteratureContinuationRecord; readonly reservation: LiteratureContinuationReservation }
  | { readonly kind: 'replay'; readonly result: LiteratureSearchResult }
  | { readonly kind: 'same-operation-in-progress'; readonly reservation: LiteratureContinuationReservation }

export interface ContinuationRecoveryReport {
  readonly projectId: string
  readonly completedOutcomeIds: readonly Sha256Digest[]
  readonly pendingReplayContinuationDigests: readonly Sha256Digest[]
}

export interface LiteratureSourceMaterial {
  readonly chain: LiteratureSearchChainRecord
  readonly item: LiteratureItem
  readonly generation: number
  readonly providerTrace: LiteratureProviderTrace
}

const STORE_SCHEMA_VERSION = 1
const WRITE_TAILS = new Map<string, Promise<void>>()

export class ContinuationFileStore {
  private readonly home: string
  private readonly lockTimeoutMs: number
  private readonly reservationLeaseMs: number
  private readonly clock: () => string
  private readonly randomNonce: () => string

  constructor(config: ContinuationStoreConfig) {
    this.home = config.home
    this.lockTimeoutMs = config.lockTimeoutMs ?? 2_000
    this.reservationLeaseMs = config.reservationLeaseMs ?? 30_000
    this.clock = config.now ?? (() => new Date().toISOString())
    this.randomNonce = config.nonce ?? (() => randomBytes(32).toString('base64url'))
  }

  async bindCredential(
    projectId: string,
    providerId: string,
    credentialRef: string | null,
    fingerprint: Sha256Digest | null,
  ): Promise<{ readonly epoch: number; readonly changed: boolean }> {
    if (credentialRef === null) return { epoch: 0, changed: false }
    if (fingerprint === null) throw new TypeError('credential fingerprint is required for a credentialRef')
    const key = credentialBindingKey(providerId, credentialRef)
    return this.transaction(projectId, state => {
      const existing = state.credentialBindings[key]
      if (existing?.fingerprint === fingerprint) {
        return { next: state, result: { epoch: existing.epoch, changed: false } }
      }
      const epoch = (existing?.epoch ?? 0) + 1
      return {
        next: {
          ...state,
          credentialBindings: {
            ...state.credentialBindings,
            [key]: { fingerprint, epoch, updatedAt: this.clock() },
          },
        },
        result: { epoch, changed: existing !== undefined },
      }
    })
  }

  async initialReplay(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
  ): Promise<LiteratureSearchResult | undefined> {
    const state = await this.load(projectId)
    const existing = state.initialOperations[operationKey]
    if (existing === undefined) return undefined
    if (existing.requestDigest !== requestDigest) {
      throw new GeoResearchError('IDEMPOTENCY_CONFLICT', 'initial literature operation request digest changed')
    }
    return existing.result
  }

  commitInitial(projectId: string, input: InitialSearchCommit): Promise<LiteratureSearchResult> {
    return this.transaction(projectId, state => {
      const existing = state.initialOperations[input.operationKey]
      if (existing !== undefined) {
        if (existing.requestDigest !== input.requestDigest) {
          throw new GeoResearchError('IDEMPOTENCY_CONFLICT', 'initial literature operation request digest changed')
        }
        return { next: state, result: existing.result }
      }
      if (state.chains[input.chain.chainId] !== undefined) {
        throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', `search chain ${input.chain.chainId} already exists`)
      }
      const continuations = { ...state.continuations }
      if (input.continuation !== undefined) {
        const key = input.continuation.continuationIdDigest
        if (continuations[key] !== undefined) {
          throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', 'initial continuation identity already exists')
        }
        continuations[key] = input.continuation
      }
      return {
        next: {
          ...state,
          chains: { ...state.chains, [input.chain.chainId]: input.chain },
          continuations,
          initialOperations: {
            ...state.initialOperations,
            [input.operationKey]: {
              requestDigest: input.requestDigest,
              result: input.result,
              resultDigest: digestPhase3Body(input.result),
            },
          },
        },
        result: input.result,
      }
    })
  }

  reserve(
    projectId: string,
    continuationId: string,
    owner: LiteratureContinuationOwner,
    providerBinding: LiteratureContinuationProviderBinding,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
  ): Promise<ReservationResult> {
    const continuationIdDigest = continuationDigest(continuationId)
    return this.transaction<ReservationResult | StoredFailure>(projectId, state => {
      let next = state
      let current = state.continuations[continuationIdDigest]
      if (current === undefined) {
        throw new GeoResearchError('LITERATURE_CONTINUATION_NOT_FOUND', 'continuation token is unknown')
      }
      const now = this.clock()
      if (new Date(current.expiresAt).getTime() <= new Date(now).getTime() && current.state !== 'consumed') {
        current = { ...current, state: 'expired', updatedAt: now }
        next = replaceContinuation(state, current)
        return failure(next, 'LITERATURE_CONTINUATION_EXPIRED', 'continuation token has expired')
      }
      if (!sameOwner(current.owner, owner)) {
        return failure(state, 'LITERATURE_CONTINUATION_OWNER_MISMATCH', 'continuation owner scope does not match')
      }
      if (!sameProviderCompatibility(current.providerBinding, providerBinding)) {
        current = {
          ...current,
          state: 'revoked',
          revocationCode: 'LITERATURE_PROVIDER_INCOMPATIBLE',
          updatedAt: this.clock(),
        }
        return failure(
          replaceContinuation(state, current),
          'LITERATURE_PROVIDER_INCOMPATIBLE',
          'continuation provider is no longer compatible',
        )
      }
      if (current.providerBinding.credentialBindingEpoch !== providerBinding.credentialBindingEpoch) {
        current = {
          ...current,
          state: 'revoked',
          revocationCode: 'LITERATURE_CONTINUATION_CREDENTIAL_BINDING_CHANGED',
          updatedAt: this.clock(),
        }
        return failure(
          replaceContinuation(state, current),
          'LITERATURE_CONTINUATION_CREDENTIAL_BINDING_CHANGED',
          'credential binding changed after the continuation was issued',
        )
      }
      if (current.state === 'consumed') {
        if (current.exactResult === undefined || current.exactResultDigest !== digestPhase3Body(current.exactResult)) {
          throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', 'consumed continuation exact result is invalid')
        }
        return { next: state, result: { kind: 'replay', result: current.exactResult } }
      }
      if (current.state === 'expired') {
        return failure(state, 'LITERATURE_CONTINUATION_EXPIRED', 'continuation token has expired')
      }
      if (current.state === 'revoked') {
        return failure(state, 'LITERATURE_CONTINUATION_REVOKED', 'continuation token has been revoked')
      }
      if (current.state === 'reserved') {
        const reservation = requireReservation(current)
        if (!leaseExpired(reservation, now)) {
          if (reservation.operationKey === operationKey && reservation.requestDigest === requestDigest) {
            return { next: state, result: { kind: 'same-operation-in-progress', reservation } }
          }
          return failure(state, 'LITERATURE_CONTINUATION_IN_USE', 'continuation token is reserved by another operation')
        }
      }
      if (current.state === 'dispatched-unknown') {
        const reservation = requireReservation(current)
        const outcome = Object.values(state.outcomes).find(candidate => (
          candidate.continuationIdDigest === current?.continuationIdDigest
          && candidate.reservationEpoch === reservation.reservationEpoch
          && candidate.fence === reservation.fence
          && candidate.operationKey === reservation.operationKey
        ))
        if (outcome !== undefined) {
          next = consumeOutcomeInState(state, current, outcome, this.clock())
          const consumed = next.continuations[continuationIdDigest]
          if (consumed?.exactResult === undefined) {
            throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', 'outcome recovery did not produce an exact result')
          }
          return { next, result: { kind: 'replay', result: consumed.exactResult } }
        }
        if (!leaseExpired(reservation, now)) {
          if (reservation.operationKey === operationKey && reservation.requestDigest === requestDigest) {
            return { next: state, result: { kind: 'same-operation-in-progress', reservation } }
          }
          return failure(
            state,
            'LITERATURE_CONTINUATION_IN_USE',
            'continuation has an unresolved dispatched operation',
          )
        }
        operationKey = reservation.operationKey
        requestDigest = reservation.requestDigest
      }
      const reservation = this.newReservation(current, operationKey, requestDigest, now)
      current = {
        ...current,
        state: 'reserved',
        reservationEpoch: reservation.reservationEpoch,
        reservation,
        updatedAt: now,
      }
      return {
        next: replaceContinuation(next, current),
        result: { kind: 'reserved', continuation: current, reservation },
      }
    }).then(throwStoredFailure)
  }

  markDispatched(
    projectId: string,
    continuationIdDigest: Sha256Digest,
    reservation: LiteratureContinuationReservation,
  ): Promise<LiteratureContinuationRecord> {
    return this.transaction(projectId, state => {
      const current = state.continuations[continuationIdDigest]
      assertReservation(current, reservation, 'reserved')
      const dispatched: LiteratureContinuationRecord = {
        ...current,
        state: 'dispatched-unknown',
        updatedAt: this.clock(),
      }
      return { next: replaceContinuation(state, dispatched), result: dispatched }
    })
  }

  releaseUndispatched(
    projectId: string,
    continuationIdDigest: Sha256Digest,
    reservation: LiteratureContinuationReservation,
  ): Promise<void> {
    return this.transaction(projectId, state => {
      const current = state.continuations[continuationIdDigest]
      assertReservation(current, reservation, 'reserved')
      const { reservation: _reservation, ...withoutReservation } = current
      return {
        next: replaceContinuation(state, {
          ...withoutReservation,
          state: 'active',
          updatedAt: this.clock(),
        }),
        result: undefined,
      }
    })
  }

  recordOutcome(projectId: string, outcome: ContinuationAdvanceOutcome): Promise<void> {
    return this.transaction(projectId, state => {
      const current = state.continuations[outcome.continuationIdDigest]
      assertOutcomeMatches(current, outcome)
      const existing = state.outcomes[outcome.advanceId]
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(outcome)) {
          throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', `advance outcome ${outcome.advanceId} changed`)
        }
        return { next: state, result: undefined }
      }
      return {
        next: { ...state, outcomes: { ...state.outcomes, [outcome.advanceId]: outcome } },
        result: undefined,
      }
    })
  }

  consumeOutcome(projectId: string, advanceId: Sha256Digest): Promise<LiteratureSearchResult> {
    return this.transaction(projectId, state => {
      const outcome = state.outcomes[advanceId]
      if (outcome === undefined) throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', 'advance outcome is missing')
      const current = state.continuations[outcome.continuationIdDigest]
      if (current?.state === 'consumed') {
        if (current.exactResult === undefined) {
          throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', 'consumed continuation result is missing')
        }
        return { next: state, result: current.exactResult }
      }
      assertOutcomeMatches(current, outcome)
      const next = consumeOutcomeInState(state, current, outcome, this.clock())
      return { next, result: outcome.exactResult }
    })
  }

  revoke(
    projectId: string,
    continuationIdDigest: Sha256Digest,
    code: string,
  ): Promise<void> {
    return this.transaction(projectId, state => {
      const current = state.continuations[continuationIdDigest]
      if (current === undefined || current.state === 'consumed') return { next: state, result: undefined }
      return {
        next: replaceContinuation(state, {
          ...current,
          state: 'revoked',
          revocationCode: code,
          updatedAt: this.clock(),
        }),
        result: undefined,
      }
    })
  }

  async chain(
    projectId: string,
    chainId: string,
    owner?: LiteratureContinuationOwner,
  ): Promise<LiteratureSearchChainRecord> {
    const chain = (await this.load(projectId)).chains[chainId]
    if (chain === undefined) throw new GeoResearchError('SOURCE_NOT_FOUND', `search chain ${chainId} is unknown`)
    if (owner !== undefined && !sameOwner(chain.owner, owner)) {
      throw new GeoResearchError('LITERATURE_CONTINUATION_OWNER_MISMATCH', 'search chain owner scope does not match')
    }
    return chain
  }

  async sourceMaterial(
    projectId: string,
    chainId: string,
    generation: number,
    providerItemId: string,
    owner: LiteratureContinuationOwner,
  ): Promise<LiteratureSourceMaterial> {
    const state = await this.load(projectId)
    const chain = state.chains[chainId]
    if (chain === undefined) throw new GeoResearchError('SOURCE_NOT_FOUND', `search chain ${chainId} is unknown`)
    if (!sameOwner(chain.owner, owner)) {
      throw new GeoResearchError('LITERATURE_CONTINUATION_OWNER_MISMATCH', 'search chain owner scope does not match')
    }
    const exactResults = [
      ...Object.values(state.initialOperations).map(operation => operation.result),
      ...Object.values(state.outcomes).map(outcome => outcome.exactResult),
    ]
    const result = exactResults.find(candidate => (
      candidate.searchChainTrace.chainId === chainId
      && candidate.searchChainTrace.generation === generation
      && candidate.items.some(item => item.providerItemId === providerItemId)
    ))
    const item = result?.items.find(candidate => candidate.providerItemId === providerItemId)
    if (result === undefined || item === undefined) {
      throw new GeoResearchError(
        'SOURCE_NOT_FOUND',
        `provider item ${providerItemId} was not returned by chain ${chainId} generation ${generation}`,
      )
    }
    return { chain, item, generation, providerTrace: result.providerTrace }
  }

  savePaperReadReceipt(projectId: string, receipt: PaperReadReceipt): Promise<PaperReadReceipt> {
    return this.transaction(projectId, state => {
      const existing = state.paperReadReceipts[receipt.readReceiptId]
      if (existing !== undefined) {
        if (existing.readReceiptDigest !== receipt.readReceiptDigest) {
          throw new GeoResearchError('EVIDENCE_READ_RECEIPT_MISMATCH', 'paper read receipt identity changed')
        }
        return { next: state, result: existing }
      }
      return {
        next: {
          ...state,
          paperReadReceipts: { ...state.paperReadReceipts, [receipt.readReceiptId]: receipt },
        },
        result: receipt,
      }
    })
  }

  async paperReadReceipt(projectId: string, readReceiptId: string): Promise<PaperReadReceipt> {
    const receipt = (await this.load(projectId)).paperReadReceipts[readReceiptId]
    if (receipt === undefined) {
      throw new GeoResearchError('EVIDENCE_READ_RECEIPT_NOT_FOUND', `paper read receipt ${readReceiptId} is unknown`)
    }
    return receipt
  }

  recover(projectId: string): Promise<ContinuationRecoveryReport> {
    return this.transaction(projectId, state => {
      let next = state
      const completed: Sha256Digest[] = []
      const pending: Sha256Digest[] = []
      for (const continuation of Object.values(state.continuations)) {
        if (continuation.state !== 'dispatched-unknown') continue
        const reservation = requireReservation(continuation)
        const outcome = Object.values(state.outcomes).find(candidate => (
          candidate.continuationIdDigest === continuation.continuationIdDigest
          && candidate.reservationEpoch === reservation.reservationEpoch
          && candidate.fence === reservation.fence
          && candidate.operationKey === reservation.operationKey
        ))
        if (outcome === undefined) {
          pending.push(continuation.continuationIdDigest)
          continue
        }
        next = consumeOutcomeInState(next, continuation, outcome, this.clock())
        completed.push(outcome.advanceId)
      }
      return {
        next,
        result: {
          projectId,
          completedOutcomeIds: completed.sort(),
          pendingReplayContinuationDigests: pending.sort(),
        },
      }
    })
  }

  reserveRecovery(
    projectId: string,
    continuationIdDigest: Sha256Digest,
    force = false,
  ): Promise<{ readonly continuation: LiteratureContinuationRecord; readonly reservation: LiteratureContinuationReservation } | undefined> {
    return this.transaction(projectId, state => {
      const current = state.continuations[continuationIdDigest]
      if (current === undefined || current.state !== 'dispatched-unknown') {
        return { next: state, result: undefined }
      }
      const prior = requireReservation(current)
      if (Object.values(state.outcomes).some(outcome => (
        outcome.continuationIdDigest === continuationIdDigest
        && outcome.reservationEpoch === prior.reservationEpoch
        && outcome.fence === prior.fence
        && outcome.operationKey === prior.operationKey
      ))) {
        return { next: state, result: undefined }
      }
      const now = this.clock()
      if (!force && !leaseExpired(prior, now)) return { next: state, result: undefined }
      if (new Date(current.expiresAt).getTime() <= new Date(now).getTime()) {
        const expired: LiteratureContinuationRecord = { ...current, state: 'expired', updatedAt: now }
        return { next: replaceContinuation(state, expired), result: undefined }
      }
      const reservation = this.newReservation(current, prior.operationKey, prior.requestDigest, now)
      const reserved: LiteratureContinuationRecord = {
        ...current,
        state: 'reserved',
        reservationEpoch: reservation.reservationEpoch,
        reservation,
        updatedAt: now,
      }
      return {
        next: replaceContinuation(state, reserved),
        result: { continuation: reserved, reservation },
      }
    })
  }

  private async load(projectId: string): Promise<EvidenceStoreFile> {
    const path = storePath(this.home, projectId)
    try {
      return parseStore(JSON.parse(await readFile(path, 'utf8')) as unknown, projectId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore(projectId, this.clock())
      throw error
    }
  }

  private transaction<T>(
    projectId: string,
    action: (state: EvidenceStoreFile) => {
      readonly next: EvidenceStoreFile
      readonly result: T
    },
  ): Promise<T> {
    return this.serial(projectId, async () => {
      const mutex = await acquireProjectMutex(projectId, this.lockTimeoutMs)
      try {
        const current = await this.load(projectId)
        const decision = action(current)
        const result = decision.result
        if (decision.next !== current) {
          const path = storePath(this.home, projectId)
          await mkdir(join(projectPaths(this.home, projectId).continuations), { recursive: true })
          await atomicWriteJson(path, finalizeStore(decision.next, current.revision + 1, this.clock()))
        }
        return result
      } finally {
        await mutex.release()
      }
    })
  }

  private serial<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const key = `${this.home.toLowerCase()}\0${projectId}`
    const previous = WRITE_TAILS.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    WRITE_TAILS.set(key, tail)
    return previous.catch(() => undefined).then(action).finally(() => {
      release()
      if (WRITE_TAILS.get(key) === tail) WRITE_TAILS.delete(key)
    })
  }

  private newReservation(
    continuation: LiteratureContinuationRecord,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    reservedAt: string,
  ): LiteratureContinuationReservation {
    const reservationEpoch = continuation.reservationEpoch + 1
    return {
      operationKey,
      requestDigest,
      reservationEpoch,
      fence: digestPhase3Body({
        domain: 'georesearch.continuation-fence/v1',
        continuationIdDigest: continuation.continuationIdDigest,
        reservationEpoch,
        operationKey,
        nonce: this.randomNonce(),
      }),
      reservedAt,
      leaseExpiresAt: new Date(new Date(reservedAt).getTime() + this.reservationLeaseMs).toISOString(),
    }
  }
}

interface StoredFailure {
  readonly kind: 'failure'
  readonly code: GeoResearchErrorCode
  readonly message: string
}

function failure(
  next: EvidenceStoreFile,
  code: import('@georesearch/dsh-contracts').GeoResearchErrorCode,
  message: string,
): { readonly next: EvidenceStoreFile; readonly result: StoredFailure } {
  return { next, result: { kind: 'failure', code, message } }
}

function throwStoredFailure(value: ReservationResult | StoredFailure): ReservationResult {
  if (value.kind === 'failure') throw new GeoResearchError(value.code, value.message)
  return value
}

function replaceContinuation(state: EvidenceStoreFile, continuation: LiteratureContinuationRecord): EvidenceStoreFile {
  return {
    ...state,
    continuations: {
      ...state.continuations,
      [continuation.continuationIdDigest]: continuation,
    },
  }
}

function consumeOutcomeInState(
  state: EvidenceStoreFile,
  current: LiteratureContinuationRecord,
  outcome: ContinuationAdvanceOutcome,
  now: string,
): EvidenceStoreFile {
  assertOutcomeMatches(current, outcome)
  if (outcome.exactResultDigest !== digestPhase3Body(outcome.exactResult)) {
    throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', 'advance outcome exact result digest is invalid')
  }
  const chain = state.chains[current.chainId]
  if (chain === undefined) throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', 'search chain is missing')
  const seen = new Set(chain.seenProviderItemIds)
  const itemsByProviderId = { ...chain.itemsByProviderId }
  for (const item of outcome.exactResult.items) {
    seen.add(item.providerItemId)
    itemsByProviderId[item.providerItemId] = item
  }
  const updatedChain: LiteratureSearchChainRecord = {
    ...chain,
    pagesAdvanced: chain.pagesAdvanced + outcome.upstreamPagesAdvanced,
    uniqueItemCount: seen.size,
    seenProviderItemIds: [...seen].sort(),
    itemsByProviderId,
    updatedAt: now,
  }
  const consumed: LiteratureContinuationRecord = {
    ...current,
    state: 'consumed',
    exactResult: outcome.exactResult,
    exactResultDigest: outcome.exactResultDigest,
    consumedOutcome: outcome.advanceId,
    updatedAt: now,
  }
  const continuations = { ...state.continuations, [current.continuationIdDigest]: consumed }
  if (outcome.successor !== undefined) {
    if (outcome.successor.generation !== current.generation + 1) {
      throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', 'successor generation is not monotonic')
    }
    if (continuations[outcome.successor.continuationIdDigest] !== undefined) {
      throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', 'successor continuation already exists')
    }
    continuations[outcome.successor.continuationIdDigest] = {
      schemaVersion: 1,
      continuationIdDigest: outcome.successor.continuationIdDigest,
      chainId: current.chainId,
      generation: outcome.successor.generation,
      state: 'active',
      owner: current.owner,
      providerBinding: current.providerBinding,
      encryptedUpstreamState: outcome.successor.encryptedUpstreamState,
      upstreamStateDigest: outcome.successor.upstreamStateDigest,
      expiresAt: outcome.successor.expiresAt,
      createdAt: now,
      updatedAt: now,
      reservationEpoch: 0,
    }
  }
  return {
    ...state,
    chains: { ...state.chains, [chain.chainId]: updatedChain },
    continuations,
  }
}

function assertReservation(
  continuation: LiteratureContinuationRecord | undefined,
  reservation: LiteratureContinuationReservation,
  expectedState: 'reserved' | 'dispatched-unknown',
): asserts continuation is LiteratureContinuationRecord {
  if (continuation === undefined || continuation.state !== expectedState) {
    throw new GeoResearchError('LITERATURE_CONTINUATION_IN_USE', `continuation is not ${expectedState}`)
  }
  const current = requireReservation(continuation)
  if (current.reservationEpoch !== reservation.reservationEpoch
    || current.fence !== reservation.fence
    || current.operationKey !== reservation.operationKey
    || current.requestDigest !== reservation.requestDigest) {
    throw new GeoResearchError('LITERATURE_CONTINUATION_IN_USE', 'continuation reservation fence is stale')
  }
}

function assertOutcomeMatches(
  continuation: LiteratureContinuationRecord | undefined,
  outcome: ContinuationAdvanceOutcome,
): asserts continuation is LiteratureContinuationRecord {
  if (continuation === undefined || continuation.state !== 'dispatched-unknown') {
    throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', 'continuation is not dispatched-unknown')
  }
  const reservation = requireReservation(continuation)
  if (outcome.chainId !== continuation.chainId
    || outcome.generation !== continuation.generation
    || outcome.reservationEpoch !== reservation.reservationEpoch
    || outcome.fence !== reservation.fence
    || outcome.operationKey !== reservation.operationKey
    || outcome.requestDigest !== reservation.requestDigest
    || outcome.providerId !== continuation.providerBinding.providerId
    || outcome.providerVersion !== continuation.providerBinding.providerVersion
    || outcome.credentialBindingEpoch !== continuation.providerBinding.credentialBindingEpoch) {
    throw new GeoResearchError('LITERATURE_OUTCOME_CONFLICT', 'advance outcome does not match the current fence')
  }
}

function requireReservation(continuation: LiteratureContinuationRecord): LiteratureContinuationReservation {
  if (continuation.reservation === undefined) {
    throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', 'continuation reservation is missing')
  }
  return continuation.reservation
}

function sameOwner(left: LiteratureContinuationOwner, right: LiteratureContinuationOwner): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function sameProviderCompatibility(
  left: LiteratureContinuationProviderBinding,
  right: LiteratureContinuationProviderBinding,
): boolean {
  return left.providerId === right.providerId
    && left.providerVersion === right.providerVersion
    && left.continuationFormatDigest === right.continuationFormatDigest
    && left.credentialRef === right.credentialRef
}

function leaseExpired(reservation: LiteratureContinuationReservation, now: string): boolean {
  return new Date(reservation.leaseExpiresAt).getTime() <= new Date(now).getTime()
}

export function continuationDigest(continuationId: string): Sha256Digest {
  return digestPhase3Body({ domain: 'georesearch.continuation-id/v1', continuationId })
}

export function continuationStateBinding(
  continuationIdDigest: Sha256Digest,
  chainId: string,
  generation: number,
  owner: LiteratureContinuationOwner,
  providerBinding: LiteratureContinuationProviderBinding,
): JsonValue {
  return {
    domain: 'georesearch.continuation-state/v1',
    continuationIdDigest,
    chainId,
    generation,
    owner: owner as unknown as JsonValue,
    providerBinding: providerBinding as unknown as JsonValue,
  }
}

function credentialBindingKey(providerId: string, credentialRef: string): string {
  return Buffer.from(`${providerId}\0${credentialRef}`, 'utf8').toString('base64url')
}

function storePath(home: string, projectId: string): string {
  return join(projectPaths(home, projectId).continuations, 'store.json')
}

function emptyStore(projectId: string, now: string): EvidenceStoreFile {
  return finalizeStore({
    schemaVersion: 1,
    projectId,
    revision: 0,
    chains: {},
    continuations: {},
    outcomes: {},
    credentialBindings: {},
    initialOperations: {},
    paperReadReceipts: {},
    updatedAt: now,
    digest: digestPhase3Body({ empty: true }),
  }, 0, now)
}

function finalizeStore(state: EvidenceStoreFile, revision: number, updatedAt: string): EvidenceStoreFile {
  const body = {
    schemaVersion: STORE_SCHEMA_VERSION as 1,
    projectId: state.projectId,
    revision,
    chains: state.chains,
    continuations: state.continuations,
    outcomes: state.outcomes,
    credentialBindings: state.credentialBindings,
    initialOperations: state.initialOperations,
    paperReadReceipts: state.paperReadReceipts,
    updatedAt,
  }
  return { ...body, digest: digestPhase3Body(body) }
}

function parseStore(value: unknown, projectId: string): EvidenceStoreFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', 'continuation store must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || record.projectId !== projectId
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || typeof record.updatedAt !== 'string' || !isSha256Digest(record.digest)) {
    throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', 'continuation store header is invalid')
  }
  for (const field of [
    'chains', 'continuations', 'outcomes', 'credentialBindings',
    'initialOperations', 'paperReadReceipts',
  ]) {
    const child = record[field]
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', `continuation store ${field} is invalid`)
    }
  }
  const body = {
    schemaVersion: 1 as const,
    projectId,
    revision: record.revision as number,
    chains: record.chains as EvidenceStoreFile['chains'],
    continuations: record.continuations as EvidenceStoreFile['continuations'],
    outcomes: record.outcomes as EvidenceStoreFile['outcomes'],
    credentialBindings: record.credentialBindings as EvidenceStoreFile['credentialBindings'],
    initialOperations: record.initialOperations as EvidenceStoreFile['initialOperations'],
    paperReadReceipts: record.paperReadReceipts as EvidenceStoreFile['paperReadReceipts'],
    updatedAt: record.updatedAt,
  }
  if (digestPhase3Body(body) !== record.digest) {
    throw new GeoResearchError('LITERATURE_CONTINUATION_RECOVERY_REQUIRED', 'continuation store digest is invalid')
  }
  return { ...body, digest: record.digest }
}
