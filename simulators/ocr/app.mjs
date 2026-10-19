import { clockInfo, nowIso } from '../common/clock.mjs';
import { moneyObject, parseAmountString } from '../common/money.mjs';
import { createRouter } from '../common/router.mjs';
import { createState } from '../common/store.mjs';
import { Validator } from '../common/validate.mjs';
import { CATEGORY, CODES, problem } from '../common/problem.mjs';
import { withIdempotency } from '../common/idempotency.mjs';
import { COMMON_SCENARIOS, assertScenario } from '../common/scenarios.mjs';
import { paginate } from '../common/pagination.mjs';
import { sha256Hex } from '../common/canonical.mjs';

export const OCR_SYSTEM = 'ocr';
export const OCR_BASE_PATH = '/sim/ocr/v1';
const SCHEMA_MAJOR = 1;
const DOCUMENT_TYPES = ['CMS1500', 'UB04', 'INVOICE', 'LOSS_ADVICE', 'POLICE_REPORT', 'OTHER'];

const ALLOWED_SCENARIOS = Object.freeze([...COMMON_SCENARIOS, 'fail', 'low_confidence']);
const MAGIC_SCENARIOS = Object.freeze([
  { suffix: '-LOWCONF', scenario: 'low_confidence' },
  { suffix: '-FAIL', scenario: 'fail' },
  { suffix: '-REJECT', scenario: 'reject' },
  { suffix: '-TIMEOUT', scenario: 'timeout' },
  { suffix: '-UNAVAILABLE', scenario: 'unavailable' },
  { suffix: '-THROTTLED', scenario: 'throttled' },
  { suffix: '-MALFORMED', scenario: 'malformed' },
  { suffix: '-DUPLICATE', scenario: 'duplicate' },
]);

const COLLECTIONS = ['documents'];

function notFound(ctx, detail) {
  return problem({
    status: 404,
    category: CATEGORY.NOT_FOUND,
    code: CODES.NOT_FOUND,
    title: 'OCR job not found',
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

function digitsFrom(seed, count) {
  const hex = sha256Hex(seed);
  return [...hex]
    .map((character) => (Number.parseInt(character, 16) % 10).toString())
    .join('')
    .slice(0, count);
}

function extractionFor(documentType, versionHash) {
  const seed = `${documentType}|${versionHash}`;
  const suffix = digitsFrom(seed, 6);
  const amount = (value) => moneyObject(parseAmountString(value), 'USD');
  switch (documentType) {
    case 'CMS1500':
      return {
        patientName: 'Doe, Jane',
        memberId: `M${suffix}`,
        payerName: 'Example Health Plan',
        serviceDateFrom: '2026-01-15',
        serviceDateTo: '2026-01-15',
        diagnosisCodes: ['M54.5', 'E11.9'],
        billedAmount: amount('1250.00'),
      };
    case 'UB04':
      return {
        facilityName: 'Example Medical Center',
        statementFrom: '2026-01-01',
        statementTo: '2026-01-31',
        principalDiagnosis: 'M54.5',
        totalCharges: amount('4825.00'),
      };
    case 'INVOICE':
      return {
        invoiceNumber: `INV-2026-${suffix}`,
        invoiceDate: '2026-09-15',
        dueDate: '2026-10-15',
        vendorName: 'Acme Defense Counsel LLP',
        totalAmount: amount('5000.00'),
      };
    case 'LOSS_ADVICE':
      return {
        claimNumber: `CLM-2026-${suffix}`,
        lossDate: '2026-08-30',
        causeOfLoss: 'Product liability',
        paidAmount: amount('2400.00'),
      };
    case 'POLICE_REPORT':
      return {
        reportNumber: `PD-2026-${suffix}`,
        incidentDate: '2026-08-28',
        officerName: 'Officer J. Sample',
        incidentType: 'Theft',
      };
    default:
      return { text: `Synthetic OCR text for document version ${versionHash.slice(0, 12)}.` };
  }
}

function confidenceFor(status) {
  if (status === 'LOW_CONFIDENCE') return 0.42;
  if (status === 'FAILED') return 0;
  return 0.98;
}

function jobView(record) {
  return {
    jobId: record.jobId,
    documentId: record.documentId,
    documentType: record.documentType,
    versionHash: record.versionHash,
    status: record.status,
    confidence: record.confidence,
    pageCount: record.pageCount,
    extractedFields: record.extractedFields,
    fieldConfidences: record.fieldConfidences,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    callbackUrl: record.callbackUrl ?? null,
    error: record.error ?? null,
    _links: { self: { href: `${OCR_BASE_PATH}/documents/${record.jobId}` } },
  };
}

export function createApp({ state = createState({ system: OCR_SYSTEM, collections: COLLECTIONS }) } = {}) {
  const router = createRouter();
  const repository = state.repo;

  function scenarioRefs(payload) {
    return [payload?.documentId, payload?.versionHash, payload?.documentType];
  }

  router.get('/admin/state', () => ({
    status: 200,
    body: {
      simulator: OCR_SYSTEM,
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
    return { status: 200, body: { status: 'RESET', simulator: OCR_SYSTEM, clock: nowIso(), counts: state.counts() } };
  });

  router.get('/admin/scenarios', () => ({
    status: 200,
    body: { simulator: OCR_SYSTEM, defaultScenario: state.defaultScenario, allowed: ALLOWED_SCENARIOS },
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
    return { status: 200, body: { simulator: OCR_SYSTEM, defaultScenario: state.defaultScenario } };
  });

  router.post('/documents', async (ctx) => {
    assertScenario(ctx, ['fail', 'low_confidence', 'reject']);
    const validator = new Validator();
    const documentId = validator.string(ctx.payload.documentId, 'documentId', { max: 64 });
    const documentType = validator.string(ctx.payload.documentType, 'documentType', { enumValues: DOCUMENT_TYPES });
    const versionHash = validator.string(ctx.payload.versionHash, 'versionHash', {
      pattern: /^[A-Za-z0-9_-]{8,128}$/,
    });
    const contentType = validator.string(ctx.payload.contentType, 'contentType', { required: false, max: 100 });
    const pageCount = validator.integer(ctx.payload.pageCount, 'pageCount', { required: false, min: 1, max: 500 }) ?? 1;
    const callbackUrl = validator.string(ctx.payload.callbackUrl, 'callbackUrl', {
      required: false,
      max: 512,
      pattern: /^https?:\/\//,
    });
    const contentBase64 = validator.string(ctx.payload.contentBase64, 'contentBase64', { required: false, max: 1_400_000 });
    if (contentBase64) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
        validator.add('contentBase64', 'BASE64', 'must be valid base64');
      } else if (Buffer.from(contentBase64, 'base64').length > 1_048_576) {
        validator.add('contentBase64', 'MAX_SIZE', 'decoded content must not exceed 1048576 bytes');
      }
    }
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'documents', async () => {
      const naturalKey = `${documentId}|${versionHash}`;
      const existing = repository('documents').find((record) => record.naturalKey === naturalKey);
      if (existing) {
        if (existing.businessPayloadHash === ctx.payloadHash) {
          return { status: 200, body: { ...jobView(existing), duplicate: true }, headers: { 'x-sim-duplicate': 'true' } };
        }
        return problem({
          status: 409,
          category: CATEGORY.CONFLICT,
          code: CODES.CONFLICT,
          title: 'Document version already processed with different content',
          detail: `Document ${documentId} version ${versionHash} already has an OCR result. A new version is a new hash and a new job (SPEC §7.8).`,
          instance: ctx.path,
          retryable: false,
          meta: { reasonCode: 'DOCUMENT_VERSION_CONFLICT', existingJob: existing.jobId },
          correlationId: ctx.correlationId,
        });
      }

      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'OCR provider rejected the document',
          detail: `Document ${documentId} was rejected before extraction.`,
          reasonCode: 'OCR-DOCUMENT-REJECTED',
          errors: [{ field: 'documentType', code: 'UNSUPPORTED_DOCUMENT', message: 'provider rejected the document type' }],
          meta: { documentId, documentType },
        });
      }

      let status = 'COMPLETED';
      if (ctx.scenario === 'fail') status = 'FAILED';
      else if (ctx.scenario === 'low_confidence') status = 'LOW_CONFIDENCE';
      const confidence = confidenceFor(status);
      const extractedFields = status === 'FAILED' ? {} : extractionFor(documentType, versionHash);
      const fieldConfidences = Object.fromEntries(Object.keys(extractedFields).map((field) => [field, confidence]));
      const jobId = state.nextId('OCR');
      const record = {
        jobId,
        naturalKey,
        businessPayloadHash: ctx.payloadHash,
        documentId,
        documentType,
        versionHash,
        contentType,
        pageCount,
        status,
        confidence,
        extractedFields,
        fieldConfidences,
        durationMs: 250,
        callbackUrl,
        completedAt: nowIso(),
        error:
          status === 'FAILED'
            ? { code: 'OCR_UNREADABLE', message: 'The document could not be read; route to manual indexing.', retryable: true }
            : null,
      };
      repository('documents').add(jobId, record);
      return { status: 201, body: jobView(record) };
    });
  });

  router.get('/documents', (ctx) => {
    const documentId = ctx.query.get('documentId');
    const status = ctx.query.get('status');
    const documents = repository('documents')
      .all()
      .filter((record) => !documentId || record.documentId === documentId)
      .filter((record) => !status || record.status === status)
      .map(jobView);
    return { status: 200, body: paginate(documents, { searchParams: ctx.query, path: `${OCR_BASE_PATH}/documents` }) };
  });

  router.get('/documents/:jobId', (ctx) => {
    const record = repository('documents').get(ctx.params.jobId);
    if (!record) return notFound(ctx, `No OCR job ${ctx.params.jobId}.`);
    return { status: 200, body: jobView(record) };
  });

  return {
    system: OCR_SYSTEM,
    basePath: OCR_BASE_PATH,
    description: 'OCR test double: complete, low confidence and failed extraction with deterministic field templates.',
    schemaMajor: SCHEMA_MAJOR,
    targetSystemAliases: ['OCR', 'OCR_ENGINE', 'DOCUMENT_AI'],
    requiresBook: false,
    allowedScenarios: ALLOWED_SCENARIOS,
    magicScenarios: MAGIC_SCENARIOS,
    scenarioRefs,
    router,
    state,
  };
}
