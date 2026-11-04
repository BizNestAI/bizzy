// Decimal-to-cents conversion without binary floating-point rounding at .005.
// Amounts beyond the safe integer range are rejected rather than approximated.
export function decimalCents(value) {
  const match = String(value).match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('invalid_money');
  const fraction = match[3] || '';
  const absolute = Number(match[2]) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0')) + (Number(fraction[2] || 0) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(absolute)) throw new Error('money_precision_limit');
  return match[1] === '-' ? -absolute : absolute;
}
