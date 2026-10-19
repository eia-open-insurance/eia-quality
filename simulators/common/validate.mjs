import { AmountError, moneyObject, parseAmountString, parseMoneyObject, parsePercentString } from './money.mjs';
import { isRfc3339, isValidDate } from './clock.mjs';

/** Field-level validation failure collected by Validator. */
export class ValidationError extends Error {
  constructor(errors) {
    super(`Validation failed: ${errors.map((error) => `${error.field} ${error.code}`).join(', ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a dotted path from an object. */
export function getPath(value, fieldPath) {
  return fieldPath.split('.').reduce((current, segment) => {
    if (current === null || current === undefined) return undefined;
    return current[segment];
  }, value);
}

/**
 * Collects every validation error instead of failing on the first one, matching
 * the Problem.errors[] shape in SPEC §12.2.
 */
export class Validator {
  constructor() {
    this.errors = [];
  }

  add(field, code, message) {
    this.errors.push({ field, code, message });
    return this;
  }

  get valid() {
    return this.errors.length === 0;
  }

  throwIfInvalid() {
    if (this.errors.length > 0) throw new ValidationError(this.errors);
    return this;
  }

  object(value, field = '$', { required = true } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'must be an object');
      return undefined;
    }
    if (!isPlainObject(value)) {
      this.add(field, 'TYPE', 'must be an object');
      return undefined;
    }
    return value;
  }

  string(value, field, { required = true, min = 1, max = 255, pattern, enumValues, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    if (typeof value !== 'string') {
      this.add(field, 'TYPE', 'must be a string');
      return undefined;
    }
    const text = value.trim();
    if (!allowEmpty && text.length === 0) {
      this.add(field, 'EMPTY', 'must not be empty');
      return undefined;
    }
    if (text.length < min) this.add(field, 'MIN_LENGTH', `must be at least ${min} characters`);
    if (text.length > max) this.add(field, 'MAX_LENGTH', `must be at most ${max} characters`);
    if (pattern && !pattern.test(text)) this.add(field, 'PATTERN', `must match ${pattern}`);
    if (enumValues && !enumValues.includes(text)) {
      this.add(field, 'ENUM', `must be one of ${enumValues.join(', ')}`);
    }
    return text;
  }

  boolean(value, field, { required = true } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    if (typeof value !== 'boolean') {
      this.add(field, 'TYPE', 'must be a boolean');
      return undefined;
    }
    return value;
  }

  integer(value, field, { required = true, min, max } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    if (!Number.isInteger(value)) {
      this.add(field, 'TYPE', 'must be an integer');
      return undefined;
    }
    if (min !== undefined && value < min) this.add(field, 'MIN', `must be at least ${min}`);
    if (max !== undefined && value > max) this.add(field, 'MAX', `must be at most ${max}`);
    return value;
  }

  date(value, field, { required = true } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    if (typeof value !== 'string' || !isValidDate(value)) {
      this.add(field, 'DATE', 'must be a calendar date in YYYY-MM-DD form');
      return undefined;
    }
    return value;
  }

  timestamp(value, field, { required = true } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    if (typeof value !== 'string' || !isRfc3339(value)) {
      this.add(field, 'TIMESTAMP', 'must be an RFC 3339 timestamp with an explicit offset');
      return undefined;
    }
    return value;
  }

  money(value, field, { required = true, positive = false, nonNegative = false, maxUnits } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    try {
      const parsed = parseMoneyObject(value);
      if (positive && parsed.units <= 0n) this.add(`${field}.amount`, 'POSITIVE', 'must be greater than zero');
      if (nonNegative && parsed.units < 0n) this.add(`${field}.amount`, 'NON_NEGATIVE', 'must not be negative');
      if (maxUnits !== undefined && parsed.units > maxUnits) this.add(`${field}.amount`, 'MAX', 'exceeds the permitted maximum');
      return parsed;
    } catch (error) {
      if (!(error instanceof AmountError)) throw error;
      this.add(field, 'MONEY', error.message);
      return undefined;
    }
  }

  amountString(value, field, { required = true, nonNegative = true } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    try {
      const units = parseAmountString(value);
      if (nonNegative && units < 0n) this.add(field, 'NON_NEGATIVE', 'must not be negative');
      return units;
    } catch (error) {
      if (!(error instanceof AmountError)) throw error;
      this.add(field, 'AMOUNT', error.message);
      return undefined;
    }
  }

  percent(value, field, { required = true, min = 0n, max = 1000000n } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    try {
      const units = parsePercentString(value);
      if (units < min) this.add(field, 'MIN', 'is below the permitted minimum');
      if (units > max) this.add(field, 'MAX', 'is above the permitted maximum');
      return units;
    } catch (error) {
      if (!(error instanceof AmountError)) throw error;
      this.add(field, 'PERCENT', error.message);
      return undefined;
    }
  }

  array(value, field, { required = true, min = 1, max = 1000 } = {}) {
    if (value === undefined || value === null) {
      if (required) this.add(field, 'REQUIRED', 'is required');
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.add(field, 'TYPE', 'must be an array');
      return undefined;
    }
    if (value.length < min) this.add(field, 'MIN_ITEMS', `must contain at least ${min} item(s)`);
    if (value.length > max) this.add(field, 'MAX_ITEMS', `must contain at most ${max} item(s)`);
    return value;
  }
}

/** Build a Money response object only when the parsed value is present. */
export function optionalMoney(validator, value, field) {
  const parsed = validator.money(value, field, { required: false });
  return parsed ? moneyObject(parsed.units, parsed.currency) : undefined;
}
