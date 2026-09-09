import type { PgClientLike, PgPoolLike, PgQueryResult } from '../../database/src/postgres';
import {
  configuredProfiles,
  validateDigest,
  validateDocument,
  validateOrganizationId,
  validateQuery,
  validateResourceIds,
  SearchValidationError,
  type SearchHealth,
  type SearchHit,
  type SearchProfileOptions,
  type SearchQuery,
  type SearchDocument,
  type SemanticIndex,
} from './types';

export type SearchQueryExecutor = <Row = Record<string, unknown>>(
  text: string,
  parameters?: readonly unknown[],
) => Promise<PgQueryResult<Row>>;

export interface PostgresSemanticIndexOptions extends SearchProfileOptions {
  /** Existing application pool. No pg or provider SDK is imported here. */
  pool?: PgPoolLike;
  /** A portable query function for edge bridges and tests. */
  query?: SearchQueryExecutor;
  tableName?: string;
  /** When true, create the vector extension and unbounded-dimension table. */
  autoMigrate?: boolean;
}

export function postgresSemanticIndexSchemaSql(tableName = 'private_skills_semantic_index'): string {
  const table = quoteIdentifier(tableName);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  organization_id text NOT NULL,
  resource_id text NOT NULL,
  profile_id text NOT NULL,
  artifact_digest text NOT NULL,
  content_digest text NOT NULL,
  text text NOT NULL,
  vector vector NOT NULL,
  indexed_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, resource_id, profile_id)
);
CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tableName}_scope_idx`)}
  ON ${table} (organization_id, profile_id, resource_id);
`;
}

export const POSTGRES_SEMANTIC_INDEX_SCHEMA_SQL = postgresSemanticIndexSchemaSql();

export class PostgresSemanticIndex implements SemanticIndex {
  private readonly pool?: PgPoolLike;
  private readonly queryExecutor: SearchQueryExecutor;
  private readonly table: string;
  private readonly tableName: string;
  private readonly autoMigrate: boolean;
  private readonly profiles: ReturnType<typeof configuredProfiles>;
  private migrationPromise?: Promise<void>;

  constructor(options: PostgresSemanticIndexOptions);
  constructor(pool: PgPoolLike, options?: Omit<PostgresSemanticIndexOptions, 'pool'>);
  constructor(
    optionsOrPool: PostgresSemanticIndexOptions | PgPoolLike,
    options: Omit<PostgresSemanticIndexOptions, 'pool'> = {},
  ) {
    const isPool = isPgPool(optionsOrPool);
    const supplied = isPool ? { ...options, pool: optionsOrPool } : optionsOrPool;
    this.pool = supplied.pool;
    if (!supplied.query && !supplied.pool) throw new Error('PostgresSemanticIndex requires a pool or query function');
    this.queryExecutor = supplied.query ?? ((text, parameters) => supplied.pool!.query(text, parameters));
    this.tableName = supplied.tableName ?? 'private_skills_semantic_index';
    this.table = quoteIdentifier(this.tableName);
    this.autoMigrate = supplied.autoMigrate ?? false;
    this.profiles = configuredProfiles(supplied);
  }

  async upsert(documents: readonly SearchDocument[]): Promise<void> {
    const checked = documents.map((document) => validateDocument(document, this.profiles));
    const identities = new Set<string>();
    for (const document of checked) {
      const key = `${document.organizationId}\u0000${document.resourceId}\u0000${document.profileId}`;
      if (identities.has(key)) throw new SearchValidationError('DOCUMENT_DUPLICATE', 'A batch cannot contain duplicate organization/resource/profile documents');
      identities.add(key);
    }
    if (checked.length === 0) return;
    await this.ensureSchema();
    await this.withTransaction(async (executor) => {
      for (const document of checked) {
        await executor.query(
          `INSERT INTO ${this.table}
             (organization_id, resource_id, profile_id, artifact_digest, content_digest, text, vector, indexed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::timestamptz)
           ON CONFLICT (organization_id, resource_id, profile_id)
           DO UPDATE SET artifact_digest = EXCLUDED.artifact_digest,
                         content_digest = EXCLUDED.content_digest,
                         text = EXCLUDED.text,
                         vector = EXCLUDED.vector,
                         indexed_at = EXCLUDED.indexed_at`,
          [
            document.organizationId,
            document.resourceId,
            document.profileId,
            document.artifactDigest,
            document.contentDigest,
            document.text,
            vectorLiteral(document.vector),
            document.indexedAt,
          ],
        );
      }
    });
  }

  async search(query: SearchQuery): Promise<readonly SearchHit[]> {
    const checked = validateQuery(query, this.profiles);
    if (checked.allowedResourceIds.length === 0) return [];
    await this.ensureSchema();
    // The resource allowlist is in the WHERE clause before ORDER/LIMIT. We do
    // not create an ANN index here, so pgvector executes exact cosine distance.
    const result = await this.queryExecutor(
      `SELECT resource_id, artifact_digest, content_digest,
              1 - (vector <=> $1::vector) AS score
         FROM ${this.table}
        WHERE organization_id = $2
          AND profile_id = $3
          AND resource_id = ANY($4::text[])
        ORDER BY vector <=> $1::vector ASC, resource_id ASC
        LIMIT $5`,
      [vectorLiteral(checked.vector), checked.organizationId, checked.profileId, checked.allowedResourceIds, checked.limit],
    );
    const allowed = new Set(checked.allowedResourceIds);
    // Keep a second allowlist check at the adapter boundary in case a proxy or
    // database view returns rows outside the requested scope. The SQL scope
    // remains before ORDER/LIMIT, so this defense does not create post-limit
    // authorization as the primary control.
    return result.rows.map((row) => rowToHit(row)).filter((hit) => allowed.has(hit.resourceId));
  }

  async remove(organizationId: string, resourceIds: readonly string[]): Promise<void> {
    validateOrganizationId(organizationId);
    const checkedIds = validateResourceIds(resourceIds);
    if (checkedIds.length === 0) return;
    await this.ensureSchema();
    await this.queryExecutor(
      `DELETE FROM ${this.table}
        WHERE organization_id = $1 AND resource_id = ANY($2::text[])`,
      [organizationId, checkedIds],
    );
  }

  async health(): Promise<SearchHealth> {
    try {
      await this.ensureSchema();
      await this.queryExecutor('SELECT 1');
      return { status: 'ok', provider: 'postgres-pgvector' };
    }
    catch {
      // Do not return provider errors, connection strings, or query text to a
      // caller that may expose health details outside the trusted boundary.
      return { status: 'degraded', provider: 'postgres-pgvector', error: 'database unavailable' };
    }
  }

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) return;
    this.migrationPromise ??= (async () => {
      await this.queryExecutor('CREATE EXTENSION IF NOT EXISTS vector');
      await this.queryExecutor(postgresSemanticIndexSchemaSql(this.tableName));
    })();
    await this.migrationPromise;
  }

  private async withTransaction(operation: (executor: Pick<PgClientLike, 'query'>) => Promise<void>): Promise<void> {
    if (!this.pool) {
      await operation({ query: this.queryExecutor });
      return;
    }
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await operation(client);
      await client.query('COMMIT');
      began = false;
    }
    catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      }
      throw error;
    }
    finally {
      await client.release?.();
    }
  }
}

export const PgVectorSemanticIndex = PostgresSemanticIndex;

function isPgPool(value: PostgresSemanticIndexOptions | PgPoolLike): value is PgPoolLike {
  return typeof (value as PgPoolLike).query === 'function' && typeof (value as PgPoolLike).connect === 'function';
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error('PostgreSQL table name is invalid');
  return `"${identifier}"`;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => Object.is(value, -0) ? '0' : String(value)).join(',')}]`;
}

function rowToHit(row: Record<string, unknown>): SearchHit {
  const resourceId = row.resource_id;
  const artifactDigest = row.artifact_digest;
  const contentDigest = row.content_digest;
  const rawScore = row.score;
  if (typeof resourceId !== 'string' || resourceId.length === 0) throw new Error('PostgreSQL search returned an invalid resource id');
  validateDigest(artifactDigest, 'artifact digest');
  validateDigest(contentDigest, 'content digest');
  const score = typeof rawScore === 'number' ? rawScore : typeof rawScore === 'string' ? Number(rawScore) : NaN;
  if (!Number.isFinite(score)) throw new Error('PostgreSQL search returned an invalid similarity score');
  return { resourceId, artifactDigest, contentDigest, score };
}
