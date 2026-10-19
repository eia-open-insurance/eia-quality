#!/usr/bin/env node
/**
 * Stdlib-only test runner for the simulator smoke suites.
 *
 *   node simulators/run-tests.mjs            # every simulator
 *   node simulators/run-tests.mjs fsri       # one simulator (substring filter)
 *
 * It shells out to Node's built-in test runner; no package manager or
 * dependency is required.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const filter = process.argv[2]?.toLowerCase();

const systems = readdirSync(here, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !['common', 'fixtures'].includes(name))
  .sort();

const files = [];
for (const system of systems) {
  if (filter && !system.includes(filter)) continue;
  const testDirectory = path.join(here, system, 'test');
  let entries = [];
  try {
    entries = readdirSync(testDirectory);
  } catch {
    continue;
  }
  for (const entry of entries.sort()) {
    if (entry.endsWith('.test.mjs')) files.push(path.join(testDirectory, entry));
  }
}

if (files.length === 0) {
  console.error(`[simulators] no smoke tests found${filter ? ` for filter "${filter}"` : ''}`);
  process.exit(1);
}

console.log(`[simulators] running ${files.length} smoke test file(s) from ${path.relative(repoRoot, here)}`);
for (const file of files) console.log(`[simulators]   ${path.relative(repoRoot, file)}`);

const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', ...files],
  { cwd: repoRoot, stdio: 'inherit' },
);

if (result.error) {
  console.error('[simulators] failed to start the test runner', result.error);
  process.exit(1);
}

console.log('');
console.log(`[simulators] smoke test run finished with exit code ${result.status ?? 1}`);
process.exit(result.status ?? 1);
