import type { RegistryState, StateRepository } from '../../contracts/src/index';
import {
  configuredProfiles,
  rankHits,
  validateDocument,
  validateOrganizationId,
  validateQuery,
  validateResourceIds,
  SearchValidationError,
  type SearchDocument,
  type SearchHealth,
  type SearchHit,
  type SearchProfileOptions,
  type SearchQuery,
  type SemanticIndex,
  type StateSemanticIndexOptions,
} from './types';

/** Name of the optional extension persisted inside RegistryState. */
export const SEARCH_STATE_PROPERTY = 'search';

/** The JSON-compatible portion of RegistryState owned by this adapter. */
export interface PersistedSearchIndex {
  version: 1;
  documents: SearchDocument[];
}

/** A local type intersection keeps the shared contracts package unchanged. */
export type SearchRegistryState = RegistryState & {
  search?: PersistedSearchIndex;
  /** Accepted for forward/backward compatibility with early private builds. */
  semanticSearch?: PersistedSearchIndex;
};

export class StateSemanticIndex implements SemanticIndex {
  private readonly repository: StateRepository;
  private readonly profiles: ReturnType<typeof configuredProfiles>;

  constructor(options: StateSemanticIndexOptions);
  constructor(repository: StateRepository, options?: SearchProfileOptions);
  constructor(
    optionsOrRepository: StateSemanticIndexOptions | StateRepository,
    options: SearchProfileOptions = {},
  ) {
    if ('repository' in optionsOrRepository) {
      this.repository = optionsOrRepository.repository;
      this.profiles = configuredProfiles(optionsOrRepository);
    }
    else {
      this.repository = optionsOrRepository;
      this.profiles = configuredProfiles(options);
    }
  }

  async upsert(documents: readonly SearchDocument[]): Promise<void> {
    const checked = documents.map((document) => validateDocument(document, this.profiles));
    const byOrganization = new Map<string, SearchDocument[]>();
    const identities = new Set<string>();
    for (const document of checked) {
      const key = identity(document);
      if (identities.has(key)) throw new SearchValidationError('DOCUMENT_DUPLICATE', 'A batch cannot contain duplicate organization/resource/profile documents');
      identities.add(key);
      const organization = byOrganization.get(document.organizationId) ?? [];
      organization.push(document);
      byOrganization.set(document.organizationId, organization);
    }
    for (const [organizationId, organizationDocuments] of byOrganization) {
      await this.repository.transaction(organizationId, (state) => {
        const typedState = state as SearchRegistryState;
        const existing = readPersistedDocuments(typedState, this.profiles);
        const byIdentity = new Map(existing.map((document) => [identity(document), document]));
        for (const document of organizationDocuments) {
          // The repository transaction is the authorization boundary. Do not
          // allow a caller to write a document into a different tenant row.
          if (document.organizationId !== organizationId) {
            throw new SearchValidationError('ORGANIZATION_MISMATCH', 'Search document organization does not match repository boundary');
          }
          byIdentity.set(identity(document), document);
        }
        writePersistedDocuments(typedState, [...byIdentity.values()]);
      });
    }
  }

  async search(query: SearchQuery): Promise<readonly SearchHit[]> {
    const checked = validateQuery(query, this.profiles);
    // An empty allowlist is an intentional no-result query. It must never be
    // interpreted as permission to search an entire tenant.
    if (checked.allowedResourceIds.length === 0) return [];
    const state = await this.repository.read(checked.organizationId) as SearchRegistryState;
    const documents = readPersistedDocuments(state, this.profiles);
    return rankHits(documents, checked);
  }

  async remove(organizationId: string, resourceIds: readonly string[]): Promise<void> {
    validateOrganizationId(organizationId);
    const checkedIds = validateResourceIds(resourceIds);
    if (checkedIds.length === 0) return;
    const removeSet = new Set(checkedIds);
    await this.repository.transaction(organizationId, (state) => {
      const typedState = state as SearchRegistryState;
      const documents = readPersistedDocuments(typedState, this.profiles)
        .filter((document) => !removeSet.has(document.resourceId));
      writePersistedDocuments(typedState, documents);
    });
  }

  async health(organizationId?: string): Promise<SearchHealth> {
    if (organizationId === undefined) {
      return {
        status: 'degraded',
        provider: 'state-exact-cosine',
        error: 'organization scope unavailable',
      };
    }
    try {
      validateOrganizationId(organizationId);
      const state = await this.repository.read(organizationId) as SearchRegistryState;
      // Reading the extension validates both the persistence transport and
      // the stored vectors/profile boundary. Do not report a healthy index
      // when the state row is unreachable or corrupted.
      readPersistedDocuments(state, this.profiles);
      return { status: 'ok', provider: 'state-exact-cosine' };
    } catch {
      return {
        status: 'degraded',
        provider: 'state-exact-cosine',
        error: 'state repository unavailable',
      };
    }
  }
}

/** Alias retained for callers that name adapters after their persistence. */
export const StateSearchIndex = StateSemanticIndex;

function identity(document: SearchDocument): string {
  return `${document.organizationId}\u0000${document.resourceId}\u0000${document.profileId}`;
}

function readPersistedDocuments(
  state: SearchRegistryState,
  profiles: ReturnType<typeof configuredProfiles>,
): SearchDocument[] {
  const extension = state.search ?? state.semanticSearch;
  if (extension === undefined) return [];
  if (!extension || extension.version !== 1 || !Array.isArray(extension.documents)) {
    throw new SearchValidationError('STATE_EXTENSION_INVALID', 'Persisted search index extension is invalid');
  }
  return extension.documents.map((document) => validateDocument(document, profiles));
}

function writePersistedDocuments(state: SearchRegistryState, documents: readonly SearchDocument[]): void {
  const sorted = [...documents].sort((left, right) => {
    const leftKey = identity(left);
    const rightKey = identity(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  state.search = { version: 1, documents: sorted.map((document) => ({ ...document, vector: [...document.vector] })) };
}
