import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.mjs';
import {
  expectProblem,
  expectReplay,
  fixture,
  payloadHash,
  request,
  startSimulator,
  withKey,
} from '../../common/testkit.mjs';

const PATH = '/sim/fsri/v1';

async function launch(t) {
  const sim = await startSimulator(createServer);
  t.after(() => sim.close());
  return sim;
}

async function post(sim, path, body, headers = {}) {
  return request(sim, { method: 'POST', path: `${PATH}${path}`, body, headers });
}

async function seedContract(sim, { book = 'DIRECT', key = 'smoke-fsri-contract-1' } = {}) {
  const body = withKey(fixture(book === 'DIRECT' ? 'fsri-contract' : 'fsri-retro-contract'), key);
  const response = await post(sim, '/contracts', body);
  assert.equal(response.status, 201, response.text);
  return response.json;
}

function cessionBody(key = 'smoke-fsri-cession-1') {
  const body = withKey(fixture('fsri-cession'), key);
  body.payloadHash = payloadHash(body);
  return body;
}

test('FS-RI simulator exposes health, discovery and OpenAPI', async (t) => {
  const sim = await launch(t);

  const root = await request(sim, { path: '/' });
  assert.equal(root.status, 200);
  assert.equal(root.json.testDouble, true);
  assert.equal(root.json.simulators[0].system, 'fsri');

  const health = await request(sim, { path: '/sim/fsri/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'UP');
  assert.equal(health.json.simulator, 'fsri');
  assert.equal(health.json.clock.mode, 'fixed');
  assert.equal(health.json.clock.instant, '2026-10-19T12:00:00.000Z');

  const openapi = await request(sim, { path: '/sim/fsri/openapi.yaml' });
  assert.equal(openapi.status, 200);
  assert.match(openapi.headers['content-type'], /application\/yaml/);
  assert.match(openapi.text, /openapi: 3\.1\.0/);

  const base = await request(sim, { path: PATH });
  assert.equal(base.status, 200);
  assert.ok(base.json.endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path.endsWith('/cessions')));
});

test('contract master hand-off is deterministic, idempotent and duplicate-aware', async (t) => {
  const sim = await launch(t);
  const body = fixture('fsri-contract');

  const first = await post(sim, '/contracts', body);
  assert.equal(first.status, 201, first.text);
  assert.equal(first.json.fsriContractRef, 'FSRI-CTR-DIRECT-000001');
  assert.equal(first.json.status, 'ACKNOWLEDGED');
  assert.equal(first.json.contractStatus, 'BOUND');
  assert.equal(first.headers['x-sim-mode'], 'TEST_DOUBLE');
  assert.equal(first.headers['idempotent-replayed'], 'false');

  const replay = await post(sim, '/contracts', body);
  expectReplay(replay);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.json, first.json);

  const businessDuplicateBody = withKey(body, 'smoke-fsri-contract-2');
  businessDuplicateBody.messageId = '0192f3a4-0000-7000-8000-000000010002';
  const duplicate = await post(sim, '/contracts', businessDuplicateBody);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.headers['x-sim-duplicate'], 'true');
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(duplicate.json.fsriContractRef, first.json.fsriContractRef);

  const conflictingBody = withKey(body, 'smoke-fsri-contract-3');
  conflictingBody.messageId = '0192f3a4-0000-7000-8000-000000010003';
  conflictingBody.layers = [{ layerNumber: 1, attachment: { amount: '0.00', currency: 'USD' }, limit: { amount: '9000000.00', currency: 'USD' } }];
  const conflict = await post(sim, '/contracts', conflictingBody);
  expectProblem(conflict, { status: 409, category: 'CONFLICT' });
  assert.equal(conflict.json.meta.reasonCode, 'CONTRACT_MASTER_CONFLICT');
});

test('cession hand-off posts a confirmation, recoverable, statement and balanced reconciliation', async (t) => {
  const sim = await launch(t);
  await seedContract(sim);

  const cession = await post(sim, '/cessions', cessionBody());
  assert.equal(cession.status, 201, cession.text);
  assert.equal(cession.json.fsriCessionId, 'FSRI-CES-DIRECT-000001');
  assert.equal(cession.json.status, 'POSTED');
  assert.equal(cession.json.confirmedAmount.amount, '240000.00');
  assert.equal(cession.json.variance.amount, '0.00');
  assert.equal(cession.json.confirmation.status, 'CONFIRMED');
  assert.equal(cession.json.commission.amount, '100000.00');
  assert.deepEqual(cession.json.errors, []);

  const recoverable = await request(sim, { path: `${PATH}/recoverables/${cession.json._links.recoverable.href.split('/').pop()}` });
  assert.equal(recoverable.status, 200);
  assert.equal(recoverable.json.paid.amount, '144000.00');
  assert.equal(recoverable.json.unpaid.amount, '72000.00');
  assert.equal(recoverable.json.ibnr.amount, '24000.00');
  assert.equal(recoverable.json.dueDate, '2026-10-30');

  const confirmation = await post(
    sim,
    `/cessions/${cession.json.fsriCessionId}/confirmation`,
    {
      messageId: '0192f3a4-0000-7000-8000-000000015001',
      idempotencyKey: 'smoke-fsri-confirmation-1',
      tenantId: '0192f3a4-0000-7000-8000-000000000001',
      businessBook: 'DIRECT',
      sourceSystem: 'eia-quality-test',
      targetSystem: 'FS-RI',
      schemaVersion: '1.0.0',
      createdAt: '2026-10-19T12:00:00.000Z',
    },
  );
  assert.equal(confirmation.status, 200, confirmation.text);
  assert.equal(confirmation.json.confirmationId, 'FSRI-CNF-DIRECT-000001');

  const statement = await post(sim, '/statements', withKey(fixture('fsri-statement'), 'smoke-fsri-statement-1'));
  assert.equal(statement.status, 201, statement.text);
  assert.equal(statement.json.lines.length, 3);
  assert.equal(statement.json.totals.cededPremium.amount, '400000.00');
  assert.equal(statement.json.totals.cededLoss.amount, '240000.00');
  assert.equal(statement.json.totals.commission.amount, '100000.00');
  assert.equal(statement.json.totals.netDue.amount, '60000.00');

  const reconciliation = await request(sim, { path: `${PATH}/reconciliations?businessBook=DIRECT&period=2026-09` });
  assert.equal(reconciliation.status, 200);
  assert.equal(reconciliation.json.sent, 1);
  assert.equal(reconciliation.json.accepted, 1);
  assert.equal(reconciliation.json.rejected, 0);
  assert.equal(reconciliation.json.status, 'BALANCED');
  assert.equal(reconciliation.json.variance.amount, '0.00');
  assert.deepEqual(reconciliation.json.breaks, []);
});

test('retro hand-off uses the ASSUMED book and creates a retro recoverable', async (t) => {
  const sim = await launch(t);
  await seedContract(sim, { book: 'ASSUMED', key: 'smoke-fsri-retro-contract-1' });

  const retro = await post(sim, '/retros', withKey(fixture('fsri-retro'), 'smoke-fsri-retro-1'));
  assert.equal(retro.status, 201, retro.text);
  assert.equal(retro.json.fsriRetroId, 'FSRI-RET-ASSUMED-000001');
  assert.equal(retro.json.businessBook, 'ASSUMED');
  assert.equal(retro.json.confirmedAmount.amount, '210000.00');

  const recoverables = await request(sim, { path: `${PATH}/recoverables?businessBook=ASSUMED` });
  assert.equal(recoverables.status, 200);
  assert.equal(recoverables.json.data.length, 1);
  assert.equal(recoverables.json.data[0].businessBook, 'ASSUMED');
  assert.equal(recoverables.json.data[0].recoverableId, 'FSRI-RCV-ASSUMED-000001');
});

test('partial hand-off is stored as partial, never as complete', async (t) => {
  const sim = await launch(t);
  await seedContract(sim);

  const response = await post(sim, '/cessions', cessionBody('smoke-fsri-cession-partial'), {
    'x-sim-scenario': 'partial',
  });
  assert.equal(response.status, 207, response.text);
  assert.equal(response.json.status, 'PARTIAL');
  assert.equal(response.json.confirmedAmount.amount, '144000.00');
  assert.equal(response.json.variance.amount, '96000.00');
  assert.equal(response.json.errors[0].code, 'CEDED_AMOUNT_OUT_OF_TOLERANCE');
  assert.equal(response.json.lines[1].status, 'REJECTED');

  const reconciliation = await request(sim, { path: `${PATH}/reconciliations?businessBook=DIRECT&period=2026-09` });
  assert.equal(reconciliation.json.partial, 1);
  assert.equal(reconciliation.json.accepted, 0);
  assert.equal(reconciliation.json.status, 'BREAKS');
  assert.equal(reconciliation.json.breaks[0].reason, 'AMOUNT_MISMATCH');
  assert.equal(reconciliation.json.invariant.balanced, true);
});

test('rejection, book wall and confirmation mismatch are deterministic', async (t) => {
  const sim = await launch(t);
  await seedContract(sim);

  const rejected = await post(sim, '/cessions', cessionBody('smoke-fsri-cession-reject'), {
    'x-sim-scenario': 'reject',
  });
  expectProblem(rejected, { status: 422, category: 'BUSINESS_REJECT' });
  assert.equal(rejected.json.meta.reasonCode, 'FSRI-CESSION-REJECTED');
  assert.equal(rejected.json.meta.exceptionOwner, 'reinsurance-operations');

  const wallBody = cessionBody('smoke-fsri-cession-wall');
  wallBody.businessBook = 'ASSUMED';
  const wall = await post(sim, '/cessions', wallBody);
  expectProblem(wall, { status: 403, category: 'AUTHORIZATION' });
  assert.equal(wall.json.code, 'EIA-SIM-BOOK-WALL');
  assert.equal(wall.json.meta.securityEvent, 'BOOK_WALL_VIOLATION');

  const state = await request(sim, { path: `${PATH}/admin/state` });
  assert.equal(state.json.securityEvents.length, 1);

  const accepted = await post(sim, '/cessions', cessionBody('smoke-fsri-cession-mismatch'));
  const mismatch = await post(
    sim,
    `/cessions/${accepted.json.fsriCessionId}/confirmation`,
    {
      messageId: '0192f3a4-0000-7000-8000-000000016001',
      idempotencyKey: 'smoke-fsri-confirmation-mismatch',
      tenantId: '0192f3a4-0000-7000-8000-000000000001',
      businessBook: 'DIRECT',
      sourceSystem: 'eia-quality-test',
      targetSystem: 'FS-RI',
      schemaVersion: '1.0.0',
      createdAt: '2026-10-19T12:00:00.000Z',
    },
    { 'x-sim-scenario': 'mismatch' },
  );
  assert.equal(mismatch.status, 200, mismatch.text);
  assert.equal(mismatch.json.status, 'MISMATCH');
  assert.equal(mismatch.json.confirmedAmount.amount, '216000.00');
  assert.equal(mismatch.json.errors[0].code, 'CONFIRMATION_MISMATCH');
});

test('envelope, payload hash and idempotency misuse are rejected', async (t) => {
  const sim = await launch(t);

  const missingKey = fixture('fsri-contract');
  delete missingKey.idempotencyKey;
  const noKey = await post(sim, '/contracts', missingKey);
  expectProblem(noKey, { status: 400, category: 'VALIDATION' });
  assert.equal(noKey.json.code, 'EIA-SIM-IDEMPOTENCY-KEY-REQUIRED');

  const badHash = fixture('fsri-contract');
  badHash.payloadHash = '0'.repeat(64);
  const hashMismatch = await post(sim, '/contracts', badHash);
  expectProblem(hashMismatch, { status: 400, category: 'VALIDATION' });
  assert.equal(hashMismatch.json.code, 'EIA-SIM-PAYLOAD-HASH-MISMATCH');
  assert.match(hashMismatch.json.meta.expected, /^[a-f0-9]{64}$/);

  const body = fixture('fsri-contract');
  await post(sim, '/contracts', body);
  const changed = withKey(body, body.idempotencyKey);
  changed.layers = [{ layerNumber: 1, attachment: { amount: '0.00', currency: 'USD' }, limit: { amount: '6000000.00', currency: 'USD' } }];
  const conflict = await post(sim, '/contracts', changed);
  expectProblem(conflict, { status: 409, category: 'CONFLICT' });
  assert.equal(conflict.json.code, 'EIA-SIM-IDEMPOTENCY-CONFLICT');

  const unknownScenario = await post(sim, '/contracts', withKey(fixture('fsri-contract'), 'smoke-fsri-contract-unknown'), {
    'x-sim-scenario': 'nonsense',
  });
  expectProblem(unknownScenario, { status: 400, category: 'VALIDATION' });
  assert.equal(unknownScenario.json.code, 'EIA-SIM-SCENARIO-UNKNOWN');
});

test('timeout, outage, throttling and malformed scenarios return the taxonomy', async (t) => {
  const sim = await launch(t);

  const timeout = await post(sim, '/contracts', withKey(fixture('fsri-contract'), 'smoke-fsri-timeout'), {
    'x-sim-scenario': 'timeout',
    'x-sim-delay-ms': '0',
  });
  expectProblem(timeout, { status: 504, category: 'TIMEOUT' });
  assert.equal(timeout.json.retryable, true);

  const unavailable = await post(sim, '/contracts', withKey(fixture('fsri-contract'), 'smoke-fsri-unavailable'), {
    'x-sim-scenario': 'unavailable',
  });
  expectProblem(unavailable, { status: 503, category: 'UNAVAILABLE' });
  assert.equal(unavailable.headers['retry-after'], '5');

  const throttled = await post(sim, '/contracts', withKey(fixture('fsri-contract'), 'smoke-fsri-throttled'), {
    'x-sim-scenario': 'throttled',
  });
  expectProblem(throttled, { status: 429, category: 'THROTTLED' });
  assert.equal(throttled.headers['retry-after'], '1');

  const malformed = await post(sim, '/contracts', withKey(fixture('fsri-contract'), 'smoke-fsri-malformed'), {
    'x-sim-scenario': 'malformed',
  });
  expectProblem(malformed, { status: 400, category: 'VALIDATION' });
  assert.equal(malformed.json.code, 'EIA-SIM-MALFORMED-PAYLOAD');

  const noPrior = await post(sim, '/contracts', withKey(fixture('fsri-contract'), 'smoke-fsri-no-prior'), {
    'x-sim-scenario': 'duplicate',
  });
  expectProblem(noPrior, { status: 404, category: 'NOT_FOUND' });
  assert.equal(noPrior.json.code, 'EIA-SIM-NO-PRIOR-MESSAGE');

  const invalidJson = await request(sim, {
    method: 'POST',
    path: `${PATH}/contracts`,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'smoke-fsri-bad-json' },
    body: undefined,
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.code, 'EIA-SIM-VALIDATION');

  const state = await request(sim, { path: `${PATH}/admin/state` });
  assert.equal(state.json.counts.contracts, 0);
  assert.equal(state.json.counts.idempotencyKeys, 0);
});

test('admin reset restores a clean deterministic state', async (t) => {
  const sim = await launch(t);
  await seedContract(sim);
  await post(sim, '/cessions', cessionBody());

  const before = await request(sim, { path: `${PATH}/admin/state` });
  assert.equal(before.json.counts.contracts, 1);
  assert.equal(before.json.counts.cessions, 1);

  const reset = await request(sim, { method: 'POST', path: `${PATH}/admin/reset` });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.status, 'RESET');

  const after = await request(sim, { path: `${PATH}/admin/state` });
  assert.equal(after.json.counts.contracts, 0);
  assert.equal(after.json.counts.cessions, 0);
  assert.equal(after.json.counts.idempotencyKeys, 0);

  await seedContract(sim, { key: 'smoke-fsri-contract-after-reset' });
  const setScenario = await request(sim, {
    method: 'POST',
    path: `${PATH}/admin/scenarios`,
    body: { scenario: 'reject' },
  });
  assert.equal(setScenario.status, 200);
  assert.equal(setScenario.json.defaultScenario, 'reject');
  const rejectedByDefault = await post(sim, '/cessions', cessionBody('smoke-fsri-cession-admin-default'));
  expectProblem(rejectedByDefault, { status: 422, category: 'BUSINESS_REJECT' });

  const clearScenario = await request(sim, {
    method: 'POST',
    path: `${PATH}/admin/scenarios`,
    body: { scenario: null },
  });
  assert.equal(clearScenario.json.defaultScenario, null);
  const accepted = await post(sim, '/cessions', cessionBody('smoke-fsri-cession-after-clear'));
  assert.equal(accepted.status, 201, accepted.text);
});

test('identical request sequences produce identical response bodies', async () => {
  async function runOnce() {
    const sim = await startSimulator(createServer);
    try {
      const contract = await post(sim, '/contracts', fixture('fsri-contract'));
      const cession = await post(sim, '/cessions', cessionBody());
      const recoverable = await request(sim, { path: `${PATH}/recoverables` });
      return { contract: contract.json, cession: cession.json, recoverable: recoverable.json };
    } finally {
      await sim.close();
    }
  }

  const first = await runOnce();
  const second = await runOnce();
  assert.deepEqual(second, first);
});
