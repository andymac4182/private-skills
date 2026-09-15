import { ApiError } from './api'
import type {
  ApiTokenMetadata,
  CreateApiTokenInput,
  CreateApiTokenResult,
} from '../../../../packages/api-tokens/src/index'

/** Browser-safe response from the company-scoped token list route. */
export interface ApiTokenListResponse {
  tokens: readonly ApiTokenMetadata[]
}

/** Response returned after a server-authorized revoke. */
export interface ApiTokenRevokeResponse {
  revoked: boolean
  token: ApiTokenMetadata
}

export const apiTokenRoute = (tokenId?: string): string => {
  const base = '/v1/tokens'
  if (tokenId === undefined) return base
  const id = tokenId.trim()
  if (!id) throw new Error('A CLI token is required.')
  return `${base}/${encodeURIComponent(id)}`
}

type ApiTokenRequestInit = Omit<RequestInit, 'body'> & { body?: unknown }

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

async function requestApiTokens<T>(path: string, init: ApiTokenRequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body !== undefined) headers.set('content-type', 'application/json')

  const response = await fetch(path, {
    ...init,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'include',
    headers,
  })
  const body = await readJson(response)
  if (!response.ok) throw new ApiError(response.status, body, 'The CLI token request failed.')
  return body as T
}

export function isApiTokenUnavailableError(error: unknown): error is ApiError {
  return error instanceof ApiError && [404, 405, 501, 503].includes(error.status)
}

export function apiTokenErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback
}

export function listApiTokens(includeRevoked = true, signal?: AbortSignal): Promise<ApiTokenListResponse> {
  const path = includeRevoked ? `${apiTokenRoute()}?includeRevoked=true` : apiTokenRoute()
  return requestApiTokens<ApiTokenListResponse>(path, { signal })
}

export function createApiToken(input: CreateApiTokenInput): Promise<CreateApiTokenResult> {
  return requestApiTokens<CreateApiTokenResult>(apiTokenRoute(), { method: 'POST', body: input })
}

export function revokeApiToken(tokenId: string): Promise<ApiTokenRevokeResponse> {
  return requestApiTokens<ApiTokenRevokeResponse>(apiTokenRoute(tokenId), { method: 'DELETE' })
}
