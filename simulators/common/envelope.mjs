import { sha256Hex, canonicalJson } from './canonical.mjs';
import { headerValue } from './headers.mjs';
import { CODES, CATEGORY, SimProblem, problem } from './problem.mjs';
import { Validator, isPlainObject } from './validate.mjs';

/** Fields defined by the integration envelope in SPEC §7.23.2. */
export const ENVELOPE_FIELDS = Object.freeze([
  'messageId',
  'idempotencyKey',
  'correlationId',
  'causationId',
  'tenantId',
  'businessBook',
  'sourceSystem',
  'targetSystem',
  'schemaVersion',
  'createdAt',
  'payloadHash',
  'signature',
]);

const TRANSPORT_FIELDS = new Set([...ENVELOPE_FIELDS, 'simulation']);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Split a request body into envelope fields and business payload. */
export function splitEnvelope(body) {
  const envelope = {};
  const payload = {};
  for (const [key, value] of Object.entries(body)) {
    if (TRANSPORT_FIELDS.has(key)) envelope[key] = value;
    else payload[key] = value;
  }
  return { envelope, payload };
}

/** SHA-256 of the canonical business payload, excluding envelope fields. */
export function payloadHashOf(payload) {
  return sha256Hex(canonicalJson(payload));
}

function validationFailure(ctx, errors, title = 'Request validation failed') {
  return new SimProblem(
    problem({
      status: 400,
      category: CATEGORY.VALIDATION,
      code: CODES.VALIDATION,
      title,
      detail: 'The request envelope or payload is invalid. Correct it and resend; retrying unchanged will fail again.',
      instance: ctx.path,
      errors,
      correlationId: ctx.correlationId,
    }),
  );
}

/**
 * Validate the SPEC §7.23.2 message envelope on a write request, enforce the
 * idempotency key, verify payloadHash when supplied, and return payload plus
 * routing metadata.
 */
export function validateEnvelope({ body, headers, method, path, app }) {
  const ctx = { path };
  if (!isPlainObject(body)) {
    throw validationFailure(ctx, [{ field: '$', code: 'TYPE', message: 'request body must be a JSON object' }], 'Malformed request body');
  }

  const headerCorrelationId = headerValue(headers, 'x-correlation-id');
  const { envelope, payload } = splitEnvelope(body);
  const validator = new Validator();

  validator.string(envelope.messageId, 'messageId', { max: 128 });
  validator.string(envelope.tenantId, 'tenantId', { max: 64 });
  validator.string(envelope.sourceSystem, 'sourceSystem', { max: 64 });
  const targetSystem = validator.string(envelope.targetSystem, 'targetSystem', { max: 64 });
  validator.string(envelope.schemaVersion, 'schemaVersion', { max: 16, pattern: /^\d+\.\d+\.\d+$/ });
  validator.timestamp(envelope.createdAt, 'createdAt');
  validator.string(headerCorrelationId ?? envelope.correlationId, 'correlationId', { required: false, max: 128 });

  if (app.requiresBook) {
    validator.string(envelope.businessBook, 'businessBook', { enumValues: ['DIRECT', 'ASSUMED'] });
  } else if (envelope.businessBook !== undefined) {
    validator.string(envelope.businessBook, 'businessBook', { enumValues: ['DIRECT', 'ASSUMED'] });
  }

  const suppliedHeaderKey = headerValue(headers, 'idempotency-key');
  validator.string(suppliedHeaderKey ?? envelope.idempotencyKey, 'idempotencyKey', {
    required: false,
    max: 128,
    pattern: IDEMPOTENCY_KEY_PATTERN,
  });

  if (envelope.payloadHash !== undefined) {
    validator.string(envelope.payloadHash, 'payloadHash', { pattern: /^[a-f0-9]{64}$/ });
  }

  if (!validator.valid) throw validationFailure(ctx, validator.errors);

  if (targetSystem && !app.targetSystemAliases.map((alias) => alias.toUpperCase()).includes(targetSystem.toUpperCase())) {
    throw validationFailure(
      ctx,
      [{ field: 'targetSystem', code: 'TARGET_SYSTEM', message: `must address ${app.system} (accepted: ${app.targetSystemAliases.join(', ')})` }],
      'Envelope addresses the wrong system',
    );
  }

  const major = Number(envelope.schemaVersion.split('.')[0]);
  if (major !== app.schemaMajor) {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.UNSUPPORTED_SCHEMA_VERSION,
        title: 'Unsupported schema version',
        detail: `Simulator ${app.system} implements schema ${app.schemaMajor}.x; received ${envelope.schemaVersion}.`,
        instance: path,
        retryable: false,
        errors: [{ field: 'schemaVersion', code: 'UNSUPPORTED_SCHEMA_VERSION', message: `major version ${major} is not implemented` }],
        meta: { supportedMajor: app.schemaMajor, received: envelope.schemaVersion },
        correlationId: headerCorrelationId ?? envelope.correlationId ?? null,
      }),
    );
  }

  const idempotencyKey = suppliedHeaderKey ?? envelope.idempotencyKey;
  if (!idempotencyKey) {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.IDEMPOTENCY_KEY_REQUIRED,
        title: 'Idempotency-Key required',
        detail: 'Every write carries a stable idempotency key in the Idempotency-Key header or the envelope idempotencyKey field (SPEC §7.23.3 INT-01).',
        instance: path,
        retryable: false,
        errors: [{ field: 'Idempotency-Key', code: 'REQUIRED', message: 'header or envelope idempotencyKey is required' }],
        correlationId: headerCorrelationId ?? envelope.correlationId ?? null,
      }),
    );
  }

  const computedHash = payloadHashOf(payload);
  if (envelope.payloadHash && envelope.payloadHash !== computedHash) {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.PAYLOAD_HASH_MISMATCH,
        title: 'Payload hash mismatch',
        detail: 'payloadHash is the SHA-256 of the canonical business payload with envelope fields removed.',
        instance: path,
        retryable: false,
        errors: [{ field: 'payloadHash', code: 'PAYLOAD_HASH_MISMATCH', message: 'does not match the supplied payload' }],
        meta: { expected: computedHash, received: envelope.payloadHash },
        correlationId: headerCorrelationId ?? envelope.correlationId ?? null,
      }),
    );
  }

  const correlationId =
    headerCorrelationId ??
    envelope.correlationId ??
    `corr-${sha256Hex(`${app.system}:${method}:${path}:${idempotencyKey}`).slice(0, 16)}`;

  return {
    envelope,
    payload,
    idempotencyKey,
    correlationId,
    payloadHash: computedHash,
  };
}
