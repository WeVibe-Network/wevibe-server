// Wallet-derived at-rest seed wrapper (Option A: wallet-as-identity).
//
// Mirrors passkey.ts's envelope — HKDF-SHA256 → AES-256-GCM — but the KEK
// secret comes from a wallet signature over a FIXED domain-separated message
// (deterministic RFC6979 for software Keplr/Leap), instead of a WebAuthn PRF
// output. Same wallet key re-signing the fixed message reproduces the same KEK.
//
// The pure core (*WithWalletSecret) has NO wallet I/O and is Node-import-safe;
// the wallet-facing wrappers import ./wallet-connect dynamically (browser-only
// module) at call time.

import type { WrappedSeed } from './passkey';

/** Fixed domain-separated message the wallet signs (public, non-secret). */
export const WALLET_WRAP_MESSAGE = 'wevibe-identity-seed-wrap-v1';

const WALLET_SEED_KEK_INFO = new TextEncoder().encode('wevibe-seed-kek-wallet-v1');

// Module-private helpers mirrored verbatim from passkey.ts (kept unexported
// there), except bare `crypto` becomes `globalThis.crypto` so this module also
// runs under Node for its unit test.

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/** Hashes the wallet signature bytes into the HKDF input key material. */
async function signatureToIkm(signature: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytesToArrayBuffer(signature));
  return new Uint8Array(digest);
}

/** Derives an AES-256-GCM key-encryption-key from signature-derived IKM via HKDF. */
async function deriveWalletSeedKek(ikm: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const ikmKey = await globalThis.crypto.subtle.importKey(
    'raw',
    bytesToArrayBuffer(ikm),
    'HKDF',
    false,
    ['deriveKey'],
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bytesToArrayBuffer(hkdfSalt),
      info: bytesToArrayBuffer(WALLET_SEED_KEK_INFO),
    },
    ikmKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypts an identity seed under a KEK derived from wallet signature bytes. Pure: no wallet I/O. */
export async function wrapSeedWithWalletSecret(
  signature: Uint8Array,
  seed: Uint8Array,
): Promise<WrappedSeed> {
  const hkdfSalt = randomBytes(32);
  const iv = randomBytes(12);
  // Local copy so the caller's buffer is never mutated by zeroization.
  const signatureCopy = Uint8Array.from(signature);
  const ikm = await signatureToIkm(signatureCopy);

  try {
    const kek = await deriveWalletSeedKek(ikm, hkdfSalt);
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
      kek,
      bytesToArrayBuffer(seed),
    );

    return {
      v: 1,
      hkdfSaltB64: bytesToBase64(hkdfSalt),
      ivB64: bytesToBase64(iv),
      ctB64: bytesToBase64(new Uint8Array(ciphertext)),
    };
  } finally {
    ikm.fill(0);
    signatureCopy.fill(0);
  }
}

/** Decrypts a wallet-wrapped seed payload from the same wallet signature bytes. Pure: no wallet I/O. */
export async function unwrapSeedWithWalletSecret(
  signature: Uint8Array,
  wrapped: WrappedSeed,
): Promise<Uint8Array> {
  // Local copy so the caller's buffer is never mutated by zeroization.
  const signatureCopy = Uint8Array.from(signature);
  const ikm = await signatureToIkm(signatureCopy);

  try {
    if (wrapped.v !== 1) {
      throw new Error(`Unsupported wrapped seed version: ${wrapped.v}`);
    }

    const hkdfSalt = base64ToBytes(wrapped.hkdfSaltB64);
    const iv = base64ToBytes(wrapped.ivB64);
    const ciphertext = base64ToBytes(wrapped.ctB64);

    const kek = await deriveWalletSeedKek(ikm, hkdfSalt);
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
      kek,
      bytesToArrayBuffer(ciphertext),
    );

    return new Uint8Array(plaintext);
  } finally {
    ikm.fill(0);
    signatureCopy.fill(0);
  }
}

/** Wallet-facing wrap: sign the fixed message with the connected wallet, then delegate to the pure core. */
export async function wrapSeedWithWallet(walletAddress: string, seed: Uint8Array): Promise<WrappedSeed> {
  const { signArbitraryMessage, getChainConfig } = await import('./wallet-connect');
  const { signature } = await signArbitraryMessage(
    getChainConfig().chainId,
    walletAddress,
    WALLET_WRAP_MESSAGE,
  );
  return wrapSeedWithWalletSecret(signature, seed);
}

/** Wallet-facing unwrap: sign the fixed message with the connected wallet, then delegate to the pure core. */
export async function unwrapSeedWithWallet(walletAddress: string, wrapped: WrappedSeed): Promise<Uint8Array> {
  const { signArbitraryMessage, getChainConfig } = await import('./wallet-connect');
  const { signature } = await signArbitraryMessage(
    getChainConfig().chainId,
    walletAddress,
    WALLET_WRAP_MESSAGE,
  );
  return unwrapSeedWithWalletSecret(signature, wrapped);
}
