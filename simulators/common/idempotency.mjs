import { canonicalJson, sha256Hex } from './canonical.mjs';
import { CODES, CATEGORY, SimProblem, problem } from './problem.mjs';

/** In-memory idempotency registry scoped by resource collection. */
export class IdempotencyStore {
  constructor() {
    this.entries = new Map();
  }

  static compositeKey(scope, key) {
    return `${scope}\u0000${key}`;
  }

  get(scope, key) {
    return this.entries.get(IdempotencyStore.compositeKey(scope, key));
  }

  put(scope, key, entry) {
    this.entries.set(IdempotencyStore.compositeKey(scope, key), entry);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Execute a write exactly once per idempotency key.
 *
 * A replay returns the stored status and body with Idempotent-Replayed: true.
 * Reusing a key with a different payload returns 409 CONFLICT. Transient
 * failures (5xx and 429) are never stored, so a retry can succeed.
 * Scenario "duplicate" requires an existing record and replays it.
 */
export async function withIdempotency(ctx, resource, compute) {
  if (!ctx.idempotencyKey) {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.IDEMPOTENCY_KEY_REQUIRED,
        title: 'Idempotency-Key required',
        detail: 'Every write requires an idempotency key.',
        instance: ctx.path,
        retryable: false,
        correlationId: ctx.correlationId,
      }),
    );
  }

  const scope = `${ctx.system}:${ctx.basePath}:${resource}`;
  const fingerprint = sha256Hex(canonicalJson(ctx.payload));
  const prior = ctx.state.idempotency.get(scope, ctx.idempotencyKey);

  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      throw new SimProblem(
        problem({
          status: 409,
          category: CATEGORY.CONFLICT,
          code: CODES.IDEMPOTENCY_CONFLICT,
          title: 'Idempotency key reused with a different payload',
          detail: 'The same idempotency key was already processed with different content. Use a new key for a changed hand-off (SPEC §7.18.3 HAND-02).',
          instance: ctx.path,
          retryable: false,
          meta: { originalRequestId: prior.requestId, resource },
          correlationId: ctx.correlationId,
        }),
      );
    }
    return replayResponse(prior, ctx);
  }

  if (ctx.scenario === 'duplicate') {
    throw new SimProblem(
      problem({
        status: 404,
        category: CATEGORY.NOT_FOUND,
        code: CODES.NO_PRIOR_MESSAGE,
        title: 'No prior message to replay',
        detail: 'The duplicate scenario replays an existing idempotency record; none exists for this key.',
        instance: ctx.path,
        retryable: false,
        meta: { idempotencyKey: ctx.idempotencyKey, resource },
        correlationId: ctx.correlationId,
      }),
    );
  }

  const response = await compute();
  if (response.status < 500 && response.status !== 429) {
    ctx.state.idempotency.put(scope, ctx.idempotencyKey, {
      fingerprint,
      status: response.status,
      body: response.body,
      contentType: response.contentType,
      requestId: ctx.requestId,
      createdAt: response.body?.receivedAt ?? response.body?.postedAt ?? response.body?.createdAt ?? null,
    });
  }
  return response;
}

function replayResponse(prior, ctx) {
  ctx.idempotencyReplay = true;
  return {
    status: prior.status,
    body: prior.body,
    contentType: prior.contentType,
    headers: {
      'idempotent-replayed': 'true',
      'x-sim-duplicate': 'true',
      'x-sim-original-request-id': prior.requestId,
    },
  };
}
