import { describe, expect, it, vi } from 'vitest';

import {
  COMPUTE_SDK_VERSIONS,
  createComputeSdkVercelSdk,
  createSandboxProvider,
  SandboxProviderError,
  type ComputeSdkVercelModule,
  type ComputeSdkVercelProvider,
  type SandboxCreateOptions,
} from '../src/index.js';

const IMAGE = `registry.example/scanner@sha256:${'a'.repeat(64)}`;
const SNAPSHOT = 'snapshot-2026-09-10';

function oidcToken(teamId: string, projectId: string): string {
  const payload = Buffer.from(JSON.stringify({ owner_id: teamId, project_id: projectId })).toString('base64url');
  return ['header', payload, 'signature'].join('.');
}

function versionEvidence() {
  return { ...COMPUTE_SDK_VERSIONS };
}

interface Harness {
  native: Record<string, unknown>;
  createOptions?: Record<string, unknown>;
  commandOptions?: Record<string, unknown>;
  writeCount: number;
  genericDestroyCount: number;
}

function fakeModule(options: {
  source?: 'image' | 'snapshot';
  networkPolicy?: unknown;
  persistent?: unknown;
  image?: unknown;
  sourceSnapshotId?: unknown;
  timeout?: unknown;
  vcpus?: unknown;
  stop?: () => Promise<unknown>;
  getInstance?: () => unknown;
} = {}): { module: ComputeSdkVercelModule; harness: Harness } {
  const harness: Harness = {
    native: {},
    writeCount: 0,
    genericDestroyCount: 0,
  };
  const command = {
    async wait() {
      return { exitCode: 0, durationMs: 12 };
    },
    async *logs() {
      yield { stream: 'stdout', data: 'native output\n' };
    },
    async kill() {
      // The native control is intentionally observable in the test below.
    },
  };
  const native = {
    fs: {
      async stat(path: string) {
        return { size: path.length, isFile: () => true, isSymbolicLink: () => false };
      },
      async lstat(path: string) {
        return { size: path.length, isFile: () => true, isSymbolicLink: () => false };
      },
      async readFile() {
        return Buffer.from('read');
      },
    },
    persistent: options.persistent ?? false,
    networkPolicy: options.networkPolicy ?? 'deny-all',
    image: options.image ?? (options.source === 'snapshot' ? undefined : IMAGE),
    sourceSnapshotId: options.sourceSnapshotId ?? (options.source === 'snapshot' ? SNAPSHOT : undefined),
    timeout: options.timeout ?? 2_000,
    vcpus: options.vcpus ?? 2,
    async mkDir() {
      // Native directory operation.
    },
    async writeFiles() {
      harness.writeCount += 1;
    },
    async readFileToBuffer() {
      return Buffer.from([0, 255, 1]);
    },
    async runCommand(commandOptions: Record<string, unknown>) {
      harness.commandOptions = commandOptions;
      return command;
    },
    async stop() {
      if (options.stop) return options.stop();
      return { stopped: true };
    },
  };
  harness.native = native;
  const provider: ComputeSdkVercelProvider = {
    name: 'vercel',
    sandbox: {
      async create(createOptions) {
        harness.createOptions = createOptions;
        return {
          sandboxId: 'sandbox-test-1',
          getInstance: options.getInstance ?? (() => native),
          async destroy() {
            harness.genericDestroyCount += 1;
          },
        };
      },
    },
  };
  return {
    module: {
      versions: versionEvidence(),
      vercel: () => provider,
      oidcTokenResolver: async () => oidcToken('team-test', 'project-test'),
    },
    harness,
  };
}

function createOptions(source: 'image' | 'snapshot' = 'image'): SandboxCreateOptions {
  return source === 'image'
    ? {
        image: IMAGE,
        resources: { vcpus: 2 },
        timeout: 2_000,
        networkPolicy: 'deny-all',
        persistent: false,
      }
    : {
        source: { type: 'snapshot', snapshotId: SNAPSHOT },
        resources: { vcpus: 2 },
        timeout: 2_000,
        networkPolicy: 'deny-all',
        persistent: false,
      };
}

describe('ComputeSDK Vercel sandbox provider', () => {
  it('rejects unsupported provider names before constructing a client', () => {
    expect(() => createSandboxProvider({ provider: 'e2b' })).toThrowError(
      expect.objectContaining({ code: 'unsupported-provider' }),
    );
  });

  it('rejects an injected provider whose identity does not match the selected adapter', async () => {
    const { module } = fakeModule();
    const wrongIdentity = {
      ...module,
      vercel: () => ({ ...module.vercel!({}), name: 'daytona' }),
    };
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => wrongIdentity });
    await expect(sdk.Sandbox.create(createOptions())).rejects.toThrow(
      'provider factory did not identify the Vercel provider',
    );
  });

  it('requires an explicit Vercel provider identity', async () => {
    const { module } = fakeModule();
    const unnamed = {
      ...module,
      vercel: () => {
        const provider = module.vercel!({});
        const { name: _name, ...withoutName } = provider;
        return withoutName;
      },
    };
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => unnamed });
    await expect(sdk.Sandbox.create(createOptions())).rejects.toThrow(
      'provider factory did not identify the Vercel provider',
    );
  });

  it('forwards the complete security create contract and authenticates per provider instance', async () => {
    const { module, harness } = fakeModule();
    const providerFactory = vi.fn(() => module.vercel!({}));
    const oidcTokenResolver = vi.fn(async () => oidcToken('unused-team', 'unused-project'));
    const sdk = await createComputeSdkVercelSdk({
      auth: { token: 'token-value', teamId: 'team-value', projectId: 'project-value' },
      moduleLoader: async () => module,
      providerFactory,
      oidcTokenResolver,
      versionEvidence: versionEvidence(),
    });
    const signal = new AbortController().signal;
    await sdk.Sandbox.create({ ...createOptions(), signal });

    expect(providerFactory).toHaveBeenCalledWith({
      token: 'token-value',
      teamId: 'team-value',
      projectId: 'project-value',
      ports: [],
      daemonSsePort: false,
    });
    expect(harness.createOptions).toEqual({
      image: IMAGE,
      resources: { vcpus: 2 },
      timeout: 2_000,
      networkPolicy: 'deny-all',
      persistent: false,
      signal,
    });
    expect(oidcTokenResolver).not.toHaveBeenCalled();
  });

  it('redacts provider factory failures', async () => {
    const { module } = fakeModule();
    const secret = 'Authorization: Bearer factory-secret';
    const providerFactory = vi.fn(() => {
      throw new Error(secret);
    });

    const failure = await createComputeSdkVercelSdk({
      auth: { token: 'token-value', teamId: 'team-value', projectId: 'project-value' },
      moduleLoader: async () => module,
      providerFactory,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SandboxProviderError);
    expect(failure).toMatchObject({
      code: 'missing-dependency',
      message: 'Vercel sandbox provider could not be initialized',
    });
    expect((failure as Error).message).not.toContain(secret);
  });

  it('redacts provider sandbox creation failures', async () => {
    const { module } = fakeModule();
    const secret = 'Authorization: Bearer create-secret';
    const providerFactory = vi.fn(() => {
      const provider = module.vercel!({});
      return {
        ...provider,
        sandbox: {
          async create() {
            throw new Error(secret);
          },
        },
      };
    });
    const sdk = await createComputeSdkVercelSdk({
      auth: { token: 'token-value', teamId: 'team-value', projectId: 'project-value' },
      moduleLoader: async () => module,
      providerFactory,
    });

    const failure = await sdk.Sandbox.create(createOptions()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxProviderError);
    expect(failure).toMatchObject({
      code: 'missing-dependency',
      message: 'Vercel sandbox could not be created',
    });
    expect((failure as Error).message).not.toContain(secret);
  });

  it('redacts provider module import failures', async () => {
    const secret = 'Authorization: Bearer import-secret';
    const failure = await createComputeSdkVercelSdk({
      moduleLoader: async () => {
        throw new Error(secret);
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SandboxProviderError);
    expect(failure).toMatchObject({
      code: 'missing-dependency',
      message: 'sandbox provider module could not be loaded',
    });
    expect((failure as Error).message).not.toContain(secret);
  });

  it('redacts dynamic import failures', async () => {
    const secret = 'Authorization: Bearer dynamic-import-secret';
    class ThrowingFunction {
      constructor() {
        throw new Error(secret);
      }
    }
    vi.stubGlobal('Function', ThrowingFunction);
    let failure: unknown;
    try {
      failure = await createComputeSdkVercelSdk().catch((error: unknown) => error);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(failure).toBeInstanceOf(SandboxProviderError);
    expect(failure).toMatchObject({
      code: 'missing-dependency',
      message: 'sandbox provider module could not be loaded',
    });
    expect((failure as Error).message).not.toContain(secret);
  });

  it('resolves independent OIDC credentials for concurrent creates', async () => {
    const { module } = fakeModule();
    const tokens = [
      oidcToken('team-one', 'project-one'),
      oidcToken('team-two', 'project-two'),
    ];
    let nextToken = 0;
    const oidcTokenResolver = vi.fn(async () => {
      const token = tokens[nextToken++];
      await new Promise((resolve) => setTimeout(resolve, token === tokens[0] ? 10 : 0));
      return token!;
    });
    const configs: Array<Record<string, unknown>> = [];
    const providerFactory = vi.fn((config: Record<string, unknown>) => {
      configs.push(config);
      return module.vercel!({ ...config });
    });
    const sdk = await createComputeSdkVercelSdk({
      moduleLoader: async () => module,
      providerFactory,
      oidcTokenResolver,
    });

    await Promise.all([
      sdk.Sandbox.create(createOptions()),
      sdk.Sandbox.create(createOptions()),
    ]);

    expect(oidcTokenResolver).toHaveBeenCalledTimes(2);
    expect(configs.map((config) => ({
      token: config.token,
      teamId: config.teamId,
      projectId: config.projectId,
    }))).toEqual(expect.arrayContaining([
      { token: tokens[0], teamId: 'team-one', projectId: 'project-one' },
      { token: tokens[1], teamId: 'team-two', projectId: 'project-two' },
    ]));
  });

  it('rejects helper tokens without tenant claims before provider creation', async () => {
    const { module } = fakeModule();
    const providerFactory = vi.fn(() => module.vercel!({}));
    const sdk = await createComputeSdkVercelSdk({
      moduleLoader: async () => module,
      providerFactory,
      oidcTokenResolver: async () => oidcToken('team-only', 'project-only').replace(
        Buffer.from(JSON.stringify({ owner_id: 'team-only', project_id: 'project-only' })).toString('base64url'),
        Buffer.from(JSON.stringify({ owner_id: 'team-only' })).toString('base64url'),
      ),
    });

    await expect(sdk.Sandbox.create(createOptions())).rejects.toThrowError(
      expect.objectContaining({ code: 'invalid-auth' }),
    );
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('fails closed on missing request credentials even when a global PAT is present', async () => {
    const { module } = fakeModule();
    const providerFactory = vi.fn(() => module.vercel!({}));
    vi.stubEnv('VERCEL_TOKEN', 'legacy-token');
    vi.stubEnv('VERCEL_TEAM_ID', 'legacy-team');
    vi.stubEnv('VERCEL_PROJECT_ID', 'legacy-project');
    try {
      const sdk = await createComputeSdkVercelSdk({
        moduleLoader: async () => module,
        providerFactory,
        oidcTokenResolver: async () => {
          throw new Error('request has no OIDC context');
        },
      });

      await expect(sdk.Sandbox.create(createOptions())).rejects.toThrowError(
        expect.objectContaining({ code: 'invalid-auth' }),
      );
      expect(providerFactory).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses getInstance native argv, byte files, bounded-log handles, and native stop', async () => {
    const { module, harness } = fakeModule();
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    const sandbox = await sdk.Sandbox.create(createOptions());

    await sandbox.mkDir('/vercel/sandbox/private-skills/input');
    await sandbox.writeFiles([{ path: '/vercel/sandbox/private-skills/input/blob', content: Buffer.from([0, 255]), mode: 0o755 }]);
    expect(harness.writeCount).toBe(1);
    await expect(sandbox.readFileToBuffer?.({ path: '/vercel/sandbox/private-skills/input/blob' })).resolves.toEqual(Buffer.from([0, 255, 1]));
    await expect(sandbox.fs.stat('/vercel/sandbox/private-skills/input/blob')).resolves.toMatchObject({ size: expect.any(Number) });

    const command = await sandbox.runCommand({
      cmd: 'scanner',
      args: ['--input', '/vercel/sandbox/private-skills/input', '--literal', '$(touch pwned)'],
      cwd: '/vercel/sandbox/private-skills/input',
      env: { LANG: 'C.UTF-8' },
      detached: true,
    });
    expect(harness.commandOptions).toEqual({
      cmd: 'scanner',
      args: ['--input', '/vercel/sandbox/private-skills/input', '--literal', '$(touch pwned)'],
      cwd: '/vercel/sandbox/private-skills/input',
      env: { LANG: 'C.UTF-8' },
      detached: true,
    });
    await expect(command.wait()).resolves.toMatchObject({ exitCode: 0 });
    const logs: Array<{ stream: string; data: string }> = [];
    for await (const log of command.logs?.() ?? []) logs.push(log);
    expect(logs).toEqual([{ stream: 'stdout', data: 'native output\n' }]);
    await expect(sandbox.stop()).resolves.toMatchObject({ stopped: true });
    expect(harness.genericDestroyCount).toBe(0);
    expect(sandbox.capabilities).toMatchObject({
      provider: 'vercel',
      networkPolicy: 'deny-all',
      persistent: false,
      argv: true,
      binaryFiles: true,
      cleanup: 'native-stop-errors-fatal',
    });
  });

  it('preserves a sanitized ENOENT marker for optional output lookups', async () => {
    const { module, harness } = fakeModule();
    const nativeFs = harness.native.fs as {
      lstat: (path: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
    };
    nativeFs.lstat = async () => {
      const failure = new Error('Authorization: Bearer missing-file-secret') as Error & { code: 'ENOENT' };
      failure.code = 'ENOENT';
      throw failure;
    };
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    const sandbox = await sdk.Sandbox.create(createOptions());

    const failure = await sandbox.fs.lstat!('/vercel/sandbox/private-skills/output/missing.json')
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'ENOENT',
      message: 'Vercel native filesystem entry was not found',
    });
    expect((failure as Error).message).not.toContain('missing-file-secret');
    expect((failure as Error).message).not.toContain('Authorization');
    expect(Object.prototype.hasOwnProperty.call(failure, 'cause')).toBe(false);
  });

  it('rejects an unverified network or persistence capability before file transfer', async () => {
    const { module, harness } = fakeModule({ networkPolicy: 'allow-all' });
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    await expect(sdk.Sandbox.create(createOptions())).rejects.toThrowError(
      expect.objectContaining({ code: 'unsupported-capability' }),
    );
    expect(harness.writeCount).toBe(0);
  });

  it('stops a newly created native sandbox when capability attestation fails', async () => {
    let stopCount = 0;
    const { module } = fakeModule({
      networkPolicy: 'allow-all',
      stop: async () => {
        stopCount += 1;
      },
    });
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    await expect(sdk.Sandbox.create(createOptions())).rejects.toThrow(/networkPolicy=deny-all/);
    expect(stopCount).toBe(1);
  });

  it('attempts best-effort generic cleanup when getInstance throws and never returns a sandbox', async () => {
    const { module, harness } = fakeModule({
      getInstance: () => {
        throw new Error('Authorization: Bearer native-unwrap-secret');
      },
    });
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    const failure = await sdk.Sandbox.create(createOptions()).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'cleanup-failed',
      message: 'Vercel native sandbox cleanup completed through an unverified fallback',
    });
    expect((failure as Error).message).not.toContain('native-unwrap-secret');
    expect((failure as Error).message).not.toContain('Authorization');
    expect(harness.genericDestroyCount).toBe(1);
  });

  it('forwards immutable snapshot source and rejects options the adapter cannot preserve', async () => {
    const { module, harness } = fakeModule({ source: 'snapshot' });
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    await sdk.Sandbox.create(createOptions('snapshot'));
    expect(harness.createOptions).toMatchObject({
      source: { type: 'snapshot', snapshotId: SNAPSHOT },
      networkPolicy: 'deny-all',
      persistent: false,
    });
    await expect(sdk.Sandbox.create({ ...createOptions(), providerOptionThatWouldBeDropped: true } as never)).rejects.toThrow(
      'sandbox create option providerOptionThatWouldBeDropped is unsupported',
    );
  });

  it('rejects version mismatches before the provider can create a remote sandbox', async () => {
    const { module } = fakeModule();
    const providerFactory = vi.fn(() => module.vercel!({}));
    await expect(createComputeSdkVercelSdk({
      moduleLoader: async () => ({ ...module, versions: { ...versionEvidence(), nativeVercel: '3.1.0' } }),
      providerFactory,
    })).rejects.toThrowError(new RegExp(`nativeVercel expected ${COMPUTE_SDK_VERSIONS.nativeVercel}`));
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('propagates native stop failures instead of using ComputeSDK destroy swallowing', async () => {
    const { module, harness } = fakeModule({ stop: async () => { throw new Error('Authorization: Bearer native-stop-secret'); } });
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    const sandbox = await sdk.Sandbox.create(createOptions());
    const failure = await sandbox.stop().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'cleanup-failed',
      message: 'Vercel native sandbox cleanup failed',
    });
    expect((failure as Error).message).not.toContain('native-stop-secret');
    expect((failure as Error).message).not.toContain('Authorization');
    expect(harness.genericDestroyCount).toBe(0);
  });

  it('requires complete traditional Vercel credentials when environment auth is disabled', async () => {
    const { module } = fakeModule();
    await expect(createComputeSdkVercelSdk({ allowEnvironmentAuth: false, moduleLoader: async () => module })).rejects.toThrowError(
      'Vercel sandbox auth requires explicit token/teamId/projectId when environment auth is disabled',
    );
  });
});
