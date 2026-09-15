import { ApiError } from './api'
import type {
  CompanySsoProviderCreateInput,
  CompanySsoProviderPublic,
  CompanySsoProviderStatus,
  CompanySsoProviderUpdateInput,
} from '../../../../packages/identity/src/company-sso-types'

/** The company SSO API is mounted beside the existing registry API. */
export const companySsoRoute = (organizationId: string, providerId?: string): string => {
  const organization = organizationId.trim()
  if (!organization) throw new Error('A company is required for SSO settings.')
  const base = `/v1/companies/${encodeURIComponent(organization)}/sso/providers`
  if (providerId === undefined) return base
  const provider = providerId.trim()
  if (!provider) throw new Error('A company SSO provider is required.')
  return `${base}/${encodeURIComponent(provider)}`
}

/** Public provider metadata used by the company-specific sign-in picker. */
export interface CompanySsoLoginProvider {
  providerId: string
  displayName: string
  protocol: 'oidc' | 'saml'
}

export interface CompanySsoLoginProviderListResponse {
  organizationId: string
  providers: readonly CompanySsoLoginProvider[]
}

export interface CompanySsoLoginResponse {
  url?: string
  redirect?: boolean
}

export const companySsoLoginRoute = (organizationId: string): string => {
  const organization = organizationId.trim()
  if (!organization) throw new Error('A company is required for company sign-in.')
  return `/v1/companies/${encodeURIComponent(organization)}/sso/login`
}

export interface CompanySsoProviderListResponse {
  providers: readonly CompanySsoProviderPublic[]
}

export interface CompanySsoProviderResponse {
  provider: CompanySsoProviderPublic
}

export interface CompanySsoDeleteResponse {
  deleted: boolean
  providerId: string
}

type CompanySsoRequestInit = Omit<RequestInit, 'body'> & { body?: unknown }

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

async function requestCompanySso<T>(path: string, init: CompanySsoRequestInit = {}): Promise<T> {
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
  if (!response.ok) throw new ApiError(response.status, body, 'Company SSO request failed.')
  return body as T
}

export function isCompanySsoUnavailableError(error: unknown): error is ApiError {
  return error instanceof ApiError && [404, 501, 503].includes(error.status)
}

export function companySsoErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback
}

export async function listCompanySsoProviders(organizationId: string, signal?: AbortSignal): Promise<CompanySsoProviderListResponse> {
  return requestCompanySso<CompanySsoProviderListResponse>(companySsoRoute(organizationId), { signal })
}

export async function listCompanySsoLoginProviders(organizationId: string, signal?: AbortSignal): Promise<CompanySsoLoginProviderListResponse> {
  return requestCompanySso<CompanySsoLoginProviderListResponse>(companySsoLoginRoute(organizationId), { signal })
}

export async function startCompanySsoLogin(
  organizationId: string,
  providerId: string,
  callbackURL: string,
): Promise<CompanySsoLoginResponse> {
  const provider = providerId.trim()
  if (!provider) throw new Error('A company SSO provider is required.')
  return requestCompanySso<CompanySsoLoginResponse>(companySsoLoginRoute(organizationId), {
    method: 'POST',
    body: { providerId: provider, callbackURL },
  })
}

export async function createCompanySsoProvider(organizationId: string, input: CompanySsoProviderCreateInput): Promise<CompanySsoProviderResponse> {
  return requestCompanySso<CompanySsoProviderResponse>(companySsoRoute(organizationId), { method: 'POST', body: input })
}

export async function updateCompanySsoProvider(
  organizationId: string,
  providerId: string,
  input: CompanySsoProviderUpdateInput,
  revision: number,
): Promise<CompanySsoProviderResponse> {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('A valid company SSO provider revision is required.')
  return requestCompanySso<CompanySsoProviderResponse>(companySsoRoute(organizationId, providerId), {
    method: 'PATCH',
    body: input,
    headers: { 'if-match': String(revision) },
  })
}

export function setCompanySsoProviderStatus(
  organizationId: string,
  provider: Pick<CompanySsoProviderPublic, 'providerId' | 'revision'>,
  status: CompanySsoProviderStatus,
): Promise<CompanySsoProviderResponse> {
  return updateCompanySsoProvider(organizationId, provider.providerId, { status }, provider.revision)
}
