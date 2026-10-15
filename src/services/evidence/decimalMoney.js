const MONEY_SCALE = 100n;
const PERCENT_SCALE = 10000n;

export function moneyMinor(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("invalid_money_value");
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const minor = BigInt(whole) * MONEY_SCALE + BigInt((fraction + "00").slice(0, 2));
  return negative ? -minor : minor;
}

export function moneyString(minor) {
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / MONEY_SCALE}.${String(absolute % MONEY_SCALE).padStart(2, "0")}`;
}

export function sumMoney(values = []) {
  return values.reduce((sum, value) => sum + moneyMinor(value), 0n);
}

export function percentString(numeratorMinor, denominatorMinor) {
  const numerator = BigInt(numeratorMinor);
  const denominator = BigInt(denominatorMinor);
  if (denominator === 0n) return null;
  const scaled = divideRounded(numerator * 100n * PERCENT_SCALE, denominator);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  return `${negative ? "-" : ""}${absolute / PERCENT_SCALE}.${String(absolute % PERCENT_SCALE).padStart(4, "0")}`;
}

function divideRounded(numerator, denominator) {
  if (denominator === 0n) throw new Error("division_by_zero");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const rounded = n % d * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function absoluteMinor(value) {
  const minor = BigInt(value);
  return minor < 0n ? -minor : minor;
}

