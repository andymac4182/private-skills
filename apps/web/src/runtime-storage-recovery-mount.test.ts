import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Digest,
  RecoverableBlobStore,
  RegistryState,
  StateRepository,
  StorageAttempt,
  StorageObjectInspection,
  StoredBlob,
} from '../../../packages/contracts/src/index.js'
import { createMemoryStateRepository, defaultRegistryState } from '../../../packages/database/src/index.js'
import {
  BillingService,
  createMemoryBillingRepository,
} from '../../../packages/billing/src/index.js'
import {
  createDurableStorageRecoveryProofVerifier,
  digestBytes,
  StorageRecoveryService,
} from '../../../packages/storage/src/index.js'

const infrastructure = vi.hoisted(() => ({
  createInfrastructure: vi.fn(),
}))

vi.mock('#pskills-infrastructure', () => infrastructure)

import { handleRegistryRequest } from '../server/runtime.js'

const ORGANIZATION = 'runtime-storage-org'
const OPERATOR_TOKEN = 'storage-recovery-secret'
const KEY = 'sealed/runtime-recovery-object'
const BYTES = new TextEncoder().encode('runtime recovery bytes')

class MemoryRecoverableBlobStore implements RecoverableBlobStore {
  readonly objects = new Map<string, Uint8Array>()
  removeCalls = 0
  inspectUnknown = false

  allocateObjectKey(): string {
    return KEY
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    return this.putAtKey(KEY, bytes)
  }

  async putAtKey(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    const digest = await digestBytes(bytes)
    this.objects.set(key, bytes.slice())
    return { key, digest, size: bytes.byteLength }
  }

  async confirmWriteTerminated(): Promise<boolean> {
    return true
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key)
    if (!bytes) throw new Error('not found')
    return bytes.slice()
  }

  async remove(key: string): Promise<void> {
    this.removeCalls += 1
    this.objects.delete(key)
  }

  async inspectObject(key: string): Promise<StorageObjectInspection> {
    if (this.inspectUnknown) return { state: 'unknown', key, reason: 'provider-error' }
    const bytes = this.objects.get(key)
    if (!bytes) return { state: 'absent', key }
    return { state: 'present', key, digest: await digestBytes(bytes), size: bytes.byteLength }
  }
}

function attempt(overrides: Partial<StorageAttempt> = {}): StorageAttempt {
  return {
    id: 'runtime-attempt-1',
    organizationId: ORGANIZATION,
    reservationKey: 'private-skills:runtime-storage:runtime-attempt-1',
    digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as Digest,
    size: BYTES.byteLength,
    state: 'orphaned',
    reservationGeneration: 1,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    objectKey: KEY,
    ...overrides,
  }
}

async function runtimeFixture(candidate: StorageAttempt = attempt()) {
  const digest = await digestBytes(BYTES)
  const state = seededState(candidate, digest)
  const repository = createMemoryStateRepository({ initial: { [ORGANIZATION]: state } })
  const blobs = new MemoryRecoverableBlobStore()
  blobs.objects.set(KEY, BYTES.slice())
  const billing = new BillingService({ repository: createMemoryBillingRepository(), enabled: true })
  await billing.reserveUsage(ORGANIZATION, { storageBytes: BYTES.byteLength }, candidate.reservationKey)
  const storageRecovery = new StorageRecoveryService({
    repository,
    blobs,
    billing,
    verifyProof: createDurableStorageRecoveryProofVerifier(repository),
  })
  return { repository, blobs, billing, storageRecovery }
}

function seededState(candidate: StorageAttempt, digest: Digest): RegistryState {
  const state = defaultRegistryState({ production: false, allowUnscanned: true })
  state.storageAttempts = [{ ...candidate, digest }]
  return state
}

async function runtimeFixtureWithRepository(candidate: StorageAttempt, repository: StateRepository) {
  const digest = await digestBytes(BYTES)
  const blobs = new MemoryRecoverableBlobStore()
  blobs.objects.set(KEY, BYTES.slice())
  const billing = new BillingService({ repository: createMemoryBillingRepository(), enabled: true })
  await billing.reserveUsage(ORGANIZATION, { storageBytes: BYTES.byteLength }, candidate.reservationKey)
  const storageRecovery = new StorageRecoveryService({
    repository,
    blobs,
    billing,
    verifyProof: createDurableStorageRecoveryProofVerifier(repository),
  })
  return { repository, blobs, billing, storageRecovery, digest }
}

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PSKILLS_ENVIRONMENT: 'test',
    PSKILLS_PUBLIC_ORIGIN: 'http://localhost:5173',
    PSKILLS_SESSION_SECRET: 'runtime-storage-session-secret-1234567890',
    PSKILLS_STORAGE_RECOVERY_TOKEN: OPERATOR_TOKEN,
    PSKILLS_STORAGE_RECOVERY_TOKEN_ID: 'runtime-storage-recovery-operator',
    PSKILLS_STORAGE_RECOVERY_ORGANIZATION_ID: ORGANIZATION,
    PSKILLS_STORAGE_RECOVERY_SUBJECT: 'runtime-storage-operator',
    ...overrides,
  }
}

function fakeInfrastructure(fixture: {
  repository: StateRepository
  blobs: MemoryRecoverableBlobStore
  billing: BillingService
  storageRecovery: StorageRecoveryService
}) {
  return {
    repository: fixture.repository,
    blobs: fixture.blobs,
    billing: { service: fixture.billing },
    storageRecovery: fixture.storageRecovery,
    directoryTokenProvider: async () => 'directory-token',
    directoryOfficialTokenProvider: async () => 'directory-token',
    directoryOfficialAvailable: false,
    createSearchIndex: () => ({}),
  }
}

describe('Nitro storage recovery route mount', () => {
  beforeEach(() => {
    infrastructure.createInfrastructure.mockReset()
  })

  it('runs the mounted operator route through the durable repository and provider', async () => {
    const fixture = await runtimeFixture()
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure(fixture))
    const response = await handleRegistryRequest(
      new Request('http://localhost:5173/internal/storage/recovery', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${OPERATOR_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ attemptId: 'runtime-attempt-1', cleanupConfirmed: true }),
      }),
      environment(),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      protocolVersion: 1,
      recovery: { status: 'released', inspection: 'deleted', billing: 'reconciled' },
    })
    expect(fixture.blobs.removeCalls).toBe(1)
    expect((await fixture.repository.read(ORGANIZATION)).storageAttempts?.[0]).toMatchObject({ state: 'released', objectKey: KEY })
    await expect(fixture.billing.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({ usage: { storageBytes: 0 } })
  })

  it.each(['tenant-token', 'admin-token', 'ordinary-worker-token'])('denies a non-dedicated credential: %s', async (token) => {
    const fixture = await runtimeFixture()
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure(fixture))
    const response = await handleRegistryRequest(
      new Request('http://localhost:5173/internal/storage/recovery', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'runtime-attempt-1', cleanupConfirmed: true }),
      }),
      environment({
        PSKILLS_BOOTSTRAP_TOKEN: 'tenant-token',
        PSKILLS_BOOTSTRAP_ROLES: 'owner',
        PSKILLS_WORKER_TOKEN: 'ordinary-worker-token',
      }),
    )

    expect(response.status).toBe(403)
    expect(fixture.blobs.removeCalls).toBe(0)
    expect((await fixture.repository.read(ORGANIZATION)).storageAttempts?.[0]?.state).toBe('orphaned')
  })

  it('rejects caller supplied proof or tenant fields before touching the recoverer', async () => {
    const fixture = await runtimeFixture()
    const recover = vi.spyOn(fixture.storageRecovery, 'recover')
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure(fixture))
    const response = await handleRegistryRequest(
      new Request('http://localhost:5173/internal/storage/recovery', {
        method: 'POST',
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          attemptId: 'runtime-attempt-1',
          organizationId: 'attacker-org',
          proof: { kind: 'known-failure', reference: 'attacker-assertion' },
        }),
      }),
      environment(),
    )

    expect(response.status).toBe(400)
    expect(recover).not.toHaveBeenCalled()
    expect(fixture.blobs.removeCalls).toBe(0)
  })

  it('keeps a still-pending writer charged until a durable orphaned transition exists', async () => {
    const fixture = await runtimeFixture(attempt({ state: 'pending' }))
    fixture.blobs.objects.clear()
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure(fixture))
    const response = await handleRegistryRequest(
      new Request('http://localhost:5173/internal/storage/recovery', {
        method: 'POST',
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'runtime-attempt-1' }),
      }),
      environment(),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ recovery: { status: 'retained', reason: 'proof-rejected', attempt: { state: 'pending' } } })
    expect(fixture.blobs.removeCalls).toBe(0)
    await expect(fixture.billing.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({ usage: { storageBytes: BYTES.byteLength } })
  })

  it('keeps the charge when provider inspection is unknown', async () => {
    const fixture = await runtimeFixture()
    fixture.blobs.inspectUnknown = true
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure(fixture))
    const response = await handleRegistryRequest(
      new Request('http://localhost:5173/internal/storage/recovery', {
        method: 'POST',
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'runtime-attempt-1' }),
      }),
      environment(),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ recovery: { status: 'retained', reason: 'provider-unknown' } })
    expect(fixture.blobs.removeCalls).toBe(0)
    await expect(fixture.billing.usageSnapshot(ORGANIZATION)).resolves.toMatchObject({ usage: { storageBytes: BYTES.byteLength } })
  })

  it('allows an operator retry after persistence fails following the external correction', async () => {
    const digest = await digestBytes(BYTES)
    const inner = createMemoryStateRepository({ initial: { [ORGANIZATION]: seededState(attempt(), digest) } })
    let transactions = 0
    const repository: StateRepository = {
      read: (organizationId) => inner.read(organizationId),
      transaction: async <T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T> => {
        transactions += 1
        if (transactions === 3) throw new Error('simulated persistence crash')
        return inner.transaction(organizationId, updater)
      },
    }
    const fixture = await runtimeFixtureWithRepository(attempt(), repository)
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure(fixture))
    const env = environment()
    const first = await handleRegistryRequest(
      new Request('http://localhost:5173/internal/storage/recovery', {
        method: 'POST',
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'runtime-attempt-1', cleanupConfirmed: true }),
      }),
      env,
    )

    expect(first.status).toBe(503)
    expect((await inner.read(ORGANIZATION)).storageAttempts?.[0]?.state).toBe('releasing')
    const resumed = await handleRegistryRequest(
      new Request('http://localhost:5173/internal/storage/recovery', {
        method: 'POST',
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'runtime-attempt-1', cleanupConfirmed: true, resume: true }),
      }),
      env,
    )

    expect(resumed.status).toBe(200)
    await expect(resumed.json()).resolves.toMatchObject({ recovery: { status: 'released', billing: 'reconciled' } })
    expect((await inner.read(ORGANIZATION)).storageAttempts?.[0]?.state).toBe('released')
  })

  it('reports an honest unavailable state when no dedicated recovery credential is configured', async () => {
    const fixture = await runtimeFixture()
    infrastructure.createInfrastructure.mockResolvedValueOnce(fakeInfrastructure(fixture))
    const response = await handleRegistryRequest(
      new Request('http://localhost:5173/internal/storage/recovery', { method: 'POST' }),
      environment({
        PSKILLS_STORAGE_RECOVERY_TOKEN: undefined,
        PSKILLS_STORAGE_RECOVERY_ORGANIZATION_ID: undefined,
      }),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'STORAGE_RECOVERY_UNAVAILABLE' })
  })
})
