import { sso, type SSOOptions } from '@better-auth/sso';

import {
  CompanySsoError,
  type CompanySsoProviderRepository,
} from './company-sso-types.js';

export interface CompanySsoPluginOptions {
  repository: CompanySsoProviderRepository;
}

function companySsoOptions(options: CompanySsoPluginOptions): SSOOptions {
  return {
    providersLimit: 0,
    domainVerification: { enabled: false },
    organizationProvisioning: {
      disabled: false,
      defaultRole: 'member',
    },
    resolveUser: async (input) => {
      const provider = await options.repository.getByProviderId(input.providerId);
      const source = input.providerReference.source;
      const exactPersistedRecord = source.type === 'persisted' && source.recordId === provider?.id;
      if (!provider || provider.status !== 'active' || input.providerReference.providerId !== provider.providerId || !exactPersistedRecord) {
        return { action: 'reject', code: 'COMPANY_SSO_PROVIDER_BINDING_INVALID', message: 'Company SSO provider binding is invalid' };
      }
      if (provider.issuer !== input.accountKey.issuer) {
        return { action: 'reject', code: 'COMPANY_SSO_ISSUER_MISMATCH', message: 'Company SSO issuer is not authorized for this provider' };
      }
      return { action: 'continue' };
    },
    // The admin API performs validated changes. Better Auth's generic mutation
    // endpoints must never provide a second path around that authorization.
    guardProviderMutation: async () => {
      throw new CompanySsoError('COMPANY_SSO_MUTATION_OWNERSHIP', 'Company SSO provider mutations must use the company admin API', 403);
    },
  };
}

/**
 * Better Auth adapter for the company provider registry.
 *
 * Provider registration and mutation are owned by the company admin API. The
 * Better Auth SSO registration endpoint is disabled (`providersLimit: 0`) so
 * a browser cannot submit a user-controlled organizationId. The resolver
 * rechecks the exact persisted provider binding before account finalization.
 * Domain verification remains disabled because this feature uses explicit
 * company portal selection; callers must reject domain-based sign-in requests.
 */
export function createCompanySsoPlugin(options: CompanySsoPluginOptions): ReturnType<typeof sso> {
  return sso(companySsoOptions(options));
}

/** Structural options for callers that compose `sso()` into Better Auth. */
export function companySsoPluginOptions(options: CompanySsoPluginOptions): SSOOptions {
  return companySsoOptions(options);
}
