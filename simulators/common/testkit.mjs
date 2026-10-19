import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { closeServer, listen } from './http.mjs';
import { payloadHashOf as hashPayload } from './envelope.mjs';
import { deterministicUuid } from './canonical.mjs';

/** Start a simulator server on an ephemeral port for smoke tests. */
export async function startSimulator(factory, { host = '127.0.0.1' } = {}) {
  const server = factory();
  const address = await listen(server, { port: 0, host });
  const baseUrl = `http://${host}:${address.port}`;
  return {
    server,
    baseUrl,
    port: address.port,
    close: () => closeServer(server),
    request: (options) => request(baseUrl, options),
    adminReset: (system) => adminReset(baseUrl, system),
  };
}

/**
 * Issue an HTTP request and return status, headers, raw text and parsed JSON.
 * Does not throw on non-2xx statuses: simulator fault modes are asserted.
 */
export async function request(baseUrlOrSimulator, { method = 'GET', path, body, headers = {}, timeoutMs = 15_000 } = {}) {
  const baseUrl = typeof baseUrlOrSimulator === 'string' ? baseUrlOrSimulator : baseUrlOrSimulator.baseUrl;
  const requestHeaders = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders['content-type'] ??= 'application/json';
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text,
    json,
  };
}

/** POST a JSON body with an explicit idempotency key header. */
export function post(baseUrlOrSimulator, path, body, { key, headers = {}, method = 'POST' } = {}) {
  const requestHeaders = { ...headers };
  if (key) requestHeaders['idempotency-key'] = key;
  return request(baseUrlOrSimulator, { method, path, body, headers: requestHeaders });
}

/** Reset a simulator's in-memory state and counters. */
export async function adminReset(baseUrlOrSimulator, system) {
  const response = await request(baseUrlOrSimulator, { method: 'POST', path: `/sim/${system}/v1/admin/reset` });
  assert.equal(response.status, 200, `reset failed: ${response.text}`);
  return response;
}

/** Load a JSON fixture from the shared simulators/fixtures directory. */
export function fixture(name) {
  const file = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Deep clone fixture data so tests can mutate it safely. */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Prepare a fixture for a specific idempotency key. */
export function withKey(value, key) {
  const copy = clone(value);
  copy.idempotencyKey = key;
  return copy;
}

/** Compute the envelope payload hash for a request body. */
export function payloadHash(body) {
  const envelopeFields = new Set([
    'messageId',
    'idempotencyKey',
    'correlationId',
    'causationId',
    'tenantId',
    'businessBook',
    'sourceSystem',
    'targetSystem',
    'schemaVersion',
    'createdAt',
    'payloadHash',
    'signature',
    'simulation',
  ]);
  const payload = Object.fromEntries(Object.entries(body).filter(([key]) => !envelopeFields.has(key)));
  return hashPayload(payload);
}

/** Assert a Problem response matches the spec taxonomy. */
export function expectProblem(response, { status, code, category } = {}) {
  if (status !== undefined) assert.equal(response.status, status, `expected HTTP ${status}, received ${response.status}: ${response.text}`);
  assert.ok(response.json, `expected a JSON problem body, received: ${response.text}`);
  if (code !== undefined) assert.equal(response.json.code, code, `unexpected problem code: ${response.text}`);
  if (category !== undefined) assert.equal(response.json.category, category, `unexpected problem category: ${response.text}`);
  assert.equal(response.headers['content-type'], 'application/problem+json', 'problem responses use application/problem+json');
  assert.equal(typeof response.json.type, 'string');
  assert.equal(typeof response.json.title, 'string');
  assert.ok(Array.isArray(response.json.errors));
  return response;
}

/** Assert an idempotent replay. */
export function expectReplay(response) {
  assert.equal(response.headers['idempotent-replayed'], 'true', 'expected Idempotent-Replayed: true');
  assert.equal(response.headers['x-sim-duplicate'], 'true', 'expected the duplicate marker header');
  return response;
}

export { deterministicUuid };
