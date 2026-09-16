import type { Authenticator, Principal } from '../../../../packages/contracts/src/index.js'
import {
  STORAGE_RECOVERY_CAPABILITY,
  STORAGE_RECOVERY_SCOPE,
  StorageRecoveryError,
  StorageRecoveryService,
} from '../../../../packages/storage/src/index.js'

/** Internal route owned by the platform storage reconciler. */
export const STORAGE_RECOVERY_ROUTE_PATH = '/internal/storage/recovery'

const MAX_STORAGE_RECOVERY_BODY_BYTES = 16 * 1024
const OPERATOR_ROLES = new Set(['worker'])
const ALLOWED_BODY_FIELDS = new Set(['attemptId', 'cleanupConfirmed', 'resume'])

export interface StorageRecoveryRoutesOptions {
  /** A separately provisioned bearer authenticator, never the tenant authenticator. */
  authorizeOperator: Authenticator['authenticate']
  /** The recoverer owns all provider, repository, and billing side effects. */
  service: StorageRecoveryService
  /** Pin the credential identity as well as its worker role and scope. */
  operatorTokenId: string
  maxBodyBytes?: number
}

export interface StorageRecoveryRoutes {
  (request: Request): Promise<Response | undefined>
}

class StorageRecoveryRouteError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean

  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message)
    this.name = 'StorageRecoveryRouteError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname.replace(/\/+$/u, '') || '/'
  } catch {
    return ''
  }
}

function routeMethod(request: Request): string {
  return request.method.toUpperCase()
}

function responseError(error: unknown): Response {
  if (error instanceof StorageRecoveryRouteError) {
    return Response.json({ code: error.code, message: error.message, retryable: error.retryable }, {
      status: error.status,
      headers: { 'cache-control': 'no-store' },
    })
  }
  if (error instanceof StorageRecoveryError) {
    const status = error.code === 'STORAGE_ATTEMPT_NOT_FOUND'
      ? 404
      : error.code === 'RECOVERY_FORBIDDEN'
        ? 403
        : error.code === 'RECOVERY_INVALID'
          ? 400
          : 503
    return Response.json({
      code: error.code,
      message: error.code === 'STORAGE_ATTEMPT_NOT_FOUND'
        ? 'The storage attempt was not found.'
        : error.code === 'RECOVERY_FORBIDDEN'
          ? 'Platform storage recovery access is required.'
          : error.code === 'RECOVERY_INVALID'
            ? 'The storage recovery request is invalid.'
            : 'Storage recovery persistence is temporarily unavailable.',
      retryable: status >= 500,
    }, { status, headers: { 'cache-control': 'no-store' } })
  }
  return Response.json({
    code: 'STORAGE_RECOVERY_UNAVAILABLE',
    message: 'Storage recovery is temporarily unavailable.',
    retryable: true,
  }, { status: 503, headers: { 'cache-control': 'no-store' } })
}

function positiveBodyLimit(value: number | undefined): number {
  const limit = value ?? MAX_STORAGE_RECOVERY_BODY_BYTES
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_STORAGE_RECOVERY_BODY_BYTES) {
    throw new StorageRecoveryRouteError('INVALID_CONFIGURATION', 'Storage recovery request body limit is invalid.', 500)
  }
  return limit
}

async function readBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  let bytes: ArrayBuffer
  try {
    bytes = await request.arrayBuffer()
  } catch {
    throw new StorageRecoveryRouteError('INVALID_REQUEST', 'The storage recovery request could not be read.')
  }
  if (bytes.byteLength > maxBytes) {
    throw new StorageRecoveryRouteError('PAYLOAD_TOO_LARGE', 'The storage recovery request is too large.', 413)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new StorageRecoveryRouteError('INVALID_REQUEST', 'The storage recovery request is not valid UTF-8.')
  }
  if (text.trim() === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new StorageRecoveryRouteError('INVALID_REQUEST', 'The storage recovery request JSON is invalid.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageRecoveryRouteError('INVALID_REQUEST', 'The storage recovery request must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function requiredIdentifier(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StorageRecoveryRouteError('INVALID_REQUEST', `${field} is invalid.`)
  }
  return value.trim()
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new StorageRecoveryRouteError('INVALID_REQUEST', `${field} is invalid.`)
  return value
}

function assertOperator(value: Principal | null, expectedTokenId: string): Principal {
  const operator = value as (Principal & { identity?: unknown; tokenId?: unknown; scopes?: unknown }) | null
  if (
    !operator ||
    operator.identity !== 'worker' ||
    !Array.isArray(operator.roles) ||
    operator.roles.length !== 1 ||
    !operator.roles.every((role) => OPERATOR_ROLES.has(role)) ||
    !Array.isArray(operator.scopes) ||
    !operator.scopes.includes(STORAGE_RECOVERY_SCOPE) ||
    operator.tokenId !== expectedTokenId ||
    typeof operator.organizationId !== 'string' ||
    operator.organizationId.trim() === '' ||
    typeof operator.subject !== 'string' ||
    operator.subject.trim() === ''
  ) {
    throw new StorageRecoveryRouteError('STORAGE_RECOVERY_FORBIDDEN', 'Platform storage recovery access is required.', 403)
  }
  return operator
}

/**
 * Mount the platform-only storage recovery workflow. The request body has no
 * tenant, actor, or proof fields: those values are created from the verified
 * dedicated operator identity and the recoverer's durable attempt record.
 */
export function createStorageRecoveryRoutes(options: StorageRecoveryRoutesOptions): StorageRecoveryRoutes {
  if (typeof options?.authorizeOperator !== 'function') throw new Error('storage recovery operator authenticator is required')
  if (!(options.service instanceof StorageRecoveryService)) throw new Error('storage recovery service is required')
  const operatorTokenId = requiredIdentifier(options.operatorTokenId, 'operatorTokenId')
  const maxBodyBytes = positiveBodyLimit(options.maxBodyBytes)

  return async (request: Request): Promise<Response | undefined> => {
    if (safePath(request) !== STORAGE_RECOVERY_ROUTE_PATH) return undefined
    try {
      if (routeMethod(request) !== 'POST') {
        throw new StorageRecoveryRouteError('METHOD_NOT_ALLOWED', 'Storage recovery only accepts POST.', 405)
      }
      let principal: Principal | null
      try {
        principal = await options.authorizeOperator(request)
      } catch {
        throw new StorageRecoveryRouteError('STORAGE_RECOVERY_AUTH_UNAVAILABLE', 'Storage recovery authorization is temporarily unavailable.', 503, true)
      }
      const operator = assertOperator(principal, operatorTokenId)
      const body = await readBody(request, maxBodyBytes)
      for (const field of Object.keys(body)) {
        if (!ALLOWED_BODY_FIELDS.has(field)) {
          // In particular, never accept caller supplied organization, actor,
          // capability, scope, or proof data at this boundary.
          throw new StorageRecoveryRouteError('INVALID_REQUEST', `${field} is not accepted by storage recovery.`)
        }
      }
      const attemptId = requiredIdentifier(body.attemptId, 'attemptId')
      const cleanupConfirmed = optionalBoolean(body.cleanupConfirmed, 'cleanupConfirmed')
      const resume = optionalBoolean(body.resume, 'resume')
      const recovery = await options.service.recover({
        organizationId: operator.organizationId.trim(),
        attemptId,
        actor: {
          organizationId: operator.organizationId.trim(),
          subject: operator.subject.trim(),
          capability: STORAGE_RECOVERY_CAPABILITY,
          scopes: [STORAGE_RECOVERY_SCOPE],
        },
        // The reference is deterministic and server-created. The service's
        // proof verifier must establish the failed writer from durable facts;
        // this value is never treated as evidence on its own.
        proof: { kind: 'writer-terminated', reference: `runtime-storage-attempt:${attemptId}` },
        ...(cleanupConfirmed === undefined ? {} : { cleanupConfirmed }),
        ...(resume === undefined ? {} : { resume }),
      })
      return Response.json({ protocolVersion: 1, recovery }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return responseError(error)
    }
  }
}
