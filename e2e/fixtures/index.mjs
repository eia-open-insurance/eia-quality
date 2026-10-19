import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHARED_FIXTURES = new URL('../../simulators/fixtures/', import.meta.url);

/** Load a fixture from the canonical simulators/fixtures directory. */
export function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, SHARED_FIXTURES), 'utf8'));
}

/** Deep clone so a test can mutate fixture data safely. */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Prepare a fixture with a specific idempotency key. */
export function withKey(value, key) {
  const copy = clone(value);
  copy.idempotencyKey = key;
  return copy;
}

/** Load the simulator routing configuration. */
export function loadSimulatorConfig() {
  return JSON.parse(readFileSync(new URL('./simulators.json', import.meta.url), 'utf8'));
}

/**
 * Resolve base URLs for every simulator.
 *
 * Priority: EIA_SIM_BASE_URL (aggregate) > per-system env > documented local
 * host ports. A per-system URL is the full base path, e.g.
 * http://127.0.0.1:8181/sim/fsri/v1.
 */
export function resolveSimulatorUrls(config = loadSimulatorConfig(), env = process.env) {
  const urls = {};
  const aggregateBase = env[config.aggregate.env];
  for (const [system, entry] of Object.entries(config.systems)) {
    let baseUrl;
    if (env[entry.env]) {
      baseUrl = env[entry.env];
    } else if (aggregateBase) {
      baseUrl = `${aggregateBase.replace(/\/$/, '')}${entry.basePath}`;
    } else {
      baseUrl = `http://${entry.defaultHost}:${entry.defaultPort}${entry.basePath}`;
    }
    urls[system] = {
      baseUrl,
      healthUrl: `${baseUrl.replace(/\/v1$/, '')}/health`,
      openapiUrl: `${baseUrl.replace(/\/v1$/, '')}/openapi.yaml`,
    };
  }
  return urls;
}
