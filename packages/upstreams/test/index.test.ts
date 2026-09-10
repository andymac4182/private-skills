import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, it } from 'vitest';

import {
  acquireSkill,
  serializeSkillBundle,
  UpstreamAcquisitionError,
  validateUpstreamURL,
  validateSkillBundle,
} from '../src/index.js';

const COMMIT = '0123456789012345678901234567890123456789';

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)])).digest('hex');
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
}

function bytes(res: ServerResponse, value: Uint8Array): void {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(value.length) });
  res.end(Buffer.from(value));
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

describe('upstream acquisition', () => {
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let lastHeaders: Record<string, string> = {};
  let payload: Uint8Array;

  beforeAll(async () => {
    const skill = Buffer.from('# Fixture skill\n');
    const license = Buffer.from('MIT\n');
    payload = serializeSkillBundle({
      format: 'pskills-bundle-v1',
      files: [
        { path: 'SKILL.md', content: b64(skill.toString('utf8')) },
        { path: 'LICENSE', content: b64(license.toString('utf8')) },
      ],
    });
    const skillSha = gitBlobSha(skill);
    const licenseSha = gitBlobSha(license);
    server = createServer((req, res) => {
      lastHeaders = Object.fromEntries(Object.entries(req.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]));
      const requestURL = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
      if (requestURL.pathname === '/api/repos/octo/repo/commits/main') {
        json(res, { sha: COMMIT });
        return;
      }
      if (requestURL.pathname === `/api/repos/octo/repo/git/trees/${COMMIT}`) {
        json(res, {
          sha: COMMIT,
          truncated: false,
          tree: [
            { path: 'skills/demo', mode: '040000', type: 'tree', sha: 'tree' },
            { path: 'skills/demo/SKILL.md', mode: '100644', type: 'blob', sha: skillSha, size: skill.length },
            { path: 'skills/demo/LICENSE', mode: '100644', type: 'blob', sha: licenseSha, size: license.length },
          ],
        });
        return;
      }
      if (requestURL.pathname === `/api/repos/octo/repo/git/blobs/${skillSha}`) {
        json(res, { encoding: 'base64', content: skill.toString('base64'), size: skill.length, sha: skillSha });
        return;
      }
      if (requestURL.pathname === `/api/repos/octo/repo/git/blobs/${licenseSha}`) {
        json(res, { encoding: 'base64', content: license.toString('base64'), size: license.length, sha: licenseSha });
        return;
      }
      if (requestURL.pathname === '/payload') {
        bytes(res, payload);
        return;
      }
      json(res, { error: 'missing fixture route' }, 404);
    });
    origin = await listen(server);
  });

  afterAll(() => server.close());

  it('fetches a complete pinned GitHub directory and preserves support files', async () => {
    const result = await acquireSkill({
      upstream: {
        id: 'github-fixture',
        organizationId: 'org',
        name: 'fixture',
        kind: 'github',
        enabled: true,
        repositories: ['octo/repo'],
        baseUrl: `${origin}/api`,
        namespace: 'team',
      },
      importRequest: {
        upstreamId: 'github-fixture',
        repository: 'octo/repo',
        path: 'skills/demo',
        ref: 'main',
        name: '@team/demo',
        version: '1.0.0',
      },
      allowLoopbackForTests: true,
    });
    assert.deepEqual(result.bundle.files.map((file) => file.path), ['LICENSE', 'SKILL.md']);
    assert.equal(result.provenance.revision, COMMIT);
    assert.match(result.provenance.fetchedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(lastHeaders.authorization, undefined);
  });

  it('uses named environment credentials only for registry control-plane calls', async () => {
    process.env.PSKILLS_FIXTURE_TOKEN = 'fixture-secret';
    const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    const registry = createServer((req, res) => {
      const requestURL = new URL(req.url ?? '/', origin);
      const auth = req.headers.authorization;
      if (requestURL.pathname === '/v1/resolve') {
        assert.equal(auth, 'Bearer fixture-secret');
        const chain = req.headers['x-private-skills-proxy-chain'];
        const hop = req.headers['x-private-skills-proxy-hop'];
        if (typeof chain === 'string') res.setHeader('x-private-skills-proxy-chain', chain);
        if (typeof hop === 'string') res.setHeader('x-private-skills-proxy-hop', hop);
        json(res, { resolution: { kind: 'skill', resourceId: 'skill-1', organizationId: 'org', name: '@team/demo', version: '1.0.0', digest } });
        return;
      }
      if (requestURL.pathname === '/v1/install-authorizations') {
        assert.equal(auth, 'Bearer fixture-secret');
        const chain = req.headers['x-private-skills-proxy-chain'];
        const hop = req.headers['x-private-skills-proxy-hop'];
        if (typeof chain === 'string') res.setHeader('x-private-skills-proxy-chain', chain);
        if (typeof hop === 'string') res.setHeader('x-private-skills-proxy-hop', hop);
        json(res, { authorization: { id: 'auth-1', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
        return;
      }
      if (requestURL.pathname === `/v1/artifacts/${encodeURIComponent(digest)}/download` || decodeURIComponent(requestURL.pathname) === `/v1/artifacts/${digest}/download`) {
        assert.equal(auth, 'Bearer fixture-secret');
        const chain = req.headers['x-private-skills-proxy-chain'];
        const hop = req.headers['x-private-skills-proxy-hop'];
        if (typeof chain === 'string') res.setHeader('x-private-skills-proxy-chain', chain);
        if (typeof hop === 'string') res.setHeader('x-private-skills-proxy-hop', hop);
        json(res, { mode: 'gateway', url: `${origin}/payload`, method: 'GET', headers: { authorization: 'Bearer descriptor-secret', 'proxy-authorization': 'Basic descriptor-secret' }, size: payload.length, digest });
        return;
      }
      if (requestURL.pathname === '/payload') {
        assert.equal(auth, undefined);
        bytes(res, payload);
        return;
      }
      json(res, { error: 'missing fixture route' }, 404);
    });
    const registryOrigin = await listen(registry);
    try {
      const result = await acquireSkill({
        upstream: {
          id: 'registry-fixture',
          organizationId: 'org',
          name: 'fixture',
          kind: 'registry',
          enabled: true,
          baseUrl: registryOrigin,
          credentialEnv: 'PSKILLS_FIXTURE_TOKEN',
          namespace: 'team',
        },
        importRequest: {
          upstreamId: 'registry-fixture',
          path: '@team/demo',
          name: '@team/demo',
          version: '1.0.0',
        },
        allowLoopbackForTests: true,
      });
      assert.equal(result.provenance.kind, 'registry');
      assert.equal(result.provenance.sourceDigest, digest);
      assert.equal(lastHeaders.authorization, undefined);
      assert.equal(lastHeaders['proxy-authorization'], undefined);
    } finally {
      await new Promise<void>((resolve) => registry.close(() => resolve()));
      delete process.env.PSKILLS_FIXTURE_TOKEN;
    }
  });

  it('rejects loopback HTTP unless the explicit fixture switch is enabled', async () => {
    await assert.rejects(
      () => acquireSkill({
        upstream: {
          id: 'github-fixture', organizationId: 'org', name: 'fixture', kind: 'github', enabled: true,
          repositories: ['octo/repo'], baseUrl: origin, namespace: 'team',
        },
        importRequest: { upstreamId: 'github-fixture', repository: 'octo/repo', path: 'skills/demo', ref: 'main', name: '@team/demo', version: '1.0.0' },
      }),
      (error: unknown) => error instanceof UpstreamAcquisitionError && error.code === 'insecure_upstream',
    );
  });

  it('does not forward source credentials across an off-origin redirect', async () => {
    process.env.PSKILLS_REDIRECT_TOKEN = 'redirect-secret';
    const seen: Array<Record<string, string>> = [];
    try {
      await assert.rejects(
        () => acquireSkill({
          upstream: {
            id: 'github-redirect', organizationId: 'org', name: 'fixture', kind: 'github', enabled: true,
            repositories: ['octo/repo'], baseUrl: `${origin}/api`, credentialEnv: 'PSKILLS_REDIRECT_TOKEN', namespace: 'team',
          },
          importRequest: { upstreamId: 'github-redirect', repository: 'octo/repo', path: 'skills/demo', ref: 'main', name: '@team/demo', version: '1.0.0' },
          allowLoopbackForTests: true,
          fetchImpl: async (_input, init) => {
            seen.push({ ...(init?.headers ?? {}) });
            return new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } });
          },
        }),
        (error: unknown) => error instanceof UpstreamAcquisitionError && error.code === 'redirect_denied',
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.authorization, 'Bearer redirect-secret');
    } finally {
      delete process.env.PSKILLS_REDIRECT_TOKEN;
    }
  });

  it('rejects metadata and private destinations before any fetch', async () => {
    await assert.rejects(
      () => validateUpstreamURL('https://169.254.169.254/'),
      (error: unknown) => error instanceof UpstreamAcquisitionError && error.code === 'ssrf_denied',
    );
    await assert.rejects(
      () => validateUpstreamURL('https://localhost/'),
      (error: unknown) => error instanceof UpstreamAcquisitionError && error.code === 'ssrf_denied',
    );
  });
});

describe('bundle validation', () => {
  it('rejects traversal, collisions, plugin payloads, and binary content', () => {
    for (const file of [
      { path: '../SKILL.md', content: b64('x') },
      { path: 'a\\SKILL.md', content: b64('x') },
      { path: '.claude-plugin/plugin.json', content: b64('{}') },
      { path: 'SKILL.md', content: b64('\0binary') },
    ]) {
      assert.throws(
        () => validateSkillBundle({ format: 'pskills-bundle-v1', files: [file] }),
        UpstreamAcquisitionError,
      );
    }
  });

  it('preserves bounded binary support files as canonical base64', () => {
    const binary = Uint8Array.from([0, 1, 2, 255]);
    const bundle = validateSkillBundle({
      format: 'pskills-bundle-v1',
      files: [
        { path: 'SKILL.md', content: b64('# skill') },
        { path: 'assets/icon.bin', content: Buffer.from(binary).toString('base64') },
      ],
    });
    assert.equal(bundle.files[1]?.content, Buffer.from(binary).toString('base64'));
    assert.throws(
      () => validateSkillBundle({ format: 'pskills-bundle-v1', files: [{ path: 'SKILL.md', content: Buffer.from([0xff]).toString('base64') }] }),
      (error: unknown) => error instanceof UpstreamAcquisitionError && error.code === 'binary_file',
    );
    assert.throws(
      () => validateSkillBundle({
        format: 'pskills-bundle-v1',
        files: [{ path: 'SKILL.md', content: b64('# skill') }, { path: 'assets/icon.bin', content: Buffer.from(binary).toString('base64') }],
      }, { maxBinaryBytes: 1 }),
      (error: unknown) => error instanceof UpstreamAcquisitionError && error.code === 'binary_size_limit',
    );
    const explicitFalse = validateSkillBundle({
      format: 'pskills-bundle-v1',
      files: [{ path: 'SKILL.md', content: b64('# skill'), executable: false }],
    });
    assert.deepEqual(explicitFalse.files, [{ path: 'SKILL.md', content: b64('# skill') }]);
  });
});
