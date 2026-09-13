import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  LOCAL_REGISTRY_MAX_RESPONSE_BYTES,
  LOCAL_REGISTRY_REQUEST_TIMEOUT_MS,
  requestBoundedJson,
} from './local-m6-http.mjs';

test('local registry HTTP helper returns bounded JSON responses', async () => {
  const stub = await startHttpStub((request, response) => {
    if (request.url === '/ok') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ready' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
  try {
    const result = await requestBoundedJson(`${stub.origin}/ok`);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.value, { status: 'ready' });
  } finally {
    await stub.close();
  }
});

test('local registry HTTP helper aborts a stalled response within its configured bound', async () => {
  assert.equal(LOCAL_REGISTRY_REQUEST_TIMEOUT_MS, 8_000);
  const stub = await startHttpStub((request, response) => {
    if (request.url !== '/stall') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"status":"');
    const timer = setTimeout(() => response.end('never-arrives"}'), 250);
    response.on('close', () => clearTimeout(timer));
  });
  try {
    const started = Date.now();
    await assert.rejects(
      requestBoundedJson(`${stub.origin}/stall`, {}, { timeoutMs: 50 }),
      (error) => error instanceof Error && error.message === 'registry request timed out',
    );
    assert.ok(Date.now() - started < 1_000, 'the stalled request must fail promptly');
  } finally {
    await stub.close();
  }
});

test('local registry HTTP helper rejects an oversized streamed response without exposing its body', async () => {
  const secret = 'upstream-body-must-not-appear-in-errors';
  const oversized = Buffer.concat([
    Buffer.from('{"payload":"'),
    Buffer.alloc(LOCAL_REGISTRY_MAX_RESPONSE_BYTES, 'x'),
    Buffer.from(`","marker":"${secret}"}`),
  ]);
  const stub = await startHttpStub((request, response) => {
    if (request.url !== '/oversized') {
      response.writeHead(404);
      response.end();
      return;
    }
    // Deliberately omit Content-Length so the streaming byte cap is tested.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(oversized);
  });
  try {
    await assert.rejects(
      requestBoundedJson(`${stub.origin}/oversized`),
      (error) => error instanceof Error
        && error.message === 'registry response exceeded the bounded size'
        && !error.message.includes(secret),
    );
  } finally {
    await stub.close();
  }
});

async function startHttpStub(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP stub did not bind a TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
