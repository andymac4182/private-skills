import { describe, expect, it, vi } from 'vitest';

import {
  COMPUTE_SDK_VERSIONS,
  createComputeSdkVercelSdk,
  createSandboxProvider,
  type ComputeSdkVercelModule,
  type ComputeSdkVercelProvider,
  type SandboxCreateOptions,
} from '../src/index.js';

const IMAGE = `registry.example/scanner@sha256:${'a'.repeat(64)}`;
const SNAPSHOT = 'snapshot-2026-09-10';

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
    module: { versions: versionEvidence(), vercel: () => provider },
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
    await expect(createComputeSdkVercelSdk({ moduleLoader: async () => wrongIdentity })).rejects.toThrow(
      'provider factory returned unsupported provider daytona',
    );
  });

  it('forwards the complete security create contract and authenticates per provider instance', async () => {
    const { module, harness } = fakeModule();
    const providerFactory = vi.fn(() => module.vercel!({}));
    const sdk = await createComputeSdkVercelSdk({
      auth: { token: 'token-value', teamId: 'team-value', projectId: 'project-value' },
      moduleLoader: async () => module,
      providerFactory,
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
        throw new Error('native unwrap failed');
      },
    });
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    await expect(sdk.Sandbox.create(createOptions())).rejects.toThrow(
      /native unwrap failed.*best-effort generic cleanup completed but cleanup is unverified/,
    );
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
    const { module, harness } = fakeModule({ stop: async () => { throw new Error('native stop failed'); } });
    const sdk = await createComputeSdkVercelSdk({ moduleLoader: async () => module });
    const sandbox = await sdk.Sandbox.create(createOptions());
    await expect(sandbox.stop()).rejects.toThrow('native stop failed');
    expect(harness.genericDestroyCount).toBe(0);
  });

  it('requires complete traditional Vercel credentials when environment auth is disabled', async () => {
    const { module } = fakeModule();
    await expect(createComputeSdkVercelSdk({ allowEnvironmentAuth: false, moduleLoader: async () => module })).rejects.toThrowError(
      'Vercel sandbox auth requires explicit token/teamId/projectId when environment auth is disabled',
    );
  });
});
