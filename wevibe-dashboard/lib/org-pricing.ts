// Mirrors chain x/org DefaultParams for alpha-slot pricing.
// TODO: live-fetch these params from chain/hub in a follow-up.
export const BASE_PRICE_UVIBE = 10_000_000;
export const INCREASE_PERCENT = 20;
export const SLOT_CAP = 32;

const UVIBE_PER_VIBE = 1_000_000;

export function slotPriceUvibe(slot: number): number {
  const normalizedSlot = Math.max(0, Math.floor(slot));
  const multiplier = Math.pow(1 + INCREASE_PERCENT / 100, normalizedSlot);
  return Math.round(BASE_PRICE_UVIBE * multiplier);
}

export function slotBarHeightPercent(slot: number): number {
  const FLOOR = 6;
  const maxSlot = SLOT_CAP - 1;
  const s = Math.max(0, Math.min(Math.floor(slot), maxSlot));
  return FLOOR + (s / maxSlot) * (100 - FLOOR);
}

export function uvibeToVibe(uvibe: number): number {
  return uvibe / UVIBE_PER_VIBE;
}
