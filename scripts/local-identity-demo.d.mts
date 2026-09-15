export interface LocalIdentityUser {
  id: string
  subject: string
  username: string
  name: string
  email: string
  defaultCompanyId: string
}

export interface LocalIdentityCompany {
  id: string
  name: string
  tenantId: string
}

export interface LocalIdentityProviderDescriptor {
  schemaVersion: number
  id: 'acme' | 'globex'
  label: string
  issuer: string
  discoveryUrl: string
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint: string
  jwksUri: string
  redirectUri: string
  redirectUris: string[]
  clientId: string
  users: LocalIdentityUser[]
  companies: LocalIdentityCompany[]
}

export interface LocalIdentityProviderConfiguration extends LocalIdentityProviderDescriptor {
  clientSecret: string
  scopes: string[]
  responseType: 'code'
  codeChallengeMethod: 'S256'
}

export interface LocalIdentityProvider {
  id: 'acme' | 'globex'
  label: string
  issuer: string
  clientId: string
  clientSecret: string
  redirectUris: string[]
  descriptor: LocalIdentityProviderDescriptor
  clientConfiguration: LocalIdentityProviderConfiguration
  fixture: { id: string; label: string; users: LocalIdentityUser[]; companies: LocalIdentityCompany[] }
  server: import('node:http').Server
  close(): Promise<void>
}

export interface SourceSnapshotManifest {
  schemaVersion: number
  snapshotMode: 'working-tree-copy'
  sourceRoot: string
  sourceHead: string | null
  createdAt: string
  fileCount: number
  totalBytes: number
  treeDigest: string
  workingTreeChanges: Array<{ state: string; path: string }>
  excluded: Array<{ path: string; reason: string }>
  files: Array<{ path: string; bytes: number; sha256: string }>
}

export declare function assertLoopbackOrigin(value: string, label?: string): URL
export declare function assertDemoEnvironment(environment?: Record<string, string | undefined>): void
export declare function parseLaunchOptions(args: string[]): {
  sourceRoot: string
  appPort: number
  acmePort: number
  globexPort: number
  databaseUrl?: string
  identityAdapter: 'auto' | 'postgres' | 'test'
  loginPath: string
}
export declare function createPkcePair(): { verifier: string; challenge: string; method: 'S256' }
export declare function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signature: Buffer; signingInput: string } | undefined
export declare function verifyJwtSignature(token: string, jwk: Record<string, unknown>): boolean
export declare function startLocalOidcProvider(options: {
  providerId?: 'acme' | 'globex'
  id?: 'acme' | 'globex'
  appOrigin: string
  port?: number
  clientId?: string
  clientSecret?: string
  callbackPaths?: readonly string[]
}): Promise<LocalIdentityProvider>
export declare function startLocalOidcProviders(options: { appOrigin: string; acmePort?: number; globexPort?: number }): Promise<[LocalIdentityProvider, LocalIdentityProvider]>
export declare function buildIdentityProviderEnvironment(providers: readonly LocalIdentityProvider[], persistence?: { adapter: string; databaseConfigured: boolean }): Record<string, string>
export declare function buildAppEnvironment(options: {
  origin: string
  stateRoot: string
  blobRoot: string
  sessionSecret: string
  identitySecret: string
  bootstrapToken: string
  providerEnvironment: Record<string, string>
  persistence: { adapter: string; databaseConfigured: boolean }
  databaseUrl?: string
}): Record<string, string>
export declare function createSourceSnapshot(options: { sourceRoot: string; destinationRoot: string }): { sourceRoot: string; destinationRoot: string; manifest: SourceSnapshotManifest }
export declare function redactSecrets(value: string, secrets: readonly string[]): string
