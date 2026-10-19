/** Read a header value from Node's IncomingHttpHeaders object. */
export function headerValue(headers, name) {
  if (!headers) return undefined;
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0];
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

/** Send a header map to lower case, dropping undefined values. */
export function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) out[key.toLowerCase()] = String(value);
  }
  return out;
}
