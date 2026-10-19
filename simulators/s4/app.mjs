import { clockInfo, nowIso, periodOf } from '../common/clock.mjs';
import { moneyObject, parseAmountString } from '../common/money.mjs';
import { createRouter } from '../common/router.mjs';
import { createState } from '../common/store.mjs';
import { Validator } from '../common/validate.mjs';
import { CATEGORY, CODES, SimProblem, problem } from '../common/problem.mjs';
import { withIdempotency } from '../common/idempotency.mjs';
import { COMMON_SCENARIOS, assertScenario } from '../common/scenarios.mjs';
import { paginate } from '../common/pagination.mjs';
import { sha256Hex } from '../common/canonical.mjs';

export const S4_SYSTEM = 's4';
export const S4_BASE_PATH = '/sim/s4/v1';
const SCHEMA_MAJOR = 1;
const COMPANY_CODE_PATTERN = /^\d{4}$/;
const ACCOUNT_PATTERN = /^\d{6}$/;
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const GL_ACCOUNTS = Object.freeze({
  '100100': 'Bank / Cash',
  '120100': 'Premium Receivable',
  '140100': 'Input Tax',
  '200100': 'Accounts Payable',
  '215000': 'Loss Reserve',
  '220100': 'Tax Payable',
  '400100': 'Written Premium',
  '510100': 'Incurred Loss',
  '610100': 'Defense and Claim Expense',
});

const ALLOWED_SCENARIOS = Object.freeze([
  ...COMMON_SCENARIOS.filter((scenario) => scenario !== 'partial'),
  'closed_period',
  'fx_difference',
]);

const MAGIC_SCENARIOS = Object.freeze([
  { suffix: '-CLOSED', scenario: 'closed_period' },
  { suffix: '-FX', scenario: 'fx_difference' },
  { suffix: '-REJECT', scenario: 'reject' },
  { suffix: '-TIMEOUT', scenario: 'timeout' },
  { suffix: '-UNAVAILABLE', scenario: 'unavailable' },
  { suffix: '-THROTTLED', scenario: 'throttled' },
  { suffix: '-MALFORMED', scenario: 'malformed' },
  { suffix: '-DUPLICATE', scenario: 'duplicate' },
]);

const COLLECTIONS = [
  'journalEntries',
  'arInvoices',
  'supplierInvoices',
  'paymentAdvices',
  'cashApplications',
  'reversals',
  'reconciliations',
  'glPostings',
];

function defaultClosedPeriods() {
  const configured = process.env.S4_CLOSED_PERIODS;
  if (configured === undefined || configured.trim() === '') return ['2025-12'];
  return configured
    .split(',')
    .map((period) => period.trim())
    .filter((period) => PERIOD_PATTERN.test(period));
}

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

function duplicateConflict(ctx, title, detail, reasonCode, meta = {}) {
  return problem({
    status: 409,
    category: CATEGORY.CONFLICT,
    code: CODES.CONFLICT,
    title,
    detail,
    instance: ctx.path,
    retryable: false,
    meta: { reasonCode, ...meta },
    correlationId: ctx.correlationId,
  });
}

function moneyView(units, currency) {
  return moneyObject(units, currency);
}

function closedPeriodResponse(ctx, { period, postingDate, documentType }) {
  return problem({
    status: 422,
    category: CATEGORY.BUSINESS_REJECT,
    code: CODES.CLOSED_PERIOD,
    title: 'Fiscal period is closed',
    detail: `Period ${period} is closed in the S/4HANA simulator. The accounting date and posting date are separate, and a closed period rejects posting (POST-02, FIN-25).`,
    instance: ctx.path,
    retryable: false,
    errors: [{ field: 'postingDate', code: 'CLOSED_PERIOD', message: `period ${period} is closed` }],
    meta: { reasonCode: 'CLOSED_PERIOD', period, postingDate, documentType, closedPeriods: [...ctx.state.closedPeriods] },
    correlationId: ctx.correlationId,
  });
}

function requireOpenPeriod(ctx, payload) {
  const period = periodOf(payload.postingDate);
  if (ctx.scenario === 'closed_period' || ctx.state.closedPeriods.has(period)) {
    return closedPeriodResponse(ctx, { period, postingDate: payload.postingDate, documentType: payload.documentType });
  }
  return null;
}

function duplicateOrConflict(ctx, existing, view, { resource, reasonCode, naturalKey }) {
  if (existing.businessPayloadHash === ctx.payloadHash) {
    return {
      status: 200,
      body: { ...view(existing), duplicate: true },
      headers: { 'x-sim-duplicate': 'true' },
    };
  }
  return duplicateConflict(
    ctx,
    `Conflicting ${resource} reference`,
    `The ${resource} business key ${naturalKey} already exists with different content. SAP duplicate checks do not overwrite a posted document.`,
    reasonCode,
    { naturalKey, existingDocument: existing.documentNumber ?? existing.clearingDocument ?? null },
  );
}

function validateJournal(payload) {
  const validator = new Validator();
  const companyCode = validator.string(payload.companyCode, 'companyCode', { pattern: COMPANY_CODE_PATTERN });
  const postingDate = validator.date(payload.postingDate, 'postingDate');
  const documentDate = validator.date(payload.documentDate, 'documentDate', { required: false }) ?? postingDate;
  const documentType = validator.string(payload.documentType, 'documentType', { required: false, enumValues: ['SA', 'KR', 'DR', 'AB'] }) ?? 'SA';
  const currency = validator.string(payload.currency, 'currency', { pattern: /^[A-Z]{3}$/ });
  const businessReference = validator.string(payload.businessReference, 'businessReference', { max: 64 });
  const functionalCurrency = validator.string(payload.functionalCurrency, 'functionalCurrency', { required: false, pattern: /^[A-Z]{3}$/ }) ?? currency;

  const linesInput = validator.array(payload.lines, 'lines', { min: 2, max: 100 }) ?? [];
  const lines = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  linesInput.forEach((line, index) => {
    const prefix = `lines[${index}]`;
    if (line === null || typeof line !== 'object' || Array.isArray(line)) {
      validator.add(prefix, 'TYPE', 'must be an object');
      return;
    }
    const account = validator.string(line.account, `${prefix}.account`, { pattern: ACCOUNT_PATTERN });
    const debit = validator.money(line.debitAmount, `${prefix}.debitAmount`, { required: false, positive: true });
    const credit = validator.money(line.creditAmount, `${prefix}.creditAmount`, { required: false, positive: true });
    if (!debit && !credit) validator.add(prefix, 'DEBIT_OR_CREDIT', 'exactly one of debitAmount or creditAmount is required');
    if (debit && credit) validator.add(prefix, 'DEBIT_AND_CREDIT', 'a line is either a debit or a credit, not both');
    if (currency && debit && debit.currency !== currency) validator.add(`${prefix}.debitAmount.currency`, 'CURRENCY_MISMATCH', 'must equal the document currency');
    if (currency && credit && credit.currency !== currency) validator.add(`${prefix}.creditAmount.currency`, 'CURRENCY_MISMATCH', 'must equal the document currency');
    const costCenter = validator.string(line.costCenter, `${prefix}.costCenter`, { required: false, max: 32 });
    const profitCenter = validator.string(line.profitCenter, `${prefix}.profitCenter`, { required: false, max: 32 });
    const taxCode = validator.string(line.taxCode, `${prefix}.taxCode`, { required: false, max: 8 });
    const text = validator.string(line.text, `${prefix}.text`, { required: false, max: 120 });
    totalDebit += debit?.units ?? 0n;
    totalCredit += credit?.units ?? 0n;
    lines.push({
      lineNumber: index + 1,
      account,
      debitUnits: debit?.units ?? 0n,
      creditUnits: credit?.units ?? 0n,
      costCenter,
      profitCenter,
      taxCode,
      text,
    });
  });

  if (totalDebit !== totalCredit) {
    validator.add('lines', 'UNBALANCED_JOURNAL', `total debits ${moneyObject(totalDebit, currency ?? 'USD').amount} must equal total credits ${moneyObject(totalCredit, currency ?? 'USD').amount}`);
  }
  validator.throwIfInvalid();

  return {
    companyCode,
    postingDate,
    documentDate,
    documentType,
    currency,
    functionalCurrency,
    businessReference,
    lines,
    totalDebit,
    totalCredit,
    period: periodOf(postingDate),
  };
}

function validateArInvoice(payload) {
  const validator = new Validator();
  const billingInstructionId = validator.string(payload.billingInstructionId, 'billingInstructionId', { max: 64 });
  const companyCode = validator.string(payload.companyCode, 'companyCode', { pattern: COMPANY_CODE_PATTERN });
  const customer = payload.customer;
  let customerId;
  let customerName;
  if (customer === null || typeof customer !== 'object' || Array.isArray(customer)) {
    validator.add('customer', 'REQUIRED', 'must be an object');
  } else {
    customerId = validator.string(customer.customerId, 'customer.customerId', { max: 32 });
    customerName = validator.string(customer.name, 'customer.name', { max: 120 });
  }
  const netAmount = validator.money(payload.netAmount, 'netAmount', { positive: true });
  const taxAmount = validator.money(payload.taxAmount, 'taxAmount', { required: false, nonNegative: true });
  const currency = validator.string(payload.currency, 'currency', { pattern: /^[A-Z]{3}$/ });
  const invoiceDate = validator.date(payload.invoiceDate, 'invoiceDate');
  const dueDate = validator.date(payload.dueDate, 'dueDate');
  if (invoiceDate && dueDate && dueDate < invoiceDate) validator.add('dueDate', 'DATE_ORDER', 'must not be earlier than invoiceDate');
  const paymentTerms = validator.string(payload.paymentTerms, 'paymentTerms', { required: false, max: 16 }) ?? 'NET30';
  const businessReference = validator.string(payload.businessReference, 'businessReference', { max: 64 });
  if (currency && netAmount && netAmount.currency !== currency) validator.add('netAmount.currency', 'CURRENCY_MISMATCH', 'must equal the document currency');
  if (currency && taxAmount && taxAmount.currency !== currency) validator.add('taxAmount.currency', 'CURRENCY_MISMATCH', 'must equal the document currency');
  validator.throwIfInvalid();

  const taxUnits = taxAmount?.units ?? 0n;
  return {
    billingInstructionId,
    companyCode,
    customerId,
    customerName,
    netUnits: netAmount.units,
    taxUnits,
    grossUnits: netAmount.units + taxUnits,
    currency,
    invoiceDate,
    dueDate,
    paymentTerms,
    businessReference,
    period: periodOf(invoiceDate),
  };
}

function validateSupplierInvoice(payload) {
  const validator = new Validator();
  const invoiceId = validator.string(payload.invoiceId, 'invoiceId', { max: 64 });
  const supplier = payload.supplier;
  let vendorId;
  let vendorName;
  if (supplier === null || typeof supplier !== 'object' || Array.isArray(supplier)) {
    validator.add('supplier', 'REQUIRED', 'must be an object');
  } else {
    vendorId = validator.string(supplier.vendorId, 'supplier.vendorId', { max: 32 });
    vendorName = validator.string(supplier.name, 'supplier.name', { max: 120 });
  }
  const companyCode = validator.string(payload.companyCode, 'companyCode', { pattern: COMPANY_CODE_PATTERN });
  const netAmount = validator.money(payload.netAmount, 'netAmount', { positive: true });
  const taxAmount = validator.money(payload.taxAmount, 'taxAmount', { required: false, nonNegative: true });
  const currency = validator.string(payload.currency, 'currency', { pattern: /^[A-Z]{3}$/ });
  const invoiceDate = validator.date(payload.invoiceDate, 'invoiceDate');
  const dueDate = validator.date(payload.dueDate, 'dueDate');
  if (invoiceDate && dueDate && dueDate < invoiceDate) validator.add('dueDate', 'DATE_ORDER', 'must not be earlier than invoiceDate');
  const businessReference = validator.string(payload.businessReference, 'businessReference', { max: 64 });
  const purchaseOrder = validator.string(payload.purchaseOrder, 'purchaseOrder', { required: false, max: 32 });
  if (currency && netAmount && netAmount.currency !== currency) validator.add('netAmount.currency', 'CURRENCY_MISMATCH', 'must equal the document currency');
  if (currency && taxAmount && taxAmount.currency !== currency) validator.add('taxAmount.currency', 'CURRENCY_MISMATCH', 'must equal the document currency');
  validator.throwIfInvalid();

  const taxUnits = taxAmount?.units ?? 0n;
  return {
    invoiceId,
    vendorId,
    vendorName,
    companyCode,
    netUnits: netAmount.units,
    taxUnits,
    grossUnits: netAmount.units + taxUnits,
    currency,
    invoiceDate,
    dueDate,
    businessReference,
    purchaseOrder,
    period: periodOf(invoiceDate),
  };
}

function validatePaymentAdvice(payload) {
  const validator = new Validator();
  const paymentId = validator.string(payload.paymentId, 'paymentId', { max: 64 });
  const companyCode = validator.string(payload.companyCode, 'companyCode', { pattern: COMPANY_CODE_PATTERN });
  const payee = payload.payee;
  let vendorId;
  let payeeName;
  let bankAccount;
  if (payee === null || typeof payee !== 'object' || Array.isArray(payee)) {
    validator.add('payee', 'REQUIRED', 'must be an object');
  } else {
    vendorId = validator.string(payee.vendorId, 'payee.vendorId', { max: 32 });
    payeeName = validator.string(payee.name, 'payee.name', { max: 120 });
    bankAccount = validator.string(payee.bankAccount, 'payee.bankAccount', { required: false, max: 34 });
  }
  const amount = validator.money(payload.amount, 'amount', { positive: true });
  const currency = validator.string(payload.currency, 'currency', { pattern: /^[A-Z]{3}$/ });
  const method = validator.string(payload.method, 'method', { enumValues: ['ACH', 'WIRE', 'CHECK'] });
  const dueDate = validator.date(payload.dueDate, 'dueDate');
  const valueDate = validator.date(payload.valueDate, 'valueDate', { required: false }) ?? dueDate;
  const remittance = payload.remittance;
  let businessReferences = [];
  let note;
  if (remittance !== undefined && remittance !== null) {
    if (typeof remittance !== 'object' || Array.isArray(remittance)) {
      validator.add('remittance', 'TYPE', 'must be an object');
    } else {
      businessReferences = validator.array(remittance.businessReferences, 'remittance.businessReferences', { required: false, min: 0, max: 20 }) ?? [];
      businessReferences.forEach((reference, index) =>
        validator.string(reference, `remittance.businessReferences[${index}]`, { max: 64 }),
      );
      note = validator.string(remittance.note, 'remittance.note', { required: false, max: 140 });
    }
  }
  if (currency && amount && amount.currency !== currency) validator.add('amount.currency', 'CURRENCY_MISMATCH', 'must equal the document currency');
  validator.throwIfInvalid();
  return {
    paymentId,
    companyCode,
    vendorId,
    payeeName,
    bankAccount,
    amountUnits: amount.units,
    currency,
    method,
    dueDate,
    valueDate,
    businessReferences,
    note,
    period: periodOf(valueDate),
  };
}

function journalView(record) {
  return {
    documentNumber: record.documentNumber,
    companyCode: record.companyCode,
    fiscalYear: record.fiscalYear,
    postingPeriod: record.period,
    documentType: record.documentType,
    documentDate: record.documentDate,
    postingDate: record.postingDate,
    status: record.status,
    businessReference: record.businessReference,
    documentCurrency: record.currency,
    totalDebit: moneyView(record.totalDebitUnits, record.currency),
    totalCredit: moneyView(record.totalCreditUnits, record.currency),
    fxDifference: moneyView(record.fxDifferenceUnits, record.functionalCurrency),
    functionalCurrency: record.functionalCurrency,
    lines: record.lines.map((line) => ({
      lineNumber: line.lineNumber,
      account: line.account,
      debitAmount: moneyView(line.debitUnits, record.currency),
      creditAmount: moneyView(line.creditUnits, record.currency),
      costCenter: line.costCenter ?? null,
      profitCenter: line.profitCenter ?? null,
      taxCode: line.taxCode ?? null,
      text: line.text ?? null,
    })),
    reversed: record.reversed ?? false,
    reversedBy: record.reversedBy ?? null,
    postedAt: record.postedAt,
    _links: {
      self: { href: `${S4_BASE_PATH}/journal-entries/${record.documentNumber}` },
      glBalances: { href: `${S4_BASE_PATH}/gl-balances?companyCode=${record.companyCode}&period=${record.period}` },
    },
  };
}

function arInvoiceView(record) {
  return {
    arInvoiceNumber: record.documentNumber,
    billingInstructionId: record.billingInstructionId,
    companyCode: record.companyCode,
    customer: { customerId: record.customerId, name: record.customerName },
    status: record.status,
    currency: record.currency,
    netAmount: moneyView(record.netUnits, record.currency),
    taxAmount: moneyView(record.taxUnits, record.currency),
    grossAmount: moneyView(record.grossUnits, record.currency),
    openAmount: moneyView(record.openUnits, record.currency),
    clearingStatus: record.clearingStatus,
    invoiceDate: record.invoiceDate,
    dueDate: record.dueDate,
    paymentTerms: record.paymentTerms,
    businessReference: record.businessReference,
    reversed: record.reversed ?? false,
    postedAt: record.postedAt,
    _links: { self: { href: `${S4_BASE_PATH}/ar-invoices/${record.documentNumber}` } },
  };
}

function supplierInvoiceView(record) {
  return {
    supplierInvoiceNumber: record.documentNumber,
    invoiceId: record.invoiceId,
    companyCode: record.companyCode,
    supplier: { vendorId: record.vendorId, name: record.vendorName },
    status: record.status,
    currency: record.currency,
    netAmount: moneyView(record.netUnits, record.currency),
    taxAmount: moneyView(record.taxUnits, record.currency),
    grossAmount: moneyView(record.grossUnits, record.currency),
    openAmount: moneyView(record.openUnits, record.currency),
    invoiceDate: record.invoiceDate,
    dueDate: record.dueDate,
    businessReference: record.businessReference,
    purchaseOrder: record.purchaseOrder ?? null,
    duplicateCheck: 'PASSED',
    reversed: record.reversed ?? false,
    postedAt: record.postedAt,
    _links: { self: { href: `${S4_BASE_PATH}/supplier-invoices/${record.documentNumber}` } },
  };
}

function paymentAdviceView(record) {
  return {
    paymentAdviceNumber: record.documentNumber,
    paymentDocument: record.paymentDocumentNumber,
    paymentId: record.paymentId,
    companyCode: record.companyCode,
    payee: { vendorId: record.vendorId, name: record.payeeName, bankAccount: record.bankAccount ?? null },
    status: record.status,
    amount: moneyView(record.amountUnits, record.currency),
    currency: record.currency,
    method: record.method,
    valueDate: record.valueDate,
    dueDate: record.dueDate,
    bankReference: record.bankReference,
    remittance: { businessReferences: record.businessReferences, note: record.note ?? null },
    reversed: record.reversed ?? false,
    paidAt: record.paidAt,
    _links: { self: { href: `${S4_BASE_PATH}/payment-advices/${record.documentNumber}` } },
  };
}

function cashApplicationView(record) {
  return {
    clearingDocument: record.clearingDocument,
    invoiceReference: record.invoiceReference,
    invoiceDocumentNumber: record.invoiceDocumentNumber ?? null,
    companyCode: record.companyCode,
    status: record.status,
    amount: moneyView(record.amountUnits, record.currency),
    appliedAmount: moneyView(record.appliedUnits, record.currency),
    unappliedAmount: moneyView(record.unappliedUnits, record.currency),
    valueDate: record.valueDate,
    bankReference: record.bankReference,
    clearedAt: record.clearedAt,
    _links: { self: { href: `${S4_BASE_PATH}/cash-applications/${record.clearingDocument}` } },
  };
}

function reversalView(record) {
  return {
    reversalDocumentNumber: record.documentNumber,
    originalDocumentNumber: record.originalDocumentNumber,
    originalDocumentType: record.originalDocumentType,
    status: record.status,
    reversedAmount: moneyView(record.reversedUnits, record.reversedCurrency),
    reason: record.reason,
    postingDate: record.postingDate,
    postedAt: record.postedAt,
    _links: { self: { href: `${S4_BASE_PATH}/reversals/${record.documentNumber}` } },
  };
}

export function createApp({ state = createState({ system: S4_SYSTEM, collections: COLLECTIONS }) } = {}) {
  const router = createRouter();
  const repository = state.repo;
  state.closedPeriods = new Set(defaultClosedPeriods());
  const baseReset = state.reset;
  state.reset = () => {
    baseReset();
    state.closedPeriods = new Set(defaultClosedPeriods());
  };

  function scenarioRefs(payload) {
    return [
      payload?.businessReference,
      payload?.billingInstructionId,
      payload?.invoiceId,
      payload?.paymentId,
      payload?.originalDocumentNumber,
      payload?.postingDate,
      payload?.invoiceDate,
      payload?.valueDate,
      payload?.period,
    ];
  }

  function postToGl({ documentNumber, companyCode, documentType, postingDate, currency, lines }) {
    const period = periodOf(postingDate);
    lines.forEach((line, index) => {
      const postingId = `${documentNumber}-${index + 1}`;
      repository('glPostings').add(postingId, {
        postingId,
        documentNumber,
        companyCode,
        documentType,
        postingDate,
        period,
        account: line.account,
        debitUnits: line.debitUnits ?? 0n,
        creditUnits: line.creditUnits ?? 0n,
        currency,
      });
    });
  }

  function reversedPostings(documentNumber) {
    return repository('glPostings')
      .all()
      .filter((posting) => posting.documentNumber === documentNumber)
      .map((posting, index) => ({
        account: posting.account,
        debitUnits: posting.creditUnits,
        creditUnits: posting.debitUnits,
        index,
      }));
  }

  function findAnyDocument(documentNumber) {
    return (
      repository('journalEntries').get(documentNumber) ??
      repository('arInvoices').get(documentNumber) ??
      repository('supplierInvoices').get(documentNumber) ??
      repository('paymentAdvices').get(documentNumber) ??
      null
    );
  }

  router.get('/admin/state', (ctx) => ({
    status: 200,
    body: {
      simulator: S4_SYSTEM,
      testDouble: true,
      clock: clockInfo(),
      startedAt: state.startedAt,
      scenario: state.defaultScenario,
      scenarios: ALLOWED_SCENARIOS,
      closedPeriods: [...state.closedPeriods].sort(),
      counts: state.counts(),
      recentRequests: state.requests.slice(-20),
    },
  }));

  router.post('/admin/reset', () => {
    state.reset();
    return {
      status: 200,
      body: {
        status: 'RESET',
        simulator: S4_SYSTEM,
        clock: nowIso(),
        closedPeriods: [...state.closedPeriods].sort(),
        counts: state.counts(),
      },
    };
  });

  router.get('/admin/scenarios', () => ({
    status: 200,
    body: { simulator: S4_SYSTEM, defaultScenario: state.defaultScenario, allowed: ALLOWED_SCENARIOS },
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
    return { status: 200, body: { simulator: S4_SYSTEM, defaultScenario: state.defaultScenario } };
  });

  router.get('/admin/periods', () => ({
    status: 200,
    body: { simulator: S4_SYSTEM, closedPeriods: [...state.closedPeriods].sort() },
  }));

  router.post('/admin/periods/:period/close', (ctx) => {
    if (!PERIOD_PATTERN.test(ctx.params.period)) {
      return problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.VALIDATION,
        title: 'Invalid period',
        detail: 'Period must be YYYY-MM.',
        instance: ctx.path,
        retryable: false,
        errors: [{ field: 'period', code: 'PATTERN', message: 'must be YYYY-MM' }],
      });
    }
    state.closedPeriods.add(ctx.params.period);
    return { status: 200, body: { simulator: S4_SYSTEM, closedPeriods: [...state.closedPeriods].sort() } };
  });

  router.post('/admin/periods/:period/open', (ctx) => {
    state.closedPeriods.delete(ctx.params.period);
    return { status: 200, body: { simulator: S4_SYSTEM, closedPeriods: [...state.closedPeriods].sort() } };
  });

  router.post('/journal-entries', async (ctx) => {
    assertScenario(ctx, ['closed_period', 'fx_difference', 'reject']);
    const input = validateJournal(ctx.payload);
    return withIdempotency(ctx, 'journal-entries', async () => {
      const closed = requireOpenPeriod(ctx, input);
      if (closed) return closed;

      const naturalKey = `${input.companyCode}|${input.businessReference}|${input.documentType}`;
      const existing = repository('journalEntries').find((record) => record.naturalKey === naturalKey);
      if (existing) return duplicateOrConflict(ctx, existing, journalView, { resource: 'journal entry', reasonCode: 'DUPLICATE_DOCUMENT', naturalKey });

      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'S/4HANA rejected the journal entry',
          detail: `Journal business reference ${input.businessReference} was rejected by the S/4HANA simulator.`,
          reasonCode: 'S4-FI-REJECT',
          errors: [{ field: 'lines', code: 'JOURNAL_REJECTED', message: 'rejected by S/4 scenario' }],
          meta: { businessReference: input.businessReference, companyCode: input.companyCode },
        });
      }

      const fiscalYear = input.postingDate.slice(0, 4);
      const documentNumber = state.nextId(`S4-JE-${fiscalYear}`);
      const fxDifferenceUnits = ctx.scenario === 'fx_difference' ? 123_400n : 0n;
      const record = {
        documentNumber,
        naturalKey,
        businessPayloadHash: ctx.payloadHash,
        companyCode: input.companyCode,
        fiscalYear,
        period: input.period,
        documentType: input.documentType,
        documentDate: input.documentDate,
        postingDate: input.postingDate,
        status: 'POSTED',
        businessReference: input.businessReference,
        currency: input.currency,
        functionalCurrency: input.functionalCurrency,
        totalDebitUnits: input.totalDebit,
        totalCreditUnits: input.totalCredit,
        fxDifferenceUnits,
        lines: input.lines,
        postedAt: nowIso(),
        reversed: false,
      };
      repository('journalEntries').add(documentNumber, record);
      postToGl({
        documentNumber,
        companyCode: input.companyCode,
        documentType: input.documentType,
        postingDate: input.postingDate,
        currency: input.currency,
        lines: input.lines,
      });
      return { status: 201, body: journalView(record) };
    });
  });

  router.get('/journal-entries', (ctx) => {
    const companyCode = ctx.query.get('companyCode');
    const period = ctx.query.get('period');
    const records = repository('journalEntries')
      .all()
      .filter((record) => !companyCode || record.companyCode === companyCode)
      .filter((record) => !period || record.period === period)
      .map(journalView);
    return {
      status: 200,
      body: paginate(records, { searchParams: ctx.query, path: `${S4_BASE_PATH}/journal-entries` }),
    };
  });

  router.get('/journal-entries/:documentNumber', (ctx) => {
    const record = repository('journalEntries').get(ctx.params.documentNumber);
    if (!record) return notFound(ctx, 'Journal entry not found', `No journal entry ${ctx.params.documentNumber}.`);
    return { status: 200, body: journalView(record) };
  });

  router.post('/ar-invoices', async (ctx) => {
    assertScenario(ctx, ['closed_period', 'reject']);
    const input = validateArInvoice(ctx.payload);
    return withIdempotency(ctx, 'ar-invoices', async () => {
      const closed = requireOpenPeriod(ctx, {
        postingDate: input.invoiceDate,
        documentType: 'AR_INVOICE',
      });
      if (closed) return closed;

      const existing = repository('arInvoices').find((record) => record.billingInstructionId === input.billingInstructionId);
      if (existing) {
        return duplicateOrConflict(ctx, existing, arInvoiceView, {
          resource: 'AR invoice',
          reasonCode: 'DUPLICATE_INVOICE',
          naturalKey: input.billingInstructionId,
        });
      }
      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'S/4HANA rejected the AR invoice',
          detail: `Billing instruction ${input.billingInstructionId} was rejected by the S/4HANA simulator.`,
          reasonCode: 'S4-AR-REJECT',
          errors: [{ field: 'billingInstructionId', code: 'AR_INVOICE_REJECTED', message: 'rejected by S/4 scenario' }],
          meta: { billingInstructionId: input.billingInstructionId },
        });
      }

      const fiscalYear = input.invoiceDate.slice(0, 4);
      const documentNumber = state.nextId(`S4-AR-${fiscalYear}`);
      const record = {
        documentNumber,
        naturalKey: input.billingInstructionId,
        businessPayloadHash: ctx.payloadHash,
        billingInstructionId: input.billingInstructionId,
        companyCode: input.companyCode,
        customerId: input.customerId,
        customerName: input.customerName,
        status: 'POSTED',
        currency: input.currency,
        netUnits: input.netUnits,
        taxUnits: input.taxUnits,
        grossUnits: input.grossUnits,
        openUnits: input.grossUnits,
        clearingStatus: 'OPEN',
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        paymentTerms: input.paymentTerms,
        businessReference: input.businessReference,
        period: input.period,
        postedAt: nowIso(),
        reversed: false,
      };
      repository('arInvoices').add(documentNumber, record);
      const glLines = [
        { account: '120100', debitUnits: input.grossUnits },
        { account: '400100', creditUnits: input.netUnits },
      ];
      if (input.taxUnits > 0n) glLines.push({ account: '220100', creditUnits: input.taxUnits });
      postToGl({
        documentNumber,
        companyCode: input.companyCode,
        documentType: 'AR_INVOICE',
        postingDate: input.invoiceDate,
        currency: input.currency,
        lines: glLines,
      });
      return { status: 201, body: arInvoiceView(record) };
    });
  });

  router.get('/ar-invoices', (ctx) => {
    const companyCode = ctx.query.get('companyCode');
    const period = ctx.query.get('period');
    const records = repository('arInvoices')
      .all()
      .filter((record) => !companyCode || record.companyCode === companyCode)
      .filter((record) => !period || record.period === period)
      .map(arInvoiceView);
    return {
      status: 200,
      body: paginate(records, { searchParams: ctx.query, path: `${S4_BASE_PATH}/ar-invoices` }),
    };
  });

  router.get('/ar-invoices/:documentNumber', (ctx) => {
    const record = repository('arInvoices').get(ctx.params.documentNumber);
    if (!record) return notFound(ctx, 'AR invoice not found', `No AR invoice ${ctx.params.documentNumber}.`);
    return { status: 200, body: arInvoiceView(record) };
  });

  router.post('/supplier-invoices', async (ctx) => {
    assertScenario(ctx, ['closed_period', 'reject']);
    const input = validateSupplierInvoice(ctx.payload);
    return withIdempotency(ctx, 'supplier-invoices', async () => {
      const closed = requireOpenPeriod(ctx, {
        postingDate: input.invoiceDate,
        documentType: 'SUPPLIER_INVOICE',
      });
      if (closed) return closed;

      const naturalKey = `${input.invoiceId}|${input.vendorId}`;
      const existing = repository('supplierInvoices').find((record) => record.naturalKey === naturalKey);
      if (existing) {
        return duplicateOrConflict(ctx, existing, supplierInvoiceView, {
          resource: 'supplier invoice',
          reasonCode: 'DUPLICATE_SUPPLIER_INVOICE',
          naturalKey,
        });
      }
      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'S/4HANA rejected the supplier invoice',
          detail: `Supplier invoice ${input.invoiceId} was rejected by the S/4HANA simulator.`,
          reasonCode: 'S4-AP-REJECT',
          errors: [{ field: 'invoiceId', code: 'SUPPLIER_INVOICE_REJECTED', message: 'rejected by S/4 scenario' }],
          meta: { invoiceId: input.invoiceId, vendorId: input.vendorId },
        });
      }

      const fiscalYear = input.invoiceDate.slice(0, 4);
      const documentNumber = state.nextId(`S4-SI-${fiscalYear}`);
      const record = {
        documentNumber,
        naturalKey,
        businessPayloadHash: ctx.payloadHash,
        invoiceId: input.invoiceId,
        vendorId: input.vendorId,
        vendorName: input.vendorName,
        companyCode: input.companyCode,
        status: 'POSTED',
        currency: input.currency,
        netUnits: input.netUnits,
        taxUnits: input.taxUnits,
        grossUnits: input.grossUnits,
        openUnits: input.grossUnits,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        businessReference: input.businessReference,
        purchaseOrder: input.purchaseOrder,
        period: input.period,
        postedAt: nowIso(),
        reversed: false,
      };
      repository('supplierInvoices').add(documentNumber, record);
      const glLines = [
        { account: '610100', debitUnits: input.netUnits },
        { account: '200100', creditUnits: input.grossUnits },
      ];
      if (input.taxUnits > 0n) glLines.push({ account: '140100', debitUnits: input.taxUnits });
      postToGl({
        documentNumber,
        companyCode: input.companyCode,
        documentType: 'SUPPLIER_INVOICE',
        postingDate: input.invoiceDate,
        currency: input.currency,
        lines: glLines,
      });
      return { status: 201, body: supplierInvoiceView(record) };
    });
  });

  router.get('/supplier-invoices', (ctx) => {
    const companyCode = ctx.query.get('companyCode');
    const period = ctx.query.get('period');
    const records = repository('supplierInvoices')
      .all()
      .filter((record) => !companyCode || record.companyCode === companyCode)
      .filter((record) => !period || record.period === period)
      .map(supplierInvoiceView);
    return {
      status: 200,
      body: paginate(records, { searchParams: ctx.query, path: `${S4_BASE_PATH}/supplier-invoices` }),
    };
  });

  router.get('/supplier-invoices/:documentNumber', (ctx) => {
    const record = repository('supplierInvoices').get(ctx.params.documentNumber);
    if (!record) return notFound(ctx, 'Supplier invoice not found', `No supplier invoice ${ctx.params.documentNumber}.`);
    return { status: 200, body: supplierInvoiceView(record) };
  });

  router.post('/payment-advices', async (ctx) => {
    assertScenario(ctx, ['closed_period', 'reject']);
    const input = validatePaymentAdvice(ctx.payload);
    return withIdempotency(ctx, 'payment-advices', async () => {
      const closed = requireOpenPeriod(ctx, {
        postingDate: input.valueDate,
        documentType: 'PAYMENT_ADVICE',
      });
      if (closed) return closed;

      const existing = repository('paymentAdvices').find((record) => record.paymentId === input.paymentId);
      if (existing) {
        return duplicateOrConflict(ctx, existing, paymentAdviceView, {
          resource: 'payment advice',
          reasonCode: 'DUPLICATE_PAYMENT',
          naturalKey: input.paymentId,
        });
      }
      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'S/4HANA rejected the payment advice',
          detail: `Payment ${input.paymentId} was rejected by the S/4HANA simulator.`,
          reasonCode: 'S4-PAY-REJECT',
          errors: [{ field: 'paymentId', code: 'PAYMENT_REJECTED', message: 'rejected by S/4 scenario' }],
          meta: { paymentId: input.paymentId },
        });
      }

      const fiscalYear = input.valueDate.slice(0, 4);
      const documentNumber = state.nextId(`S4-PA-${fiscalYear}`);
      const paymentDocumentNumber = state.nextId(`S4-PD-${fiscalYear}`);
      const bankReference = `BNK-${sha256Hex(input.paymentId).slice(0, 10).toUpperCase()}`;
      const record = {
        documentNumber,
        paymentDocumentNumber,
        naturalKey: input.paymentId,
        businessPayloadHash: ctx.payloadHash,
        paymentId: input.paymentId,
        companyCode: input.companyCode,
        vendorId: input.vendorId,
        payeeName: input.payeeName,
        bankAccount: input.bankAccount,
        status: 'PAID',
        amountUnits: input.amountUnits,
        currency: input.currency,
        method: input.method,
        dueDate: input.dueDate,
        valueDate: input.valueDate,
        businessReferences: input.businessReferences,
        note: input.note,
        bankReference,
        period: input.period,
        paidAt: nowIso(),
        reversed: false,
      };
      repository('paymentAdvices').add(documentNumber, record);
      postToGl({
        documentNumber,
        companyCode: input.companyCode,
        documentType: 'PAYMENT_ADVICE',
        postingDate: input.valueDate,
        currency: input.currency,
        lines: [
          { account: '200100', debitUnits: input.amountUnits },
          { account: '100100', creditUnits: input.amountUnits },
        ],
      });
      return { status: 201, body: paymentAdviceView(record) };
    });
  });

  router.get('/payment-advices', (ctx) => {
    const companyCode = ctx.query.get('companyCode');
    const period = ctx.query.get('period');
    const records = repository('paymentAdvices')
      .all()
      .filter((record) => !companyCode || record.companyCode === companyCode)
      .filter((record) => !period || record.period === period)
      .map(paymentAdviceView);
    return {
      status: 200,
      body: paginate(records, { searchParams: ctx.query, path: `${S4_BASE_PATH}/payment-advices` }),
    };
  });

  router.get('/payment-advices/:documentNumber', (ctx) => {
    const record = repository('paymentAdvices').get(ctx.params.documentNumber);
    if (!record) return notFound(ctx, 'Payment advice not found', `No payment advice ${ctx.params.documentNumber}.`);
    return { status: 200, body: paymentAdviceView(record) };
  });

  router.post('/cash-applications', async (ctx) => {
    assertScenario(ctx, ['reject']);
    const validator = new Validator();
    const invoiceReference = validator.string(ctx.payload.invoiceReference, 'invoiceReference', { max: 64 });
    const companyCode = validator.string(ctx.payload.companyCode, 'companyCode', { required: false, pattern: COMPANY_CODE_PATTERN });
    const amount = validator.money(ctx.payload.amount, 'amount', { positive: true });
    const currency = validator.string(ctx.payload.currency, 'currency', { pattern: /^[A-Z]{3}$/ });
    const valueDate = validator.date(ctx.payload.valueDate, 'valueDate');
    const bankReference = validator.string(ctx.payload.bankReference, 'bankReference', { max: 64 });
    const suppliedClearingDocument = validator.string(ctx.payload.clearingDocument, 'clearingDocument', { required: false, max: 32 });
    if (currency && amount && amount.currency !== currency) validator.add('amount.currency', 'CURRENCY_MISMATCH', 'must equal the document currency');
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'cash-applications', async () => {
      const naturalKey = suppliedClearingDocument ?? bankReference;
      const existing = repository('cashApplications').find((record) => record.naturalKey === naturalKey);
      if (existing) {
        return duplicateOrConflict(ctx, existing, cashApplicationView, {
          resource: 'cash application',
          reasonCode: 'DUPLICATE_CLEARING_DOCUMENT',
          naturalKey,
        });
      }
      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'S/4HANA rejected the cash application',
          detail: `Cash application ${naturalKey} was rejected by the S/4HANA simulator.`,
          reasonCode: 'S4-CASH-REJECT',
          errors: [{ field: 'bankReference', code: 'CASH_REJECTED', message: 'rejected by S/4 scenario' }],
          meta: { bankReference },
        });
      }

      const invoice =
        repository('arInvoices').get(invoiceReference) ??
        repository('arInvoices').find((record) => record.businessReference === invoiceReference) ??
        null;

      let appliedUnits = amount.units;
      let status = 'CLEARED';
      if (!invoice) {
        appliedUnits = 0n;
        status = 'UNALLOCATED';
      } else {
        if (companyCode && invoice.companyCode !== companyCode) {
          return problem({
            status: 409,
            category: CATEGORY.CONFLICT,
            code: CODES.CONFLICT,
            title: 'Company code mismatch',
            detail: `Invoice ${invoice.documentNumber} belongs to company code ${invoice.companyCode}, not ${companyCode}.`,
            instance: ctx.path,
            retryable: false,
            meta: { reasonCode: 'COMPANY_CODE_MISMATCH', invoiceCompanyCode: invoice.companyCode, requestedCompanyCode: companyCode },
          });
        }
        if (invoice.currency !== currency) {
          return problem({
            status: 409,
            category: CATEGORY.CONFLICT,
            code: CODES.CONFLICT,
            title: 'Currency mismatch',
            detail: `Invoice ${invoice.documentNumber} is in ${invoice.currency}, not ${currency}.`,
            instance: ctx.path,
            retryable: false,
            meta: { reasonCode: 'CURRENCY_MISMATCH' },
          });
        }
        if (amount.units >= invoice.openUnits) {
          appliedUnits = invoice.openUnits;
          status = amount.units === invoice.openUnits ? 'CLEARED' : 'PARTIAL';
          invoice.openUnits = 0n;
          invoice.clearingStatus = 'CLEARED';
        } else {
          appliedUnits = amount.units;
          invoice.openUnits -= amount.units;
          invoice.clearingStatus = 'PARTIAL';
          status = 'PARTIAL';
        }
      }

      const unappliedUnits = amount.units - appliedUnits;
      const fiscalYear = valueDate.slice(0, 4);
      const clearingDocument = suppliedClearingDocument ?? state.nextId(`S4-CL-${fiscalYear}`);
      const record = {
        clearingDocument,
        naturalKey,
        businessPayloadHash: ctx.payloadHash,
        invoiceReference,
        invoiceDocumentNumber: invoice?.documentNumber ?? null,
        companyCode: invoice?.companyCode ?? companyCode ?? null,
        status,
        amountUnits: amount.units,
        appliedUnits,
        unappliedUnits,
        currency,
        valueDate,
        bankReference,
        period: periodOf(valueDate),
        clearedAt: nowIso(),
      };
      repository('cashApplications').add(clearingDocument, record);
      if (appliedUnits > 0n) {
        postToGl({
          documentNumber: clearingDocument,
          companyCode: record.companyCode,
          documentType: 'CASH_APPLICATION',
          postingDate: valueDate,
          currency,
          lines: [
            { account: '100100', debitUnits: appliedUnits },
            { account: '120100', creditUnits: appliedUnits },
          ],
        });
      }
      return { status: 201, body: cashApplicationView(record) };
    });
  });

  router.get('/cash-applications', (ctx) => {
    const records = repository('cashApplications').all().map(cashApplicationView);
    return {
      status: 200,
      body: paginate(records, { searchParams: ctx.query, path: `${S4_BASE_PATH}/cash-applications` }),
    };
  });

  router.get('/cash-applications/:clearingDocument', (ctx) => {
    const record = repository('cashApplications').get(ctx.params.clearingDocument);
    if (!record) return notFound(ctx, 'Cash application not found', `No clearing document ${ctx.params.clearingDocument}.`);
    return { status: 200, body: cashApplicationView(record) };
  });

  router.post('/reversals', async (ctx) => {
    assertScenario(ctx, ['closed_period', 'reject']);
    const validator = new Validator();
    const originalDocumentNumber = validator.string(ctx.payload.originalDocumentNumber, 'originalDocumentNumber', { max: 32 });
    const reason = validator.string(ctx.payload.reason, 'reason', { max: 140 });
    const postingDate = validator.date(ctx.payload.postingDate, 'postingDate');
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'reversals', async () => {
      const closed = requireOpenPeriod(ctx, { postingDate, documentType: 'REVERSAL' });
      if (closed) return closed;
      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'S/4HANA rejected the reversal',
          detail: `Reversal of ${originalDocumentNumber} was rejected by the S/4HANA simulator.`,
          reasonCode: 'S4-REVERSAL-REJECT',
          errors: [{ field: 'originalDocumentNumber', code: 'REVERSAL_REJECTED', message: 'rejected by S/4 scenario' }],
          meta: { originalDocumentNumber },
        });
      }

      const original = findAnyDocument(originalDocumentNumber);
      if (!original) return notFound(ctx, 'Original document not found', `No posted document ${originalDocumentNumber} to reverse.`);
      if (original.reversed) {
        return duplicateConflict(
          ctx,
          'Document is already reversed',
          `${originalDocumentNumber} was already reversed by ${original.reversedBy}. A correction is a reversal plus a new document (POST-03).`,
          'ALREADY_REVERSED',
          { originalDocumentNumber, reversalDocumentNumber: original.reversedBy },
        );
      }

      const fiscalYear = postingDate.slice(0, 4);
      const documentNumber = state.nextId(`S4-RV-${fiscalYear}`);
      const totalDebitUnits = repository('glPostings')
        .all()
        .filter((posting) => posting.documentNumber === originalDocumentNumber)
        .reduce((total, posting) => total + posting.debitUnits, 0n);
      const originalType =
        repository('journalEntries').has(originalDocumentNumber) ? 'JOURNAL_ENTRY'
          : repository('arInvoices').has(originalDocumentNumber) ? 'AR_INVOICE'
            : repository('supplierInvoices').has(originalDocumentNumber) ? 'SUPPLIER_INVOICE'
              : 'PAYMENT_ADVICE';
      const record = {
        documentNumber,
        naturalKey: originalDocumentNumber,
        businessPayloadHash: ctx.payloadHash,
        originalDocumentNumber,
        originalDocumentType: originalType,
        status: 'POSTED',
        reversedUnits: totalDebitUnits,
        reversedCurrency: original.currency,
        reason,
        postingDate,
        period: periodOf(postingDate),
        postedAt: nowIso(),
      };
      repository('reversals').add(documentNumber, record);
      original.reversed = true;
      original.reversedBy = documentNumber;
      postToGl({
        documentNumber,
        companyCode: original.companyCode,
        documentType: 'REVERSAL',
        postingDate,
        currency: original.currency,
        lines: reversedPostings(originalDocumentNumber),
      });
      return { status: 201, body: reversalView(record) };
    });
  });

  router.get('/reversals', (ctx) => {
    const records = repository('reversals').all().map(reversalView);
    return {
      status: 200,
      body: paginate(records, { searchParams: ctx.query, path: `${S4_BASE_PATH}/reversals` }),
    };
  });

  router.get('/reversals/:documentNumber', (ctx) => {
    const record = repository('reversals').get(ctx.params.documentNumber);
    if (!record) return notFound(ctx, 'Reversal not found', `No reversal document ${ctx.params.documentNumber}.`);
    return { status: 200, body: reversalView(record) };
  });

  router.get('/gl-balances', (ctx) => {
    const companyCode = ctx.query.get('companyCode');
    const period = ctx.query.get('period');
    const account = ctx.query.get('account');
    const grouped = new Map();
    for (const posting of repository('glPostings').all()) {
      if (companyCode && posting.companyCode !== companyCode) continue;
      if (period && posting.period !== period) continue;
      if (account && posting.account !== account) continue;
      const key = `${posting.companyCode}|${posting.period}|${posting.account}|${posting.currency}`;
      const entry = grouped.get(key) ?? {
        companyCode: posting.companyCode,
        period: posting.period,
        account: posting.account,
        accountName: GL_ACCOUNTS[posting.account] ?? 'Unmapped GL account',
        currency: posting.currency,
        debitUnits: 0n,
        creditUnits: 0n,
      };
      entry.debitUnits += posting.debitUnits;
      entry.creditUnits += posting.creditUnits;
      grouped.set(key, entry);
    }
    const balances = [...grouped.values()]
      .sort((left, right) => `${left.companyCode}${left.account}`.localeCompare(`${right.companyCode}${right.account}`))
      .map((entry) => ({
        companyCode: entry.companyCode,
        period: entry.period,
        account: entry.account,
        accountName: entry.accountName,
        currency: entry.currency,
        debit: moneyView(entry.debitUnits, entry.currency),
        credit: moneyView(entry.creditUnits, entry.currency),
        balance: moneyView(entry.debitUnits - entry.creditUnits, entry.currency),
      }));
    const totals = balances.reduce(
      (accumulator, entry) => ({
        debitUnits: accumulator.debitUnits + parseAmountString(entry.debit.amount),
        creditUnits: accumulator.creditUnits + parseAmountString(entry.credit.amount),
      }),
      { debitUnits: 0n, creditUnits: 0n },
    );
    const response = paginate(balances, { searchParams: ctx.query, path: `${S4_BASE_PATH}/gl-balances` });
    response.totals = {
      debit: moneyView(totals.debitUnits, balances[0]?.currency ?? 'USD'),
      credit: moneyView(totals.creditUnits, balances[0]?.currency ?? 'USD'),
      balance: moneyView(totals.debitUnits - totals.creditUnits, balances[0]?.currency ?? 'USD'),
    };
    return { status: 200, body: response };
  });

  router.post('/reconciliations', async (ctx) => {
    assertScenario(ctx, ['reject']);
    const validator = new Validator();
    const companyCode = validator.string(ctx.payload.companyCode, 'companyCode', { pattern: COMPANY_CODE_PATTERN });
    const period = validator.string(ctx.payload.period, 'period', { pattern: PERIOD_PATTERN });
    const currency = validator.string(ctx.payload.currency, 'currency', { required: false, pattern: /^[A-Z]{3}$/ }) ?? 'USD';
    const expectedInput = validator.array(ctx.payload.expected, 'expected', { min: 0, max: 200 }) ?? [];
    const expected = [];
    expectedInput.forEach((item, index) => {
      const prefix = `expected[${index}]`;
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        validator.add(prefix, 'TYPE', 'must be an object');
        return;
      }
      const businessReference = validator.string(item.businessReference, `${prefix}.businessReference`, { max: 64 });
      const documentType = validator.string(item.documentType, `${prefix}.documentType`, {
        enumValues: ['AR_INVOICE', 'SUPPLIER_INVOICE', 'PAYMENT_ADVICE', 'JOURNAL_ENTRY'],
      });
      const amount = validator.money(item.amount, `${prefix}.amount`, { nonNegative: true });
      expected.push({ businessReference, documentType, amountUnits: amount?.units, currency: amount?.currency });
    });
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'reconciliations', async () => {
      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'S/4HANA rejected the reconciliation request',
          detail: `Reconciliation for ${companyCode} ${period} was rejected by the S/4HANA simulator.`,
          reasonCode: 'S4-RECON-REJECT',
          errors: [{ field: 'period', code: 'RECONCILIATION_REJECTED', message: 'rejected by S/4 scenario' }],
          meta: { companyCode, period },
        });
      }

      const posted = [];
      for (const invoice of repository('arInvoices').all()) {
        if (invoice.companyCode !== companyCode || invoice.period !== period) continue;
        posted.push({
          businessReference: invoice.businessReference,
          documentType: 'AR_INVOICE',
          documentNumber: invoice.documentNumber,
          units: invoice.grossUnits,
          currency: invoice.currency,
        });
      }
      for (const invoice of repository('supplierInvoices').all()) {
        if (invoice.companyCode !== companyCode || invoice.period !== period) continue;
        posted.push({
          businessReference: invoice.businessReference,
          documentType: 'SUPPLIER_INVOICE',
          documentNumber: invoice.documentNumber,
          units: invoice.grossUnits,
          currency: invoice.currency,
        });
      }
      for (const advice of repository('paymentAdvices').all()) {
        if (advice.companyCode !== companyCode || advice.period !== period) continue;
        posted.push({
          businessReference: advice.paymentId,
          documentType: 'PAYMENT_ADVICE',
          documentNumber: advice.documentNumber,
          units: advice.amountUnits,
          currency: advice.currency,
        });
      }
      for (const entry of repository('journalEntries').all()) {
        if (entry.companyCode !== companyCode || entry.period !== period) continue;
        posted.push({
          businessReference: entry.businessReference,
          documentType: 'JOURNAL_ENTRY',
          documentNumber: entry.documentNumber,
          units: entry.totalDebitUnits,
          currency: entry.currency,
        });
      }

      const keyOf = (businessReference, documentType) => `${businessReference}|${documentType}`;
      const expectedTypes = new Set(expected.map((item) => item.documentType));
      const scopedPosted = posted.filter((item) => expectedTypes.has(item.documentType));
      const postedByKey = new Map();
      const duplicateKeys = new Set();
      for (const item of scopedPosted) {
        const key = keyOf(item.businessReference, item.documentType);
        if (postedByKey.has(key)) duplicateKeys.add(key);
        postedByKey.set(key, item);
      }
      const expectedKeys = new Set(expected.map((item) => keyOf(item.businessReference, item.documentType)));
      const breaks = [];
      let matchedCount = 0;
      let expectedTotalUnits = 0n;
      let postedTotalUnits = 0n;

      for (const item of expected) {
        expectedTotalUnits += item.amountUnits ?? 0n;
        const key = keyOf(item.businessReference, item.documentType);
        const match = postedByKey.get(key);
        if (!match) {
          breaks.push({
            businessReference: item.businessReference,
            documentType: item.documentType,
            reason: 'MISSING_SAP_INVOICE',
            expectedAmount: moneyView(item.amountUnits, item.currency ?? currency),
            postedAmount: null,
            difference: moneyView(item.amountUnits, item.currency ?? currency),
          });
          continue;
        }
        postedTotalUnits += match.units;
        const differenceUnits = (item.amountUnits ?? 0n) - match.units;
        if (differenceUnits === 0n) {
          matchedCount += 1;
        } else if (differenceUnits > -100n && differenceUnits < 100n) {
          matchedCount += 1;
        } else {
          breaks.push({
            businessReference: item.businessReference,
            documentType: item.documentType,
            reason: 'AMOUNT_MISMATCH',
            documentNumber: match.documentNumber,
            expectedAmount: moneyView(item.amountUnits, item.currency ?? currency),
            postedAmount: moneyView(match.units, match.currency),
            difference: moneyView(differenceUnits, match.currency),
          });
        }
      }

      for (const item of scopedPosted) {
        const key = keyOf(item.businessReference, item.documentType);
        if (!expectedKeys.has(key)) {
          postedTotalUnits += item.units;
          breaks.push({
            businessReference: item.businessReference,
            documentType: item.documentType,
            reason: 'MISSING_EXPECTATION',
            documentNumber: item.documentNumber,
            expectedAmount: null,
            postedAmount: moneyView(item.units, item.currency),
            difference: moneyView(-item.units, item.currency),
          });
        }
      }
      for (const key of duplicateKeys) {
        const item = postedByKey.get(key);
        breaks.push({
          businessReference: item.businessReference,
          documentType: item.documentType,
          reason: 'DUPLICATE',
          documentNumber: item.documentNumber,
          expectedAmount: moneyView(item.units, item.currency),
          postedAmount: moneyView(item.units, item.currency),
          difference: moneyView(0n, item.currency),
        });
      }

      const reconciliationId = state.nextId(`S4-REC-${period.replace('-', '')}`);
      const record = {
        reconciliationId,
        naturalKey: `${companyCode}|${period}`,
        businessPayloadHash: ctx.payloadHash,
        companyCode,
        period,
        currency,
        status: breaks.length === 0 ? 'MATCHED' : 'BREAKS',
        matchedCount,
        breakCount: breaks.length,
        expectedTotal: moneyView(expectedTotalUnits, currency),
        postedTotal: moneyView(postedTotalUnits, currency),
        variance: moneyView(expectedTotalUnits - postedTotalUnits, currency),
        tolerance: { amount: moneyView(100n, currency), rule: '±0.01 amount tolerance (SPEC §7.13.5)' },
        breaks,
        checkedAt: nowIso(),
        _links: { self: { href: `${S4_BASE_PATH}/reconciliations/${reconciliationId}` } },
      };
      repository('reconciliations').add(reconciliationId, record);
      return { status: 201, body: record };
    });
  });

  router.get('/reconciliations', (ctx) => {
    const companyCode = ctx.query.get('companyCode');
    const period = ctx.query.get('period');
    const records = repository('reconciliations')
      .all()
      .filter((record) => !companyCode || record.companyCode === companyCode)
      .filter((record) => !period || record.period === period);
    return {
      status: 200,
      body: paginate(records, { searchParams: ctx.query, path: `${S4_BASE_PATH}/reconciliations` }),
    };
  });

  router.get('/reconciliations/:id', (ctx) => {
    const record = repository('reconciliations').get(ctx.params.id);
    if (!record) return notFound(ctx, 'Reconciliation not found', `No reconciliation ${ctx.params.id}.`);
    return { status: 200, body: record };
  });

  return {
    system: S4_SYSTEM,
    basePath: S4_BASE_PATH,
    description: 'SAP S/4HANA test double: AR/AP invoices, GL journal, payment advice, cash application, reversal, GL balances, reconciliation.',
    schemaMajor: SCHEMA_MAJOR,
    targetSystemAliases: ['S/4HANA', 'S4', 'SAP-S4'],
    requiresBook: false,
    allowedScenarios: ALLOWED_SCENARIOS,
    magicScenarios: MAGIC_SCENARIOS,
    scenarioRefs,
    router,
    state,
  };
}

export { ALLOWED_SCENARIOS as S4_ALLOWED_SCENARIOS };
