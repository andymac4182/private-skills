import type {
  AuditEvent,
  Job,
  PackVersion,
  Policy,
  Principal,
  ScanResult,
  SkillBundle,
  SkillVersion,
  Upstream,
} from '../../../../packages/contracts/src/index'

export type {
  AuditEvent,
  Job,
  PackVersion,
  Policy,
  Principal,
  ScanResult,
  SkillBundle,
  SkillVersion,
  Upstream,
}

export interface ApiErrorShape {
  code?: string
  message?: string
  requestId?: string
  details?: unknown
  retryable?: boolean
}

export interface SkillListResponse { skills: SkillVersion[] }
export interface SkillResponse { skill: SkillVersion }
export interface PackListResponse { packs: PackVersion[] }
export interface OperationListResponse { operations: Job[] }
export interface ScanListResponse { scans: ScanResult[] }
export interface PolicyResponse { policy: Policy }
export interface UpstreamListResponse { upstreams: Upstream[] }
export interface AuditListResponse { events: AuditEvent[] }
export interface HealthResponse { ok: boolean; service: string; version: string }
export interface OperationResponse { operation: Job }
export interface PublishResponse { operation?: Job; skill?: SkillVersion }
export interface ScanActionResponse { operation?: Job; skill?: SkillVersion }
export interface PackCreateResponse { pack: PackVersion }
export interface UpstreamResponse { upstream: Upstream }
export interface ImportResponse { operation: Job }
export interface SessionResponse { principal?: Principal }

