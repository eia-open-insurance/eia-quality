import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.mjs';
import { expectProblem, fixture, payloadHash, request, startSimulator, withKey } from '../../common/testkit.mjs';

async function launch(t) {
  const sim = await startSimulator(createServer);
  t.after(() => sim.close());
  return sim;
}

test('aggregate simulator mounts all six systems on one base URL', async (t) => {
  const sim = await launch(t);

  const root = await request(sim, { path: '/' });
  assert.equal(root.status, 200);
  assert.equal(root.json.testDouble, true);
  assert.equal(root.json.simulators.length, 6);
  assert.deepEqual(
    root.json.simulators.map((entry) => entry.basePath),
    ['/sim/fsri/v1', '/sim/s4/v1', '/sim/bank/v1', '/sim/email/v1', '/sim/ocr/v1', '/sim/sanctions/v1'],
  );

  for (const system of ['fsri', 's4', 'bank', 'email', 'ocr', 'sanctions']) {
    const health = await request(sim, { path: `/sim/${system}/health` });
    assert.equal(health.status, 200, `${system} health`);
    assert.equal(health.json.simulator, system);
    assert.equal(health.json.status, 'UP');

    const openapi = await request(sim, { path: `/sim/${system}/openapi.yaml` });
    assert.equal(openapi.status, 200, `${system} openapi`);
    assert.match(openapi.text, /openapi: 3\.1\.0/);
  }

  const unknown = await request(sim, { path: '/sim/unknown/v1/nothing' });
  expectProblem(unknown, { status: 404, category: 'NOT_FOUND' });
  assert.equal(unknown.json.meta.simulators.length, 6);
});

test('a reinsurance and finance journey runs against the aggregate service', async (t) => {
  const sim = await launch(t);

  const contract = await request(sim, {
    method: 'POST',
    path: '/sim/fsri/v1/contracts',
    body: fixture('fsri-contract'),
  });
  assert.equal(contract.status, 201, contract.text);

  const cession = withKey(fixture('fsri-cession'), 'smoke-all-cession');
  cession.payloadHash = payloadHash(cession);
  const handoff = await request(sim, { method: 'POST', path: '/sim/fsri/v1/cessions', body: cession });
  assert.equal(handoff.status, 201, handoff.text);
  assert.equal(handoff.headers['x-sim-system'], 'fsri');

  const journal = await request(sim, {
    method: 'POST',
    path: '/sim/s4/v1/journal-entries',
    body: fixture('s4-journal-entry'),
  });
  assert.equal(journal.status, 201, journal.text);
  assert.equal(journal.headers['x-sim-system'], 's4');
  assert.equal(journal.json.documentNumber, 'S4-JE-2026-000001');

  const recoverable = await request(sim, { path: '/sim/fsri/v1/recoverables' });
  assert.equal(recoverable.json.data.length, 1);
  assert.equal(recoverable.json.data[0].recoverableId, 'FSRI-RCV-DIRECT-000001');

  const balances = await request(sim, { path: '/sim/s4/v1/gl-balances?companyCode=1000&period=2026-09' });
  assert.equal(balances.json.data.find((entry) => entry.account === '510100').debit.amount, '250000.00');

  const fsriState = await request(sim, { path: '/sim/fsri/v1/admin/state' });
  const s4State = await request(sim, { path: '/sim/s4/v1/admin/state' });
  assert.equal(fsriState.json.counts.cessions, 1);
  assert.equal(s4State.json.counts.journalEntries, 1);
  assert.equal(fsriState.json.counts.journalEntries, undefined);
  assert.equal(s4State.json.counts.cessions, undefined);
});
