#!/usr/bin/env node
/**
 * Stdlib-only cross-simulator E2E smoke runner.
 *
 * Default: starts the aggregate simulator on an ephemeral port and runs every
 * journey against it.
 *
 * Against an existing stack:
 *   $env:EIA_SIM_BASE_URL = "http://127.0.0.1:8180"
 *   node e2e/run-smoke.mjs
 *
 * Per-system overrides: EIA_SIM_FSRI_URL, EIA_SIM_S4_URL, EIA_SIM_BANK_URL,
 * EIA_SIM_EMAIL_URL, EIA_SIM_OCR_URL, EIA_SIM_SANCTIONS_URL (full base path,
 * e.g. http://host:8181/sim/fsri/v1).
 */
import { createServer as createAggregateServer } from '../simulators/all/server.mjs';
import { startSimulator } from '../simulators/common/testkit.mjs';
import { resolveSimulatorUrls } from './fixtures/index.mjs';
import { runJourneys } from './smoke/journeys.mjs';

const externalConfigured = Boolean(
  process.env.EIA_SIM_BASE_URL ||
    process.env.EIA_SIM_FSRI_URL ||
    process.env.EIA_SIM_S4_URL ||
    process.env.EIA_SIM_BANK_URL ||
    process.env.EIA_SIM_EMAIL_URL ||
    process.env.EIA_SIM_OCR_URL ||
    process.env.EIA_SIM_SANCTIONS_URL,
);

let localSimulator;
let urls;

try {
  if (externalConfigured) {
    urls = resolveSimulatorUrls();
    console.log('[e2e] using externally configured simulators');
  } else {
    localSimulator = await startSimulator(createAggregateServer);
    urls = resolveSimulatorUrls(undefined, { ...process.env, EIA_SIM_BASE_URL: localSimulator.baseUrl });
    console.log(`[e2e] started aggregate simulator on ${localSimulator.baseUrl}`);
  }

  for (const [system, entry] of Object.entries(urls)) {
    console.log(`[e2e] ${system.padEnd(10)} ${entry.baseUrl}`);
  }

  const summary = await runJourneys({ urls });
  console.log(`[e2e] PASS all journeys (${summary.checks} checks, ${summary.systems.length} systems)`);
} catch (error) {
  console.error('[e2e] FAIL', error);
  process.exitCode = 1;
} finally {
  if (localSimulator) await localSimulator.close();
}
