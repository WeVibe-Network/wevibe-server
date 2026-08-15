// Unit tests for the wallet-derived at-rest seed envelope (wallet-seed-wrap.ts).
// Exercises ONLY the pure, wallet-I/O-free core (wrapSeedWithWalletSecret /
// unwrapSeedWithWalletSecret) with fixed fake signature bytes — no wallet, no
// network. Mirrors lib/merkle.test.ts harness style.
// Run via:
//   npx tsx lib/wallet-seed-wrap.test.ts

import type { WrappedSeed } from './passkey';
import { unwrapSeedWithWalletSecret, wrapSeedWithWalletSecret } from './wallet-seed-wrap';

// Fixed, distinct fake signatures (crypto-envelope inputs only; never real
// wallet output). 0xa5 and 0x5a are bit-inversions, so the derived KEKs differ.
const sigA = new Uint8Array(64).fill(0xa5);
const sigB = new Uint8Array(64).fill(0x5a);

// Deterministic 32-byte identity seed.
const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);

let failed = 0;
let total = 0;

function report(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}\n  ${detail}`);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function main() {
  // 1. Round-trip: wrap then unwrap with the SAME signature bytes.
  const wrappedA = await wrapSeedWithWalletSecret(sigA, seed);
  const roundTripped = await unwrapSeedWithWalletSecret(sigA, wrappedA);
  const roundTripOk = roundTripped.length === 32 && bytesEqual(roundTripped, seed);
  report(
    'round-trip (wrap -> unwrap with same signature)',
    roundTripOk,
    `length ${roundTripped.length} (expected 32), byte-for-byte equal ${roundTripped.length === 32 && bytesEqual(roundTripped, seed)}`,
  );

  // 2. Wrong key fails: unwrap with a DIFFERENT signature must reject
  //    (AES-GCM authentication failure).
  let wrongKeyRejected = false;
  let wrongKeyDetail = 'unwrap unexpectedly resolved';
  try {
    const leaked = await unwrapSeedWithWalletSecret(sigB, wrappedA);
    wrongKeyDetail = `resolved with ${leaked.length} bytes`;
  } catch (err) {
    wrongKeyRejected = true;
    wrongKeyDetail = `rejected: ${err instanceof Error ? err.name : String(err)}`;
  }
  report('wrong-key unwrap rejects (AES-GCM auth failure)', wrongKeyRejected, wrongKeyDetail);

  // 3a. Version guard: a v !== 1 payload throws the explicit version error.
  const badVersion = {
    v: 2,
    hkdfSaltB64: wrappedA.hkdfSaltB64,
    ivB64: wrappedA.ivB64,
    ctB64: wrappedA.ctB64,
  } as unknown as WrappedSeed;
  let versionGuardError = '';
  try {
    await unwrapSeedWithWalletSecret(sigA, badVersion);
  } catch (err) {
    versionGuardError = err instanceof Error ? err.message : String(err);
  }
  report(
    'version guard (v: 2 payload rejected)',
    versionGuardError === 'Unsupported wrapped seed version: 2',
    `error "${versionGuardError}" (expected "Unsupported wrapped seed version: 2")`,
  );

  // 3b. Malformed payload: missing b64 fields must throw, not silently decrypt.
  const missingFields = { v: 1 } as unknown as WrappedSeed;
  let missingFieldsRejected = false;
  try {
    await unwrapSeedWithWalletSecret(sigA, missingFields);
  } catch {
    missingFieldsRejected = true;
  }
  report('malformed payload (missing fields rejected)', missingFieldsRejected, missingFieldsRejected ? 'threw as expected' : 'unwrap unexpectedly resolved');

  // 4. Fresh randomness per wrap: same sig + seed => different salt/iv/ct,
  //    and BOTH payloads unwrap to the identical seed.
  const wrappedA2 = await wrapSeedWithWalletSecret(sigA, seed);
  const envelopesDiffer = wrappedA.hkdfSaltB64 !== wrappedA2.hkdfSaltB64
    && wrappedA.ivB64 !== wrappedA2.ivB64
    && wrappedA.ctB64 !== wrappedA2.ctB64;
  const secondRoundTrip = await unwrapSeedWithWalletSecret(sigA, wrappedA2);
  const secondUnwrapOk = bytesEqual(secondRoundTrip, seed);
  report(
    'fresh salt/iv per wrap (envelopes differ, both unwrap)',
    envelopesDiffer && secondUnwrapOk,
    `salt/iv/ct all differ ${envelopesDiffer}, second unwrap matches seed ${secondUnwrapOk}`,
  );

  if (failed > 0) {
    console.log(`\nFAILED ${failed} of ${total} wallet-seed-wrap tests`);
    process.exit(1);
  }
  console.log(`\nAll ${total} wallet-seed-wrap tests PASSED`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
