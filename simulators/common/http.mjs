import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { nowIso } from './clock.mjs';

const DEFAULT_LIMIT_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
    this.limit = limit;
  }
}

/** Read the raw request body with a hard limit (SPEC §7.6: max 1 MB JSON). */
export function readRawBody(req, limit = DEFAULT_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLargeError(limit));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}

/** Create a Node HTTP server from an async handler. */
export function createHttpServer(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'Handler failure', status: 500 }));
      } else if (!res.writableEnded) {
        res.end();
      }
      console.error('[simulator] unhandled handler error', error);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

/** Send a transport wrapper: JSON body, raw body, or empty. */
export function sendResponse(res, response) {
  if (res.writableEnded || res.destroyed) return;
  const { status = 200, body, raw, contentType, headers = {} } = response ?? {};
  const outHeaders = { ...headers };
  if (raw !== undefined) {
    outHeaders['content-type'] ??= contentType ?? 'application/octet-stream';
    outHeaders['content-length'] = Buffer.byteLength(raw);
    res.writeHead(status, outHeaders);
    if (res.req?.method === 'HEAD') res.end();
    else res.end(raw);
    return;
  }
  if (body === undefined) {
    res.writeHead(status, outHeaders);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  outHeaders['content-type'] ??= contentType ?? 'application/json; charset=utf-8';
  outHeaders['content-length'] = Buffer.byteLength(text);
  res.writeHead(status, outHeaders);
  if (res.req?.method === 'HEAD') res.end();
  else res.end(text);
}

/** JSON response convenience. */
export function jsonResponse(status, body, headers = {}) {
  return { status, body, headers };
}

/** Start a server on a port and resolve with the bound address. */
export function listen(server, { port = 0, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Close a server and resolve once all connections are closed. */
export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Monotonic duration in milliseconds, used only for server logs. */
export function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

/** Fixed startup log line (no wall-clock timestamp, so output is reproducible). */
export function logLine(event, fields = {}) {
  console.log(JSON.stringify({ event, clock: nowIso(), ...fields }));
}
