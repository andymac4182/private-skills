import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_SOURCE_IDS,
  createSourceCatalogAdapters,
  createSourceCatalogClientFromEnv,
  createSourceCatalogConfigurationFromEnv,
  SOURCE_TRUSTED_ORIGINS,
} from '../src/index.js';

describe('source catalog runtime composition', () => {
  it('registers every built-in source and exposes missing key-only sources safely', async () => {
    const client = createSourceCatalogClientFromEnv({ env: {} });
    const response = await client.list({ organizationId: 'tenant-a' });

    expect(response.sources.map((source) => source.id)).toEqual(BUILT_IN_SOURCE_IDS);
    expect(response.sources.find((source) => source.id === 'clawhub')?.availability.state).toBe('available');
    expect(response.sources.find((source) => source.id === 'tessl')?.availability.state).toBe('available');
    expect(response.sources.find((source) => source.id === 'github-openai-skills')?.availability.state).toBe('available');
    // SkillsMP accepts public reads and uses its key only for elevated rate
    // limits; the adapters that require keys fail closed below.
    expect(response.sources.find((source) => source.id === 'skillsmp')?.availability.state).toBe('available');
    expect(response.sources.find((source) => source.id === 'skills-directory')?.availability.state).toBe('unavailable');
    expect(response.sources.find((source) => source.id === 'skillhub-pro')?.availability.state).toBe('unavailable');
    expect(response.sources.find((source) => source.id === 'github-code-search')?.availability.state).toBe('unavailable');
    expect(response.sources.find((source) => source.id === 'github-custom')?.availability.state).toBe('unavailable');

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('Bearer ');
  });

  it('applies global and per-source enablement without removing descriptors', async () => {
    const globalDisabled = createSourceCatalogClientFromEnv({
      env: { PSKILLS_SOURCES_ENABLED: 'false' },
    });
    const globalResponse = await globalDisabled.list({ organizationId: 'tenant-a' });
    expect(globalResponse.sources).toHaveLength(BUILT_IN_SOURCE_IDS.length);
    expect(globalResponse.sources.every((source) => source.availability.state === 'disabled')).toBe(true);

    const perSource = createSourceCatalogClientFromEnv({
      env: {
        PSKILLS_SOURCES_JSON: JSON.stringify({
          sources: {
            clawhub: { enabled: false },
          },
        }),
      },
    });
    const perSourceResponse = await perSource.list({ organizationId: 'tenant-a' });
    expect(perSourceResponse.sources.find((source) => source.id === 'clawhub')?.availability).toMatchObject({
      state: 'disabled',
    });
    expect(perSourceResponse.sources.find((source) => source.id === 'tessl')?.availability.state).toBe('available');
  });

  it('accepts an exact custom GitHub repository allowlist from the server environment', async () => {
    const repositories = [
      { repository: 'acme/agent-skills', ref: 'main' },
      { repository: 'citypaul/.dotfiles', ref: 'main' },
    ];
    const adapters = createSourceCatalogAdapters({
      env: {
        PSKILLS_GITHUB_CUSTOM_REPOSITORIES: JSON.stringify(repositories),
      },
    });
    const custom = adapters.find((adapter) => adapter.id === 'github-custom');

    expect(custom?.availability({ organizationId: 'tenant-a' })).toMatchObject({ state: 'available' });
    expect(custom?.configRevision).toContain('acme/agent-skills@main');
    expect(custom?.configRevision).toContain('citypaul/.dotfiles@main');
    expect(adapters.map((adapter) => adapter.id)).toEqual(BUILT_IN_SOURCE_IDS);
  });

  it('keeps trust origins fixed and rejects malformed server configuration', () => {
    const config = createSourceCatalogConfigurationFromEnv({
      PSKILLS_SOURCES_JSON: JSON.stringify({
        sources: {
          skillsmp: { enabled: true, trustedOrigins: ['https://skillsmp.com'] },
        },
      }),
    });
    expect(config.sources?.skillsmp?.trustedOrigins).toEqual(['https://skillsmp.com']);
    expect(SOURCE_TRUSTED_ORIGINS.skillsmp).toContain('https://github.com');

    expect(() => createSourceCatalogConfigurationFromEnv({
      PSKILLS_SOURCES_JSON: JSON.stringify({
        sources: { tessl: { trustedOrigins: ['https://evil.example'] } },
      }),
    })).toThrow(/fixed provider boundary/i);
    expect(() => createSourceCatalogConfigurationFromEnv({
      PSKILLS_GITHUB_CUSTOM_REPOSITORIES: JSON.stringify(['https://github.com/acme/skills']),
    })).toThrow(/invalid repository/i);
    expect(() => createSourceCatalogConfigurationFromEnv({
      PSKILLS_SOURCES_JSON: JSON.stringify({
        sources: { tessl: { repositories: [{ repository: 'acme/skills' }] } },
      }),
    })).toThrow(/unknown setting/i);
  });
});
