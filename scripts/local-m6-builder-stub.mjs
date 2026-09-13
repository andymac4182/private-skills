import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.LOCAL_BUILDER_PORT ?? '5196');
const registryOrigin = required('LOCAL_REGISTRY_ORIGIN');
const serviceToken = required('LOCAL_BUILDER_SERVICE_TOKEN');
const eveToken = required('LOCAL_BUILDER_EVE_TOKEN');
const registryToken = required('LOCAL_BUILDER_REGISTRY_TOKEN');
const certificatePath = required('LOCAL_BUILDER_CERT');
const keyPath = required('LOCAL_BUILDER_KEY');
const logPath = required('LOCAL_BUILDER_LOG');

assertLoopbackRegistryOrigin(registryOrigin);

const sessions = new Map();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function assertLoopbackRegistryOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('LOCAL_REGISTRY_ORIGIN must be a URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('LOCAL_REGISTRY_ORIGIN must be a plain loopback HTTP origin');
  }
}

function log(event) {
  appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function unauthorized(res) {
  json(res, 401, { code: 'UNAUTHORIZED', message: 'Authentication is required' });
}

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 128 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSessionInput(value) {
  if (!isRecord(value)) throw new Error('invalid session input');
  for (const key of ['sessionKey', 'registrySessionId', 'draftId', 'digest', 'message', 'requestId', 'requestDigest']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) throw new Error(`missing ${key}`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('invalid revision');
  if (value.selectedPath !== undefined && typeof value.selectedPath !== 'string') throw new Error('invalid selectedPath');
}

async function registryJson(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${registryToken}`);
  headers.set('x-pskills-tool-identity', 'skill-builder');
  const response = await fetch(new URL(path, registryOrigin), {
    ...init,
    headers,
    redirect: 'error',
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('registry returned invalid json'); }
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
  return value;
}

async function makeProposal(input) {
  const context = await registryJson(
    `/v1/drafts/${encodeURIComponent(input.draftId)}/builder-context?revision=${input.revision}&digest=${encodeURIComponent(input.digest)}`,
  );
  if (!isRecord(context) || !Array.isArray(context.files)) throw new Error('registry context is invalid');
  const selectedPath = input.selectedPath ?? context.files.find((file) => isRecord(file) && file.kind === 'text' && file.contentAvailable === true)?.path;
  if (typeof selectedPath !== 'string' || selectedPath.length === 0) throw new Error('no selected text file');
  const file = await registryJson(
    `/v1/drafts/${encodeURIComponent(input.draftId)}/builder-file?revision=${input.revision}&digest=${encodeURIComponent(input.digest)}&path=${encodeURIComponent(selectedPath)}`,
  );
  if (!isRecord(file) || typeof file.content !== 'string') throw new Error('registry file is invalid');

  // This is the only fixture boundary in the local run. The registry context,
  // file read, proposal persistence, apply, scan, and publish calls remain real
  // HTTP requests. The suffix is deterministic and does not depend on model IO.
  const suffix = '\n\nLocal deterministic Eve fixture proposal.\n';
  const after = file.content.endsWith('\n') ? `${file.content}${suffix.slice(1)}` : `${file.content}${suffix}`;
  const proposal = await registryJson(`/v1/drafts/${encodeURIComponent(input.draftId)}/proposals`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `local-fixture:${input.registrySessionId}:${input.requestId}`,
    },
    body: JSON.stringify({
      draftId: input.draftId,
      draftRevision: input.revision,
      draftDigest: input.digest,
      sessionId: input.registrySessionId,
      operations: [{ op: 'edit', path: selectedPath, content: after }],
    }),
  });
  if (!isRecord(proposal) || !isRecord(proposal.proposal)) throw new Error('registry proposal is invalid');
  return { selectedPath, proposalId: proposal.proposal.id };
}

function eventLine(type, sessionId, at, data = {}) {
  return JSON.stringify({ type, data, meta: { id: `${sessionId}:${type}`, at } });
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `https://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/eve/v1/health') {
    json(res, 200, { ok: true, service: 'local-deterministic-builder' });
    return;
  }
  if (req.method === 'GET' && path === '/internal/builder/status') {
    if (bearer(req) !== serviceToken) { unauthorized(res); return; }
    json(res, 200, { enabled: true, model: 'fixture/local-deterministic' });
    return;
  }
  if (req.method === 'POST' && path === '/internal/builder/sessions') {
    if (bearer(req) !== serviceToken) { unauthorized(res); return; }
    try {
      const input = await readJson(req);
      assertSessionInput(input);
      const existing = [...sessions.values()].find((candidate) => candidate.registrySessionId === input.registrySessionId && candidate.requestId === input.requestId);
      if (existing) {
        json(res, 200, existing.acceptance);
        return;
      }
      const createdAt = new Date().toISOString();
      const providerSessionId = `fixture-eve-${randomUUID()}`;
      const result = await makeProposal(input);
      const acceptance = {
        status: 'accepted',
        sessionId: providerSessionId,
        sessionKey: input.sessionKey,
        registrySessionId: input.registrySessionId,
        draftId: input.draftId,
        revision: input.revision,
        digest: input.digest,
        requestId: input.requestId,
        requestDigest: input.requestDigest,
        ...(input.selectedPath === undefined ? {} : { selectedPath: input.selectedPath }),
      };
      const events = [
        eventLine('message.received', providerSessionId, createdAt, { message: input.message }),
        eventLine('message.completed', providerSessionId, new Date().toISOString(), { message: 'A deterministic fixture proposal is ready for review.' }),
        eventLine('session.waiting', providerSessionId, new Date().toISOString()),
      ].join('\n') + '\n';
      sessions.set(providerSessionId, { acceptance, events, registrySessionId: input.registrySessionId, requestId: input.requestId, proposalId: result.proposalId });
      log({ event: 'accepted', providerSessionId, registrySessionId: input.registrySessionId, draftId: input.draftId, revision: input.revision, proposalId: result.proposalId });
      json(res, 202, acceptance);
    } catch {
      // Keep local logs bounded and free of request content, upstream bodies,
      // and credential-bearing error details.
      log({ event: 'rejected', reason: 'fixture_request_invalid' });
      json(res, 400, { code: 'FIXTURE_REQUEST_INVALID', message: 'The local fixture could not accept this session' });
    }
    return;
  }

  const streamMatch = /^\/eve\/v1\/session\/([^/]+)\/stream$/u.exec(path);
  if (req.method === 'GET' && streamMatch) {
    if (bearer(req) !== eveToken) { unauthorized(res); return; }
    const session = sessions.get(decodeURIComponent(streamMatch[1]));
    if (!session) { json(res, 404, { code: 'NOT_FOUND' }); return; }
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/x-ndjson' });
    res.end(session.events);
    return;
  }

  const cancelMatch = /^\/eve\/v1\/session\/([^/]+)\/cancel$/u.exec(path);
  if (req.method === 'POST' && cancelMatch) {
    if (bearer(req) !== eveToken) { unauthorized(res); return; }
    if (!sessions.has(decodeURIComponent(cancelMatch[1]))) { json(res, 404, { code: 'NOT_FOUND' }); return; }
    json(res, 200, { ok: true, status: 'no_active_turn' });
    return;
  }

  json(res, 404, { code: 'NOT_FOUND' });
}

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (req, res) => {
  void handle(req, res).catch(() => json(res, 500, { code: 'FIXTURE_ERROR', message: 'The local fixture failed' }));
});
server.listen(port, '127.0.0.1', () => {
  log({ event: 'listening', port });
  process.stdout.write(`local-builder-listening:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
