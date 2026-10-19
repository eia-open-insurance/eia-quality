/**
 * Exact decimal money arithmetic for simulator test doubles.
 *
 * Amounts are decimal strings with up to four fraction digits (SPEC §12.2,
 * numeric(19,4)). Internally they are held as BigInt in units of 0.0001 so
 * that no floating point value ever reaches a response body. Displayed money
 * is rounded half-up to currency precision (two fraction digits).
 */

const AMOUNT_PATTERN = /^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/;
const PERCENT_PATTERN = /^(-?)(\d{1,3})(?:\.(\d{1,6}))?$/;

const SCALE = 4;
const SCALE_FACTOR = 10n ** BigInt(SCALE); // 10000n
const PERCENT_SCALE = 6;
const PERCENT_FACTOR = 10n ** BigInt(PERCENT_SCALE); // 1000000n
const CENTS_PER_UNIT = 100n;

export class AmountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AmountError';
  }
}

/** Divide two positive BigInts, rounding half-up, and restore the sign. */
function divideHalfUp(numerator, denominator) {
  if (denominator <= 0n) throw new AmountError('denominator must be positive');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (magnitude * 2n + denominator) / (2n * denominator);
  return negative ? -quotient : quotient;
}

/** Parse a decimal amount string into 0.0001 units. */
export function parseAmountString(value) {
  if (typeof value !== 'string') throw new AmountError('amount must be a decimal string, never a JSON number');
  const match = AMOUNT_PATTERN.exec(value);
  if (!match) throw new AmountError('amount must match -?d{1,15}(.d{1,4})?');
  const [, sign, whole, fraction = ''] = match;
  const paddedFraction = fraction.padEnd(SCALE, '0');
  const units = BigInt(whole) * SCALE_FACTOR + BigInt(paddedFraction || '0');
  return sign === '-' ? -units : units;
}

/** Parse a decimal fraction (Percent, six digits) into 0.000001 units. */
export function parsePercentString(value) {
  if (typeof value !== 'string') throw new AmountError('percent must be a decimal string');
  const match = PERCENT_PATTERN.exec(value);
  if (!match) throw new AmountError('percent must match -?d{1,3}(.d{1,6})?');
  const [, sign, whole, fraction = ''] = match;
  const paddedFraction = fraction.padEnd(PERCENT_SCALE, '0');
  const units = BigInt(whole) * PERCENT_FACTOR + BigInt(paddedFraction || '0');
  return sign === '-' ? -units : units;
}

/** Format 0.0001 units with the requested number of fraction digits (0-4). */
export function formatUnits(units, scale = SCALE) {
  if (!Number.isInteger(scale) || scale < 0 || scale > SCALE) {
    throw new AmountError(`scale must be an integer between 0 and ${SCALE}`);
  }
  const divisor = 10n ** BigInt(SCALE - scale);
  const rounded = divideHalfUp(units, divisor);
  const negative = rounded < 0n;
  const magnitude = negative ? -rounded : rounded;
  const digits = magnitude.toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Format 0.000001 units as a Percent string with six fraction digits. */
export function formatPercent(percentUnits) {
  const negative = percentUnits < 0n;
  const magnitude = negative ? -percentUnits : percentUnits;
  const digits = magnitude.toString().padStart(PERCENT_SCALE + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, digits.length - PERCENT_SCALE)}.${digits.slice(digits.length - PERCENT_SCALE)}`;
}

/** Round 0.0001 units to whole cents. */
export function roundToCents(units) {
  return divideHalfUp(units, CENTS_PER_UNIT) * CENTS_PER_UNIT;
}

/** Apply a Percent to a money amount, rounding half-up at cents. */
export function applyPercent(amountUnits, percentUnits) {
  const cents = divideHalfUp(amountUnits * percentUnits, PERCENT_FACTOR * CENTS_PER_UNIT);
  return cents * CENTS_PER_UNIT;
}

/** Convert cents to 0.0001 units. */
export function fromCents(cents) {
  return cents * CENTS_PER_UNIT;
}

/** Ratio expressed in 0.000001 units, or null when the denominator is zero. */
export function ratioPercentUnits(numeratorUnits, denominatorUnits) {
  if (denominatorUnits === 0n) return null;
  return divideHalfUp(numeratorUnits * PERCENT_FACTOR, denominatorUnits);
}

export function addUnits(...values) {
  return values.reduce((total, value) => total + value, 0n);
}

export function sumUnits(values) {
  return values.reduce((total, value) => total + value, 0n);
}

export function subtractUnits(left, right) {
  return left - right;
}

export function negateUnits(value) {
  return -value;
}

export function absUnits(value) {
  return value < 0n ? -value : value;
}

export function compareUnits(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function minUnits(left, right) {
  return left <= right ? left : right;
}

export function maxUnits(left, right) {
  return left >= right ? left : right;
}

/** Build the canonical Money object used in responses. */
export function moneyObject(units, currency) {
  return { amount: formatUnits(units, 2), currency };
}

/** Parse a Money object, returning units and currency. */
export function parseMoneyObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AmountError('money must be an object with amount and currency');
  }
  const units = parseAmountString(value.amount);
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) {
    throw new AmountError('currency must be an ISO 4217 alpha-3 code');
  }
  return { units, currency: value.currency };
}

/** True when the value is exactly zero. */
export function isZero(value) {
  return value === 0n;
}

export { SCALE, PERCENT_SCALE, PERCENT_FACTOR };
