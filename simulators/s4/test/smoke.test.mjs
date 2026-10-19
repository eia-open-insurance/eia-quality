import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.mjs';
import { expectProblem, expectReplay, fixture, request, startSimulator, withKey } from '../../common/testkit.mjs';

const PATH = '/sim/s4/v1';

async function launch(t) {
  const sim = await startSimulator(createServer);
  t.after(() => sim.close());
  return sim;
}

function post(sim, path, body, headers = {}) {
  return request(sim, { method: 'POST', path: `${PATH}${path}`, body, headers });
}

async function seedJournal(sim, key = 'smoke-s4-journal-1') {
  const response = await post(sim, '/journal-entries', withKey(fixture('s4-journal-entry'), key));
  assert.equal(response.status, 201, response.text);
  return response.json;
}

async function seedInvoices(sim) {
  const ar = await post(sim, '/ar-invoices', fixture('s4-ar-invoice'));
  assert.equal(ar.status, 201, ar.text);
  const supplier = await post(sim, '/supplier-invoices', fixture('s4-supplier-invoice'));
  assert.equal(supplier.status, 201, supplier.text);
  return { ar: ar.json, supplier: supplier.json };
}

test('S/4 simulator exposes health, discovery and OpenAPI', async (t) => {
  const sim = await launch(t);
  const health = await request(sim, { path: '/sim/s4/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.simulator, 's4');
  assert.deepEqual(health.json.closedPeriods, undefined);
  assert.deepEqual(health.json.records.arInvoices, 0);

  const openapi = await request(sim, { path: '/sim/s4/openapi.yaml' });
  assert.equal(openapi.status, 200);
  assert.match(openapi.text, /openapi: 3\.1\.0/);

  const adminState = await request(sim, { path: `${PATH}/admin/state` });
  assert.deepEqual(adminState.json.closedPeriods, ['2025-12']);
});

test('journal entry posts, balances the GL and reverses with a new document', async (t) => {
  const sim = await launch(t);
  const journal = await seedJournal(sim);
  assert.equal(journal.documentNumber, 'S4-JE-2026-000001');
  assert.equal(journal.status, 'POSTED');
  assert.equal(journal.postingPeriod, '2026-09');
  assert.equal(journal.totalDebit.amount, '250000.00');
  assert.equal(journal.totalCredit.amount, '250000.00');
  assert.equal(journal.fxDifference.amount, '0.00');

  const balances = await request(sim, { path: `${PATH}/gl-balances?companyCode=1000&period=2026-09` });
  assert.equal(balances.status, 200);
  const incurred = balances.json.data.find((entry) => entry.account === '510100');
  const reserve = balances.json.data.find((entry) => entry.account === '215000');
  assert.equal(incurred.debit.amount, '250000.00');
  assert.equal(reserve.credit.amount, '250000.00');
  assert.equal(balances.json.totals.debit.amount, '250000.00');
  assert.equal(balances.json.totals.credit.amount, '250000.00');
  assert.equal(balances.json.totals.balance.amount, '0.00');

  const reversal = await post(sim, '/reversals', fixture('s4-reversal'));
  assert.equal(reversal.status, 201, reversal.text);
  assert.equal(reversal.json.originalDocumentNumber, 'S4-JE-2026-000001');
  assert.equal(reversal.json.reversedAmount.amount, '250000.00');
  assert.equal(reversal.json.originalDocumentType, 'JOURNAL_ENTRY');

  const second = withKey(fixture('s4-reversal'), 'smoke-s4-reversal-2');
  second.messageId = '0192f3a4-0000-7000-8000-000000026002';
  const already = await post(sim, '/reversals', second);
  expectProblem(already, { status: 409, category: 'CONFLICT' });
  assert.equal(already.json.meta.reasonCode, 'ALREADY_REVERSED');

  const october = await request(sim, { path: `${PATH}/gl-balances?companyCode=1000&period=2026-10` });
  const reversedIncurred = october.json.data.find((entry) => entry.account === '510100');
  assert.equal(reversedIncurred.credit.amount, '250000.00');

  const journalDetail = await request(sim, { path: `${PATH}/journal-entries/S4-JE-2026-000001` });
  assert.equal(journalDetail.json.reversed, true);
  assert.equal(journalDetail.json.reversedBy, 'S4-RV-2026-000001');
});

test('closed periods reject posting and can be opened by the control endpoint', async (t) => {
  const sim = await launch(t);

  const defaultClosed = withKey(fixture('s4-journal-entry'), 'smoke-s4-closed-default');
  defaultClosed.messageId = '0192f3a4-0000-7000-8000-000000020101';
  defaultClosed.postingDate = '2025-12-31';
  defaultClosed.documentDate = '2025-12-31';
  const rejected = await post(sim, '/journal-entries', defaultClosed);
  expectProblem(rejected, { status: 422, category: 'BUSINESS_REJECT' });
  assert.equal(rejected.json.code, 'EIA-SIM-CLOSED-PERIOD');
  assert.equal(rejected.json.meta.period, '2025-12');

  const close = await request(sim, { method: 'POST', path: `${PATH}/admin/periods/2026-09/close` });
  assert.equal(close.status, 200);
  assert.deepEqual(close.json.closedPeriods, ['2025-12', '2026-09']);

  const blocked = await post(sim, '/journal-entries', withKey(fixture('s4-journal-entry'), 'smoke-s4-closed-2026'));
  expectProblem(blocked, { status: 422, category: 'BUSINESS_REJECT' });
  assert.equal(blocked.json.code, 'EIA-SIM-CLOSED-PERIOD');

  const open = await request(sim, { method: 'POST', path: `${PATH}/admin/periods/2026-09/open` });
  assert.deepEqual(open.json.closedPeriods, ['2025-12']);

  const accepted = await post(sim, '/journal-entries', withKey(fixture('s4-journal-entry'), 'smoke-s4-open-2026'));
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal(accepted.json.documentNumber, 'S4-JE-2026-000001');
});

test('unbalanced journals and FX differences are deterministic', async (t) => {
  const sim = await launch(t);

  const unbalanced = withKey(fixture('s4-journal-entry'), 'smoke-s4-unbalanced');
  unbalanced.messageId = '0192f3a4-0000-7000-8000-000000020201';
  unbalanced.lines[1].creditAmount.amount = '200000.00';
  const invalid = await post(sim, '/journal-entries', unbalanced);
  expectProblem(invalid, { status: 400, category: 'VALIDATION' });
  assert.ok(invalid.json.errors.some((error) => error.code === 'UNBALANCED_JOURNAL'));

  const fx = withKey(fixture('s4-journal-entry'), 'smoke-s4-fx');
  fx.messageId = '0192f3a4-0000-7000-8000-000000020202';
  fx.functionalCurrency = 'EUR';
  const posted = await post(sim, '/journal-entries', fx, { 'x-sim-scenario': 'fx_difference' });
  assert.equal(posted.status, 201, posted.text);
  assert.equal(posted.json.fxDifference.amount, '12.34');
  assert.equal(posted.json.fxDifference.currency, 'EUR');

  const magic = withKey(fixture('s4-journal-entry'), 'smoke-s4-fx-magic');
  magic.messageId = '0192f3a4-0000-7000-8000-000000020203';
  magic.businessReference = 'JE-CLAIM-RESERVE-2026-0002-FX';
  const viaSuffix = await post(sim, '/journal-entries', magic);
  assert.equal(viaSuffix.status, 201, viaSuffix.text);
  assert.equal(viaSuffix.json.fxDifference.amount, '12.34');
});

test('AR, AP, payment advice, cash application and reconciliation form a closed loop', async (t) => {
  const sim = await launch(t);
  await seedJournal(sim);
  const invoices = await seedInvoices(sim);
  assert.equal(invoices.ar.arInvoiceNumber, 'S4-AR-2026-000001');
  assert.equal(invoices.ar.grossAmount.amount, '100000.00');
  assert.equal(invoices.supplier.supplierInvoiceNumber, 'S4-SI-2026-000001');
  assert.equal(invoices.supplier.grossAmount.amount, '50000.00');
  assert.equal(invoices.supplier.duplicateCheck, 'PASSED');

  const advice = await post(sim, '/payment-advices', fixture('s4-payment-advice'));
  assert.equal(advice.status, 201, advice.text);
  assert.equal(advice.json.status, 'PAID');
  assert.equal(advice.json.paymentAdviceNumber, 'S4-PA-2026-000001');
  assert.equal(advice.json.paymentDocument, 'S4-PD-2026-000001');
  assert.match(advice.json.bankReference, /^BNK-[A-F0-9]{10}$/);

  const cash = await post(sim, '/cash-applications', fixture('s4-cash-application'));
  assert.equal(cash.status, 201, cash.text);
  assert.equal(cash.json.status, 'CLEARED');
  assert.equal(cash.json.appliedAmount.amount, '100000.00');
  assert.equal(cash.json.unappliedAmount.amount, '0.00');
  assert.equal(cash.json.invoiceDocumentNumber, 'S4-AR-2026-000001');

  const ar = await request(sim, { path: `${PATH}/ar-invoices/S4-AR-2026-000001` });
  assert.equal(ar.json.openAmount.amount, '0.00');
  assert.equal(ar.json.clearingStatus, 'CLEARED');

  const reconciliation = await post(sim, '/reconciliations', fixture('s4-reconciliation'));
  assert.equal(reconciliation.status, 201, reconciliation.text);
  assert.equal(reconciliation.json.status, 'MATCHED');
  assert.equal(reconciliation.json.matchedCount, 2);
  assert.equal(reconciliation.json.breakCount, 0);
  assert.equal(reconciliation.json.expectedTotal.amount, '150000.00');
  assert.equal(reconciliation.json.postedTotal.amount, '150000.00');
  assert.equal(reconciliation.json.variance.amount, '0.00');
  assert.deepEqual(reconciliation.json.breaks, []);

  const breaks = withKey(fixture('s4-reconciliation'), 'smoke-s4-recon-breaks');
  breaks.messageId = '0192f3a4-0000-7000-8000-000000025002';
  breaks.expected[0].amount.amount = '99999.00';
  breaks.expected.push({
    businessReference: 'BILL-MISSING-0001',
    documentType: 'AR_INVOICE',
    amount: { amount: '1000.00', currency: 'USD' },
  });
  const broken = await post(sim, '/reconciliations', breaks);
  assert.equal(broken.status, 201);
  assert.equal(broken.json.status, 'BREAKS');
  assert.ok(broken.json.breaks.some((entry) => entry.reason === 'AMOUNT_MISMATCH'));
  assert.ok(broken.json.breaks.some((entry) => entry.reason === 'MISSING_SAP_INVOICE'));
});

test('idempotent replay and SAP duplicate checks acknowledge instead of reposting', async (t) => {
  const sim = await launch(t);
  const body = fixture('s4-ar-invoice');

  const first = await post(sim, '/ar-invoices', body);
  assert.equal(first.status, 201);

  const replay = await post(sim, '/ar-invoices', body);
  expectReplay(replay);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.json, first.json);

  const duplicate = withKey(body, 'smoke-s4-ar-duplicate');
  duplicate.messageId = '0192f3a4-0000-7000-8000-000000021002';
  const duplicateResponse = await post(sim, '/ar-invoices', duplicate);
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateResponse.json.duplicate, true);
  assert.equal(duplicateResponse.json.arInvoiceNumber, first.json.arInvoiceNumber);

  const conflict = withKey(body, 'smoke-s4-ar-conflict');
  conflict.messageId = '0192f3a4-0000-7000-8000-000000021003';
  conflict.netAmount.amount = '120000.00';
  const conflictResponse = await post(sim, '/ar-invoices', conflict);
  expectProblem(conflictResponse, { status: 409, category: 'CONFLICT' });
  assert.equal(conflictResponse.json.meta.reasonCode, 'DUPLICATE_INVOICE');

  const missingKey = fixture('s4-ar-invoice');
  delete missingKey.idempotencyKey;
  missingKey.billingInstructionId = 'BI-2026-0002';
  const noKey = await post(sim, '/ar-invoices', missingKey);
  expectProblem(noKey, { status: 400, category: 'VALIDATION' });
  assert.equal(noKey.json.code, 'EIA-SIM-IDEMPOTENCY-KEY-REQUIRED');
});

test('fault scenarios use the shared taxonomy', async (t) => {
  const sim = await launch(t);

  const reject = await post(sim, '/journal-entries', withKey(fixture('s4-journal-entry'), 'smoke-s4-reject'), {
    'x-sim-scenario': 'reject',
  });
  expectProblem(reject, { status: 422, category: 'BUSINESS_REJECT' });
  assert.equal(reject.json.meta.reasonCode, 'S4-FI-REJECT');

  const timeout = await post(sim, '/journal-entries', withKey(fixture('s4-journal-entry'), 'smoke-s4-timeout'), {
    'x-sim-scenario': 'timeout',
    'x-sim-delay-ms': '0',
  });
  expectProblem(timeout, { status: 504, category: 'TIMEOUT' });

  const unavailable = await post(sim, '/journal-entries', withKey(fixture('s4-journal-entry'), 'smoke-s4-unavailable'), {
    'x-sim-scenario': 'unavailable',
  });
  expectProblem(unavailable, { status: 503, category: 'UNAVAILABLE' });
  assert.equal(unavailable.headers['retry-after'], '5');

  const state = await request(sim, { path: `${PATH}/admin/state` });
  assert.equal(state.json.counts.journalEntries, 0);
});

test('identical request sequences produce identical response bodies', async () => {
  async function runOnce() {
    const sim = await startSimulator(createServer);
    try {
      const journal = await post(sim, '/journal-entries', fixture('s4-journal-entry'));
      const ar = await post(sim, '/ar-invoices', fixture('s4-ar-invoice'));
      const balances = await request(sim, { path: `${PATH}/gl-balances?companyCode=1000&period=2026-09` });
      return { journal: journal.json, ar: ar.json, balances: balances.json };
    } finally {
      await sim.close();
    }
  }
  const first = await runOnce();
  const second = await runOnce();
  assert.deepEqual(second, first);
});
