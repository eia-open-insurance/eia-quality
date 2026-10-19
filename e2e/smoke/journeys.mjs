import assert from 'node:assert/strict';

import { clone, loadFixture, withKey } from '../fixtures/index.mjs';

async function call(baseUrl, { method = 'GET', path = '', body, headers = {} } = {}) {
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
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, json };
}

function ok(response, expected, label) {
  assert.equal(response.status, expected, `${label} failed: HTTP ${response.status} ${response.text}`);
  return response.json;
}

function envelope(key, messageId, { book, system = 'eia-quality-e2e', target }) {
  return {
    messageId,
    idempotencyKey: key,
    tenantId: '0192f3a4-0000-7000-8000-000000000001',
    ...(book ? { businessBook: book } : {}),
    sourceSystem: system,
    targetSystem: target,
    schemaVersion: '1.0.0',
    createdAt: '2026-10-19T12:00:00.000Z',
  };
}

async function resetAll(urls) {
  for (const [system, entry] of Object.entries(urls)) {
    const response = await call(entry.baseUrl, { method: 'POST', path: '/admin/reset' });
    assert.equal(response.status, 200, `reset ${system} failed: ${response.text}`);
  }
}

async function reinsuranceJourney(urls, evidence) {
  const fsri = urls.fsri.baseUrl;

  const contract = await call(fsri, { method: 'POST', path: '/contracts', body: loadFixture('fsri-contract') });
  const contractBody = ok(contract, 201, 'FS-RI contract hand-off');
  assert.equal(contractBody.fsriContractRef, 'FSRI-CTR-DIRECT-000001');
  evidence.push(`FS-RI contract ${contractBody.contractNumber} → ${contractBody.fsriContractRef}`);

  const cession = await call(fsri, { method: 'POST', path: '/cessions', body: loadFixture('fsri-cession') });
  const cessionBody = ok(cession, 201, 'FS-RI cession hand-off');
  assert.equal(cessionBody.confirmedAmount.amount, '240000.00');
  assert.equal(cessionBody.confirmation.status, 'CONFIRMED');
  assert.match(cessionBody._links.recoverable.href, /FSRI-RCV-DIRECT-000001$/);
  evidence.push(
    `FS-RI cession ${cessionBody.fsriCessionId} confirmed ${cessionBody.confirmedAmount.amount} ${cessionBody.confirmedAmount.currency}`,
  );

  const confirmation = await call(fsri, {
    method: 'POST',
    path: `/cessions/${cessionBody.fsriCessionId}/confirmation`,
    body: envelope('e2e-fsri-confirmation-1', '0192f3a4-0000-7000-8000-000000090001', {
      book: 'DIRECT',
      target: 'FS-RI',
    }),
  });
  const confirmationBody = ok(confirmation, 200, 'FS-RI confirmation');
  assert.equal(confirmationBody.status, 'CONFIRMED');
  evidence.push(`FS-RI confirmation ${confirmationBody.confirmationId} ${confirmationBody.status}`);

  const recoverables = await call(fsri, { path: '/recoverables?businessBook=DIRECT' });
  const recoverableList = ok(recoverables, 200, 'FS-RI recoverables');
  assert.equal(recoverableList.data.length, 1);
  assert.equal(recoverableList.data[0].paid.amount, '144000.00');
  evidence.push(`FS-RI recoverable ${recoverableList.data[0].recoverableId} paid ${recoverableList.data[0].paid.amount}`);

  const statement = await call(fsri, { method: 'POST', path: '/statements', body: loadFixture('fsri-statement') });
  const statementBody = ok(statement, 201, 'FS-RI statement');
  assert.equal(statementBody.totals.netDue.amount, '60000.00');
  evidence.push(`FS-RI statement ${statementBody.statementNumber} net due ${statementBody.totals.netDue.amount}`);

  const reconciliation = await call(fsri, { path: '/reconciliations?businessBook=DIRECT&period=2026-09' });
  const reconciliationBody = ok(reconciliation, 200, 'FS-RI reconciliation');
  assert.equal(reconciliationBody.status, 'BALANCED');
  assert.equal(reconciliationBody.invariant.balanced, true);
  evidence.push(`FS-RI reconciliation ${reconciliationBody.status} sent=${reconciliationBody.sent} accepted=${reconciliationBody.accepted}`);
}

async function financeJourney(urls, evidence) {
  const s4 = urls.s4.baseUrl;

  const journal = await call(s4, { method: 'POST', path: '/journal-entries', body: loadFixture('s4-journal-entry') });
  const journalBody = ok(journal, 201, 'S/4 journal');
  assert.equal(journalBody.documentNumber, 'S4-JE-2026-000001');
  assert.equal(journalBody.totalDebit.amount, journalBody.totalCredit.amount);
  evidence.push(`S/4 journal ${journalBody.documentNumber} ${journalBody.totalDebit.amount} balanced`);

  const ar = await call(s4, { method: 'POST', path: '/ar-invoices', body: loadFixture('s4-ar-invoice') });
  const arBody = ok(ar, 201, 'S/4 AR invoice');
  assert.equal(arBody.grossAmount.amount, '100000.00');
  evidence.push(`S/4 AR ${arBody.arInvoiceNumber} ${arBody.grossAmount.amount}`);

  const supplier = await call(s4, {
    method: 'POST',
    path: '/supplier-invoices',
    body: loadFixture('s4-supplier-invoice'),
  });
  const supplierBody = ok(supplier, 201, 'S/4 supplier invoice');
  assert.equal(supplierBody.grossAmount.amount, '50000.00');
  evidence.push(`S/4 AP ${supplierBody.supplierInvoiceNumber} ${supplierBody.grossAmount.amount}`);

  const advice = await call(s4, { method: 'POST', path: '/payment-advices', body: loadFixture('s4-payment-advice') });
  const adviceBody = ok(advice, 201, 'S/4 payment advice');
  assert.equal(adviceBody.status, 'PAID');
  evidence.push(`S/4 payment advice ${adviceBody.paymentAdviceNumber} paid ${adviceBody.amount.amount}`);

  const cash = await call(s4, {
    method: 'POST',
    path: '/cash-applications',
    body: loadFixture('s4-cash-application'),
  });
  const cashBody = ok(cash, 201, 'S/4 cash application');
  assert.equal(cashBody.status, 'CLEARED');
  evidence.push(`S/4 clearing ${cashBody.clearingDocument} applied ${cashBody.appliedAmount.amount}`);

  const reconciliation = await call(s4, {
    method: 'POST',
    path: '/reconciliations',
    body: loadFixture('s4-reconciliation'),
  });
  const reconciliationBody = ok(reconciliation, 201, 'S/4 reconciliation');
  assert.equal(reconciliationBody.status, 'MATCHED');
  assert.equal(reconciliationBody.breakCount, 0);
  evidence.push(`S/4 reconciliation ${reconciliationBody.reconciliationId} ${reconciliationBody.status}`);

  const balances = await call(s4, { path: '/gl-balances?companyCode=1000&period=2026-09' });
  const balanceBody = ok(balances, 200, 'S/4 GL balances');
  const receivable = balanceBody.data.find((entry) => entry.account === '120100');
  assert.equal(receivable.debit.amount, '100000.00');
  evidence.push(`S/4 GL 120100 debit ${receivable.debit.amount} balance ${receivable.balance.amount}`);
}

async function bankJourney(urls, evidence) {
  const bank = urls.bank.baseUrl;

  const payment = await call(bank, { method: 'POST', path: '/payments', body: loadFixture('bank-payment') });
  const paymentBody = ok(payment, 201, 'Bank payment');
  assert.equal(paymentBody.settlementStatus, 'MATCHED');
  evidence.push(`Bank payment ${paymentBody.bankPaymentId} ${paymentBody.settlementStatus}`);

  const statement = await call(bank, { method: 'POST', path: '/statements', body: loadFixture('bank-statement') });
  const statementBody = ok(statement, 201, 'Bank statement');
  assert.equal(statementBody.entryCount, 1);
  const xml = await call(bank, { path: `/statements/${statementBody.statementId}/camt053` });
  assert.equal(xml.status, 200, `camt.053 failed: ${xml.text}`);
  assert.match(xml.text, /camt\.053\.001\.08/);
  assert.match(xml.text, /E2E-2026-0044721/);
  evidence.push(`Bank camt.053 ${statementBody.statementId} entries=${statementBody.entryCount}`);

  const returned = withKey(loadFixture('bank-payment'), 'e2e-bank-return-1');
  returned.messageId = '0192f3a4-0000-7000-8000-000000091001';
  returned.paymentId = 'PAY-2026-0044722';
  returned.endToEndId = 'E2E-2026-0044722-RETURN';
  const returnResponse = await call(bank, { method: 'POST', path: '/payments', body: returned });
  const returnBody = ok(returnResponse, 201, 'Bank return payment');
  assert.equal(returnBody.settlementStatus, 'RETURNED');
  assert.equal(returnBody.returnReason, 'AC04');
  evidence.push(`Bank return ${returnBody.bankPaymentId} reason ${returnBody.returnReason}`);
}

async function screeningAndDocumentJourney(urls, evidence) {
  const email = urls.email.baseUrl;
  const ocr = urls.ocr.baseUrl;
  const sanctions = urls.sanctions.baseUrl;

  const delivered = await call(email, { method: 'POST', path: '/messages', body: loadFixture('email-message') });
  const deliveredBody = ok(delivered, 201, 'Email delivery');
  assert.equal(deliveredBody.status, 'DELIVERED');
  evidence.push(`Email ${deliveredBody.messageId} ${deliveredBody.status}`);

  const bounced = withKey(loadFixture('email-message'), 'e2e-email-bounce-1');
  bounced.messageId = '0192f3a4-0000-7000-8000-000000092001';
  bounced.notificationId = 'NOTIF-E2E-000002';
  bounced.recipients = [{ address: 'bounce@example.test', name: 'Bounce Target' }];
  const bounceResponse = await call(email, { method: 'POST', path: '/messages', body: bounced });
  const bounceBody = ok(bounceResponse, 201, 'Email bounce');
  assert.equal(bounceBody.status, 'BOUNCED');
  evidence.push(`Email ${bounceBody.messageId} ${bounceBody.status} ${bounceBody.bounce.code}`);

  const completed = await call(ocr, { method: 'POST', path: '/documents', body: loadFixture('ocr-document') });
  const completedBody = ok(completed, 201, 'OCR completion');
  assert.equal(completedBody.status, 'COMPLETED');
  assert.equal(completedBody.extractedFields.billedAmount.amount, '1250.00');
  evidence.push(`OCR ${completedBody.jobId} ${completedBody.status} confidence=${completedBody.confidence}`);

  const low = withKey(loadFixture('ocr-document'), 'e2e-ocr-low-1');
  low.messageId = '0192f3a4-0000-7000-8000-000000093001';
  low.documentId = '0192f3a4-0000-7000-8000-000000050101';
  low.versionHash = '1'.repeat(64);
  const lowResponse = await call(ocr, {
    method: 'POST',
    path: '/documents',
    body: low,
    headers: { 'x-sim-scenario': 'low_confidence' },
  });
  const lowBody = ok(lowResponse, 201, 'OCR low confidence');
  assert.equal(lowBody.status, 'LOW_CONFIDENCE');
  evidence.push(`OCR ${lowBody.jobId} ${lowBody.status} confidence=${lowBody.confidence}`);

  const clear = await call(sanctions, {
    method: 'POST',
    path: '/screenings',
    body: loadFixture('sanctions-screening'),
  });
  const clearBody = ok(clear, 201, 'Sanctions clear');
  assert.equal(clearBody.status, 'CLEAR');
  evidence.push(`Sanctions ${clearBody.screeningId} ${clearBody.status}`);

  const confirmed = withKey(loadFixture('sanctions-screening'), 'e2e-sanctions-confirmed-1');
  confirmed.messageId = '0192f3a4-0000-7000-8000-000000094001';
  confirmed.screeningRequestId = 'SCR-REQ-E2E-000002';
  confirmed.party.name = 'Ivan Fictionalov';
  const confirmedResponse = await call(sanctions, { method: 'POST', path: '/screenings', body: confirmed });
  const confirmedBody = ok(confirmedResponse, 201, 'Sanctions confirmed');
  assert.equal(confirmedBody.status, 'CONFIRMED_MATCH');
  assert.equal(confirmedBody.decision, 'BLOCK');
  evidence.push(`Sanctions ${confirmedBody.screeningId} ${confirmedBody.status} decision=${confirmedBody.decision}`);
}

/**
 * Cross-simulator journeys used by local E2E. Each journey resets the
 * simulator state first, then asserts the integration contract rather than
 * only the HTTP status.
 */
export async function runJourneys({ urls, log = (line) => console.log(line) } = {}) {
  if (!urls) throw new Error('runJourneys requires resolved simulator URLs');
  const evidence = [];
  const started = Date.now();

  log('[e2e] resetting simulator state');
  await resetAll(urls);

  log('[e2e] journey 1/4: reinsurance cession hand-off and statement');
  await reinsuranceJourney(urls, evidence);

  log('[e2e] journey 2/4: SAP finance posting, payment and reconciliation');
  await financeJourney(urls, evidence);

  log('[e2e] journey 3/4: bank camt.053 statement');
  await bankJourney(urls, evidence);

  log('[e2e] journey 4/4: notification, OCR and sanctions screening');
  await screeningAndDocumentJourney(urls, evidence);

  for (const line of evidence) log(`[e2e] PASS ${line}`);
  log(`[e2e] ${evidence.length} assertions passed in ${Date.now() - started} ms`);

  return { systems: Object.keys(urls), checks: evidence.length, evidence };
}
