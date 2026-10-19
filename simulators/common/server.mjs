import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { clockInfo, nowIso } from './clock.mjs';
import { sha256Hex } from './canonical.mjs';
import { headerValue } from './headers.mjs';
import { assertTestOnly, TEST_DOUBLE_NOTICE } from './guard.mjs';
import {
  BodyTooLargeError,
  closeServer,
  createHttpServer,
  listen,
  logLine,
  readRawBody,
  sendResponse,
} from './http.mjs';
import { CATEGORY, CODES, SimProblem, problem, toProblem } from './problem.mjs';
import { resolveScenario, transientResponse } from './scenarios.mjs';
import { isPlainObject, ValidationError } from './validate.mjs';
import { validateEnvelope } from './envelope.mjs';

export const SIMULATOR_VERSION = '1.0.0';

const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]*\+)?json(?:\s*;|$)/i;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizePath(pathname) {
  if (!pathname) return '/';
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function prepareEntries(apps) {
  return apps.map((entry) => {
    const app = entry.app ?? entry;
    if (!app.system || !app.basePath || !app.router) {
      throw new Error('each simulator app needs system, basePath and router');
    }
    const openapiText = entry.openapiFile ? readFileSync(entry.openapiFile, 'utf8') : (entry.openapiText ?? null);
    return { app, openapiText };
  });
}

function authorizeRequest(req, rawBody, { isWrite, isAdmin, path: requestPath }) {
  if (req.method === 'OPTIONS') return;

  const token = process.env.SIM_AUTH_TOKEN;
  if (token) {
    const authorization = headerValue(req.headers, 'authorization') ?? '';
    if (!safeEqual(authorization, `Bearer ${token}`)) {
      throw new SimProblem(
        problem({
          status: 401,
          category: CATEGORY.AUTHENTICATION,
          code: CODES.AUTHENTICATION,
          title: 'Simulator authentication required',
          detail: 'SIM_AUTH_TOKEN is configured; send Authorization: Bearer <token>.',
          instance: requestPath,
          retryable: false,
          headers: { 'www-authenticate': 'Bearer realm="eia-simulator"' },
        }),
      );
    }
  }

  const secret = process.env.SIM_HMAC_SECRET;
  if (secret && isWrite && !isAdmin) {
    const supplied = headerValue(req.headers, 'x-eia-signature');
    const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
    const expected = `sha256=${digest}`;
    const normalized = supplied ? (supplied.startsWith('sha256=') ? supplied : `sha256=${supplied}`) : '';
    if (!safeEqual(normalized, expected)) {
      throw new SimProblem(
        problem({
          status: 401,
          category: CATEGORY.AUTHENTICATION,
          code: CODES.AUTHENTICATION,
          title: 'Invalid message signature',
          detail: 'SIM_HMAC_SECRET is configured; x-eia-signature must be the HMAC-SHA256 of the raw request body.',
          instance: requestPath,
          retryable: false,
        }),
      );
    }
  }
}

function parseJsonObject(rawBody, headers, requestPath) {
  if (rawBody.length === 0) {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.VALIDATION,
        title: 'Request body required',
        detail: 'Write requests require a JSON object carrying the message envelope and business payload.',
        instance: requestPath,
        retryable: false,
        errors: [{ field: '$', code: 'REQUIRED', message: 'request body is required' }],
      }),
    );
  }
  const contentType = headerValue(headers, 'content-type');
  if (contentType && !JSON_CONTENT_TYPE.test(contentType)) {
    throw new SimProblem(
      problem({
        status: 415,
        category: CATEGORY.UNSUPPORTED_MEDIA_TYPE,
        code: CODES.UNSUPPORTED_MEDIA_TYPE,
        title: 'Unsupported media type',
        detail: 'Simulator writes accept application/json only.',
        instance: requestPath,
        retryable: false,
        meta: { received: contentType },
      }),
    );
  }
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.MALFORMED_JSON,
        title: 'Malformed JSON',
        detail: 'The request body is not valid JSON.',
        instance: requestPath,
        retryable: false,
        errors: [{ field: '$', code: 'MALFORMED_JSON', message: 'body is not valid JSON' }],
      }),
    );
  }
  if (!isPlainObject(body)) {
    throw new SimProblem(
      problem({
        status: 400,
        category: CATEGORY.VALIDATION,
        code: CODES.VALIDATION,
        title: 'Request body must be an object',
        detail: 'The message envelope and payload must be a JSON object.',
        instance: requestPath,
        retryable: false,
        errors: [{ field: '$', code: 'TYPE', message: 'body must be a JSON object' }],
      }),
    );
  }
  return body;
}

function decorate(response, ctx, isWrite) {
  const headers = { ...(response.headers ?? {}) };
  headers['x-sim-system'] ??= ctx.system;
  headers['x-sim-mode'] = 'TEST_DOUBLE';
  headers['x-sim-scenario'] = ctx.scenario;
  headers['x-sim-scenario-source'] = ctx.scenarioSource;
  headers['x-sim-request-id'] = ctx.requestId;
  headers['cache-control'] = 'no-store';
  if (ctx.correlationId) headers['x-correlation-id'] ??= ctx.correlationId;
  if (isWrite) headers['idempotent-replayed'] ??= ctx.idempotencyReplay ? 'true' : 'false';
  return { ...response, headers };
}

function discovery(singleEntry, entries, title, version) {
  return {
    service: title,
    testDouble: true,
    version,
    warning: TEST_DOUBLE_NOTICE,
    clock: clockInfo(),
    simulators: entries.map(({ app }) => ({
      system: app.system,
      description: app.description ?? null,
      basePath: app.basePath,
      schemaMajor: app.schemaMajor,
      health: `/sim/${app.system}/health`,
      openapi: `/sim/${app.system}/openapi.yaml`,
      scenarios: app.allowedScenarios,
    })),
    primary: singleEntry ? singleEntry.app.basePath : null,
  };
}

function healthFor(app, version) {
  return {
    status: 'UP',
    simulator: app.system,
    description: app.description ?? null,
    testDouble: true,
    version,
    clock: clockInfo(),
    startedAt: app.state.startedAt,
    basePath: app.basePath,
    schemaMajor: app.schemaMajor,
    scenarios: app.allowedScenarios,
    records: app.state.counts(),
    endpoints: {
      health: `/sim/${app.system}/health`,
      openapi: `/sim/${app.system}/openapi.yaml`,
      base: app.basePath,
    },
  };
}

/**
 * Build an HTTP server hosting one or more simulator apps.
 *
 * Every app owns its namespace (`/sim/{system}/v1`). The aggregate server
 * mounts all six, mirroring the single-service endpoint in SPEC §15.3.
 */
export function createSimulatorServer({ apps, title = 'EIA external-system simulators', host = '127.0.0.1', defaultPort = 8080, version = SIMULATOR_VERSION }) {
  assertTestOnly();
  if (!Array.isArray(apps) || apps.length === 0) throw new Error('createSimulatorServer requires at least one simulator app');
  const entries = prepareEntries(apps);
  const bySystem = new Map(entries.map((entry) => [entry.app.system, entry]));
  let sequence = 0;

  const server = createHttpServer(async (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'simulator.invalid'}`);
    const requestPath = normalizePath(url.pathname);
    sequence += 1;
    const requestId = `sim-${sha256Hex(`${entries.map((entry) => entry.app.system).join('+')}:${sequence}:${method}:${requestPath}`).slice(0, 12)}`;
    const ctx = {
      system: entries.length === 1 ? entries[0].app.system : 'simulators',
      app: null,
      state: null,
      basePath: null,
      method,
      path: requestPath,
      url,
      query: url.searchParams,
      headers: req.headers,
      requestId,
      correlationId: headerValue(req.headers, 'x-correlation-id') ?? null,
      scenario: 'accept',
      scenarioSource: 'default',
      requestSequence: sequence,
      now: nowIso(),
      isAdmin: false,
    };
    const isWrite = WRITE_METHODS.has(method);
    let response = null;
    let entry = null;

    try {
      if (method === 'GET' && requestPath === '/') {
        response = { status: 200, body: discovery(entries.length === 1 ? entries[0] : null, entries, title, version) };
      } else if (method === 'GET' && requestPath === '/health') {
        response = {
          status: 200,
          body: {
            status: 'UP',
            service: title,
            testDouble: true,
            version,
            clock: clockInfo(),
            simulators: entries.map(({ app }) => healthFor(app, version)),
          },
        };
      } else if (method === 'GET' && requestPath === '/sim') {
        response = { status: 200, body: discovery(entries.length === 1 ? entries[0] : null, entries, title, version) };
      } else {
        const healthMatch = /^\/sim\/([^/]+)\/health$/.exec(requestPath);
        const openapiMatch = /^\/sim\/([^/]+)\/openapi\.yaml$/.exec(requestPath);
        if (method === 'GET' && healthMatch) {
          entry = bySystem.get(healthMatch[1]) ?? null;
          if (!entry) {
            response = problem({
              status: 404,
              category: CATEGORY.NOT_FOUND,
              code: CODES.NOT_FOUND,
              title: 'Unknown simulator',
              detail: `No simulator is mounted for "${healthMatch[1]}".`,
              instance: requestPath,
              retryable: false,
              meta: { available: entries.map(({ app }) => app.system) },
            });
          } else {
            ctx.system = entry.app.system;
            response = { status: 200, body: healthFor(entry.app, version) };
          }
        } else if (method === 'GET' && openapiMatch) {
          entry = bySystem.get(openapiMatch[1]) ?? null;
          if (!entry || !entry.openapiText) {
            response = problem({
              status: 404,
              category: CATEGORY.NOT_FOUND,
              code: CODES.NOT_FOUND,
              title: 'OpenAPI document not found',
              detail: `No OpenAPI document is published for simulator "${openapiMatch[1]}".`,
              instance: requestPath,
              retryable: false,
              meta: { available: entries.map(({ app }) => app.system) },
            });
          } else {
            ctx.system = entry.app.system;
            response = { status: 200, raw: entry.openapiText, contentType: 'application/yaml; charset=utf-8' };
          }
        } else {
          entry = entries.find(({ app }) => requestPath === app.basePath || requestPath.startsWith(`${app.basePath}/`)) ?? null;
          if (!entry) {
            response = problem({
              status: 404,
              category: CATEGORY.NOT_FOUND,
              code: CODES.NOT_FOUND,
              title: 'No route',
              detail: `Nothing is mounted at ${requestPath}.`,
              instance: requestPath,
              retryable: false,
              meta: { simulators: entries.map(({ app }) => ({ system: app.system, basePath: app.basePath })) },
            });
          } else {
            const app = entry.app;
            ctx.system = app.system;
            ctx.app = app;
            ctx.state = app.state;
            ctx.basePath = app.basePath;
            ctx.isAdmin = requestPath === `${app.basePath}/admin` || requestPath.startsWith(`${app.basePath}/admin/`);
            ctx.routePath = requestPath.slice(app.basePath.length) || '/';

            const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readRawBody(req);

            if (requestPath === app.basePath && method === 'GET') {
              response = {
                status: 200,
                body: {
                  system: app.system,
                  description: app.description ?? null,
                  basePath: app.basePath,
                  testDouble: true,
                  clock: clockInfo(),
                  scenarios: app.allowedScenarios,
                  endpoints: app.router.describe().map((route) => ({ ...route, path: `${app.basePath}${route.path}` })),
                },
              };
            } else if (requestPath === `${app.basePath}/admin` || requestPath.startsWith(`${app.basePath}/admin/`)) {
              if (String(process.env.SIM_ADMIN_ENABLED ?? 'true').toLowerCase() === 'false') {
                response = problem({
                  status: 404,
                  category: CATEGORY.NOT_FOUND,
                  code: CODES.NOT_FOUND,
                  title: 'Admin endpoints are disabled',
                  detail: 'SIM_ADMIN_ENABLED=false disables simulator control endpoints.',
                  instance: requestPath,
                  retryable: false,
                });
              } else {
                authorizeRequest(req, rawBody, { isWrite, isAdmin: true, path: requestPath });
                ctx.payload = isWrite && rawBody.length > 0 ? parseJsonObject(rawBody, req.headers, requestPath) : {};
                ctx.body = ctx.payload;
                const result = await app.router.dispatch(ctx);
                response = result.handled
                  ? result.response
                  : problem({
                      status: 404,
                      category: CATEGORY.NOT_FOUND,
                      code: CODES.NOT_FOUND,
                      title: 'No admin route',
                      detail: `Nothing is mounted at ${requestPath}.`,
                      instance: requestPath,
                      retryable: false,
                    });
              }
            } else {
              authorizeRequest(req, rawBody, { isWrite, isAdmin: false, path: requestPath });

              let body;
              if (isWrite) {
                body = parseJsonObject(rawBody, req.headers, requestPath);
                const validated = validateEnvelope({ body, headers: req.headers, method, path: requestPath, app });
                ctx.envelope = validated.envelope;
                ctx.payload = validated.payload;
                ctx.idempotencyKey = validated.idempotencyKey;
                ctx.correlationId = validated.correlationId;
                ctx.payloadHash = validated.payloadHash;
                const { scenario, source } = resolveScenario({
                  headers: req.headers,
                  body,
                  state: app.state,
                  app,
                  refs: app.scenarioRefs(validated.payload),
                });
                ctx.scenario = scenario;
                ctx.scenarioSource = source;
              } else {
                const refs = ['businessKey', 'businessReference', 'scenarioRef', 'reference']
                  .map((name) => url.searchParams.get(name))
                  .filter((value) => typeof value === 'string' && value.length > 0);
                const { scenario, source } = resolveScenario({
                  headers: req.headers,
                  body: undefined,
                  state: app.state,
                  app,
                  refs,
                });
                ctx.scenario = scenario;
                ctx.scenarioSource = source;
                ctx.payload = {};
              }

              const fault = await transientResponse(ctx);
              if (fault) {
                response = fault;
              } else {
                const result = await app.router.dispatch(ctx);
                if (result.handled) {
                  response = result.response;
                } else {
                  response = problem({
                    status: 404,
                    category: CATEGORY.NOT_FOUND,
                    code: CODES.NOT_FOUND,
                    title: 'No route',
                    detail: `Nothing is mounted at ${requestPath}.`,
                    instance: requestPath,
                    retryable: false,
                    meta: { method, basePath: app.basePath, endpoints: app.router.describe() },
                  });
                }
              }
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        response = problem({
          status: 413,
          category: CATEGORY.PAYLOAD_TOO_LARGE,
          code: CODES.PAYLOAD_TOO_LARGE,
          title: 'Payload too large',
          detail: `The simulator accepts request bodies up to ${error.limit} bytes.`,
          instance: requestPath,
          retryable: false,
          meta: { limitBytes: error.limit },
        });
      } else {
        if (!(error instanceof SimProblem) && !(error instanceof ValidationError)) {
          console.error(`[simulator] ${ctx.system} unexpected error on ${method} ${requestPath}`, error);
        }
        response = toProblem(error, ctx);
      }
    } finally {
      if (!response) {
        response = problem({
          status: 500,
          category: CATEGORY.INTERNAL,
          code: CODES.INTERNAL,
          title: 'Simulator internal error',
          detail: 'No response was produced for this request.',
          instance: requestPath,
          retryable: false,
        });
      }
      if (!ctx.correlationId) ctx.correlationId = headerValue(req.headers, 'x-correlation-id') ?? null;
      const decorated = decorate(response, ctx, isWrite && !ctx.isAdmin);
      sendResponse(res, decorated);
      if (ctx.app?.state) {
        ctx.app.state.recordRequest({
          requestId,
          method,
          path: requestPath,
          status: decorated.status,
          scenario: ctx.scenario,
          scenarioSource: ctx.scenarioSource,
          idempotencyKey: ctx.idempotencyKey ?? null,
          correlationId: ctx.correlationId,
          replayed: Boolean(ctx.idempotencyReplay),
        });
      }
      if (String(process.env.SIM_LOG_REQUESTS ?? '').toLowerCase() === 'true') {
        logLine('request', {
          simulator: ctx.system,
          method,
          path: requestPath,
          status: decorated.status,
          scenario: ctx.scenario,
          requestId,
        });
      }
    }
  });

  server.simulatorHost = host;
  server.simulatorDefaultPort = defaultPort;
  return server;
}

/** Start a simulator and print deterministic, copy-pasteable evidence. */
export async function startServer(server, { defaultPort = 8080, host = '127.0.0.1', system = 'simulators', paths = [], version = SIMULATOR_VERSION } = {}) {
  const configuredPort = process.env.PORT ?? process.env.SIM_PORT ?? String(defaultPort);
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT/SIM_PORT must be an integer between 0 and 65535, received "${configuredPort}"`);
  }
  const bindHost = process.env.HOST ?? host;
  const address = await listen(server, { port, host: bindHost });
  const displayHost = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
  console.log(`[simulator] ${TEST_DOUBLE_NOTICE}`);
  console.log(`[simulator] ${system} v${version} listening on http://${displayHost}:${address.port} (bound ${bindHost}:${address.port})`);
  for (const basePath of paths) console.log(`[simulator] base path http://${displayHost}:${address.port}${basePath}`);
  console.log(`[simulator] health   http://${displayHost}:${address.port}/health`);
  if (paths.length > 0) {
    for (const basePath of paths) {
      const systemName = basePath.split('/').filter(Boolean)[1];
      console.log(`[simulator] openapi  http://${displayHost}:${address.port}/sim/${systemName}/openapi.yaml`);
    }
  } else {
    console.log('[simulator] openapi  /sim/{system}/openapi.yaml');
  }
  installShutdown(server);
  return address;
}

let shuttingDown = false;

function installShutdown(server) {
  const stop = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[simulator] ${signal} received; closing`);
    await closeServer(server);
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

/** True when the module is the process entry point. */
export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry).toLowerCase() === fileURLToPath(metaUrl).toLowerCase();
}

/** Run a startup function only when the module is the entry point. */
export function runIfMain(metaUrl, start) {
  if (!isMainModule(metaUrl)) return;
  Promise.resolve()
    .then(start)
    .catch((error) => {
      console.error('[simulator] failed to start', error);
      process.exitCode = 1;
    });
}
