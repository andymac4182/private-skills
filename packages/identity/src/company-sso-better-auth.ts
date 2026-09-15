import type { DBAdapter } from 'better-auth';

import {
  CompanySsoConflictError,
  CompanySsoRepositoryError,
  type CompanySsoProviderRecord,
  type CompanySsoProviderRepository,
} from './company-sso-types.js';
import { toBetterAuthCompanySsoProvider } from './company-sso-validation.js';

const SSO_PROVIDER_MODEL = 'ssoProvider';

/** The subset of Better Auth's adapter used by the trusted registry bridge. */
export type CompanySsoBetterAuthAdapter = Pick<DBAdapter, 'create' | 'findOne' | 'update' | 'delete'>;

/** A Better Auth instance or compatible test double exposing its server context. */
export interface CompanySsoBetterAuthHandle {
  $context: PromiseLike<{ adapter: CompanySsoBetterAuthAdapter }>;
}

/**
 * A trusted server-side bridge from the private company registry to Better
 * Auth's `ssoProvider` model. The browser-facing SSO registration endpoints
 * remain disabled; this is the only registration path for company providers.
 */
export interface CompanySsoProviderBridge {
  upsert(record: CompanySsoProviderRecord): Promise<void>;
  remove(record: CompanySsoProviderRecord): Promise<void>;
}

function providerRow(record: CompanySsoProviderRecord): Record<string, unknown> {
  const provider = toBetterAuthCompanySsoProvider(record);
  return {
    // `forceAllowId` is set on create below. Without it Better Auth adapters
    // intentionally replace a supplied id with a generated one, which would
    // break the persisted-provider reference fence in the SSO plugin.
    id: provider.id,
    issuer: provider.issuer,
    oidcConfig: provider.oidcConfig ? JSON.stringify(provider.oidcConfig) : null,
    samlConfig: provider.samlConfig ? JSON.stringify(provider.samlConfig) : null,
    userId: provider.userId,
    providerId: provider.providerId,
    organizationId: provider.organizationId,
    domain: provider.domain,
  };
}

function exactWhere(record: CompanySsoProviderRecord): Array<{ field: string; value: string }> {
  return [
    { field: 'id', value: record.id },
    { field: 'providerId', value: record.providerId },
    { field: 'organizationId', value: record.organizationId },
  ];
}

function isCompatibleExistingRow(existing: Record<string, unknown>, record: CompanySsoProviderRecord): boolean {
  return existing.id === record.id
    && existing.providerId === record.providerId
    && existing.organizationId === record.organizationId
    && existing.userId === record.createdBy;
}

/** Convert one validated registry row to the exact Better Auth DB shape. */
export function toBetterAuthSsoProviderRow(record: CompanySsoProviderRecord): Record<string, unknown> {
  return providerRow(record);
}

/**
 * Upsert one provider into Better Auth while preserving the private registry
 * row id. A provider-id collision with any other Better Auth row is rejected;
 * it is never overwritten by a company admin request.
 */
export async function syncCompanySsoProvider(
  auth: CompanySsoBetterAuthHandle,
  record: CompanySsoProviderRecord,
): Promise<void> {
  const row = providerRow(record);
  const { adapter } = await auth.$context;
  let existing: Record<string, unknown> | null;
  try {
    existing = await adapter.findOne({
      model: SSO_PROVIDER_MODEL,
      where: [{ field: 'providerId', value: record.providerId }],
    });
  } catch {
    throw new CompanySsoRepositoryError('Better Auth provider lookup failed');
  }
  if (existing && !isCompatibleExistingRow(existing, record)) {
    throw new CompanySsoConflictError('Better Auth provider id is already bound to another provider');
  }
  try {
    if (existing) {
      const { id: _id, ...update } = row;
      const updated = await adapter.update({
        model: SSO_PROVIDER_MODEL,
        where: exactWhere(record),
        update,
      });
      if (!updated) throw new Error('provider row was not updated');
      const mirrored = await adapter.findOne<Record<string, unknown>>({
        model: SSO_PROVIDER_MODEL,
        where: [{ field: 'providerId', value: record.providerId }],
      });
      if (!mirrored || !isCompatibleExistingRow(mirrored, record)) throw new Error('provider row identity changed');
      return;
    }
    const created = await adapter.create({
      model: SSO_PROVIDER_MODEL,
      data: row,
      forceAllowId: true,
    });
    // Verify the adapter honored forceAllowId. This read-back is deliberate:
    // a custom adapter that silently generates another id would make every
    // callback fail the SSO persisted-reference fence.
    const mirrored = await adapter.findOne<Record<string, unknown>>({
      model: SSO_PROVIDER_MODEL,
      where: [{ field: 'providerId', value: record.providerId }],
    });
    if (!created || created.id !== record.id || !mirrored || !isCompatibleExistingRow(mirrored, record)) {
      await adapter.delete({ model: SSO_PROVIDER_MODEL, where: [{ field: 'providerId', value: record.providerId }] }).catch(() => undefined);
      throw new Error('provider row id was not preserved');
    }
  } catch (error) {
    if (error instanceof CompanySsoConflictError) throw error;
    throw new CompanySsoRepositoryError('Better Auth provider synchronization failed');
  }
}

/** Remove one exact company provider from Better Auth after registry deletion. */
export async function removeCompanySsoProvider(
  auth: CompanySsoBetterAuthHandle,
  record: CompanySsoProviderRecord,
): Promise<void> {
  const { adapter } = await auth.$context;
  let existing: Record<string, unknown> | null;
  try {
    existing = await adapter.findOne({
      model: SSO_PROVIDER_MODEL,
      where: [{ field: 'providerId', value: record.providerId }],
    });
  } catch {
    throw new CompanySsoRepositoryError('Better Auth provider lookup failed');
  }
  if (!existing) return;
  if (!isCompatibleExistingRow(existing, record)) {
    throw new CompanySsoConflictError('Better Auth provider binding does not match the company registry');
  }
  try {
    await adapter.delete({ model: SSO_PROVIDER_MODEL, where: exactWhere(record) });
  } catch {
    throw new CompanySsoRepositoryError('Better Auth provider removal failed');
  }
}

/** Adapter-backed bridge factory for API handlers and runtime adoption code. */
export function createCompanySsoBetterAuthBridge(auth: CompanySsoBetterAuthHandle): CompanySsoProviderBridge {
  return {
    upsert: (record) => syncCompanySsoProvider(auth, record),
    remove: (record) => removeCompanySsoProvider(auth, record),
  };
}

/**
 * Synchronize all registry rows for an explicit organization list. Callers
 * must provide the list from their trusted organization catalog; this helper
 * intentionally has no global or email-domain discovery mode.
 */
export async function syncCompanySsoProviders(
  auth: CompanySsoBetterAuthHandle,
  repository: CompanySsoProviderRepository,
  organizationIds: readonly string[],
): Promise<void> {
  for (const organizationId of organizationIds) {
    const records = await repository.list(organizationId);
    for (const record of records) await syncCompanySsoProvider(auth, record);
  }
}
