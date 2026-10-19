import { nowIso } from './clock.mjs';
import { IdempotencyStore } from './idempotency.mjs';

/** Monotonic counters used for deterministic identifiers. */
export class Counters {
  constructor() {
    this.values = new Map();
  }

  next(name) {
    const current = this.values.get(name) ?? 0;
    const next = current + 1;
    this.values.set(name, next);
    return next;
  }

  clear() {
    this.values.clear();
  }
}

/** Ordered record collection with a unique business identifier. */
export class Repository {
  constructor(name) {
    this.name = name;
    this.items = [];
    this.index = new Map();
  }

  add(id, item) {
    if (typeof id !== 'string' || id.length === 0) throw new Error(`repository ${this.name} requires a string id`);
    if (this.index.has(id)) throw new Error(`repository ${this.name} already contains ${id}`);
    this.items.push(item);
    this.index.set(id, item);
    return item;
  }

  get(id) {
    return this.index.get(id);
  }

  has(id) {
    return this.index.has(id);
  }

  find(predicate) {
    return this.items.find(predicate);
  }

  filter(predicate) {
    return this.items.filter(predicate);
  }

  all() {
    return [...this.items];
  }

  get size() {
    return this.items.length;
  }

  clear() {
    this.items = [];
    this.index.clear();
  }
}

/**
 * State container shared by a simulator's route handlers and admin endpoints.
 * Every piece of mutable state is reset by POST {basePath}/admin/reset.
 */
export function createState({ system, collections = [] }) {
  const state = {
    system,
    startedAt: nowIso(),
    defaultScenario: null,
    totalRequests: 0,
    counters: new Counters(),
    idempotency: new IdempotencyStore(),
    requests: [],
    securityEvents: [],
    repos: {},
  };

  for (const name of collections) state.repos[name] = new Repository(name);

  state.repo = (name) => {
    state.repos[name] ??= new Repository(name);
    return state.repos[name];
  };

  state.nextId = (prefix, { width = 6 } = {}) => `${prefix}-${String(state.counters.next(prefix)).padStart(width, '0')}`;

  state.recordRequest = (entry) => {
    state.totalRequests += 1;
    state.requests.push({ ...entry, sequence: state.totalRequests });
    if (state.requests.length > 100) state.requests.shift();
  };

  state.recordSecurityEvent = (event) => {
    state.securityEvents.push({ ...event, detectedAt: nowIso() });
    if (state.securityEvents.length > 50) state.securityEvents.shift();
  };

  state.counts = () => {
    const counts = {};
    for (const [name, repository] of Object.entries(state.repos)) counts[name] = repository.size;
    counts.idempotencyKeys = state.idempotency.size;
    counts.securityEvents = state.securityEvents.length;
    return counts;
  };

  state.reset = () => {
    state.defaultScenario = null;
    state.totalRequests = 0;
    state.counters.clear();
    state.idempotency.clear();
    state.requests = [];
    state.securityEvents = [];
    for (const repository of Object.values(state.repos)) repository.clear();
  };

  return state;
}
