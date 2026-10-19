import { clockInfo, nowIso } from '../common/clock.mjs';
import { createRouter } from '../common/router.mjs';
import { createState } from '../common/store.mjs';
import { Validator } from '../common/validate.mjs';
import { CATEGORY, CODES, problem } from '../common/problem.mjs';
import { withIdempotency } from '../common/idempotency.mjs';
import { COMMON_SCENARIOS, assertScenario } from '../common/scenarios.mjs';
import { paginate } from '../common/pagination.mjs';

export const SANCTIONS_SYSTEM = 'sanctions';
export const SANCTIONS_BASE_PATH = '/sim/sanctions/v1';
const SCHEMA_MAJOR = 1;
const LIST_VERSION = '2026.10.01';

const ALLOWED_SCENARIOS = Object.freeze([...COMMON_SCENARIOS, 'potential', 'confirmed', 'error']);
const MAGIC_SCENARIOS = Object.freeze([
  { suffix: '-CONFIRMED', scenario: 'confirmed' },
  { suffix: '-POTENTIAL', scenario: 'potential' },
  { suffix: '-SCRERR', scenario: 'error' },
  { suffix: '-REJECT', scenario: 'reject' },
  { suffix: '-TIMEOUT', scenario: 'timeout' },
  { suffix: '-UNAVAILABLE', scenario: 'unavailable' },
  { suffix: '-THROTTLED', scenario: 'throttled' },
  { suffix: '-MALFORMED', scenario: 'malformed' },
  { suffix: '-DUPLICATE', scenario: 'duplicate' },
]);

const COLLECTIONS = ['screenings'];

/**
 * Fictional watchlist entries. They exist only to exercise screening paths and
 * must never be treated as real sanctions data.
 */
const WATCHLIST = Object.freeze([
  {
    listCode: 'OFAC_SDN',
    listName: 'OFAC Specially Designated Nationals (simulated)',
    entryId: 'SDN-0001',
    name: 'Ivan Fictionalov',
    country: 'RU',
    program: 'SIMULATED-EO',
  },
  {
    listCode: 'OFAC_SDN',
    listName: 'OFAC Specially Designated Nationals (simulated)',
    entryId: 'SDN-0002',
    name: 'Acme Sanctioned Holdings',
    country: 'IR',
    program: 'SIMULATED-IRAN',
  },
  {
    listCode: 'EU_CONSOLIDATED',
    listName: 'EU Consolidated List (simulated)',
    entryId: 'EU-0001',
    name: 'Nikolai Testov',
    country: 'BY',
    program: 'SIMULATED-BELARUS',
  },
  {
    listCode: 'UN_CONSOLIDATED',
    listName: 'UN Security Council Consolidated List (simulated)',
    entryId: 'UN-0001',
    name: 'Test Sanctions Entity',
    country: 'KP',
    program: 'SIMULATED-DPRK',
  },
]);

const LISTS = [...new Map(WATCHLIST.map((entry) => [entry.listCode, entry.listName])).entries()].map(([code, name]) => ({
  code,
  name,
  entryCount: WATCHLIST.filter((entry) => entry.listCode === code).length,
  updatedAt: LIST_VERSION,
}));

function normalizeName(value) {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalizeName(value)
    .split(' ')
    .filter((token) => token.length >= 4);
}

function matchEntry(entry, score, matchType) {
  return {
    listCode: entry.listCode,
    listName: entry.listName,
    entryId: entry.entryId,
    matchedName: entry.name,
    country: entry.country,
    program: entry.program,
    score,
    matchType,
  };
}

function notFound(ctx, detail) {
  return problem({
    status: 404,
    category: CATEGORY.NOT_FOUND,
    code: CODES.NOT_FOUND,
    title: 'Screening not found',
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

function screeningView(record) {
  return {
    screeningId: record.screeningId,
    screeningRequestId: record.screeningRequestId,
    party: record.party,
    status: record.status,
    decision: record.status === 'CLEAR' ? 'CLEAR_TO_PROCEED' : record.status === 'CONFIRMED_MATCH' ? 'BLOCK' : 'ESCALATE',
    score: record.score,
    threshold: record.threshold,
    matches: record.matches,
    listsScreened: record.listsScreened,
    listVersion: LIST_VERSION,
    screenedAt: record.screenedAt,
    failClosed: false,
    _links: { self: { href: `${SANCTIONS_BASE_PATH}/screenings/${record.screeningId}` } },
  };
}

export function createApp({ state = createState({ system: SANCTIONS_SYSTEM, collections: COLLECTIONS }) } = {}) {
  const router = createRouter();
  const repository = state.repo;

  function scenarioRefs(payload) {
    return [payload?.screeningRequestId, payload?.party?.name, payload?.party?.partyId];
  }

  router.get('/admin/state', () => ({
    status: 200,
    body: {
      simulator: SANCTIONS_SYSTEM,
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
    return { status: 200, body: { status: 'RESET', simulator: SANCTIONS_SYSTEM, clock: nowIso(), counts: state.counts() } };
  });

  router.get('/admin/scenarios', () => ({
    status: 200,
    body: { simulator: SANCTIONS_SYSTEM, defaultScenario: state.defaultScenario, allowed: ALLOWED_SCENARIOS },
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
    return { status: 200, body: { simulator: SANCTIONS_SYSTEM, defaultScenario: state.defaultScenario } };
  });

  router.get('/lists', () => ({
    status: 200,
    body: {
      simulator: SANCTIONS_SYSTEM,
      listVersion: LIST_VERSION,
      lists: LISTS,
      warning: 'All entries are fictional and exist only for simulator testing.',
    },
  }));

  router.get('/lists/:code', (ctx) => {
    const entries = WATCHLIST.filter((entry) => entry.listCode === ctx.params.code).map((entry) => ({
      entryId: entry.entryId,
      name: entry.name,
      country: entry.country,
      program: entry.program,
    }));
    if (entries.length === 0) return notFound(ctx, `No simulated list ${ctx.params.code}.`);
    return {
      status: 200,
      body: {
        listCode: ctx.params.code,
        listVersion: LIST_VERSION,
        entryCount: entries.length,
        entries,
        warning: 'All entries are fictional and exist only for simulator testing.',
      },
    };
  });

  router.post('/screenings', async (ctx) => {
    assertScenario(ctx, ['potential', 'confirmed', 'error', 'reject']);
    const validator = new Validator();
    const screeningRequestId = validator.string(ctx.payload.screeningRequestId, 'screeningRequestId', { max: 64 });
    const party = ctx.payload.party;
    let partyId;
    let name;
    let country;
    let dateOfBirth;
    if (party === null || typeof party !== 'object' || Array.isArray(party)) {
      validator.add('party', 'REQUIRED', 'must be an object');
    } else {
      partyId = validator.string(party.partyId, 'party.partyId', { required: false, max: 64 });
      name = validator.string(party.name, 'party.name', { max: 200 });
      country = validator.string(party.country, 'party.country', { required: false, pattern: /^[A-Z]{2}$/ });
      dateOfBirth = validator.date(party.dateOfBirth, 'party.dateOfBirth', { required: false });
    }
    const thresholdInput = ctx.payload.threshold ?? 85;
    if (typeof thresholdInput !== 'number' || !Number.isFinite(thresholdInput) || thresholdInput < 0 || thresholdInput > 100) {
      validator.add('threshold', 'RANGE', 'must be a number between 0 and 100');
    }
    const requestedLists = validator.array(ctx.payload.lists, 'lists', { required: false, min: 1, max: 10 });
    if (requestedLists) {
      requestedLists.forEach((code, index) => {
        if (!LISTS.some((list) => list.code === code)) validator.add(`lists[${index}]`, 'UNKNOWN_LIST', 'must be a simulated list code');
      });
    }
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'screenings', async () => {
      const existing = repository('screenings').find((record) => record.screeningRequestId === screeningRequestId);
      if (existing) {
        if (existing.businessPayloadHash === ctx.payloadHash) {
          return { status: 200, body: { ...screeningView(existing), duplicate: true }, headers: { 'x-sim-duplicate': 'true' } };
        }
        return problem({
          status: 409,
          category: CATEGORY.CONFLICT,
          code: CODES.CONFLICT,
          title: 'Screening request already processed with different content',
          detail: `screeningRequestId ${screeningRequestId} was already used for a different party or threshold. Use a new request ID (SPEC §7.8).`,
          instance: ctx.path,
          retryable: false,
          meta: { reasonCode: 'SCREENING_REQUEST_CONFLICT', existingScreening: existing.screeningId },
          correlationId: ctx.correlationId,
        });
      }

      if (ctx.scenario === 'error') {
        return problem({
          status: 503,
          category: CATEGORY.UNAVAILABLE,
          code: CODES.UNAVAILABLE,
          title: 'Sanctions provider unavailable',
          detail: 'The screening provider failed. Sanctions screening fails closed: hold the payment or onboarding until a re-screen succeeds.',
          instance: ctx.path,
          retryable: true,
          headers: { 'retry-after': '5' },
          meta: { reasonCode: 'SANCTIONS-PROVIDER-ERROR', failClosed: true },
          correlationId: ctx.correlationId,
        });
      }
      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'Sanctions provider rejected the screening request',
          detail: `Screening request ${screeningRequestId} was rejected before evaluation.`,
          reasonCode: 'SANCTIONS-REQUEST-REJECTED',
          errors: [{ field: 'party', code: 'SCREENING_REQUEST_REJECTED', message: 'provider rejected the request' }],
          meta: { screeningRequestId },
        });
      }

      const normalized = normalizeName(name ?? '');
      let status = 'CLEAR';
      let score = 0;
      let matches = [];
      const exact = WATCHLIST.find((entry) => normalizeName(entry.name) === normalized);
      if (ctx.scenario === 'confirmed' || normalized.includes('sanctioned') || normalized.includes('blocked')) {
        status = 'CONFIRMED_MATCH';
        score = 100;
        const entry = exact ?? WATCHLIST[0];
        matches = [matchEntry(entry, 100, 'EXACT')];
      } else if (exact) {
        status = 'CONFIRMED_MATCH';
        score = 100;
        matches = [matchEntry(exact, 100, 'EXACT')];
      } else if (ctx.scenario === 'potential') {
        status = 'POTENTIAL_MATCH';
        score = 78.5;
        matches = [matchEntry(WATCHLIST[0], 78.5, 'FUZZY')];
      } else {
        const nameTokens = tokens(name ?? '');
        const fuzzy = WATCHLIST.find((entry) => tokens(entry.name).some((token) => nameTokens.includes(token)));
        if (fuzzy) {
          status = 'POTENTIAL_MATCH';
          score = 91.5;
          matches = [matchEntry(fuzzy, 91.5, 'FUZZY')];
        }
      }

      const threshold = thresholdInput;
      if (ctx.scenario !== 'potential' && status === 'POTENTIAL_MATCH' && score < threshold) {
        status = 'CLEAR';
        matches = [];
      }

      const listsScreened = requestedLists && requestedLists.length > 0 ? [...requestedLists] : LISTS.map((list) => list.code);
      const screeningId = state.nextId('SCR');
      const record = {
        screeningId,
        businessPayloadHash: ctx.payloadHash,
        screeningRequestId,
        party: { partyId: partyId ?? null, name, country: country ?? null, dateOfBirth: dateOfBirth ?? null },
        status,
        score,
        threshold,
        matches,
        listsScreened,
        screenedAt: nowIso(),
      };
      repository('screenings').add(screeningId, record);
      return { status: 201, body: screeningView(record) };
    });
  });

  router.get('/screenings', (ctx) => {
    const screeningRequestId = ctx.query.get('screeningRequestId');
    const status = ctx.query.get('status');
    const screenings = repository('screenings')
      .all()
      .filter((record) => !screeningRequestId || record.screeningRequestId === screeningRequestId)
      .filter((record) => !status || record.status === status)
      .map(screeningView);
    return { status: 200, body: paginate(screenings, { searchParams: ctx.query, path: `${SANCTIONS_BASE_PATH}/screenings` }) };
  });

  router.get('/screenings/:id', (ctx) => {
    const record = repository('screenings').get(ctx.params.id);
    if (!record) return notFound(ctx, `No screening ${ctx.params.id}.`);
    return { status: 200, body: screeningView(record) };
  });

  return {
    system: SANCTIONS_SYSTEM,
    basePath: SANCTIONS_BASE_PATH,
    description: 'Sanctions screening test double: clear, potential, confirmed and fail-closed provider error.',
    schemaMajor: SCHEMA_MAJOR,
    targetSystemAliases: ['SANCTIONS', 'OFAC', 'SCREENING'],
    requiresBook: false,
    allowedScenarios: ALLOWED_SCENARIOS,
    magicScenarios: MAGIC_SCENARIOS,
    scenarioRefs,
    router,
    state,
  };
}
