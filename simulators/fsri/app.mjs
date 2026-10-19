import { addDays, clockInfo, nowIso, periodOf } from '../common/clock.mjs';
import {
  PERCENT_FACTOR,
  absUnits,
  applyPercent,
  formatPercent,
  minUnits,
  moneyObject,
  ratioPercentUnits,
} from '../common/money.mjs';
import { createRouter } from '../common/router.mjs';
import { createState } from '../common/store.mjs';
import { Validator } from '../common/validate.mjs';
import { CATEGORY, CODES, SimProblem, problem } from '../common/problem.mjs';
import { withIdempotency } from '../common/idempotency.mjs';
import { COMMON_SCENARIOS, assertScenario } from '../common/scenarios.mjs';
import { paginate } from '../common/pagination.mjs';

export const FSRI_SYSTEM = 'fsri';
export const FSRI_BASE_PATH = '/sim/fsri/v1';
const SCHEMA_MAJOR = 1;

const CONTRACT_TYPES = ['QUOTA_SHARE', 'SURPLUS', 'EXCESS_OF_LOSS', 'AGGREGATE_XOL', 'STOP_LOSS', 'FACULTATIVE'];
const CONTRACT_STATUSES = ['DRAFT', 'BOUND', 'ENDORSED', 'CANCELLED'];
const BOOKS = ['DIRECT', 'ASSUMED'];
const CONTRACT_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
const HANDOFF_KEY_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,63}$/;

const ALLOWED_SCENARIOS = Object.freeze([...COMMON_SCENARIOS, 'mismatch']);
const MAGIC_SCENARIOS = Object.freeze([
  { suffix: '-MISMATCH', scenario: 'mismatch' },
  { suffix: '-REJECT', scenario: 'reject' },
  { suffix: '-PARTIAL', scenario: 'partial' },
  { suffix: '-TIMEOUT', scenario: 'timeout' },
  { suffix: '-UNAVAILABLE', scenario: 'unavailable' },
  { suffix: '-THROTTLED', scenario: 'throttled' },
  { suffix: '-MALFORMED', scenario: 'malformed' },
  { suffix: '-DUPLICATE', scenario: 'duplicate' },
]);

const COLLECTIONS = [
  'contracts',
  'cessions',
  'retros',
  'confirmations',
  'recoverables',
  'statements',
  'rejections',
];

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
    meta: { reasonCode, exceptionOwner: 'reinsurance-operations', ...meta },
    correlationId: ctx.correlationId,
  });
}

function bookWall(ctx, expectedBook) {
  const receivedBook = ctx.envelope?.businessBook ?? null;
  ctx.state.recordSecurityEvent({
    type: 'BOOK_WALL_VIOLATION',
    system: FSRI_SYSTEM,
    path: ctx.path,
    requestId: ctx.requestId,
    expectedBook,
    receivedBook,
    tenantId: ctx.envelope?.tenantId ?? null,
  });
  return problem({
    status: 403,
    category: CATEGORY.AUTHORIZATION,
    code: CODES.BOOK_WALL,
    title: 'Book wall violation',
    detail: `The ${expectedBook} route rejects ${receivedBook ?? 'an unset'} businessBook payload (SPEC §7.18.5, PULL-06). The event is recorded as a security event.`,
    instance: ctx.path,
    retryable: false,
    meta: { expectedBook, receivedBook, securityEvent: 'BOOK_WALL_VIOLATION' },
    correlationId: ctx.correlationId,
  });
}

function requireBook(ctx, expectedBook) {
  if (ctx.envelope.businessBook !== expectedBook) throw new SimProblem(bookWall(ctx, expectedBook));
}

function recordId(ctx, prefix, width = 6) {
  return ctx.state.nextId(prefix, { width });
}

function moneyView(units, currency) {
  return moneyObject(units, currency);
}

function validateContract(payload) {
  const validator = new Validator();
  const contractNumber = validator.string(payload.contractNumber, 'contractNumber', {
    max: 32,
    pattern: CONTRACT_NUMBER_PATTERN,
  });
  const contractType = validator.string(payload.contractType, 'contractType', { enumValues: CONTRACT_TYPES });
  const cedantPartyId = validator.string(payload.cedantPartyId, 'cedantPartyId', { max: 64 });
  const reinsurerPartyIds = validator.array(payload.reinsurerPartyIds, 'reinsurerPartyIds', { min: 1, max: 20 }) ?? [];
  reinsurerPartyIds.forEach((partyId, index) => validator.string(partyId, `reinsurerPartyIds[${index}]`, { max: 64 }));
  const effectiveFrom = validator.date(payload.effectiveFrom, 'effectiveFrom');
  const effectiveTo = validator.date(payload.effectiveTo, 'effectiveTo');
  if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) {
    validator.add('effectiveTo', 'DATE_ORDER', 'must be later than effectiveFrom');
  }
  const currency = validator.string(payload.currency, 'currency', { pattern: /^[A-Z]{3}$/ });
  const status = validator.string(payload.status, 'status', { enumValues: CONTRACT_STATUSES });

  const layersInput = validator.array(payload.layers, 'layers', { min: 1, max: 20 }) ?? [];
  const layers = [];
  const layerNumbers = new Set();
  layersInput.forEach((layer, index) => {
    const prefix = `layers[${index}]`;
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) {
      validator.add(prefix, 'TYPE', 'must be an object');
      return;
    }
    const layerNumber = validator.integer(layer.layerNumber, `${prefix}.layerNumber`, { min: 1, max: 99 });
    if (layerNumber !== undefined) {
      if (layerNumbers.has(layerNumber)) validator.add(`${prefix}.layerNumber`, 'DUPLICATE', 'must be unique');
      layerNumbers.add(layerNumber);
    }
    const attachment = validator.money(layer.attachment, `${prefix}.attachment`, { nonNegative: true });
    const limit = validator.money(layer.limit, `${prefix}.limit`, { positive: true });
    if (attachment && limit && attachment.currency !== limit.currency) {
      validator.add(`${prefix}.limit.currency`, 'CURRENCY_MISMATCH', 'must equal the attachment currency');
    }
    if (attachment && currency && attachment.currency !== currency) {
      validator.add(`${prefix}.attachment.currency`, 'CURRENCY_MISMATCH', 'must equal the contract currency');
    }
    layers.push({ layerNumber, attachmentUnits: attachment?.units, limitUnits: limit?.units });
  });

  const participantsInput = validator.array(payload.participants, 'participants', { min: 1, max: 50 }) ?? [];
  const participants = [];
  const participantParties = new Set();
  let shareTotal = 0n;
  participantsInput.forEach((participant, index) => {
    const prefix = `participants[${index}]`;
    if (participant === null || typeof participant !== 'object' || Array.isArray(participant)) {
      validator.add(prefix, 'TYPE', 'must be an object');
      return;
    }
    const partyId = validator.string(participant.partyId, `${prefix}.partyId`, { max: 64 });
    const role = validator.string(participant.role, `${prefix}.role`, { enumValues: ['REINSURER', 'BROKER', 'CEDENT'] });
    const shareUnits = validator.percent(participant.sharePct, `${prefix}.sharePct`, { max: PERCENT_FACTOR });
    if (partyId) {
      if (participantParties.has(partyId)) validator.add(`${prefix}.partyId`, 'DUPLICATE', 'must be unique');
      participantParties.add(partyId);
    }
    if (shareUnits !== undefined) shareTotal += shareUnits;
    participants.push({ partyId, role, shareUnits });
  });
  if (shareTotal > PERCENT_FACTOR + 1n) {
    validator.add('participants', 'SHARES_EXCEED_100', 'participant shares must not exceed 100%');
  }
  validator.throwIfInvalid();

  return {
    contractNumber,
    contractType,
    cedantPartyId,
    reinsurerPartyIds,
    effectiveFrom,
    effectiveTo,
    currency,
    contractStatus: status,
    layers,
    participants,
    shareTotal,
  };
}

function validateHandoff(payload, kind) {
  const validator = new Validator();
  const contractNumber = validator.string(payload.contractNumber, 'contractNumber', {
    max: 32,
    pattern: CONTRACT_NUMBER_PATTERN,
  });
  const fsriContractRef = validator.string(payload.fsriContractRef, 'fsriContractRef', { required: false, max: 64 });
  const caseField = kind === 'cession' ? 'cessionCaseRef' : 'retroCaseRef';
  const caseReference = validator.string(payload[caseField], caseField, { max: 64, pattern: HANDOFF_KEY_PATTERN });
  const sourceTypes = kind === 'cession' ? ['CLAIM', 'POLICY'] : ['CONTRACT', 'CLAIM'];
  const source = payload.source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    validator.add('source', 'REQUIRED', 'must be an object');
  } else {
    validator.string(source.type, 'source.type', { enumValues: sourceTypes });
    validator.string(source.id, 'source.id', { max: 64 });
    validator.string(source.businessKey, 'source.businessKey', { max: 64 });
    validator.integer(source.version, 'source.version', { min: 1 });
    validator.string(source.book, 'source.book', { required: false, enumValues: BOOKS });
  }
  const expectedAmount = validator.money(payload.expectedAmount, 'expectedAmount', { positive: true });
  const effectiveDate = validator.date(payload.effectiveDate, 'effectiveDate');

  let cededPremium;
  let cededLoss;
  let commissionPct;
  let retrocessionPct;
  let calculationBasis;
  if (kind === 'cession') {
    cededPremium = validator.money(payload.cededPremium, 'cededPremium', { required: false, positive: true });
    commissionPct = validator.percent(payload.commissionPct, 'commissionPct', { required: false, max: PERCENT_FACTOR });
    calculationBasis = validator.string(payload.calculationBasis, 'calculationBasis', {
      required: false,
      enumValues: ['PAID_LOSS', 'RESERVE', 'ULTIMATE', 'PREMIUM'],
    });
  } else {
    cededLoss = validator.money(payload.cededLoss, 'cededLoss', { required: false, nonNegative: true });
    retrocessionPct = validator.percent(payload.retrocessionPct, 'retrocessionPct', { required: false, max: PERCENT_FACTOR });
  }

  const documentsInput = validator.array(payload.documents, 'documents', { required: false, min: 0, max: 50 }) ?? [];
  const documents = [];
  documentsInput.forEach((document, index) => {
    const prefix = `documents[${index}]`;
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      validator.add(prefix, 'TYPE', 'must be an object');
      return;
    }
    const documentId = validator.string(document.documentId, `${prefix}.documentId`, { max: 64 });
    const documentType = validator.string(document.documentType, `${prefix}.documentType`, { max: 32 });
    documents.push({ documentId, documentType });
  });

  const currency = expectedAmount?.currency ?? null;
  for (const [field, parsed] of [
    ['cededPremium', cededPremium],
    ['cededLoss', cededLoss],
  ]) {
    if (parsed && currency && parsed.currency !== currency) {
      validator.add(`${field}.currency`, 'CURRENCY_MISMATCH', 'must equal the expectedAmount currency');
    }
  }
  validator.throwIfInvalid();

  return {
    contractNumber,
    fsriContractRef,
    caseReference,
    source,
    expectedUnits: expectedAmount.units,
    currency,
    effectiveDate,
    period: periodOf(effectiveDate),
    cededPremiumUnits: cededPremium?.units,
    cededLossUnits: cededLoss?.units,
    commissionPctUnits: commissionPct,
    retrocessionPctUnits: retrocessionPct,
    calculationBasis,
    documents,
  };
}

function contractView(record) {
  return {
    fsriContractRef: record.fsriContractRef,
    contractNumber: record.contractNumber,
    businessBook: record.businessBook,
    contractType: record.contractType,
    cedantPartyId: record.cedantPartyId,
    reinsurerPartyIds: record.reinsurerPartyIds,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    currency: record.currency,
    status: 'ACKNOWLEDGED',
    contractStatus: record.contractStatus,
    layers: record.layers.map((layer) => ({
      layerNumber: layer.layerNumber,
      attachment: moneyView(layer.attachmentUnits, record.currency),
      limit: moneyView(layer.limitUnits, record.currency),
    })),
    participants: record.participants.map((participant) => ({
      partyId: participant.partyId,
      role: participant.role,
      sharePct: formatPercent(participant.shareUnits),
    })),
    acknowledgedAt: record.acknowledgedAt,
    errors: [],
    _links: {
      self: { href: `${FSRI_BASE_PATH}/contracts/${record.fsriContractRef}` },
    },
  };
}

function confirmationView(record) {
  return {
    confirmationId: record.confirmationId,
    ...(record.kind === 'cession' ? { fsriCessionId: record.parentId } : { fsriRetroId: record.parentId }),
    businessBook: record.businessBook,
    status: record.status,
    expectedAmount: moneyView(record.expectedUnits, record.currency),
    confirmedAmount: moneyView(record.confirmedUnits, record.currency),
    variance: moneyView(record.expectedUnits - record.confirmedUnits, record.currency),
    confirmedAt: record.confirmedAt,
    sourceSystem: 'FS-RI',
    errors: [],
  };
}

function handoffView(record) {
  const kind = record.kind;
  const base = {
    businessBook: record.businessBook,
    contractNumber: record.contractNumber,
    fsriContractRef: record.fsriContractRef,
    caseReference: record.caseReference,
    source: record.source,
    status: record.status,
    expectedAmount: moneyView(record.expectedUnits, record.currency),
    confirmedAmount: moneyView(record.confirmedUnits, record.currency),
    variance: moneyView(record.expectedUnits - record.confirmedUnits, record.currency),
    effectiveDate: record.effectiveDate,
    receivedAt: record.receivedAt,
    confirmation: confirmationView(record.confirmation),
    errors:
      record.status === 'PARTIAL'
        ? [{ line: 2, code: 'CEDED_AMOUNT_OUT_OF_TOLERANCE', message: 'FS-RI accepted 60% of the expected ceded amount.' }]
        : [],
    _links: {
      self: {
        href:
          kind === 'cession'
            ? `${FSRI_BASE_PATH}/cessions/${record.fsriCessionId}`
            : `${FSRI_BASE_PATH}/retros/${record.fsriRetroId}`,
      },
      confirmation: {
        href:
          kind === 'cession'
            ? `${FSRI_BASE_PATH}/cessions/${record.fsriCessionId}/confirmation`
            : `${FSRI_BASE_PATH}/retros/${record.fsriRetroId}/confirmation`,
      },
      recoverable: { href: `${FSRI_BASE_PATH}/recoverables/${record.recoverableId}` },
    },
  };
  if (kind === 'cession') {
    base.fsriCessionId = record.fsriCessionId;
    base.cedentPremium = record.cededPremiumUnits !== undefined ? moneyView(record.cededPremiumUnits, record.currency) : null;
    base.commission =
      record.commissionUnits !== undefined ? moneyView(record.commissionUnits, record.currency) : null;
    base.calculationBasis = record.calculationBasis ?? null;
    base.lines =
      record.status === 'PARTIAL'
        ? [
            { lineNumber: 1, lineType: 'CEDED_LOSS', status: 'ACCEPTED', amount: moneyView(record.confirmedUnits, record.currency) },
            {
              lineNumber: 2,
              lineType: 'CEDED_LOSS',
              status: 'REJECTED',
              amount: moneyView(record.expectedUnits - record.confirmedUnits, record.currency),
              reasonCode: 'CEDED_AMOUNT_OUT_OF_TOLERANCE',
            },
          ]
        : [{ lineNumber: 1, lineType: 'CEDED_LOSS', status: 'ACCEPTED', amount: moneyView(record.confirmedUnits, record.currency) }];
  } else {
    base.fsriRetroId = record.fsriRetroId;
    base.cededLoss = record.cededLossUnits !== undefined ? moneyView(record.cededLossUnits, record.currency) : null;
    base.retrocessionPct = record.retrocessionPctUnits !== undefined ? formatPercent(record.retrocessionPctUnits) : null;
  }
  return base;
}

function recoverableView(record) {
  return {
    recoverableId: record.recoverableId,
    businessBook: record.businessBook,
    contractNumber: record.contractNumber,
    fsriContractRef: record.fsriContractRef,
    ...(record.kind === 'cession' ? { fsriCessionId: record.parentId } : { fsriRetroId: record.parentId }),
    caseReference: record.caseReference,
    currency: record.currency,
    confirmedAmount: moneyView(record.confirmedUnits, record.currency),
    paid: moneyView(record.paidUnits, record.currency),
    unpaid: moneyView(record.unpaidUnits, record.currency),
    ibnr: moneyView(record.ibnrUnits, record.currency),
    outstanding: moneyView(record.confirmedUnits, record.currency),
    dueDate: record.dueDate,
    status: record.status,
    updatedAt: record.updatedAt,
    _links: {
      self: { href: `${FSRI_BASE_PATH}/recoverables/${record.recoverableId}` },
      contract: { href: `${FSRI_BASE_PATH}/contracts/${record.fsriContractRef}` },
    },
  };
}

function rejectionRecord(ctx, { entityType, businessReference, businessBook, period, reasonCode, naturalKey = null }) {
  return {
    rejectionId: recordId(ctx, `FSRI-REJ-${businessBook ?? 'NA'}`),
    entityType,
    businessReference,
    businessBook: businessBook ?? null,
    period: period ?? null,
    reasonCode,
    scenario: ctx.scenario,
    tenantId: ctx.envelope?.tenantId ?? null,
    rejectedAt: nowIso(),
    naturalKey,
  };
}

function findContract(state, input) {
  if (input.fsriContractRef) return state.repo('contracts').get(input.fsriContractRef) ?? null;
  return state.repo('contracts').find((contract) => contract.contractNumber === input.contractNumber) ?? null;
}

export function createApp({ state = createState({ system: FSRI_SYSTEM, collections: COLLECTIONS }) } = {}) {
  const router = createRouter();
  const repository = state.repo;

  function scenarioRefs(payload) {
    return [
      payload?.contractNumber,
      payload?.cessionCaseRef,
      payload?.retroCaseRef,
      payload?.businessReference,
      payload?.source?.businessKey,
      payload?.source?.id,
    ];
  }

  router.get('/admin/state', (ctx) => ({
    status: 200,
    body: {
      simulator: FSRI_SYSTEM,
      testDouble: true,
      clock: clockInfo(),
      startedAt: state.startedAt,
      scenario: state.defaultScenario,
      scenarios: ALLOWED_SCENARIOS,
      counts: state.counts(),
      securityEvents: state.securityEvents.slice(-10),
      recentRequests: state.requests.slice(-20),
    },
  }));

  router.post('/admin/reset', (ctx) => {
    state.reset();
    return {
      status: 200,
      body: { status: 'RESET', simulator: FSRI_SYSTEM, clock: nowIso(), counts: state.counts() },
    };
  });

  router.get('/admin/scenarios', () => ({
    status: 200,
    body: { simulator: FSRI_SYSTEM, defaultScenario: state.defaultScenario, allowed: ALLOWED_SCENARIOS },
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
    return { status: 200, body: { simulator: FSRI_SYSTEM, defaultScenario: state.defaultScenario } };
  });

  router.post('/contracts', async (ctx) => {
    assertScenario(ctx, ['reject']);
    const input = validateContract(ctx.payload);
    return withIdempotency(ctx, 'contracts', async () => {
      const existing = repository('contracts').find((contract) => contract.contractNumber === input.contractNumber);
      if (existing) {
        if (existing.businessPayloadHash !== ctx.payloadHash) {
          return problem({
            status: 409,
            category: CATEGORY.CONFLICT,
            code: CODES.CONFLICT,
            title: 'Contract master conflict',
            detail: `FS-RI already holds contract ${input.contractNumber} with different terms. The contract number is the immutable platform business key; a change requires a new version and hand-off.`,
            instance: ctx.path,
            retryable: false,
            meta: { reasonCode: 'CONTRACT_MASTER_CONFLICT', fsriContractRef: existing.fsriContractRef },
            correlationId: ctx.correlationId,
          });
        }
        return {
          status: 200,
          body: { ...contractView(existing), duplicate: true },
          headers: { 'x-sim-duplicate': 'true' },
        };
      }

      if (ctx.scenario === 'reject') {
        const rejection = rejectionRecord(ctx, {
          entityType: 'CONTRACT',
          businessReference: input.contractNumber,
          businessBook: ctx.envelope.businessBook,
          period: periodOf(input.effectiveFrom),
          reasonCode: 'FSRI-CONTRACT-REJECTED',
        });
        repository('rejections').add(rejection.rejectionId, rejection);
        return businessReject(ctx, {
          title: 'FS-RI rejected the contract master hand-off',
          detail: `FS-RI did not accept contract ${input.contractNumber}. The source stays pending and an exception is raised for the reinsurance operations owner.`,
          reasonCode: 'FSRI-CONTRACT-REJECTED',
          errors: [{ field: 'contractNumber', code: 'CONTRACT_REJECTED', message: 'rejected by FS-RI scenario' }],
          meta: { businessReference: input.contractNumber },
        });
      }

      const fsriContractRef = recordId(ctx, `FSRI-CTR-${ctx.envelope.businessBook}`);
      const record = {
        fsriContractRef,
        tenantId: ctx.envelope.tenantId,
        businessBook: ctx.envelope.businessBook,
        contractNumber: input.contractNumber,
        contractType: input.contractType,
        cedantPartyId: input.cedantPartyId,
        reinsurerPartyIds: input.reinsurerPartyIds,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        currency: input.currency,
        contractStatus: input.contractStatus,
        layers: input.layers,
        participants: input.participants,
        acknowledgedAt: nowIso(),
        businessPayloadHash: ctx.payloadHash,
      };
      repository('contracts').add(fsriContractRef, record);
      return { status: 201, body: contractView(record) };
    });
  });

  router.get('/contracts', (ctx) => {
    const book = ctx.query.get('businessBook');
    const contractNumber = ctx.query.get('contractNumber');
    const tenantId = ctx.query.get('tenantId');
    const contracts = repository('contracts')
      .all()
      .filter((contract) => !book || contract.businessBook === book)
      .filter((contract) => !contractNumber || contract.contractNumber === contractNumber)
      .filter((contract) => !tenantId || contract.tenantId === tenantId)
      .map(contractView);
    return { status: 200, body: paginate(contracts, { searchParams: ctx.query, path: `${FSRI_BASE_PATH}/contracts` }) };
  });

  router.get('/contracts/:ref', (ctx) => {
    const record = repository('contracts').get(ctx.params.ref);
    if (!record) return notFound(ctx, 'Contract not found', `No FS-RI contract with reference ${ctx.params.ref}.`);
    return { status: 200, body: contractView(record) };
  });

  function registerHandoff(kind) {
    const isCession = kind === 'cession';
    const collection = isCession ? 'cessions' : 'retros';
    const expectedBook = isCession ? 'DIRECT' : 'ASSUMED';
    const idField = isCession ? 'fsriCessionId' : 'fsriRetroId';
    const idPrefix = isCession ? 'FSRI-CES' : 'FSRI-RET';
    const entityType = isCession ? 'CESSION' : 'RETRO';
    const caseField = isCession ? 'cessionCaseRef' : 'retroCaseRef';

    router.post(`/${collection}`, async (ctx) => {
      assertScenario(ctx, ['reject', 'partial']);
      requireBook(ctx, expectedBook);
      const input = validateHandoff(ctx.payload, kind);
      if (input.source?.book && input.source.book !== expectedBook) {
        throw new SimProblem(bookWall(ctx, expectedBook));
      }

      return withIdempotency(ctx, collection, async () => {
        const contract = findContract(state, input);
        if (!contract) {
          return notFound(
            ctx,
            'FS-RI contract not found',
            `No FS-RI contract matches ${input.fsriContractRef ?? input.contractNumber}; reconcile the contract master before sending a ${kind}.`,
          );
        }
        if (contract.contractNumber !== input.contractNumber) {
          return problem({
            status: 409,
            category: CATEGORY.CONFLICT,
            code: CODES.CONFLICT,
            title: 'Contract reference mismatch',
            detail: `fsriContractRef ${contract.fsriContractRef} belongs to ${contract.contractNumber}, not ${input.contractNumber}.`,
            instance: ctx.path,
            retryable: false,
            meta: { reasonCode: 'CONTRACT_REFERENCE_MISMATCH' },
            correlationId: ctx.correlationId,
          });
        }
        if (contract.businessBook !== expectedBook) {
          return bookWall(ctx, expectedBook);
        }

        const naturalKey = `${input.caseReference}|${input.source.version}`;
        const existing = repository(collection).find((record) => record.naturalKey === naturalKey);
        if (existing) {
          if (existing.businessPayloadHash !== ctx.payloadHash) {
            return problem({
              status: 409,
              category: CATEGORY.CONFLICT,
              code: CODES.CONFLICT,
              title: 'Hand-off is immutable',
              detail: `Case ${input.caseReference} version ${input.source.version} was already handed off with different content. A source change creates a new version and a new idempotency key (HAND-02).`,
              instance: ctx.path,
              retryable: false,
              meta: {
                reasonCode: 'HANDOFF_IMMUTABLE',
                [idField]: existing[idField],
              },
              correlationId: ctx.correlationId,
            });
          }
          return {
            status: 200,
            body: { ...handoffView(existing), duplicate: true },
            headers: { 'x-sim-duplicate': 'true' },
          };
        }

        if (ctx.scenario === 'reject') {
          const rejection = rejectionRecord(ctx, {
            entityType,
            businessReference: input.caseReference,
            businessBook: expectedBook,
            period: input.period,
            reasonCode: isCession ? 'FSRI-CESSION-REJECTED' : 'FSRI-RETRO-REJECTED',
            naturalKey,
          });
          repository('rejections').add(rejection.rejectionId, rejection);
          return businessReject(ctx, {
            title: isCession ? 'FS-RI rejected the cession hand-off' : 'FS-RI rejected the retro hand-off',
            detail: `FS-RI did not accept ${input.caseReference}. The source record is flagged pending or unceded and an exception is raised for the reinsurance operations owner.`,
            reasonCode: isCession ? 'FSRI-CESSION-REJECTED' : 'FSRI-RETRO-REJECTED',
            errors: [
              {
                field: 'expectedAmount',
                code: 'OUTSIDE_TOLERANCE',
                message: 'FS-RI rejected the reported amount by simulation scenario',
              },
            ],
            meta: { businessReference: input.caseReference, period: input.period },
          });
        }

        const partial = ctx.scenario === 'partial';
        const confirmedUnits = partial ? applyPercent(input.expectedUnits, 600000n) : input.expectedUnits;
        const parentId = recordId(ctx, `${idPrefix}-${expectedBook}`);
        const confirmationId = recordId(ctx, `FSRI-CNF-${expectedBook}`);
        const confirmation = {
          confirmationId,
          kind,
          parentId,
          businessBook: expectedBook,
          status: 'CONFIRMED',
          expectedUnits: input.expectedUnits,
          confirmedUnits,
          currency: input.currency,
          confirmedAt: nowIso(),
        };
        repository('confirmations').add(confirmationId, confirmation);

        const paidUnits = applyPercent(confirmedUnits, 600000n);
        const unpaidUnits = applyPercent(confirmedUnits, 300000n);
        const ibnrUnits = confirmedUnits - paidUnits - unpaidUnits;
        const recoverableId = recordId(ctx, `FSRI-RCV-${expectedBook}`);
        const recoverable = {
          recoverableId,
          kind,
          parentId,
          businessBook: expectedBook,
          contractNumber: input.contractNumber,
          fsriContractRef: contract.fsriContractRef,
          caseReference: input.caseReference,
          currency: input.currency,
          confirmedUnits,
          paidUnits,
          unpaidUnits,
          ibnrUnits,
          dueDate: addDays(input.effectiveDate, 30),
          status: 'OPEN',
          updatedAt: nowIso(),
          tenantId: ctx.envelope.tenantId,
        };
        repository('recoverables').add(recoverableId, recoverable);

        const commissionUnits =
          isCession && input.cededPremiumUnits !== undefined && input.commissionPctUnits !== undefined
            ? applyPercent(input.cededPremiumUnits, input.commissionPctUnits)
            : undefined;

        const record = {
          ...(isCession ? { fsriCessionId: parentId } : { fsriRetroId: parentId }),
          kind,
          tenantId: ctx.envelope.tenantId,
          businessBook: expectedBook,
          contractNumber: input.contractNumber,
          fsriContractRef: contract.fsriContractRef,
          caseReference: input.caseReference,
          source: input.source,
          expectedUnits: input.expectedUnits,
          confirmedUnits,
          currency: input.currency,
          effectiveDate: input.effectiveDate,
          period: input.period,
          status: partial ? 'PARTIAL' : 'POSTED',
          receivedAt: nowIso(),
          businessPayloadHash: ctx.payloadHash,
          naturalKey,
          confirmationId,
          confirmation,
          recoverableId,
          cededPremiumUnits: input.cededPremiumUnits,
          cededLossUnits: input.cededLossUnits,
          commissionPctUnits: input.commissionPctUnits,
          commissionUnits,
          retrocessionPctUnits: input.retrocessionPctUnits,
          calculationBasis: input.calculationBasis,
          documents: input.documents,
        };
        repository(collection).add(parentId, record);
        return { status: partial ? 207 : 201, body: handoffView(record) };
      });
    });

    router.get(`/${collection}`, (ctx) => {
      const book = ctx.query.get('businessBook');
      const contractNumber = ctx.query.get('contractNumber');
      const status = ctx.query.get('status');
      const tenantId = ctx.query.get('tenantId');
      const records = repository(collection)
        .all()
        .filter((record) => !book || record.businessBook === book)
        .filter((record) => !contractNumber || record.contractNumber === contractNumber)
        .filter((record) => !status || record.status === status)
        .filter((record) => !tenantId || record.tenantId === tenantId)
        .map(handoffView);
      return {
        status: 200,
        body: paginate(records, { searchParams: ctx.query, path: `${FSRI_BASE_PATH}/${collection}` }),
      };
    });

    router.get(`/${collection}/:id`, (ctx) => {
      const record = repository(collection).get(ctx.params.id);
      if (!record) {
        return notFound(ctx, isCession ? 'Cession not found' : 'Retro not found', `No ${kind} with id ${ctx.params.id}.`);
      }
      return { status: 200, body: handoffView(record) };
    });

    router.post(`/${collection}/:id/confirmation`, async (ctx) => {
      assertScenario(ctx, ['reject', 'mismatch']);
      const record = repository(collection).get(ctx.params.id);
      if (!record) {
        return notFound(ctx, isCession ? 'Cession not found' : 'Retro not found', `No ${kind} with id ${ctx.params.id}.`);
      }
      return withIdempotency(ctx, `${collection}-confirmations`, async () => {
        if (ctx.scenario === 'reject') {
          const rejection = rejectionRecord(ctx, {
            entityType: isCession ? 'CESSION_CONFIRMATION' : 'RETRO_CONFIRMATION',
            businessReference: record.caseReference,
            businessBook: expectedBook,
            period: record.period,
            reasonCode: 'FSRI-CONFIRMATION-REJECTED',
          });
          repository('rejections').add(rejection.rejectionId, rejection);
          return businessReject(ctx, {
            title: 'FS-RI rejected the confirmation request',
            detail: `FS-RI did not confirm ${record.caseReference}; the confirmation stays pending and reconciliation will break until resolved.`,
            reasonCode: 'FSRI-CONFIRMATION-REJECTED',
            errors: [{ field: 'confirmationId', code: 'CONFIRMATION_REJECTED', message: 'rejected by FS-RI scenario' }],
            meta: { businessReference: record.caseReference },
          });
        }
        if (ctx.scenario === 'mismatch') {
          const mismatchedUnits = applyPercent(record.confirmedUnits, 900000n);
          return {
            status: 200,
            body: {
              ...confirmationView(record.confirmation),
              status: 'MISMATCH',
              confirmedAmount: moneyView(mismatchedUnits, record.currency),
              variance: moneyView(record.expectedUnits - mismatchedUnits, record.currency),
              errors: [
                {
                  code: 'CONFIRMATION_MISMATCH',
                  message: 'Confirmed amount differs from the hand-off; reconciliation break recorded, no silent correction.',
                },
              ],
            },
            headers: { 'x-sim-reconciliation-break': 'true' },
          };
        }
        return { status: 200, body: confirmationView(record.confirmation) };
      });
    });
  }

  registerHandoff('cession');
  registerHandoff('retro');

  router.get('/recoverables', (ctx) => {
    const book = ctx.query.get('businessBook');
    const contractNumber = ctx.query.get('contractNumber');
    const status = ctx.query.get('status');
    const tenantId = ctx.query.get('tenantId');
    const records = repository('recoverables')
      .all()
      .filter((record) => !book || record.businessBook === book)
      .filter((record) => !contractNumber || record.contractNumber === contractNumber)
      .filter((record) => !status || record.status === status)
      .filter((record) => !tenantId || record.tenantId === tenantId)
      .map(recoverableView);
    return {
      status: 200,
      body: paginate(records, { searchParams: ctx.query, path: `${FSRI_BASE_PATH}/recoverables` }),
    };
  });

  router.get('/recoverables/:id', (ctx) => {
    const record = repository('recoverables').get(ctx.params.id);
    if (!record) return notFound(ctx, 'Recoverable not found', `No recoverable with id ${ctx.params.id}.`);
    return { status: 200, body: recoverableView(record) };
  });

  router.post('/statements', async (ctx) => {
    assertScenario(ctx, ['reject']);
    const book = ctx.envelope.businessBook;
    const validator = new Validator();
    const period = validator.string(ctx.payload.period, 'period', { pattern: /^\d{4}-(0[1-9]|1[0-2])$/ });
    const currency = validator.string(ctx.payload.currency, 'currency', { required: false, pattern: /^[A-Z]{3}$/ }) ?? 'USD';
    const contractNumbers = validator.array(ctx.payload.contractNumbers, 'contractNumbers', {
      required: false,
      min: 0,
      max: 50,
    });
    (contractNumbers ?? []).forEach((contractNumber, index) =>
      validator.string(contractNumber, `contractNumbers[${index}]`, { max: 32 }),
    );
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'statements', async () => {
      if (ctx.scenario === 'reject') {
        const rejection = rejectionRecord(ctx, {
          entityType: 'STATEMENT',
          businessReference: `${book}-${period}`,
          businessBook: book,
          period,
          reasonCode: 'FSRI-STATEMENT-REJECTED',
        });
        repository('rejections').add(rejection.rejectionId, rejection);
        return businessReject(ctx, {
          title: 'FS-RI statement request rejected',
          detail: `FS-RI did not issue a statement for ${book} ${period}.`,
          reasonCode: 'FSRI-STATEMENT-REJECTED',
          errors: [{ field: 'period', code: 'STATEMENT_REJECTED', message: 'rejected by FS-RI scenario' }],
          meta: { businessBook: book, period },
        });
      }

      const records = [...repository('cessions').all(), ...repository('retros').all()]
        .filter((record) => record.businessBook === book && record.period === period)
        .filter((record) => !contractNumbers || contractNumbers.length === 0 || contractNumbers.includes(record.contractNumber))
        .filter((record) => record.currency === currency)
        .sort((left, right) => left.naturalKey.localeCompare(right.naturalKey));

      const lines = [];
      let cededPremiumUnits = 0n;
      let cededLossUnits = 0n;
      let commissionUnits = 0n;
      for (const record of records) {
        const pushLine = (lineType, amountUnits) => {
          lines.push({
            lineId: `FSRI-STM-LINE-${String(lines.length + 1).padStart(4, '0')}`,
            lineNumber: lines.length + 1,
            lineType,
            contractNumber: record.contractNumber,
            caseReference: record.caseReference,
            parentId: record.fsriCessionId ?? record.fsriRetroId,
            amount: moneyView(amountUnits, currency),
          });
        };
        if (record.cededPremiumUnits !== undefined) {
          pushLine('CEDED_PREMIUM', record.cededPremiumUnits);
          cededPremiumUnits += record.cededPremiumUnits;
        }
        pushLine('CEDED_LOSS', record.confirmedUnits);
        cededLossUnits += record.confirmedUnits;
        if (record.commissionUnits !== undefined) {
          pushLine('COMMISSION', record.commissionUnits);
          commissionUnits += record.commissionUnits;
        }
      }

      const version =
        repository('statements').all().filter((statement) => statement.businessBook === book && statement.period === period)
          .length + 1;
      const statementId = recordId(ctx, `FSRI-STM-${book}-${period}`);
      const statement = {
        statementId,
        statementNumber: `STM-${book}-${period}-${String(version).padStart(4, '0')}`,
        version,
        tenantId: ctx.envelope.tenantId,
        businessBook: book,
        period,
        currency,
        status: 'ISSUED',
        issuedAt: nowIso(),
        lines,
        totals: {
          cededPremium: moneyView(cededPremiumUnits, currency),
          cededLoss: moneyView(cededLossUnits, currency),
          commission: moneyView(commissionUnits, currency),
          netDue: moneyView(cededPremiumUnits - commissionUnits - cededLossUnits, currency),
        },
        _links: { self: { href: `${FSRI_BASE_PATH}/statements/${statementId}` } },
      };
      repository('statements').add(statementId, statement);
      return { status: 201, body: statement };
    });
  });

  router.get('/statements', (ctx) => {
    const book = ctx.query.get('businessBook');
    const period = ctx.query.get('period');
    const tenantId = ctx.query.get('tenantId');
    const statements = repository('statements')
      .all()
      .filter((statement) => !book || statement.businessBook === book)
      .filter((statement) => !period || statement.period === period)
      .filter((statement) => !tenantId || statement.tenantId === tenantId);
    return {
      status: 200,
      body: paginate(statements, { searchParams: ctx.query, path: `${FSRI_BASE_PATH}/statements` }),
    };
  });

  router.get('/statements/:id', (ctx) => {
    const statement = repository('statements').get(ctx.params.id);
    if (!statement) return notFound(ctx, 'Statement not found', `No statement with id ${ctx.params.id}.`);
    return { status: 200, body: statement };
  });

  router.get('/reconciliations', (ctx) => {
    const requestedBook = ctx.query.get('businessBook');
    const requestedPeriod = ctx.query.get('period');
    const books = requestedBook ? [requestedBook] : BOOKS;
    const periods = requestedPeriod
      ? [requestedPeriod]
      : [...new Set([...repository('cessions').all(), ...repository('retros').all()].map((record) => record.period))].sort();

    const summaries = [];
    for (const book of books) {
      for (const period of periods) {
        const records = [...repository('cessions').all(), ...repository('retros').all()].filter(
          (record) => record.businessBook === book && record.period === period,
        );
        const rejected = repository('rejections')
          .all()
          .filter(
            (rejection) =>
              rejection.businessBook === book &&
              rejection.period === period &&
              (rejection.entityType === 'CESSION' || rejection.entityType === 'RETRO'),
          );
        const currency = records[0]?.currency ?? 'USD';
        const expectedUnits = records.reduce((total, record) => total + record.expectedUnits, 0n);
        const confirmedUnits = records.reduce((total, record) => total + record.confirmedUnits, 0n);
        const accepted = records.filter((record) => record.status === 'POSTED').length;
        const partial = records.filter((record) => record.status === 'PARTIAL').length;
        const pending = 0;
        const sent = records.length + rejected.length;
        const toleranceUnits = minUnits(applyPercent(absUnits(confirmedUnits), 10000n), 10_000_000n);
        const breaks = records
          .filter((record) => absUnits(record.expectedUnits - record.confirmedUnits) > toleranceUnits)
          .map((record) => ({
            breakId: `FSRI-BRK-${record.fsriCessionId ?? record.fsriRetroId}`,
            businessReference: record.caseReference,
            parentId: record.fsriCessionId ?? record.fsriRetroId,
            reason: 'AMOUNT_MISMATCH',
            expectedAmount: moneyView(record.expectedUnits, record.currency),
            confirmedAmount: moneyView(record.confirmedUnits, record.currency),
            difference: moneyView(record.expectedUnits - record.confirmedUnits, record.currency),
            status: 'OPEN',
            owner: 'reinsurance-operations',
          }));
        const varianceUnits = expectedUnits - confirmedUnits;
        const variancePctUnits = ratioPercentUnits(varianceUnits, confirmedUnits);

        summaries.push({
          businessBook: book,
          period,
          currency,
          sent,
          accepted,
          partial,
          rejected: rejected.length,
          pending,
          amountExpected: moneyView(expectedUnits, currency),
          amountConfirmed: moneyView(confirmedUnits, currency),
          variance: moneyView(varianceUnits, currency),
          variancePct: variancePctUnits === null ? null : formatPercent(variancePctUnits),
          tolerance: { amount: moneyView(toleranceUnits, currency), rule: 'lesser of 1% or 1,000 in contract currency' },
          status: breaks.length === 0 ? 'BALANCED' : 'BREAKS',
          invariant: { sent, accepted, partial, rejected: rejected.length, pending, balanced: sent === accepted + partial + rejected.length + pending },
          breaks,
          checkedAt: nowIso(),
        });
      }
    }

    if (requestedBook && requestedPeriod) {
      return { status: 200, body: summaries[0] };
    }
    return {
      status: 200,
      body: paginate(summaries, { searchParams: ctx.query, path: `${FSRI_BASE_PATH}/reconciliations` }),
    };
  });

  return {
    system: FSRI_SYSTEM,
    basePath: FSRI_BASE_PATH,
    description: 'SAP FS-RI test double: contract master, cession and retro hand-off, confirmation, recoverable, statement, reconciliation.',
    schemaMajor: SCHEMA_MAJOR,
    targetSystemAliases: ['FS-RI', 'FSRI'],
    requiresBook: true,
    allowedScenarios: ALLOWED_SCENARIOS,
    magicScenarios: MAGIC_SCENARIOS,
    scenarioRefs,
    router,
    state,
  };
}

export { ALLOWED_SCENARIOS };
