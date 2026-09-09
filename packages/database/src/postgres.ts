import type { RegistryState, StateRepository } from '../../contracts/src/index';
import {
  assertRegistryState,
  assertSynchronousResult,
  advanceStateRevision,
  cloneRegistryState,
  defaultRegistryState,
  StateRepositoryError,
  type RepositoryFactory,
  type StateRepositoryConstructorOptions,
} from './state';

export interface PgQueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount?: number }
export interface PgClientLike {
  query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<PgQueryResult<Row>>;
  release?: () => void | Promise<void>;
}
export interface PgPoolLike {
  query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<PgQueryResult<Row>>;
  connect(): Promise<PgClientLike>;
}
export interface PostgresStateRepositoryOptions extends StateRepositoryConstructorOptions {
  tableName?: string;
  autoMigrate?: boolean;
}

export function postgresStateSchemaSql(tableName = 'private_skills_registry_state'): string {
  const table = quoteIdentifier(tableName);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  organization_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)
`;
}

export const POSTGRES_STATE_SCHEMA_SQL = postgresStateSchemaSql();

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new StateRepositoryError('INVALID_TABLE', 'PostgreSQL table name is invalid');
  }
  return `"${identifier}"`;
}

function rowRevision(value: unknown): number | undefined {
  const revision = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : undefined;
}

function rowState(row: { state?: unknown; revision?: unknown } | undefined): unknown {
  if (!row) return undefined;
  const revision = rowRevision(row.revision);
  if (row.revision !== undefined && revision === undefined) {
    throw new StateRepositoryError('CORRUPT_STATE', 'PostgreSQL state revision is invalid');
  }
  if (typeof row.state === 'string') {
    try {
      const parsed = JSON.parse(row.state) as Record<string, unknown>;
      if (revision !== undefined) {
        parsed.metadataRevision = revision;
      }
      return parsed;
    }
    catch { throw new StateRepositoryError('CORRUPT_STATE', 'PostgreSQL state is not valid JSON'); }
  }
  if (row.state && typeof row.state === 'object' && row.revision !== undefined) {
    const parsed = row.state as Record<string, unknown>;
    if (revision !== undefined) {
      return { ...parsed, metadataRevision: revision };
    }
  }
  return row.state;
}

export class PostgresStateRepository implements StateRepository {
  private readonly pool: PgPoolLike;
  private readonly table: string;
  private readonly stateFactory: RepositoryFactory;
  private readonly autoMigrate: boolean;
  private migrationPromise?: Promise<void>;

  constructor(pool: PgPoolLike, options?: PostgresStateRepositoryOptions);
  constructor(options: PostgresStateRepositoryOptions & { pool: PgPoolLike });
  constructor(
    poolOrOptions: PgPoolLike | (PostgresStateRepositoryOptions & { pool: PgPoolLike }),
    options: PostgresStateRepositoryOptions = {},
  ) {
    const supplied = 'pool' in poolOrOptions ? poolOrOptions : options;
    this.pool = 'pool' in poolOrOptions ? poolOrOptions.pool : poolOrOptions;
    this.table = quoteIdentifier(supplied.tableName ?? 'private_skills_registry_state');
    this.stateFactory = supplied.stateFactory ?? (() => defaultRegistryState());
    this.autoMigrate = supplied.autoMigrate ?? false;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) return;
    const tableName = this.table.slice(1, -1);
    this.migrationPromise ??= this.pool.query(postgresStateSchemaSql(tableName)).then(() => undefined);
    await this.migrationPromise;
  }

  private async ensureRow(executor: Pick<PgPoolLike, 'query'>, organizationId: string): Promise<void> {
    const state = cloneRegistryState(this.stateFactory(organizationId));
    assertRegistryState(state);
    await executor.query(
      `INSERT INTO ${this.table} (organization_id, revision, state)
       VALUES ($1, 0, $2::jsonb)
       ON CONFLICT (organization_id) DO NOTHING`,
      [organizationId, JSON.stringify(state)],
    );
  }

  async read(organizationId: string): Promise<RegistryState> {
    await this.ensureSchema();
    await this.ensureRow(this.pool, organizationId);
    const result = await this.pool.query<{ state?: unknown; revision?: unknown }>(
      `SELECT state, revision FROM ${this.table} WHERE organization_id = $1`, [organizationId],
    );
    const state = rowState(result.rows[0]);
    if (state === undefined) throw new StateRepositoryError('MISSING_STATE', 'PostgreSQL state row is unavailable');
    assertRegistryState(state);
    return cloneRegistryState(state);
  }

  async transaction<T>(organizationId: string, update: (state: RegistryState) => T): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await this.ensureRow(client, organizationId);
      const result = await client.query<{ state?: unknown; revision?: unknown }>(
        `SELECT state, revision FROM ${this.table} WHERE organization_id = $1 FOR UPDATE`, [organizationId],
      );
      const loaded = rowState(result.rows[0]);
      if (loaded === undefined) throw new StateRepositoryError('MISSING_STATE', 'PostgreSQL state row is unavailable');
      assertRegistryState(loaded);
      const working = cloneRegistryState(loaded);
      const previousRevision = (working as RegistryState & { metadataRevision?: number }).metadataRevision ?? 0;
      const value = update(working);
      assertSynchronousResult(value);
      advanceStateRevision(working, previousRevision);
      assertRegistryState(working);
      await client.query(
        `UPDATE ${this.table} SET state = $2::jsonb, revision = revision + 1, updated_at = now()
         WHERE organization_id = $1`, [organizationId, JSON.stringify(working)],
      );
      await client.query('COMMIT');
      began = false;
      return value;
    } catch (error) {
      if (began) { try { await client.query('ROLLBACK'); } catch { /* preserve error */ } }
      throw error;
    } finally {
      await client.release?.();
    }
  }
}

export function createPostgresStateRepository(pool: PgPoolLike, options: PostgresStateRepositoryOptions = {}): PostgresStateRepository {
  return new PostgresStateRepository(pool, options);
}

export const createPostgresRepository = createPostgresStateRepository;
