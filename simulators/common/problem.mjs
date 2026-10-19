import { ValidationError } from './validate.mjs';

/** Categories from the integration error taxonomy in SPEC §7.23.4. */
export const CATEGORY = Object.freeze({
  VALIDATION: 'VALIDATION',
  AUTHENTICATION: 'AUTHENTICATION',
  AUTHORIZATION: 'AUTHORIZATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  THROTTLED: 'THROTTLED',
  UNAVAILABLE: 'UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  PARTIAL: 'PARTIAL',
  BUSINESS_REJECT: 'BUSINESS_REJECT',
  DUPLICATE: 'DUPLICATE',
  INTERNAL: 'INTERNAL',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
});

const STATUS_FOR_CATEGORY = Object.freeze({
  VALIDATION: 400,
  AUTHENTICATION: 401,
  AUTHORIZATION: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  BUSINESS_REJECT: 422,
  THROTTLED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  TIMEOUT: 504,
  PARTIAL: 207,
  DUPLICATE: 200,
});

const RETRYABLE_BY_DEFAULT = new Set(['CONFLICT', 'THROTTLED', 'UNAVAILABLE', 'TIMEOUT', 'INTERNAL']);

/** Stable simulator error codes. */
export const CODES = Object.freeze({
  VALIDATION: 'EIA-SIM-VALIDATION',
  MALFORMED_JSON: 'EIA-SIM-MALFORMED-JSON',
  MALFORMED_PAYLOAD: 'EIA-SIM-MALFORMED-PAYLOAD',
  AUTHENTICATION: 'EIA-SIM-AUTHENTICATION',
  AUTHORIZATION: 'EIA-SIM-AUTHORIZATION',
  BOOK_WALL: 'EIA-SIM-BOOK-WALL',
  NOT_FOUND: 'EIA-SIM-NOT-FOUND',
  METHOD_NOT_ALLOWED: 'EIA-SIM-METHOD-NOT-ALLOWED',
  CONFLICT: 'EIA-SIM-CONFLICT',
  IDEMPOTENCY_KEY_REQUIRED: 'EIA-SIM-IDEMPOTENCY-KEY-REQUIRED',
  IDEMPOTENCY_CONFLICT: 'EIA-SIM-IDEMPOTENCY-CONFLICT',
  PAYLOAD_HASH_MISMATCH: 'EIA-SIM-PAYLOAD-HASH-MISMATCH',
  UNSUPPORTED_SCHEMA_VERSION: 'EIA-SIM-SCHEMA-VERSION',
  UNSUPPORTED_SCENARIO: 'EIA-SIM-SCENARIO-UNSUPPORTED',
  UNKNOWN_SCENARIO: 'EIA-SIM-SCENARIO-UNKNOWN',
  NO_PRIOR_MESSAGE: 'EIA-SIM-NO-PRIOR-MESSAGE',
  BUSINESS_REJECT: 'EIA-SIM-BUSINESS-REJECT',
  PARTIAL: 'EIA-SIM-PARTIAL',
  THROTTLED: 'EIA-SIM-THROTTLED',
  UNAVAILABLE: 'EIA-SIM-UNAVAILABLE',
  TIMEOUT: 'EIA-SIM-TIMEOUT',
  PAYLOAD_TOO_LARGE: 'EIA-SIM-PAYLOAD-TOO-LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'EIA-SIM-UNSUPPORTED-MEDIA-TYPE',
  INTERNAL: 'EIA-SIM-INTERNAL',
  CLOSED_PERIOD: 'EIA-SIM-CLOSED-PERIOD',
});

/**
 * Build a Problem response (SPEC §12.2). Returns the transport wrapper so
 * handlers can simply return it.
 */
export function problem({
  status,
  category = CATEGORY.VALIDATION,
  code = CODES.VALIDATION,
  title,
  detail = '',
  instance,
  retryable,
  errors = [],
  meta = {},
  correlationId = null,
  headers = {},
} = {}) {
  const resolvedStatus = status ?? STATUS_FOR_CATEGORY[category] ?? 500;
  return {
    status: resolvedStatus,
    contentType: 'application/problem+json',
    headers,
    body: {
      type: `https://errors.eia-open-insurance.example/simulator/${code.toLowerCase()}`,
      title: title ?? 'Simulator request failed',
      status: resolvedStatus,
      detail,
      instance: instance ?? null,
      code,
      category,
      retryable: retryable ?? RETRYABLE_BY_DEFAULT.has(category),
      correlationId,
      errors,
      meta,
    },
  };
}

/** Error carrying a complete Problem response. */
export class SimProblem extends Error {
  constructor(response) {
    super(response.body?.title ?? 'Simulator problem');
    this.name = 'SimProblem';
    this.response = response;
  }
}

/** Throw a Problem response. */
export function fail(spec) {
  throw new SimProblem(problem(spec));
}

/** Convert any thrown value into a Problem response, without leaking internals. */
export function toProblem(error, ctx = {}) {
  if (error instanceof SimProblem) return error.response;
  if (error instanceof ValidationError) {
    return problem({
      status: 400,
      category: CATEGORY.VALIDATION,
      code: CODES.VALIDATION,
      title: 'Request validation failed',
      detail: 'One or more fields are invalid. Correct the payload and resend; retrying unchanged will fail again.',
      instance: ctx.path,
      errors: error.errors,
      correlationId: ctx.correlationId ?? null,
    });
  }
  return problem({
    status: 500,
    category: CATEGORY.INTERNAL,
    code: CODES.INTERNAL,
    title: 'Simulator internal error',
    detail: 'The simulator failed unexpectedly. This is a defect in the test double, not a provider response.',
    instance: ctx.path,
    retryable: false,
    correlationId: ctx.correlationId ?? null,
  });
}
