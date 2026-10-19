import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.mjs';
import { expectProblem, fixture, request, startSimulator, withKey } from '../../common/testkit.mjs';

const PATH = '/sim/email/v1';

async function launch(t) {
  const sim = await startSimulator(createServer);
  t.after(() => sim.close());
  return sim;
}

function post(sim, path, body, headers = {}) {
  return request(sim, { method: 'POST', path: `${PATH}${path}`, body, headers });
}

test('email simulator exposes health and OpenAPI', async (t) => {
  const sim = await launch(t);
  const health = await request(sim, { path: '/sim/email/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.simulator, 'email');

  const openapi = await request(sim, { path: '/sim/email/openapi.yaml' });
  assert.equal(openapi.status, 200);

  const message = await post(sim, '/messages', fixture('email-message'));
  assert.equal(message.status, 201, message.text);
  assert.equal(message.json.status, 'DELIVERED');
  assert.equal(message.json.messageId, 'EML-000001');
  assert.equal(message.json.providerMessageId, 'EML-P-000001');
  assert.equal(message.json.recipients[0].status, 'DELIVERED');

  const detail = await request(sim, { path: `${PATH}/messages/EML-000001` });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.notificationId, 'NOTIF-2026-000123');
});

test('bounce, suppress and reject scenarios are deterministic', async (t) => {
  const sim = await launch(t);

  const bounce = withKey(fixture('email-message'), 'smoke-email-bounce');
  bounce.messageId = '0192f3a4-0000-7000-8000-000000040101';
  bounce.notificationId = 'NOTIF-2026-000124';
  bounce.recipients = [{ address: 'bounce@example.test', name: 'Bouncing Recipient' }];
  const bounced = await post(sim, '/messages', bounce);
  assert.equal(bounced.status, 201, bounced.text);
  assert.equal(bounced.json.status, 'BOUNCED');
  assert.equal(bounced.json.bounce.code, 'MAILBOX_FULL');
  assert.equal(bounced.json.deliveredAt, null);

  const suppressed = withKey(fixture('email-message'), 'smoke-email-suppress');
  suppressed.messageId = '0192f3a4-0000-7000-8000-000000040102';
  suppressed.notificationId = 'NOTIF-2026-000125';
  const suppressedResponse = await post(sim, '/messages', suppressed, { 'x-sim-scenario': 'suppress' });
  assert.equal(suppressedResponse.status, 201);
  assert.equal(suppressedResponse.json.status, 'SUPPRESSED');

  const rejected = withKey(fixture('email-message'), 'smoke-email-reject');
  rejected.messageId = '0192f3a4-0000-7000-8000-000000040103';
  rejected.notificationId = 'NOTIF-2026-000126';
  const rejectedResponse = await post(sim, '/messages', rejected, { 'x-sim-scenario': 'reject' });
  expectProblem(rejectedResponse, { status: 422, category: 'BUSINESS_REJECT' });
  assert.equal(rejectedResponse.json.meta.reasonCode, 'EMAIL-RELAY-REJECTED');

  const timeout = withKey(fixture('email-message'), 'smoke-email-timeout');
  timeout.messageId = '0192f3a4-0000-7000-8000-000000040104';
  timeout.notificationId = 'NOTIF-2026-000127';
  const timeoutResponse = await post(sim, '/messages', timeout, {
    'x-sim-scenario': 'timeout',
    'x-sim-delay-ms': '0',
  });
  expectProblem(timeoutResponse, { status: 504, category: 'TIMEOUT' });
});

test('notification attempts are idempotent by notificationId and attempt', async (t) => {
  const sim = await launch(t);
  const body = fixture('email-message');
  const first = await post(sim, '/messages', body);
  assert.equal(first.status, 201);

  const replay = await post(sim, '/messages', body);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers['idempotent-replayed'], 'true');
  assert.deepEqual(replay.json, first.json);

  const duplicate = withKey(body, 'smoke-email-duplicate');
  duplicate.messageId = '0192f3a4-0000-7000-8000-000000040201';
  const duplicateResponse = await post(sim, '/messages', duplicate);
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateResponse.json.duplicate, true);

  const conflict = withKey(body, 'smoke-email-conflict');
  conflict.messageId = '0192f3a4-0000-7000-8000-000000040202';
  conflict.subject = 'A different subject';
  const conflictResponse = await post(sim, '/messages', conflict);
  expectProblem(conflictResponse, { status: 409, category: 'CONFLICT' });
  assert.equal(conflictResponse.json.meta.reasonCode, 'NOTIFICATION_ATTEMPT_CONFLICT');

  const invalid = withKey(body, 'smoke-email-invalid');
  invalid.messageId = '0192f3a4-0000-7000-8000-000000040203';
  invalid.notificationId = 'NOTIF-2026-000128';
  invalid.recipients = [{ address: 'not-an-email' }];
  const invalidResponse = await post(sim, '/messages', invalid);
  expectProblem(invalidResponse, { status: 400, category: 'VALIDATION' });
});
