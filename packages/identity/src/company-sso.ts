import { createCompanySsoApi, type CompanySsoApi, type CompanySsoApiOptions } from './company-sso-api.js';
import { createCompanySsoPlugin, companySsoPluginOptions } from './company-sso-plugin.js';
import {
  toBetterAuthCompanySsoProvider,
  explicitCompanySsoSelection,
} from './company-sso-validation.js';
import {
  COMPANY_SSO_SCHEMA_SQL,
} from './company-sso-repository.js';
import type { CompanySsoProviderRecord, CompanySsoProviderRepository } from './company-sso-types.js';

export * from './company-sso-types.js';
export * from './company-sso-validation.js';
export * from './company-sso-repository.js';
export * from './company-sso-api.js';
export * from './company-sso-plugin.js';
export * from './company-sso-better-auth.js';

export interface CompanySsoModule extends CompanySsoApi {
  repository: CompanySsoProviderRepository;
  /** Explicit migration text for review by the deployment migration runner. */
  schemaSql: string;
  /** Better Auth plugin with registration/mutation disabled for browser callers. */
  plugin: ReturnType<typeof createCompanySsoPlugin>;
  /** Options for callers that need to compose the plugin with other options. */
  pluginOptions: ReturnType<typeof companySsoPluginOptions>;
  getRuntimeProvider(organizationId: string, providerId: string): Promise<ReturnType<typeof toBetterAuthCompanySsoProvider> | null>;
  selectProvider(organizationId: string, providerId: string, appOrigin: string, allowLoopbackHttp?: boolean): Promise<ReturnType<typeof explicitCompanySsoSelection> | null>;
}

export function createCompanySsoModule(options: CompanySsoApiOptions): CompanySsoModule {
  const api = createCompanySsoApi(options);
  return {
    ...api,
    repository: options.repository,
    schemaSql: COMPANY_SSO_SCHEMA_SQL,
    plugin: createCompanySsoPlugin({ repository: options.repository }),
    pluginOptions: companySsoPluginOptions({ repository: options.repository }),
    getRuntimeProvider: async (organizationId, providerId) => {
      const record = await options.repository.get(organizationId, providerId);
      if (!record || record.status !== 'active') return null;
      return toBetterAuthCompanySsoProvider(record);
    },
    selectProvider: async (organizationId, providerId, appOrigin, allowLoopbackHttp = false) => {
      const record: CompanySsoProviderRecord | null = await options.repository.get(organizationId, providerId);
      if (!record) return null;
      return explicitCompanySsoSelection(record, organizationId, providerId, appOrigin, allowLoopbackHttp);
    },
  };
}
