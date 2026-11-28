// Excel's finite range and 15 significant decimal digits apply to numeric
// cells. Text cells deliberately bypass this check and keep the input verbatim.
export function isExactXlsxNumber(literal: string): boolean {
  const canonical = (text: string) => {
    const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]{1,4}))?$/.exec(text);
    if (!match || !(match[2] || match[3])) return null;
    const fraction = match[3] ?? '';
    const allDigits = (match[2] + fraction).replace(/^0+/, '');
    const digits = allDigits.replace(/0+$/, '');
    const exponent = Number(match[4] ?? 0) - fraction.length + allDigits.length - digits.length;
    return digits ? [match[1] === '-' ? '-' : '+', digits, exponent] as const : ['+', '0', 0] as const;
  };
  if (literal.length > 128) return false;
  const decimal = canonical(literal);
  if (!decimal || decimal[1].length > 15) return false;
  const number = Number(literal);
  if (!Number.isFinite(number) || number !== 0 && Math.abs(number) < 2.2250738585072014e-308) return false;
  const roundTrip = canonical(String(number));
  return roundTrip !== null && decimal.every((part, index) => part === roundTrip[index]);
}
