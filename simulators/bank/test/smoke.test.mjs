import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.mjs';
import { expectProblem, fixture, request, startSimulator, withKey } from '../../common/testkit.mjs';

const PATH = '/sim/bank/v1';

async function launch(t) {
  const sim = await startSimulator(createServer);
  t.after(() => sim.close());
  return sim;
}

function post(sim, path, body, headers = {}) {
  return request(sim, { method: 'POST', path: `${PATH}${path}`, body, headers });
}

function paymentWith({ key, messageId, endToEndId, amount = '125000.00' }) {
  const body = withKey(fixture('bank-payment'), key);
  body.messageId = messageId;
  body.endToEndId = endToEndId;
  body.amount.amount = amount;
  return body;
}

function statementWith(key, messageId) {
  const body = withKey(fixture('bank-statement'), key);
  body.messageId = messageId;
  return body;
}

test('bank simulator exposes health, discovery and OpenAPI', async (t) => {
  const sim = await launch(t);
  const health = await request(sim, { path: '/sim/bank/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.simulator, 'bank');

  const openapi = await request(sim, { path: '/sim/bank/openapi.yaml' });
  assert.equal(openapi.status, 200);
  assert.match(openapi.text, /camt\.053/);
});

test('accepted payment produces a camt.053 statement with a matched debit entry', async (t) => {
  const sim = await launch(t);
  const payment = await post(sim, '/payments', fixture('bank-payment'));
  assert.equal(payment.status, 201, payment.text);
  assert.equal(payment.json.bankPaymentId, 'BNK-PAY-000001');
  assert.equal(payment.json.status, 'ACCEPTED');
  assert.equal(payment.json.settlementStatus, 'MATCHED');
  assert.equal(payment.json.creditedAmount.amount, '125000.00');

  const statement = await post(sim, '/statements', fixture('bank-statement'));
  assert.equal(statement.status, 201, statement.text);
  assert.equal(statement.json.statementId, 'BNK-STM-000001');
  assert.equal(statement.json.entryCount, 1);
  assert.equal(statement.json.controlSum.amount, '125000.00');
  assert.equal(statement.json.entries[0].creditDebit, 'DBIT');
  assert.equal(statement.json.entries[0].txStatus, 'MATCHED');

  const xml = await request(sim, { path: '/sim/bank/v1/statements/BNK-STM-000001/camt053' });
  assert.equal(xml.status, 200);
  assert.match(xml.headers['content-type'], /application\/xml/);
  assert.match(xml.text, /urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.08/);
  assert.match(xml.text, /<NbOfTxs>1<\/NbOfTxs>/);
  assert.match(xml.text, /<CtrlSum>125000\.00<\/CtrlSum>/);
  assert.match(xml.text, /<EndToEndId>E2E-2026-0044721<\/EndToEndId>/);
  assert.match(xml.text, /<Amt Ccy="USD">125000\.00<\/Amt>/);
  assert.match(xml.text, /<CdtDbtInd>DBIT<\/CdtDbtInd>/);
});

test('return and partial scenarios appear in the statement as credit and partial entries', async (t) => {
  const sim = await launch(t);
  await post(sim, '/payments', fixture('bank-payment'));

  const returned = await post(
    sim,
    '/payments',
    paymentWith({ key: 'smoke-bank-return-1', messageId: '0192f3a4-0000-7000-8000-000000030101', endToEndId: 'E2E-2026-0044722-RETURN' }),
  );
  assert.equal(returned.status, 201, returned.text);
  assert.equal(returned.json.settlementStatus, 'RETURNED');
  assert.equal(returned.json.returnReason, 'AC04');

  const partial = await post(
    sim,
    '/payments',
    paymentWith({ key: 'smoke-bank-partial-1', messageId: '0192f3a4-0000-7000-8000-000000030102', endToEndId: 'E2E-2026-0044723-PARTIAL' }),
    { 'x-sim-scenario': 'partial' },
  );
  assert.equal(partial.status, 201, partial.text);
  assert.equal(partial.json.settlementStatus, 'PARTIAL');
  assert.equal(partial.json.creditedAmount.amount, '62500.00');

  const statement = await post(sim, '/statements', statementWith('smoke-bank-statement-2', '0192f3a4-0000-7000-8000-000000031002'));
  assert.equal(statement.status, 201, statement.text);
  assert.equal(statement.json.entryCount, 3);
  assert.deepEqual(
    statement.json.entries.map((entry) => entry.txStatus),
    ['MATCHED', 'RETURNED', 'PARTIAL'],
  );

  const xml = await request(sim, { path: `/sim/bank/v1/statements/${statement.json.statementId}/camt053` });
  assert.match(xml.text, /<CdtDbtInd>CRDT<\/CdtDbtInd>/);
  assert.match(xml.text, /<RtrInf><Rsn><Cd>AC04<\/Cd><\/Rsn><\/RtrInf>/);
  assert.match(xml.text, /<AddtlTxInf>PARTIAL<\/AddtlTxInf>/);
});

test('duplicate end-to-end identifiers are rejected while idempotent replays are acknowledged', async (t) => {
  const sim = await launch(t);
  const body = fixture('bank-payment');
  const first = await post(sim, '/payments', body);
  assert.equal(first.status, 201);

  const replay = await post(sim, '/payments', body);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers['idempotent-replayed'], 'true');
  assert.deepEqual(replay.json, first.json);

  const duplicate = paymentWith({
    key: 'smoke-bank-duplicate-1',
    messageId: '0192f3a4-0000-7000-8000-000000030201',
    endToEndId: 'E2E-2026-0044721',
    amount: '999.00',
  });
  const conflict = await post(sim, '/payments', duplicate);
  expectProblem(conflict, { status: 409, category: 'CONFLICT' });
  assert.equal(conflict.json.meta.reasonCode, 'DUPLICATE_PAYMENT');
});

test('statement generation is deterministic and can be empty', async (t) => {
  const sim = await launch(t);
  const empty = withKey(fixture('bank-statement'), 'smoke-bank-statement-empty');
  empty.messageId = '0192f3a4-0000-7000-8000-000000031101';
  const response = await post(sim, '/statements', empty);
  assert.equal(response.status, 201, response.text);
  assert.equal(response.json.entryCount, 0);
  assert.equal(response.json.controlSum.amount, '0.00');

  const xml = await request(sim, { path: `/sim/bank/v1/statements/${response.json.statementId}/camt053` });
  assert.match(xml.text, /<NbOfTxs>0<\/NbOfTxs>/);
  assert.match(xml.text, /<CtrlSum>0\.00<\/CtrlSum>/);

  const missingKey = fixture('bank-statement');
  delete missingKey.idempotencyKey;
  const noKey = await post(sim, '/statements', missingKey);
  expectProblem(noKey, { status: 400, category: 'VALIDATION' });
  assert.equal(noKey.json.code, 'EIA-SIM-IDEMPOTENCY-KEY-REQUIRED');

  const badIban = withKey(fixture('bank-payment'), 'smoke-bank-bad-iban');
  badIban.messageId = '0192f3a4-0000-7000-8000-000000030301';
  badIban.creditor.iban = 'not-an-iban';
  const invalid = await post(sim, '/payments', badIban);
  expectProblem(invalid, { status: 400, category: 'VALIDATION' });

  const timeout = await post(sim, '/payments', paymentWith({
    key: 'smoke-bank-timeout-1',
    messageId: '0192f3a4-0000-7000-8000-000000030401',
    endToEndId: 'E2E-2026-TIMEOUT-1',
  }), { 'x-sim-scenario': 'timeout', 'x-sim-delay-ms': '0' });
  expectProblem(timeout, { status: 504, category: 'TIMEOUT' });
});
