import { headerValue } from './headers.mjs';
import { CODES, CATEGORY, SimProblem, problem } from './problem.mjs';

/** Scenarios every write-capable simulator understands. */
export const COMMON_SCENARIOS = Object.freeze([
  'accept',
  'reject',
  'partial',
  'timeout',
  'malformed',
  'unavailable',
  'throttled',
  'duplicate',
]);

const TRANSIENT_SCENARIOS = new Set(['timeout', 'unavailable', 'throttled']);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timeoutMilliseconds(headers) {
  const headerOverride = Number(headerValue(headers, 'x-sim-delay-ms'));
  const configured = Number(process.env.SIM_TIMEOUT_MS ?? 1500);
  const chosen = Number.isFinite(headerOverride) && headerOverride >= 0 ? headerOverride : configured;
  return Math.max(0, Math.min(30_000, Number.isFinite(chosen) ? chosen : 1500));
}

/** Case-insensitive check for a scenario magic suffix in business references. */
export function matchMagicScenario(refs, magic = []) {
  const values = refs.filter((value) => typeof value === 'string').map((value) => value.toUpperCase());
  for (const rule of magic) {
    const suffix = rule.suffix.toUpperCase();
    if (values.some((value) => value.endsWith(suffix))) return rule.scenario;
  }
  return null;
}

/**
 * Resolve the effective scenario.
 *
 * Priority (highest first): X-Sim-Scenario header, body simulation.scenario,
 * admin default, magic suffix in a business reference, accept.
 */
export function resolveScenario({ headers, body, state, app, refs = [] }) {
  let scenario = 'accept';
  let source = 'default';

  const headerScenario = headerValue(headers, 'x-sim-scenario');
  const bodyScenario = body?.simulation?.scenario;
  if (headerScenario) {
    scenario = headerScenario;
    source = 'header';
  } else if (bodyScenario) {
    scenario = bodyScenario;
    source = 'body';
  } else if (state?.defaultScenario) {
    scenario = state.defaultScenario;
    source = 'admin';
  } else {
    const magic = matchMagicScenario(refs, app.magicScenarios);
    if (magic) {
      scenario = magic;
      source = 'magic';
    }
  }

  scenario = String(scenario).trim().toLowerCase();
  if (!app.allowedScenarios.includes(scenario)) {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.UNKNOWN_SCENARIO,
        title: 'Unknown simulation scenario',
        detail: `Scenario "${scenario}" is not implemented by the ${app.system} simulator.`,
        instance: undefined,
        retryable: false,
        meta: { scenario, source, allowed: app.allowedScenarios },
      }),
    );
  }
  return { scenario, source };
}

/** Restrict a handler to the scenarios it implements. */
export function assertScenario(ctx, supported) {
  if (ctx.scenario === 'accept' || ctx.scenario === 'duplicate') return;
  if (!supported.includes(ctx.scenario)) {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.UNSUPPORTED_SCENARIO,
        title: 'Scenario not supported by this endpoint',
        detail: `Scenario "${ctx.scenario}" is not defined for ${ctx.method} ${ctx.path}.`,
        instance: ctx.path,
        retryable: false,
        meta: { scenario: ctx.scenario, supported: ['accept', ...supported] },
        correlationId: ctx.correlationId,
      }),
    );
  }
}

/**
 * Apply the transport-level deterministic fault scenarios. Returns a response
 * for timeout, unavailable, throttled, or malformed; otherwise null.
 */
export async function transientResponse(ctx) {
  switch (ctx.scenario) {
    case 'timeout': {
      const milliseconds = timeoutMilliseconds(ctx.headers);
      await delay(milliseconds);
      return problem({
        status: 504,
        category: CATEGORY.TIMEOUT,
        code: CODES.TIMEOUT,
        title: 'Simulated timeout',
        detail: `The ${ctx.system} simulator deliberately did not respond within ${milliseconds} ms. Retry with backoff; the request was not recorded.`,
        instance: ctx.path,
        retryable: true,
        meta: { simulatedDelayMs: milliseconds },
        correlationId: ctx.correlationId,
      });
    }
    case 'unavailable':
      return problem({
        status: 503,
        category: CATEGORY.UNAVAILABLE,
        code: CODES.UNAVAILABLE,
        title: 'Simulated provider outage',
        detail: `The ${ctx.system} simulator is unavailable by scenario. Queue the request and retry with backoff; nothing was recorded.`,
        instance: ctx.path,
        retryable: true,
        headers: { 'retry-after': '5' },
        correlationId: ctx.correlationId,
      });
    case 'throttled':
      return problem({
        status: 429,
        category: CATEGORY.THROTTLED,
        code: CODES.THROTTLED,
        title: 'Simulated rate limit',
        detail: 'Reduce the request rate and retry with backoff.',
        instance: ctx.path,
        retryable: true,
        headers: { 'retry-after': '1', 'ratelimit-limit': '1', 'ratelimit-remaining': '0', 'ratelimit-reset': '1' },
        correlationId: ctx.correlationId,
      });
    case 'malformed':
      return problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.MALFORMED_PAYLOAD,
        title: 'Simulated malformed message',
        detail: 'The simulator rejects this message as structurally malformed, as a provider would for an unparseable payload.',
        instance: ctx.path,
        retryable: false,
        meta: { expectedEnvelope: 'SPEC §7.23.2' },
        correlationId: ctx.correlationId,
      });
    default:
      return null;
  }
}

export function isTransientScenario(scenario) {
  return TRANSIENT_SCENARIOS.has(scenario);
}
