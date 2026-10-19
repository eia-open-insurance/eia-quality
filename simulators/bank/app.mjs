import { clockInfo, nowIso } from '../common/clock.mjs';
import { applyPercent, moneyObject } from '../common/money.mjs';
import { createRouter } from '../common/router.mjs';
import { createState } from '../common/store.mjs';
import { Validator } from '../common/validate.mjs';
import { CATEGORY, CODES, problem } from '../common/problem.mjs';
import { withIdempotency } from '../common/idempotency.mjs';
import { COMMON_SCENARIOS, assertScenario } from '../common/scenarios.mjs';
import { paginate } from '../common/pagination.mjs';

export const BANK_SYSTEM = 'bank';
export const BANK_BASE_PATH = '/sim/bank/v1';
const SCHEMA_MAJOR = 1;
const IBAN_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/;

const ALLOWED_SCENARIOS = Object.freeze([...COMMON_SCENARIOS, 'return']);
const MAGIC_SCENARIOS = Object.freeze([
  { suffix: '-RETURN', scenario: 'return' },
  { suffix: '-PARTIAL', scenario: 'partial' },
  { suffix: '-REJECT', scenario: 'reject' },
  { suffix: '-TIMEOUT', scenario: 'timeout' },
  { suffix: '-UNAVAILABLE', scenario: 'unavailable' },
  { suffix: '-THROTTLED', scenario: 'throttled' },
  { suffix: '-MALFORMED', scenario: 'malformed' },
  { suffix: '-DUPLICATE', scenario: 'duplicate' },
]);

const COLLECTIONS = ['payments', 'statements'];

function notFound(ctx, title, detail) {
  return problem({
    status: 404,
    category: CATEGORY.NOT_FOUND,
    code: CODES.NOT_FOUND,
    title,
    detail,
    instance: ctx.path,
    retryable: false,
    correlationId: ctx.correlationId,
  });
}

function businessReject(ctx, { title, detail, reasonCode, errors = [], meta = {} }) {
  return problem({
    status: 422,
    category: CATEGORY.BUSINESS_REJECT,
    code: CODES.BUSINESS_REJECT,
    title,
    detail,
    instance: ctx.path,
    retryable: false,
    errors,
    meta: { reasonCode, ...meta },
    correlationId: ctx.correlationId,
  });
}

function moneyView(units, currency) {
  return moneyObject(units, currency);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paymentView(record) {
  return {
    bankPaymentId: record.bankPaymentId,
    paymentId: record.paymentId,
    endToEndId: record.endToEndId,
    status: record.status,
    settlementStatus: record.settlementStatus,
    debtorAccount: { iban: record.debtorIban, name: record.debtorName ?? null },
    creditor: { name: record.creditorName, iban: record.creditorIban },
    amount: moneyView(record.amountUnits, record.currency),
    creditedAmount: moneyView(record.creditedUnits, record.currency),
    currency: record.currency,
    method: record.method,
    requestedExecutionDate: record.requestedExecutionDate,
    executionDate: record.requestedExecutionDate,
    remittanceInformation: record.remittanceInformation ?? null,
    returnReason: record.returnReason ?? null,
    acceptedAt: record.acceptedAt,
    _links: {
      self: { href: `${BANK_BASE_PATH}/payments/${record.bankPaymentId}` },
    },
  };
}

function statementView(record) {
  return {
    statementId: record.statementId,
    statementNumber: record.statementNumber,
    accountIban: record.accountIban,
    fromDate: record.fromDate,
    toDate: record.toDate,
    currency: record.currency,
    entryCount: record.entries.length,
    controlSum: moneyView(record.controlSumUnits, record.currency),
    createdAt: record.createdAt,
    entries: record.entries.map((entry) => ({
      entryReference: entry.entryReference,
      bankPaymentId: entry.bankPaymentId,
      endToEndId: entry.endToEndId,
      amount: moneyView(entry.amountUnits, record.currency),
      creditDebit: entry.creditDebit,
      status: entry.status,
      txStatus: entry.txStatus,
      bookingDate: entry.bookingDate,
      valueDate: entry.valueDate,
      returnReason: entry.returnReason ?? null,
    })),
    camt053: { href: `${BANK_BASE_PATH}/statements/${record.statementId}/camt053` },
    _links: { self: { href: `${BANK_BASE_PATH}/statements/${record.statementId}` } },
  };
}

function camt053Xml(record) {
  const entries = record.entries
    .map(
      (entry) => `      <Ntry>
        <NtryRef>${xmlEscape(entry.entryReference)}</NtryRef>
        <Amt Ccy="${xmlEscape(record.currency)}">${moneyView(entry.amountUnits, record.currency).amount}</Amt>
        <CdtDbtInd>${entry.creditDebit}</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>${entry.bookingDate}</Dt></BookgDt>
        <ValDt><Dt>${entry.valueDate}</Dt></ValDt>
        <AcctSvcrRef>${xmlEscape(entry.bankPaymentId)}</AcctSvcrRef>
        <BkTxCd>
          <Domn>
            <Cd>PMNT</Cd>
            <Fmly><Cd>ICDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly>
          </Domn>
        </BkTxCd>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <EndToEndId>${xmlEscape(entry.endToEndId)}</EndToEndId>
              <TxId>${xmlEscape(entry.bankPaymentId)}</TxId>
            </Refs>
            <AddtlTxInf>${xmlEscape(entry.txStatus)}</AddtlTxInf>${
              entry.returnReason
                ? `
            <RtrInf><Rsn><Cd>${xmlEscape(entry.returnReason)}</Cd></Rsn></RtrInf>`
                : ''
            }
          </TxDtls>
        </NtryDtls>
      </Ntry>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>BNK-MSG-${xmlEscape(record.statementId)}</MsgId>
      <CreDtTm>${record.createdAt}</CreDtTm>
      <NbOfTxs>${record.entries.length}</NbOfTxs>
      <CtrlSum>${moneyView(record.controlSumUnits, record.currency).amount}</CtrlSum>
    </GrpHdr>
    <Stmt>
      <Id>${xmlEscape(record.statementId)}</Id>
      <CreDtTm>${record.createdAt}</CreDtTm>
      <Acct>
        <Id><IBAN>${xmlEscape(record.accountIban)}</IBAN></Id>
        <Ccy>${xmlEscape(record.currency)}</Ccy>
      </Acct>
${entries}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
}

export function createApp({ state = createState({ system: BANK_SYSTEM, collections: COLLECTIONS }) } = {}) {
  const router = createRouter();
  const repository = state.repo;

  function scenarioRefs(payload) {
    return [
      payload?.endToEndId,
      payload?.paymentId,
      payload?.remittanceInformation,
      payload?.creditor?.name,
      payload?.accountIban,
    ];
  }

  router.get('/admin/state', () => ({
    status: 200,
    body: {
      simulator: BANK_SYSTEM,
      testDouble: true,
      clock: clockInfo(),
      startedAt: state.startedAt,
      scenario: state.defaultScenario,
      scenarios: ALLOWED_SCENARIOS,
      counts: state.counts(),
      recentRequests: state.requests.slice(-20),
    },
  }));

  router.post('/admin/reset', () => {
    state.reset();
    return { status: 200, body: { status: 'RESET', simulator: BANK_SYSTEM, clock: nowIso(), counts: state.counts() } };
  });

  router.get('/admin/scenarios', () => ({
    status: 200,
    body: { simulator: BANK_SYSTEM, defaultScenario: state.defaultScenario, allowed: ALLOWED_SCENARIOS },
  }));

  router.post('/admin/scenarios', (ctx) => {
    const scenario = ctx.payload?.scenario ?? null;
    if (scenario !== null && !ALLOWED_SCENARIOS.includes(String(scenario).toLowerCase())) {
      return problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.UNKNOWN_SCENARIO,
        title: 'Unknown simulation scenario',
        detail: `Use one of ${ALLOWED_SCENARIOS.join(', ')} or null to clear.`,
        instance: ctx.path,
        retryable: false,
        meta: { allowed: ALLOWED_SCENARIOS, received: scenario },
      });
    }
    state.defaultScenario = scenario === null ? null : String(scenario).toLowerCase();
    return { status: 200, body: { simulator: BANK_SYSTEM, defaultScenario: state.defaultScenario } };
  });

  router.post('/payments', async (ctx) => {
    assertScenario(ctx, ['reject', 'partial', 'return']);
    const validator = new Validator();
    const paymentId = validator.string(ctx.payload.paymentId, 'paymentId', { max: 64, pattern: REFERENCE_PATTERN });
    const endToEndId = validator.string(ctx.payload.endToEndId, 'endToEndId', { max: 64, pattern: REFERENCE_PATTERN });
    const debtor = ctx.payload.debtorAccount;
    let debtorIban;
    let debtorName;
    if (debtor === null || typeof debtor !== 'object' || Array.isArray(debtor)) {
      validator.add('debtorAccount', 'REQUIRED', 'must be an object');
    } else {
      debtorIban = validator.string(debtor.iban, 'debtorAccount.iban', { pattern: IBAN_PATTERN });
      debtorName = validator.string(debtor.name, 'debtorAccount.name', { required: false, max: 120 });
    }
    const creditor = ctx.payload.creditor;
    let creditorName;
    let creditorIban;
    if (creditor === null || typeof creditor !== 'object' || Array.isArray(creditor)) {
      validator.add('creditor', 'REQUIRED', 'must be an object');
    } else {
      creditorName = validator.string(creditor.name, 'creditor.name', { max: 120 });
      creditorIban = validator.string(creditor.iban, 'creditor.iban', { pattern: IBAN_PATTERN });
    }
    const amount = validator.money(ctx.payload.amount, 'amount', { positive: true });
    const currency = validator.string(ctx.payload.currency, 'currency', { pattern: /^[A-Z]{3}$/ });
    const method = validator.string(ctx.payload.method, 'method', { required: false, enumValues: ['ACH', 'WIRE', 'CHECK'] }) ?? 'ACH';
    const requestedExecutionDate = validator.date(ctx.payload.requestedExecutionDate, 'requestedExecutionDate');
    const remittanceInformation = validator.string(ctx.payload.remittanceInformation, 'remittanceInformation', {
      required: false,
      max: 140,
    });
    if (currency && amount && amount.currency !== currency) validator.add('amount.currency', 'CURRENCY_MISMATCH', 'must equal the document currency');
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'payments', async () => {
      const existing = repository('payments').find((record) => record.endToEndId === endToEndId);
      if (existing) {
        if (existing.businessPayloadHash === ctx.payloadHash) {
          return { status: 200, body: { ...paymentView(existing), duplicate: true }, headers: { 'x-sim-duplicate': 'true' } };
        }
        return problem({
          status: 409,
          category: CATEGORY.CONFLICT,
          code: CODES.CONFLICT,
          title: 'Duplicate end-to-end identifier',
          detail: `endToEndId ${endToEndId} was already used with different payment details. The end-to-end ID is the payment identity (SPEC §13.4).`,
          instance: ctx.path,
          retryable: false,
          meta: { reasonCode: 'DUPLICATE_PAYMENT', existingPayment: existing.bankPaymentId },
          correlationId: ctx.correlationId,
        });
      }

      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'Bank rejected the payment instruction',
          detail: `Payment ${paymentId} was rejected before execution by the bank simulator.`,
          reasonCode: 'BANK-PAYMENT-REJECTED',
          errors: [{ field: 'creditor.iban', code: 'ACCOUNT_CLOSED', message: 'creditor account cannot receive payments' }],
          meta: { paymentId, endToEndId },
        });
      }

      const bankPaymentId = state.nextId('BNK-PAY');
      const partial = ctx.scenario === 'partial';
      const returned = ctx.scenario === 'return';
      const creditedUnits = partial ? applyPercent(amount.units, 500000n) : amount.units;
      const record = {
        bankPaymentId,
        naturalKey: endToEndId,
        businessPayloadHash: ctx.payloadHash,
        paymentId,
        endToEndId,
        debtorIban,
        debtorName,
        creditorName,
        creditorIban,
        amountUnits: amount.units,
        creditedUnits,
        currency,
        method,
        requestedExecutionDate,
        remittanceInformation,
        status: 'ACCEPTED',
        settlementStatus: returned ? 'RETURNED' : partial ? 'PARTIAL' : 'MATCHED',
        returnReason: returned ? 'AC04' : null,
        acceptedAt: nowIso(),
      };
      repository('payments').add(bankPaymentId, record);
      return { status: 201, body: paymentView(record) };
    });
  });

  router.get('/payments', (ctx) => {
    const endToEndId = ctx.query.get('endToEndId');
    const payments = repository('payments')
      .all()
      .filter((record) => !endToEndId || record.endToEndId === endToEndId)
      .map(paymentView);
    return { status: 200, body: paginate(payments, { searchParams: ctx.query, path: `${BANK_BASE_PATH}/payments` }) };
  });

  router.get('/payments/:id', (ctx) => {
    const record = repository('payments').get(ctx.params.id);
    if (!record) return notFound(ctx, 'Payment not found', `No bank payment ${ctx.params.id}.`);
    return { status: 200, body: paymentView(record) };
  });

  router.post('/statements', async (ctx) => {
    assertScenario(ctx, []);
    const validator = new Validator();
    const accountIban = validator.string(ctx.payload.accountIban, 'accountIban', { pattern: IBAN_PATTERN });
    const fromDate = validator.date(ctx.payload.fromDate, 'fromDate');
    const toDate = validator.date(ctx.payload.toDate, 'toDate');
    const currency = validator.string(ctx.payload.currency, 'currency', { required: false, pattern: /^[A-Z]{3}$/ }) ?? 'USD';
    if (fromDate && toDate && toDate < fromDate) validator.add('toDate', 'DATE_ORDER', 'must not be earlier than fromDate');
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'statements', async () => {
      const payments = repository('payments')
        .all()
        .filter((record) => record.debtorIban === accountIban)
        .filter((record) => record.requestedExecutionDate >= fromDate && record.requestedExecutionDate <= toDate)
        .filter((record) => record.currency === currency)
        .sort((left, right) => left.bankPaymentId.localeCompare(right.bankPaymentId));

      let controlSumUnits = 0n;
      const entries = payments.map((payment, index) => {
        controlSumUnits += payment.creditedUnits;
        return {
          entryReference: `${index + 1}`,
          bankPaymentId: payment.bankPaymentId,
          endToEndId: payment.endToEndId,
          amountUnits: payment.creditedUnits,
          creditDebit: payment.settlementStatus === 'RETURNED' ? 'CRDT' : 'DBIT',
          status: 'BOOK',
          txStatus: payment.settlementStatus,
          bookingDate: payment.requestedExecutionDate,
          valueDate: payment.requestedExecutionDate,
          returnReason: payment.returnReason,
        };
      });

      const statementId = state.nextId('BNK-STM');
      const statement = {
        statementId,
        statementNumber: `STM-${statementId.split('-').pop()}`,
        accountIban,
        fromDate,
        toDate,
        currency,
        entries,
        controlSumUnits,
        createdAt: nowIso(),
      };
      repository('statements').add(statementId, statement);
      return { status: 201, body: statementView(statement) };
    });
  });

  router.get('/statements', (ctx) => {
    const accountIban = ctx.query.get('accountIban');
    const statements = repository('statements')
      .all()
      .filter((record) => !accountIban || record.accountIban === accountIban)
      .map(statementView);
    return { status: 200, body: paginate(statements, { searchParams: ctx.query, path: `${BANK_BASE_PATH}/statements` }) };
  });

  router.get('/statements/:id', (ctx) => {
    const record = repository('statements').get(ctx.params.id);
    if (!record) return notFound(ctx, 'Statement not found', `No statement ${ctx.params.id}.`);
    return { status: 200, body: statementView(record) };
  });

  router.get('/statements/:id/camt053', (ctx) => {
    const record = repository('statements').get(ctx.params.id);
    if (!record) return notFound(ctx, 'Statement not found', `No statement ${ctx.params.id}.`);
    return {
      status: 200,
      raw: camt053Xml(record),
      contentType: 'application/xml; charset=utf-8',
      headers: { 'content-disposition': `attachment; filename="${record.statementId}.camt053.xml"` },
    };
  });

  return {
    system: BANK_SYSTEM,
    basePath: BANK_BASE_PATH,
    description: 'Bank test double: payment instruction, camt.053 statement with match, partial, return and duplicate behaviour.',
    schemaMajor: SCHEMA_MAJOR,
    targetSystemAliases: ['BANK', 'BANK-SIM', 'ISO20022'],
    requiresBook: false,
    allowedScenarios: ALLOWED_SCENARIOS,
    magicScenarios: MAGIC_SCENARIOS,
    scenarioRefs,
    router,
    state,
  };
}
