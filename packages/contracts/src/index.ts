export const PROTOCOL_VERSION = 1;
export type Digest = `sha256:${string}`;
export type Role = 'owner' | 'admin' | 'publisher' | 'reader' | 'worker';
export interface Principal { organizationId: string; subject: string; roles: Role[]; namespaces?: string[]; }
/** content is strict RFC 4648 padded base64. Never raw UTF-8 text. */
export interface BundleFile { path: string; content: string; executable?: boolean; }
export interface SkillBundle { format: 'pskills-bundle-v1'; files: BundleFile[]; }
export interface StoredBlob { key: string; digest: Digest; size: number; }
export interface BlobStore { put(bytes: Uint8Array): Promise<StoredBlob>; get(key: string): Promise<Uint8Array>; remove(key: string): Promise<void>; }
export type DistributionState = 'pending' | 'approved' | 'quarantined' | 'scan-error' | 'revoked';
export type ScannerId = 'cisco-skill-scanner' | 'nvidia-skillspector' | 'skillsguard';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export interface ScannerPolicy { id: ScannerId; mode: 'disabled' | 'advisory' | 'required'; blockSeverities: Severity[]; timeoutSeconds: number; configuration?: Record<string, unknown>; }
export interface Policy { revision: string; scanners: ScannerPolicy[]; allowUnscanned: boolean; evidenceMaxAgeSeconds: number; hooks?: HookConfiguration[]; }
export interface HookConfiguration { id: string; event: 'ingest.validate' | 'artifact.evaluate' | 'pack.evaluate' | 'artifact.approved' | 'artifact.quarantined'; mode: 'disabled' | 'advisory' | 'required'; url?: string; secretEnv?: string; timeoutSeconds: number; }
export interface Finding { ruleId: string; fingerprint: string; severity: Severity; category: string; message: string; file?: string; line?: number; redactedEvidence?: string; }
export interface ScanResult {
  id: string; organizationId: string; jobId: string; artifactDigest: Digest; policyRevision: string;
  scannerId: ScannerId; engineVersion: string; rulesRevision: string; configurationHash: string;
  status: 'completed' | 'degraded' | 'error' | 'timeout' | 'unsupported'; findings: Finding[];
  coverage: { filesEnumerated: number; filesAnalyzed: number; filesSkipped: number; filesUnsupported: number; limitations: string[]; externalDestinations: string[]; };
  createdAt: string; durationMs: number; error?: string;
}
export interface Provenance { kind: 'native' | 'github' | 'registry'; upstreamId?: string; repository?: string; path?: string; revision?: string; sourceDigest?: Digest; }
export interface SkillVersion { id: string; organizationId: string; name: string; skillName: string; version: string; description: string; artifact: StoredBlob; state: DistributionState; policyRevision: string; createdAt: string; approvedAt?: string; provenance: Provenance; fileCount: number; scanIds: string[]; }
export interface PackMember { resourceId: string; name: string; version: string; digest: Digest; }
export interface PackVersion { id: string; organizationId: string; name: string; version: string; description: string; members: PackMember[]; manifestDigest: Digest; state: 'approved' | 'revoked'; createdAt: string; policyRevision: string; }
export interface Resolution { kind: 'skill' | 'pack'; resourceId: string; organizationId: string; name: string; version: string; digest: Digest; members: SkillVersion[]; }
export interface InstallAuthorization { id: string; organizationId: string; subject: string; resolution: Resolution; expiresAt: string; }
export interface TransferGrant { id: string; organizationId: string; subject: string; resourceId: string; authorizationId: string; digest: Digest; expiresAt: string; }
export interface TransferDescriptor { mode: 'gateway' | 'signed-url'; url: string; method: 'GET'; headers: Record<string, string>; expiresAt: string; size: number; digest: Digest; rangeSupported: boolean; }
export interface Upstream { id: string; organizationId: string; name: string; kind: 'github' | 'registry'; enabled: boolean; repositories?: string[]; baseUrl?: string; credentialEnv?: string; namespace: string; }
export interface ImportRequest { upstreamId: string; repository?: string; path: string; ref?: string; name: string; version: string; }
export interface Job { id: string; organizationId: string; kind: 'scan' | 'import'; state: 'queued' | 'running' | 'completed' | 'failed'; resourceId?: string; artifact?: StoredBlob; policyRevision: string; policy: Policy; import?: ImportRequest; upstream?: Upstream; createdAt: string; updatedAt: string; attempts: number; leaseToken?: string; leaseExpiresAt?: string; error?: string; }
export interface AuditEvent { id: string; organizationId: string; subject: string; action: string; resourceId?: string; createdAt: string; details?: Record<string, unknown>; }
export interface RegistryState { metadataRevision?: number; schemaVersion: 1; skills: SkillVersion[]; packs: PackVersion[]; jobs: Job[]; scans: ScanResult[]; policy: Policy; upstreams: Upstream[]; authorizations: InstallAuthorization[]; grants: TransferGrant[]; audit: AuditEvent[]; }
export interface StateRepository { read(organizationId: string): Promise<RegistryState>; transaction<T>(organizationId: string, updater: (state: RegistryState) => T): Promise<T>; }
export interface Authenticator { authenticate(request: Request): Promise<Principal | null>; createSession?(token: string): Promise<{ cookie: string; principal: Principal } | null>; clearSessionCookie?(): string; }
export interface RegistryConfiguration { publicOrigin: string; maxBodyBytes: number; organizationId: string; leaseSeconds: number; allowLoopbackUpstreams?: boolean; }
export interface RegistryDependencies { repository: StateRepository; blobs: BlobStore; auth: Authenticator; config: RegistryConfiguration; }
export interface WorkerCompletion { leaseToken: string; bundle?: SkillBundle; provenance?: Provenance; scanResults?: ScanResult[]; error?: string; }
