import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.mjs';
import { expectProblem, fixture, request, startSimulator, withKey } from '../../common/testkit.mjs';

const PATH = '/sim/ocr/v1';

async function launch(t) {
  const sim = await startSimulator(createServer);
  t.after(() => sim.close());
  return sim;
}

function post(sim, path, body, headers = {}) {
  return request(sim, { method: 'POST', path: `${PATH}${path}`, body, headers });
}

function documentWith({ key, messageId, documentId, versionHash }) {
  const body = withKey(fixture('ocr-document'), key);
  body.messageId = messageId;
  if (documentId) body.documentId = documentId;
  if (versionHash) body.versionHash = versionHash;
  return body;
}

test('OCR simulator extracts deterministic fields from a CMS1500 document', async (t) => {
  const sim = await launch(t);
  const health = await request(sim, { path: '/sim/ocr/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.simulator, 'ocr');

  const openapi = await request(sim, { path: '/sim/ocr/openapi.yaml' });
  assert.equal(openapi.status, 200);

  const response = await post(sim, '/documents', fixture('ocr-document'));
  assert.equal(response.status, 201, response.text);
  assert.equal(response.json.jobId, 'OCR-000001');
  assert.equal(response.json.status, 'COMPLETED');
  assert.equal(response.json.confidence, 0.98);
  assert.equal(response.json.extractedFields.patientName, 'Doe, Jane');
  assert.equal(response.json.extractedFields.billedAmount.amount, '1250.00');
  assert.equal(response.json.pageCount, 2);
  assert.equal(response.json.durationMs, 250);

  const detail = await request(sim, { path: `${PATH}/documents/OCR-000001` });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.extractedFields, response.json.extractedFields);
});

test('low confidence, failure and rejection scenarios are deterministic', async (t) => {
  const sim = await launch(t);

  const low = documentWith({
    key: 'smoke-ocr-low',
    messageId: '0192f3a4-0000-7000-8000-000000041101',
    documentId: '0192f3a4-0000-7000-8000-000000050002',
    versionHash: 'b'.repeat(64),
  });
  const lowResponse = await post(sim, '/documents', low, { 'x-sim-scenario': 'low_confidence' });
  assert.equal(lowResponse.status, 201, lowResponse.text);
  assert.equal(lowResponse.json.status, 'LOW_CONFIDENCE');
  assert.equal(lowResponse.json.confidence, 0.42);

  const fail = documentWith({
    key: 'smoke-ocr-fail',
    messageId: '0192f3a4-0000-7000-8000-000000041102',
    documentId: '0192f3a4-0000-7000-8000-000000050003',
    versionHash: 'c'.repeat(64),
  });
  const failResponse = await post(sim, '/documents', fail, { 'x-sim-scenario': 'fail' });
  assert.equal(failResponse.status, 201);
  assert.equal(failResponse.json.status, 'FAILED');
  assert.equal(failResponse.json.confidence, 0);
  assert.equal(failResponse.json.error.code, 'OCR_UNREADABLE');
  assert.deepEqual(failResponse.json.extractedFields, {});

  const rejected = documentWith({
    key: 'smoke-ocr-reject',
    messageId: '0192f3a4-0000-7000-8000-000000041103',
    documentId: '0192f3a4-0000-7000-8000-000000050004',
    versionHash: 'd'.repeat(64),
  });
  const rejectedResponse = await post(sim, '/documents', rejected, { 'x-sim-scenario': 'reject' });
  expectProblem(rejectedResponse, { status: 422, category: 'BUSINESS_REJECT' });
  assert.equal(rejectedResponse.json.meta.reasonCode, 'OCR-DOCUMENT-REJECTED');

  const timeout = documentWith({
    key: 'smoke-ocr-timeout',
    messageId: '0192f3a4-0000-7000-8000-000000041104',
    documentId: '0192f3a4-0000-7000-8000-000000050005',
    versionHash: 'e'.repeat(64),
  });
  const timeoutResponse = await post(sim, '/documents', timeout, {
    'x-sim-scenario': 'timeout',
    'x-sim-delay-ms': '0',
  });
  expectProblem(timeoutResponse, { status: 504, category: 'TIMEOUT' });
});

test('OCR jobs are idempotent by document version hash', async (t) => {
  const sim = await launch(t);
  const body = fixture('ocr-document');
  const first = await post(sim, '/documents', body);
  assert.equal(first.status, 201);

  const replay = await post(sim, '/documents', body);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers['idempotent-replayed'], 'true');
  assert.deepEqual(replay.json, first.json);

  const duplicate = withKey(body, 'smoke-ocr-duplicate');
  duplicate.messageId = '0192f3a4-0000-7000-8000-000000041201';
  const duplicateResponse = await post(sim, '/documents', duplicate);
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateResponse.json.duplicate, true);

  const nextVersion = withKey(body, 'smoke-ocr-next-version');
  nextVersion.messageId = '0192f3a4-0000-7000-8000-000000041202';
  nextVersion.versionHash = 'f'.repeat(64);
  const nextResponse = await post(sim, '/documents', nextVersion);
  assert.equal(nextResponse.status, 201, nextResponse.text);
  assert.equal(nextResponse.json.jobId, 'OCR-000002');

  const conflict = withKey(body, 'smoke-ocr-conflict');
  conflict.messageId = '0192f3a4-0000-7000-8000-000000041203';
  conflict.documentType = 'UB04';
  const conflictResponse = await post(sim, '/documents', conflict);
  expectProblem(conflictResponse, { status: 409, category: 'CONFLICT' });
  assert.equal(conflictResponse.json.meta.reasonCode, 'DOCUMENT_VERSION_CONFLICT');

  const invalid = withKey(body, 'smoke-ocr-invalid');
  invalid.messageId = '0192f3a4-0000-7000-8000-000000041204';
  invalid.documentId = '0192f3a4-0000-7000-8000-000000050006';
  invalid.contentBase64 = '%%%not-base64%%%';
  const invalidResponse = await post(sim, '/documents', invalid);
  expectProblem(invalidResponse, { status: 400, category: 'VALIDATION' });
});
