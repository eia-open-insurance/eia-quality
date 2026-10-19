import { createHash } from 'node:crypto';

/** Recursively sort object keys so hashes do not depend on JSON ordering. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON text for a value. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 hex digest of a string or of canonical JSON for an object. */
export function sha256Hex(value) {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Deterministic UUID-shaped identifier derived from a seed. */
export function deterministicUuid(seed) {
  const hex = sha256Hex(String(seed));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
