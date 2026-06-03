import { getConfig } from './config';

const UVIBE_PER_VIBE = BigInt(1_000_000);
const UVIBE_FRACTION_DIGITS = 6;

function parseUvibe(uvibe: string | number): bigint {
  if (typeof uvibe === 'number') {
    if (!Number.isFinite(uvibe) || !Number.isInteger(uvibe)) {
      throw new Error('uvibe number input must be a finite integer');
    }
    return BigInt(uvibe);
  }

  const normalized = uvibe.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error('uvibe string input must be an integer');
  }
  return BigInt(normalized);
}

export function formatVibe(uvibe: string | number): string {
  const uvibeInt = parseUvibe(uvibe);
  const isNegative = uvibeInt < BigInt(0);
  const absUvibe = isNegative ? -uvibeInt : uvibeInt;

  const wholePart = absUvibe / UVIBE_PER_VIBE;
  const fractionPart = absUvibe % UVIBE_PER_VIBE;
  const sign = isNegative ? '-' : '';

  if (fractionPart === BigInt(0)) {
    return `${sign}${wholePart.toString()}`;
  }

  const fractionalDigits = fractionPart
    .toString()
    .padStart(UVIBE_FRACTION_DIGITS, '0')
    .replace(/0+$/, '');

  return `${sign}${wholePart.toString()}.${fractionalDigits}`;
}

export function formatVibeWithDenom(uvibe: string | number): string {
  return `${formatVibe(uvibe)} ${getConfig().coinDenom}`;
}
