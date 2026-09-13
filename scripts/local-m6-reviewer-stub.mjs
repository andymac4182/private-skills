import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Disposable local-only reviewer boundary. It exercises the registry's real
// upload-review HTTP handler and persistence while keeping the model boundary
// deterministic and entirely local.
const port = Number(required('LOCAL_REVIEWER_PORT'));
const registryOrigin = required('LOCAL_REVIEWER_REGISTRY_ORIGIN');
const eveToken = required('LOCAL_REVIEWER_EVE_TOKEN');
const registryToken = required('LOCAL_REVIEWER_REGISTRY_TOKEN');
const controlToken = required('LOCAL_REVIEWER_CONTROL_TOKEN');
const logPath = required('LOCAL_REVIEWER_LOG');
const reviewerMode = process.env.LOCAL_REVIEWER_MODE ?? 'hold';
const autoCompleteMs = parseDelay(process.env.LOCAL_REVIEWER_AUTOCOMPLETE_MS);

if (!new Set(['hold', 'delay', 'auto']).has(reviewerMode)) {
  throw new Error('LOCAL_REVIEWER_MODE must be hold, delay, or auto');
}
if (reviewerMode === 'delay' && autoCompleteMs === undefined) {
  throw new Error('LOCAL_REVIEWER_AUTOCOMPLETE_MS is required for delay mode');
}
assertLoopbackRegistryOrigin(registryOrigin);

const sessions = new Map();
let sequence = 0;

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function parseDelay(value) {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/u.test(value)) throw new Error('LOCAL_REVIEWER_AUTOCOMPLETE_MS must be an integer');
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 60_000) {
    throw new Error('LOCAL_REVIEWER_AUTOCOMPLETE_MS is out of range');
  }
  return milliseconds;
}

function assertLoopbackRegistryOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('LOCAL_REVIEWER_REGISTRY_ORIGIN must be a URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('LOCAL_REVIEWER_REGISTRY_ORIGIN must be a plain loopback HTTP origin');
  }
}

function writeLog(event) {
  // Never write the trigger message, snapshot text, lease, or credentials.
  appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function bearer(request) {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function authorized(request, expected) {
  return bearer(request) === expected;
}

function readJson(request, maximum = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        reject(new Error('request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    request.on('error', reject);
  });
}

async function registryRequest(path, body) {
  const response = await fetch(new URL(path, registryOrigin), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${registryToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  const text = await response.text();
  let value = {};
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`registry response ${response.status} was not JSON`);
  }
  return { response, value };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function prepareAndComplete(session, force = false) {
  if (session.advancePromise && !force) return session.advancePromise;
  if (session.status === 'passed' || session.status === 'failed' || session.status === 'error') {
    return { status: session.status, findingCount: session.findingCount };
  }
  session.status = 'processing';
  session.advancePromise = (async () => {
    let prepared;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      prepared = await registryRequest('/internal/upload-review/prepare', {
        sessionId: session.sessionId,
        jobId: session.jobId,
      });
      if (prepared.response.status !== 404 || attempt === 5) break;
      await wait(25 * (attempt + 1));
    }
    const status = prepared.value?.status;
    if (status !== 'prepared') {
      session.status = typeof status === 'string' ? status : 'unknown';
      writeLog({ event: 'review_terminal', sessionId: session.sessionId, jobId: session.jobId, status: session.status });
      return { status: session.status };
    }
    const files = Array.isArray(prepared.value.files) ? prepared.value.files : [];
    const textFile = files.find((file) => file && file.kind === 'text' && typeof file.path === 'string');
    const findings = textFile === undefined
      ? []
      : [{
          severity: 'info',
          category: 'local-fixture',
          title: 'Deterministic local reviewer note',
          summary: 'This bounded finding was produced by the disposable local reviewer fixture.',
          path: textFile.path,
          line: 1,
        }];
    const completed = await registryRequest('/internal/upload-review/complete', {
      sessionId: session.sessionId,
      jobId: session.jobId,
      leaseToken: prepared.value.leaseToken,
      findings,
    });
    session.status = typeof completed.value?.status === 'string' ? completed.value.status : 'unknown';
    session.findingCount = findings.length;
    writeLog({
      event: 'review_completed',
      sessionId: session.sessionId,
      jobId: session.jobId,
      status: session.status,
      findingCount: findings.length,
    });
    return { status: session.status, findingCount: findings.length };
  })().catch((error) => {
    session.status = 'error';
    writeLog({ event: 'review_error', sessionId: session.sessionId, jobId: session.jobId, status: 'error', code: 'fixture_request_failed' });
    return { status: 'error' };
  });
  return session.advancePromise;
}

async function handle(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;

  if (request.method === 'GET' && path === '/eve/v1/health') {
    json(response, 200, { ok: true, status: 'ready', workflowId: 'local-upload-review-fixture', mode: reviewerMode });
    return;
  }

  if (request.method === 'POST' && path === '/eve/v1/session') {
    if (!authorized(request, eveToken)) {
      json(response, 401, { code: 'UNAUTHORIZED' });
      return;
    }
    const jobId = request.headers['x-pskills-upload-review-job'];
    if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 256 || /[\u0000-\u001f\u007f]/u.test(jobId)) {
      json(response, 400, { code: 'INVALID_JOB' });
      return;
    }
    try {
      const body = await readJson(request);
      if (!body || typeof body.message !== 'string' || body.message.length === 0) {
        json(response, 400, { code: 'INVALID_MESSAGE' });
        return;
      }
      const sessionId = `local-upload-review-${++sequence}-${randomUUID()}`;
      const session = { sessionId, jobId, status: 'pending', findingCount: 0 };
      sessions.set(sessionId, session);
      writeLog({ event: 'session_created', sessionId, jobId });
      if (reviewerMode !== 'hold') {
        // Let the registry trigger finish its post-create bind before the
        // local reviewer consumes the lease. The retry remains bounded.
        const timer = setTimeout(() => { void prepareAndComplete(session); }, reviewerMode === 'auto' ? 25 : autoCompleteMs);
        timer.unref?.();
      }
      json(response, 202, { sessionId, deliveryId: `local-delivery-${sequence}` });
    } catch {
      json(response, 400, { code: 'INVALID_REQUEST' });
    }
    return;
  }

  const streamMatch = /^\/eve\/v1\/session\/([^/]+)\/stream$/u.exec(path);
  if (request.method === 'GET' && streamMatch) {
    if (!authorized(request, eveToken)) {
      json(response, 401, { code: 'UNAUTHORIZED' });
      return;
    }
    const session = sessions.get(decodeURIComponent(streamMatch[1]));
    if (!session) {
      json(response, 404, { code: 'NOT_FOUND' });
      return;
    }
    const at = new Date().toISOString();
    const lines = [
      { type: 'session.started', data: {}, meta: { id: `${session.sessionId}:started`, at } },
      { type: 'message.completed', data: { message: 'The deterministic local review is complete.', finishReason: 'stop' }, meta: { id: `${session.sessionId}:message`, at } },
      { type: 'session.waiting', data: {}, meta: { id: `${session.sessionId}:waiting`, at } },
    ];
    response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/x-ndjson' });
    response.end(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return;
  }

  const cancelMatch = /^\/eve\/v1\/session\/([^/]+)\/cancel$/u.exec(path);
  if (request.method === 'POST' && cancelMatch) {
    if (!authorized(request, eveToken)) {
      json(response, 401, { code: 'UNAUTHORIZED' });
      return;
    }
    if (!sessions.has(decodeURIComponent(cancelMatch[1]))) {
      json(response, 404, { code: 'NOT_FOUND' });
      return;
    }
    json(response, 200, { status: 'no_active_turn' });
    return;
  }

  if (request.method === 'GET' && path === '/control/status') {
    if (!authorized(request, controlToken)) {
      json(response, 401, { code: 'UNAUTHORIZED' });
      return;
    }
    json(response, 200, {
      sessions: [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        jobId: session.jobId,
        status: session.status,
        findingCount: session.findingCount,
      })),
    });
    return;
  }

  if (request.method === 'POST' && path === '/control/advance') {
    if (!authorized(request, controlToken)) {
      json(response, 401, { code: 'UNAUTHORIZED' });
      return;
    }
    try {
      const body = await readJson(request, 16 * 1024);
      const session = body?.sessionId === undefined
        ? [...sessions.values()].find((candidate) => candidate.status === 'pending')
        : sessions.get(body.sessionId);
      if (!session) {
        json(response, 404, { code: 'NOT_FOUND' });
        return;
      }
      const result = await prepareAndComplete(session);
      json(response, 200, { jobId: session.jobId, sessionId: session.sessionId, ...result });
    } catch {
      json(response, 400, { code: 'INVALID_REQUEST' });
    }
    return;
  }

  json(response, 404, { code: 'NOT_FOUND' });
}

const server = createServer((request, response) => {
  void handle(request, response).catch(() => json(response, 500, { code: 'FIXTURE_ERROR' }));
});
server.listen(port, '127.0.0.1', () => {
  writeLog({ event: 'listening', port, mode: reviewerMode });
  process.stdout.write(`local-reviewer-listening:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
