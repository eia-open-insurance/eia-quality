import { CODES, CATEGORY, problem } from './problem.mjs';

/** Route table with params, method matching, OPTIONS and 405 handling. */
export function createRouter() {
  const routes = [];

  function register(method, pattern, handler) {
    routes.push({ method, pattern, segments: pattern.split('/').filter(Boolean), handler });
    return api;
  }

  function matchRoute(segments, pathSegments) {
    if (segments.length !== pathSegments.length) return null;
    const params = {};
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment.startsWith(':')) {
        try {
          params[segment.slice(1)] = decodeURIComponent(pathSegments[index]);
        } catch {
          return null;
        }
      } else if (segment !== pathSegments[index]) {
        return null;
      }
    }
    return params;
  }

  async function dispatch(ctx) {
    const dispatchPath = ctx.routePath ?? ctx.path;
    const pathSegments = dispatchPath.split('/').filter(Boolean);
    const candidates = [];
    for (const route of routes) {
      const params = matchRoute(route.segments, pathSegments);
      if (params) candidates.push({ route, params });
    }
    if (candidates.length === 0) return { handled: false };

    const allowed = [...new Set(candidates.map((candidate) => candidate.route.method))].sort();
    if (ctx.method === 'OPTIONS') {
      return { handled: true, response: { status: 204, headers: { allow: allowed.join(', ') } } };
    }
    const effectiveMethod = ctx.method === 'HEAD' ? 'GET' : ctx.method;
    const selected = candidates.find((candidate) => candidate.route.method === effectiveMethod);
    if (!selected) {
      return {
        handled: true,
        response: problem({
          status: 405,
          category: CATEGORY.METHOD_NOT_ALLOWED,
          code: CODES.METHOD_NOT_ALLOWED,
          title: 'Method not allowed',
          detail: `${ctx.method} is not supported for ${ctx.path}.`,
          instance: ctx.path,
          retryable: false,
          meta: { allowed },
          headers: { allow: allowed.join(', ') },
          correlationId: ctx.correlationId,
        }),
      };
    }
    ctx.params = selected.params;
    const response = await selected.route.handler(ctx);
    return { handled: true, response };
  }

  const api = {
    get: (pattern, handler) => register('GET', pattern, handler),
    post: (pattern, handler) => register('POST', pattern, handler),
    put: (pattern, handler) => register('PUT', pattern, handler),
    patch: (pattern, handler) => register('PATCH', pattern, handler),
    delete: (pattern, handler) => register('DELETE', pattern, handler),
    dispatch,
    describe: () => routes.map((route) => ({ method: route.method, path: route.pattern })),
  };
  return api;
}
