import { clockInfo, nowIso } from '../common/clock.mjs';
import { createRouter } from '../common/router.mjs';
import { createState } from '../common/store.mjs';
import { Validator } from '../common/validate.mjs';
import { CATEGORY, CODES, problem } from '../common/problem.mjs';
import { withIdempotency } from '../common/idempotency.mjs';
import { COMMON_SCENARIOS, assertScenario } from '../common/scenarios.mjs';
import { paginate } from '../common/pagination.mjs';

export const EMAIL_SYSTEM = 'email';
export const EMAIL_BASE_PATH = '/sim/email/v1';
const SCHEMA_MAJOR = 1;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

const ALLOWED_SCENARIOS = Object.freeze([...COMMON_SCENARIOS, 'bounce', 'suppress']);
const MAGIC_SCENARIOS = Object.freeze([
  { suffix: '-BOUNCE', scenario: 'bounce' },
  { suffix: '-SUPPRESS', scenario: 'suppress' },
  { suffix: '-REJECT', scenario: 'reject' },
  { suffix: '-TIMEOUT', scenario: 'timeout' },
  { suffix: '-UNAVAILABLE', scenario: 'unavailable' },
  { suffix: '-THROTTLED', scenario: 'throttled' },
  { suffix: '-MALFORMED', scenario: 'malformed' },
  { suffix: '-DUPLICATE', scenario: 'duplicate' },
]);

const COLLECTIONS = ['messages'];

function notFound(ctx, detail) {
  return problem({
    status: 404,
    category: CATEGORY.NOT_FOUND,
    code: CODES.NOT_FOUND,
    title: 'Message not found',
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

function messageView(record) {
  return {
    messageId: record.messageId,
    providerMessageId: record.providerMessageId,
    notificationId: record.notificationId,
    attempt: record.attempt,
    status: record.status,
    recipients: record.recipients.map((recipient) => ({ address: recipient.address, name: recipient.name ?? null, status: recipient.status })),
    subject: record.subject,
    templateCode: record.templateCode ?? null,
    classification: record.classification ?? null,
    acceptedAt: record.acceptedAt,
    deliveredAt: record.deliveredAt ?? null,
    bounce: record.bounce ?? null,
    _links: { self: { href: `${EMAIL_BASE_PATH}/messages/${record.messageId}` } },
  };
}

export function createApp({ state = createState({ system: EMAIL_SYSTEM, collections: COLLECTIONS }) } = {}) {
  const router = createRouter();
  const repository = state.repo;

  function scenarioRefs(payload) {
    return [payload?.notificationId, payload?.templateCode, ...(payload?.recipients ?? []).map((recipient) => recipient?.address)];
  }

  router.get('/admin/state', () => ({
    status: 200,
    body: {
      simulator: EMAIL_SYSTEM,
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
    return { status: 200, body: { status: 'RESET', simulator: EMAIL_SYSTEM, clock: nowIso(), counts: state.counts() } };
  });

  router.get('/admin/scenarios', () => ({
    status: 200,
    body: { simulator: EMAIL_SYSTEM, defaultScenario: state.defaultScenario, allowed: ALLOWED_SCENARIOS },
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
    return { status: 200, body: { simulator: EMAIL_SYSTEM, defaultScenario: state.defaultScenario } };
  });

  router.post('/messages', async (ctx) => {
    assertScenario(ctx, ['bounce', 'suppress', 'reject']);
    const validator = new Validator();
    const notificationId = validator.string(ctx.payload.notificationId, 'notificationId', { max: 64 });
    const attempt = validator.integer(ctx.payload.attempt, 'attempt', { required: false, min: 1, max: 5 }) ?? 1;
    const recipientsInput = validator.array(ctx.payload.recipients, 'recipients', { min: 1, max: 20 }) ?? [];
    const recipients = [];
    recipientsInput.forEach((recipient, index) => {
      const prefix = `recipients[${index}]`;
      if (recipient === null || typeof recipient !== 'object' || Array.isArray(recipient)) {
        validator.add(prefix, 'TYPE', 'must be an object');
        return;
      }
      const address = validator.string(recipient.address, `${prefix}.address`, { max: 254, pattern: EMAIL_PATTERN });
      const name = validator.string(recipient.name, `${prefix}.name`, { required: false, max: 120 });
      recipients.push({ address, name });
    });
    const ccInput = validator.array(ctx.payload.cc, 'cc', { required: false, min: 0, max: 20 }) ?? [];
    const cc = [];
    ccInput.forEach((recipient, index) => {
      const prefix = `cc[${index}]`;
      if (recipient === null || typeof recipient !== 'object' || Array.isArray(recipient)) {
        validator.add(prefix, 'TYPE', 'must be an object');
        return;
      }
      const address = validator.string(recipient.address, `${prefix}.address`, { max: 254, pattern: EMAIL_PATTERN });
      cc.push({ address, name: validator.string(recipient.name, `${prefix}.name`, { required: false, max: 120 }) });
    });
    const subject = validator.string(ctx.payload.subject, 'subject', { max: 200 });
    const body = validator.string(ctx.payload.body, 'body', { max: 10000 });
    const templateCode = validator.string(ctx.payload.templateCode, 'templateCode', { required: false, max: 64 });
    const classification = validator.string(ctx.payload.classification, 'classification', {
      required: false,
      enumValues: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PHI'],
    });
    validator.throwIfInvalid();

    return withIdempotency(ctx, 'messages', async () => {
      const naturalKey = `${notificationId}|${attempt}`;
      const existing = repository('messages').find((record) => record.naturalKey === naturalKey);
      if (existing) {
        if (existing.businessPayloadHash === ctx.payloadHash) {
          return { status: 200, body: { ...messageView(existing), duplicate: true }, headers: { 'x-sim-duplicate': 'true' } };
        }
        return problem({
          status: 409,
          category: CATEGORY.CONFLICT,
          code: CODES.CONFLICT,
          title: 'Notification attempt already delivered with different content',
          detail: `notificationId ${notificationId} attempt ${attempt} was already processed (SPEC §7.8 idempotency: notificationId + attempt).`,
          instance: ctx.path,
          retryable: false,
          meta: { reasonCode: 'NOTIFICATION_ATTEMPT_CONFLICT', existingMessage: existing.messageId },
          correlationId: ctx.correlationId,
        });
      }

      const bounceRecipient = recipients.some((recipient) => recipient.address.toLowerCase().startsWith('bounce@'));
      const suppressedRecipient = recipients.some((recipient) => recipient.address.toLowerCase().startsWith('suppressed@'));
      let status = 'DELIVERED';
      if (ctx.scenario === 'suppress' || suppressedRecipient) status = 'SUPPRESSED';
      else if (ctx.scenario === 'bounce' || bounceRecipient) status = 'BOUNCED';

      if (ctx.scenario === 'reject') {
        return businessReject(ctx, {
          title: 'Email relay rejected the message',
          detail: `Notification ${notificationId} was rejected by the relay before delivery.`,
          reasonCode: 'EMAIL-RELAY-REJECTED',
          errors: [{ field: 'recipients', code: 'RECIPIENT_REJECTED', message: 'relay rejected the recipient list' }],
          meta: { notificationId, attempt },
        });
      }

      const messageId = state.nextId('EML');
      const providerMessageId = state.nextId('EML-P');
      const bounce =
        status === 'BOUNCED'
          ? { code: 'MAILBOX_FULL', reason: 'Recipient mailbox is full', permanent: false, detectedAt: nowIso() }
          : null;
      const record = {
        messageId,
        providerMessageId,
        naturalKey,
        businessPayloadHash: ctx.payloadHash,
        notificationId,
        attempt,
        status,
        recipients: recipients.map((recipient) => ({
          ...recipient,
          status: status === 'DELIVERED' ? 'DELIVERED' : status,
        })),
        cc,
        subject,
        templateCode,
        classification,
        acceptedAt: nowIso(),
        deliveredAt: status === 'DELIVERED' ? nowIso() : null,
        bounce,
      };
      repository('messages').add(messageId, record);
      return { status: 201, body: messageView(record) };
    });
  });

  router.get('/messages', (ctx) => {
    const notificationId = ctx.query.get('notificationId');
    const status = ctx.query.get('status');
    const messages = repository('messages')
      .all()
      .filter((record) => !notificationId || record.notificationId === notificationId)
      .filter((record) => !status || record.status === status)
      .map(messageView);
    return { status: 200, body: paginate(messages, { searchParams: ctx.query, path: `${EMAIL_BASE_PATH}/messages` }) };
  });

  router.get('/messages/:id', (ctx) => {
    const record = repository('messages').get(ctx.params.id);
    if (!record) return notFound(ctx, `No message ${ctx.params.id}.`);
    return { status: 200, body: messageView(record) };
  });

  return {
    system: EMAIL_SYSTEM,
    basePath: EMAIL_BASE_PATH,
    description: 'Email relay test double: accept, bounce, suppress and timeout behaviour for notification delivery.',
    schemaMajor: SCHEMA_MAJOR,
    targetSystemAliases: ['EMAIL_RELAY', 'EMAIL', 'SMTP'],
    requiresBook: false,
    allowedScenarios: ALLOWED_SCENARIOS,
    magicScenarios: MAGIC_SCENARIOS,
    scenarioRefs,
    router,
    state,
  };
}
