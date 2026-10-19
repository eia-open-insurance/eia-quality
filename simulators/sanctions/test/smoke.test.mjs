import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.mjs';
import { expectProblem, fixture, request, startSimulator, withKey } from '../../common/testkit.mjs';

const PATH = '/sim/sanctions/v1';

async function launch(t) {
  const sim = await startSimulator(createServer);
  t.after(() => sim.close());
  return sim;
}

function post(sim, path, body, headers = {}) {
  return request(sim, { method: 'POST', path: `${PATH}${path}`, body, headers });
}

function screeningWith({ key, messageId, screeningRequestId, name, threshold }) {
  const body = withKey(fixture('sanctions-screening'), key);
  body.messageId = messageId;
  if (screeningRequestId) body.screeningRequestId = screeningRequestId;
  if (name) body.party.name = name;
  if (threshold !== undefined) body.threshold = threshold;
  return body;
}

test('sanctions simulator clears an unmatched party and publishes simulated lists', async (t) => {
  const sim = await launch(t);
  const health = await request(sim, { path: '/sim/sanctions/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.simulator, 'sanctions');

  const openapi = await request(sim, { path: '/sim/sanctions/openapi.yaml' });
  assert.equal(openapi.status, 200);

  const response = await post(sim, '/screenings', fixture('sanctions-screening'));
  assert.equal(response.status, 201, response.text);
  assert.equal(response.json.status, 'CLEAR');
  assert.equal(response.json.decision, 'CLEAR_TO_PROCEED');
  assert.equal(response.json.score, 0);
  assert.deepEqual(response.json.matches, []);
  assert.equal(response.json.listVersion, '2026.10.01');
  assert.equal(response.json.failClosed, false);

  const lists = await request(sim, { path: `${PATH}/lists` });
  assert.equal(lists.status, 200);
  assert.equal(lists.json.lists.length, 3);
  assert.match(lists.json.warning, /fictional/i);

  const list = await request(sim, { path: `${PATH}/lists/OFAC_SDN` });
  assert.equal(list.status, 200);
  assert.equal(list.json.entryCount, 2);
  assert.ok(list.json.entries.every((entry) => /fictional|simulated/i.test(entry.name) || entry.entryId.startsWith('SDN-')));
});

test('potential and confirmed matches are deterministic and fail closed on error', async (t) => {
  const sim = await launch(t);

  const potential = await post(
    sim,
    '/screenings',
    screeningWith({ key: 'smoke-sanctions-potential', messageId: '0192f3a4-0000-7000-8000-000000042101', screeningRequestId: 'SCR-REQ-2026-000101' }),
    { 'x-sim-scenario': 'potential' },
  );
  assert.equal(potential.status, 201, potential.text);
  assert.equal(potential.json.status, 'POTENTIAL_MATCH');
  assert.equal(potential.json.decision, 'ESCALATE');
  assert.equal(potential.json.score, 78.5);
  assert.equal(potential.json.matches[0].matchType, 'FUZZY');

  const confirmed = await post(
    sim,
    '/screenings',
    screeningWith({
      key: 'smoke-sanctions-confirmed',
      messageId: '0192f3a4-0000-7000-8000-000000042102',
      screeningRequestId: 'SCR-REQ-2026-000102',
      name: 'Ivan Fictionalov',
    }),
  );
  assert.equal(confirmed.status, 201, confirmed.text);
  assert.equal(confirmed.json.status, 'CONFIRMED_MATCH');
  assert.equal(confirmed.json.decision, 'BLOCK');
  assert.equal(confirmed.json.score, 100);
  assert.equal(confirmed.json.matches[0].entryId, 'SDN-0001');

  const providerError = await post(
    sim,
    '/screenings',
    screeningWith({ key: 'smoke-sanctions-error', messageId: '0192f3a4-0000-7000-8000-000000042103', screeningRequestId: 'SCR-REQ-2026-000103' }),
    { 'x-sim-scenario': 'error' },
  );
  expectProblem(providerError, { status: 503, category: 'UNAVAILABLE' });
  assert.equal(providerError.json.meta.failClosed, true);
  assert.equal(providerError.json.retryable, true);

  const timeout = await post(
    sim,
    '/screenings',
    screeningWith({ key: 'smoke-sanctions-timeout', messageId: '0192f3a4-0000-7000-8000-000000042104', screeningRequestId: 'SCR-REQ-2026-000104' }),
    { 'x-sim-scenario': 'timeout', 'x-sim-delay-ms': '0' },
  );
  expectProblem(timeout, { status: 504, category: 'TIMEOUT' });
});

test('screening requests are idempotent and reject conflicting reuse', async (t) => {
  const sim = await launch(t);
  const body = fixture('sanctions-screening');
  const first = await post(sim, '/screenings', body);
  assert.equal(first.status, 201);

  const replay = await post(sim, '/screenings', body);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers['idempotent-replayed'], 'true');
  assert.deepEqual(replay.json, first.json);

  const duplicate = withKey(body, 'smoke-sanctions-duplicate');
  duplicate.messageId = '0192f3a4-0000-7000-8000-000000042201';
  const duplicateResponse = await post(sim, '/screenings', duplicate);
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateResponse.json.duplicate, true);

  const conflict = withKey(body, 'smoke-sanctions-conflict');
  conflict.messageId = '0192f3a4-0000-7000-8000-000000042202';
  conflict.party.name = 'A Different Party';
  const conflictResponse = await post(sim, '/screenings', conflict);
  expectProblem(conflictResponse, { status: 409, category: 'CONFLICT' });
  assert.equal(conflictResponse.json.meta.reasonCode, 'SCREENING_REQUEST_CONFLICT');

  const unknownList = withKey(body, 'smoke-sanctions-unknown-list');
  unknownList.messageId = '0192f3a4-0000-7000-8000-000000042203';
  unknownList.screeningRequestId = 'SCR-REQ-2026-000105';
  unknownList.lists = ['NOT_A_LIST'];
  const unknownListResponse = await post(sim, '/screenings', unknownList);
  expectProblem(unknownListResponse, { status: 400, category: 'VALIDATION' });
});
