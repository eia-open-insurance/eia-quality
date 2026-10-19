/**
 * Deterministic clock for every simulator.
 *
 * Test doubles must produce byte-identical responses for identical request
 * sequences. The clock is therefore fixed to a single instant unless
 * SIM_CLOCK=live is set explicitly.
 */

const DEFAULT_INSTANT = '2026-10-19T12:00:00.000Z';
const configured = process.env.SIM_CLOCK ?? DEFAULT_INSTANT;

if (configured !== 'live') {
  const parsed = new Date(configured);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`SIM_CLOCK must be "live" or an RFC 3339 timestamp, received "${configured}"`);
  }
}

/** Current instant as a Date. Fixed unless SIM_CLOCK=live. */
export function simulatorNow() {
  return configured === 'live' ? new Date() : new Date(configured);
}

/** Current instant as an RFC 3339 UTC timestamp with millisecond precision. */
export function nowIso() {
  return simulatorNow().toISOString();
}

/** Current business date as YYYY-MM-DD. */
export function todayIso() {
  return nowIso().slice(0, 10);
}

/** Fiscal period (YYYY-MM) for a date or timestamp. */
export function periodOf(dateOrTimestamp) {
  return String(dateOrTimestamp).slice(0, 7);
}

/** Add whole days to a YYYY-MM-DD date, in UTC. */
export function addDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** True when the value is a valid calendar date in YYYY-MM-DD form. */
export function isValidDate(dateIso) {
  if (typeof dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return false;
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateIso;
}

/** True when the value is an RFC 3339 timestamp with an explicit offset. */
export function isRfc3339(timestamp) {
  if (typeof timestamp !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return false;
  return !Number.isNaN(new Date(timestamp).getTime());
}

/** Clock descriptor exposed by health and admin endpoints. */
export function clockInfo() {
  return { mode: configured === 'live' ? 'live' : 'fixed', instant: nowIso() };
}
