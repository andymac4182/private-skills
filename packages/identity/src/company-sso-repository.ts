import {
  DEFAULT_COMPANY_SSO_TABLE,
  CompanySsoConflictError,
  CompanySsoError,
  CompanySsoRepositoryError,
  type CompanySsoOidcConfig,
  type CompanySsoProviderRecord,
  type CompanySsoProviderRepository,
  type CompanySsoSamlConfig,
} from './company-sso-types.js';
import { validateCompanySsoRecord } from './company-sso-validation.js';

export interface CompanySsoPgQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number;
}

export interface CompanySsoPgExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<CompanySsoPgQueryResult<Row>>;
}

export interface CompanySsoPgPool extends CompanySsoPgExecutor {
  connect(): Promise<CompanySsoPgExecutor & { release?: () => void | Promise<void> }>;
}

/** Minimal adapter for the `postgres` package used by the identity runtime. */
export interface CompanySsoPostgresJsClient {
  unsafe<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]>;
}

export interface CompanySsoRepositoryOptions {
  tableName?: string;
  /** PostgreSQL schema shared with Better Auth when one is configured. */
  schemaName?: string;
  autoMigrate?: boolean;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new CompanySsoRepositoryError('Company SSO PostgreSQL table name is invalid');
  }
  return `"${identifier}"`;
}

function qualifiedTable(tableName: string, schemaName?: string): string {
  const tableIdentifier = quoteIdentifier(tableName);
  const normalizedSchema = schemaName?.trim();
  return normalizedSchema === undefined || normalizedSchema === ''
    ? tableIdentifier
    : `${quoteIdentifier(normalizedSchema)}.${tableIdentifier}`;
}

export function companySsoSchemaSql(tableName = DEFAULT_COMPANY_SSO_TABLE, schemaName?: string): string {
  const table = qualifiedTable(tableName, schemaName);
  const organizationIndex = quoteIdentifier(`${tableName}_organization_created_idx`);
  const issuerIndex = quoteIdentifier(`${tableName}_issuer_idx`);
  const schema = schemaName?.trim();
  const schemaStatement = schema === undefined || schema === '' ? '' : `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};\n`;
  return `
${schemaStatement}
CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  provider_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  issuer text NOT NULL,
  callback_url text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  oidc_config jsonb NULL,
  saml_config jsonb NULL,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((protocol = 'oidc' AND oidc_config IS NOT NULL AND saml_config IS NULL)
      OR (protocol = 'saml' AND oidc_config IS NULL AND saml_config IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ${organizationIndex} ON ${table} (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ${issuerIndex} ON ${table} (issuer);
`;
}

export const COMPANY_SSO_SCHEMA_SQL = companySsoSchemaSql();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dbString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new CompanySsoRepositoryError(`Stored company SSO ${field} is invalid`);
  return value;
}

function dbDate(value: unknown, field: string): string {
  const date = value instanceof Date
    ? value
    : typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) throw new CompanySsoRepositoryError(`Stored company SSO ${field} is invalid`);
  return date.toISOString();
}

function dbRevision(value: unknown): number {
  const revision = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new CompanySsoRepositoryError('Stored company SSO revision is invalid');
  }
  return revision;
}

function dbJson(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { throw new CompanySsoRepositoryError(`Stored company SSO ${field} is invalid`); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CompanySsoRepositoryError(`Stored company SSO ${field} is invalid`);
  return parsed as Record<string, unknown>;
}

function rowToRecord(row: Record<string, unknown>): CompanySsoProviderRecord {
  const protocol = row.protocol;
  if (protocol !== 'oidc' && protocol !== 'saml') throw new CompanySsoRepositoryError('Stored company SSO protocol is invalid');
  const status = row.status;
  if (status !== 'active' && status !== 'disabled') throw new CompanySsoRepositoryError('Stored company SSO status is invalid');
  const oidc = dbJson(row.oidc_config, 'OIDC configuration') as CompanySsoOidcConfig | undefined;
  const saml = dbJson(row.saml_config, 'SAML configuration') as CompanySsoSamlConfig | undefined;
  const record: CompanySsoProviderRecord = {
    id: dbString(row.id, 'id'),
    organizationId: dbString(row.organization_id, 'organization id'),
    providerId: dbString(row.provider_id, 'provider id'),
    displayName: dbString(row.display_name, 'display name'),
    protocol,
    issuer: dbString(row.issuer, 'issuer'),
    callbackUrl: dbString(row.callback_url, 'callback URL'),
    status,
    ...(oidc ? { oidc } : {}),
    ...(saml ? { saml } : {}),
    createdBy: dbString(row.created_by, 'creator'),
    updatedBy: dbString(row.updated_by, 'updater'),
    revision: dbRevision(row.revision),
    createdAt: dbDate(row.created_at, 'creation time'),
    updatedAt: dbDate(row.updated_at, 'update time'),
  };
  try { validateCompanySsoRecord(record); } catch { throw new CompanySsoRepositoryError('Stored company SSO provider is invalid'); }
  return record;
}

const PROVIDER_COLUMNS = 'id, organization_id, provider_id, display_name, protocol, issuer, callback_url, status, oidc_config, saml_config, created_by, updated_by, revision, created_at, updated_at';

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505');
}

export class PostgresCompanySsoRepository implements CompanySsoProviderRepository {
  private readonly pool: CompanySsoPgPool;
  private readonly table: string;
  private readonly tableName: string;
  private readonly schemaName?: string;
  private readonly autoMigrate: boolean;
  private migration?: Promise<void>;

  constructor(pool: CompanySsoPgPool, options?: CompanySsoRepositoryOptions);
  constructor(options: CompanySsoRepositoryOptions & { pool: CompanySsoPgPool });
  constructor(
    poolOrOptions: CompanySsoPgPool | (CompanySsoRepositoryOptions & { pool: CompanySsoPgPool }),
    options: CompanySsoRepositoryOptions = {},
  ) {
    const supplied = 'pool' in poolOrOptions ? poolOrOptions : options;
    this.pool = 'pool' in poolOrOptions ? poolOrOptions.pool : poolOrOptions;
    this.tableName = supplied.tableName ?? DEFAULT_COMPANY_SSO_TABLE;
    this.schemaName = supplied.schemaName?.trim() || undefined;
    this.table = qualifiedTable(this.tableName, this.schemaName);
    this.autoMigrate = supplied.autoMigrate ?? false;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) return;
    await this.runMigrations();
  }

  /** Run the reviewed private-table migration explicitly at deployment startup. */
  async runMigrations(): Promise<void> {
    this.migration ??= this.pool.query(companySsoSchemaSql(this.tableName, this.schemaName)).then(() => undefined);
    await this.migration;
  }

  async create(record: CompanySsoProviderRecord): Promise<CompanySsoProviderRecord> {
    validateCompanySsoRecord(record);
    await this.ensureSchema();
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO ${this.table} (${PROVIDER_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15)
         RETURNING ${PROVIDER_COLUMNS}`,
        [
          record.id,
          record.organizationId,
          record.providerId,
          record.displayName,
          record.protocol,
          record.issuer,
          record.callbackUrl,
          record.status,
          record.oidc ? JSON.stringify(record.oidc) : null,
          record.saml ? JSON.stringify(record.saml) : null,
          record.createdBy,
          record.updatedBy,
          record.revision,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return result.rows[0] === undefined ? clone(record) : rowToRecord(result.rows[0]);
    } catch (error) {
      if (error instanceof CompanySsoError) throw error;
      if (isUniqueViolation(error)) throw new CompanySsoConflictError('Company SSO provider id is already in use');
      throw new CompanySsoRepositoryError('Company SSO provider could not be created');
    }
  }

  async get(organizationId: string, providerId: string): Promise<CompanySsoProviderRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${PROVIDER_COLUMNS} FROM ${this.table} WHERE organization_id = $1 AND provider_id = $2 LIMIT 1`,
      [organizationId, providerId],
    );
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
  }

  async getByProviderId(providerId: string): Promise<CompanySsoProviderRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${PROVIDER_COLUMNS} FROM ${this.table} WHERE provider_id = $1 LIMIT 1`,
      [providerId],
    );
    return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
  }

  async list(organizationId: string): Promise<CompanySsoProviderRecord[]> {
    await this.ensureSchema();
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${PROVIDER_COLUMNS} FROM ${this.table} WHERE organization_id = $1 ORDER BY created_at DESC, provider_id ASC`,
      [organizationId],
    );
    return result.rows.map(rowToRecord);
  }

  async update(
    organizationId: string,
    providerId: string,
    patch: Partial<CompanySsoProviderRecord>,
    expectedRevision?: number,
  ): Promise<CompanySsoProviderRecord | null> {
    await this.ensureSchema();
    const sets: string[] = [];
    const parameters: unknown[] = [organizationId, providerId];
    const add = (column: string, value: unknown, cast?: string) => {
      parameters.push(value);
      sets.push(`${column} = $${parameters.length}${cast ? `::${cast}` : ''}`);
    };
    if (patch.displayName !== undefined) add('display_name', patch.displayName);
    if (patch.issuer !== undefined) add('issuer', patch.issuer);
    if (patch.callbackUrl !== undefined) add('callback_url', patch.callbackUrl);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.oidc !== undefined) add('oidc_config', JSON.stringify(patch.oidc), 'jsonb');
    if (patch.saml !== undefined) add('saml_config', JSON.stringify(patch.saml), 'jsonb');
    if (patch.updatedBy !== undefined) add('updated_by', patch.updatedBy);
    const hasUpdatedAt = patch.updatedAt !== undefined;
    if (hasUpdatedAt) add('updated_at', patch.updatedAt);
    if (sets.length === 0) return this.get(organizationId, providerId);
    sets.push('revision = revision + 1');
    if (!hasUpdatedAt) sets.push('updated_at = now()');
    const predicates = ['organization_id = $1', 'provider_id = $2'];
    if (expectedRevision !== undefined) {
      parameters.push(expectedRevision);
      predicates.push(`revision = $${parameters.length}`);
    }
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `UPDATE ${this.table} SET ${sets.join(', ')} WHERE ${predicates.join(' AND ')} RETURNING ${PROVIDER_COLUMNS}`,
        parameters,
      );
      return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
    } catch (error) {
      if (error instanceof CompanySsoError) throw error;
      throw new CompanySsoRepositoryError('Company SSO provider could not be updated');
    }
  }

  async delete(organizationId: string, providerId: string, expectedRevision?: number): Promise<boolean> {
    await this.ensureSchema();
    const parameters: unknown[] = [organizationId, providerId];
    const predicates = ['organization_id = $1', 'provider_id = $2'];
    if (expectedRevision !== undefined) {
      parameters.push(expectedRevision);
      predicates.push(`revision = $${parameters.length}`);
    }
    try {
      const result = await this.pool.query(
        `DELETE FROM ${this.table} WHERE ${predicates.join(' AND ')} RETURNING id`,
        parameters,
      );
      return (result.rowCount ?? result.rows.length) > 0;
    } catch {
      throw new CompanySsoRepositoryError('Company SSO provider could not be deleted');
    }
  }
}

export function createPostgresCompanySsoRepository(
  pool: CompanySsoPgPool,
  options: CompanySsoRepositoryOptions = {},
): PostgresCompanySsoRepository {
  return new PostgresCompanySsoRepository(pool, options);
}

export function createPostgresJsCompanySsoRepository(
  client: CompanySsoPostgresJsClient,
  options: CompanySsoRepositoryOptions = {},
): PostgresCompanySsoRepository {
  const pool: CompanySsoPgPool = {
    async query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) {
      const rows = await client.unsafe<Row>(text, parameters);
      return { rows: [...rows] };
    },
    async connect() {
      return {
        query: async <Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]) => {
          const rows = await client.unsafe<Row>(text, parameters);
          return { rows: [...rows] };
        },
      };
    },
  };
  return new PostgresCompanySsoRepository(pool, options);
}

export class MemoryCompanySsoRepository implements CompanySsoProviderRepository {
  private readonly records = new Map<string, CompanySsoProviderRecord>();

  constructor(initial: readonly CompanySsoProviderRecord[] = []) {
    for (const record of initial) {
      validateCompanySsoRecord(record);
      if (this.records.has(record.providerId) || [...this.records.values()].some((existing) => existing.id === record.id)) {
        throw new CompanySsoConflictError('Company SSO provider id is already in use');
      }
      this.records.set(record.providerId, clone(record));
    }
  }

  async create(record: CompanySsoProviderRecord): Promise<CompanySsoProviderRecord> {
    validateCompanySsoRecord(record);
    if (this.records.has(record.providerId) || [...this.records.values()].some((existing) => existing.id === record.id)) {
      throw new CompanySsoConflictError('Company SSO provider id is already in use');
    }
    this.records.set(record.providerId, clone(record));
    return clone(record);
  }

  async get(organizationId: string, providerId: string): Promise<CompanySsoProviderRecord | null> {
    const record = this.records.get(providerId);
    return record && record.organizationId === organizationId ? clone(record) : null;
  }

  async getByProviderId(providerId: string): Promise<CompanySsoProviderRecord | null> {
    const record = this.records.get(providerId);
    return record ? clone(record) : null;
  }

  async list(organizationId: string): Promise<CompanySsoProviderRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.organizationId === organizationId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.providerId.localeCompare(right.providerId))
      .map(clone);
  }

  async update(
    organizationId: string,
    providerId: string,
    patch: Partial<CompanySsoProviderRecord>,
    expectedRevision?: number,
  ): Promise<CompanySsoProviderRecord | null> {
    const existing = this.records.get(providerId);
    if (!existing || existing.organizationId !== organizationId || (expectedRevision !== undefined && existing.revision !== expectedRevision)) return null;
    const updated: CompanySsoProviderRecord = {
      ...existing,
      ...clone(patch),
      organizationId: existing.organizationId,
      providerId: existing.providerId,
      id: existing.id,
      revision: existing.revision + 1,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    validateCompanySsoRecord(updated);
    this.records.set(providerId, clone(updated));
    return clone(updated);
  }

  async delete(organizationId: string, providerId: string, expectedRevision?: number): Promise<boolean> {
    const existing = this.records.get(providerId);
    if (!existing || existing.organizationId !== organizationId || (expectedRevision !== undefined && existing.revision !== expectedRevision)) return false;
    this.records.delete(providerId);
    return true;
  }
}

export const createMemoryCompanySsoRepository = (initial: readonly CompanySsoProviderRecord[] = []): MemoryCompanySsoRepository => new MemoryCompanySsoRepository(initial);
