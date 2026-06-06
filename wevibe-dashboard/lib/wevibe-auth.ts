import * as ed from '@noble/ed25519';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import {
  type WrappedSeed,
  createIdentityPasskey,
  decryptSeedWithPrf,
  discoverPasskeyPrf,
  isPasskeySupported,
  unwrapSeed,
  wrapSeed,
} from './passkey';
import { fetchIdentityBlob } from './hub-client';

const DB_NAME = 'wevibe-dashboard';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const KEY_ID = 'dashboard-identity';
const SESSION_SEED_KEY = 'wevibe.session.seed.v1';

const X25519_DOMAIN_TAG = 'wevibe-x25519-v1';

const textEncoder = new TextEncoder();
const PAIRING_KEK_INFO = textEncoder.encode('wevibe-pair-v1');
const BASE32_RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

let unlockedSeed: Uint8Array | null = null;

interface StoredIdentityRecord {
  id: typeof KEY_ID;
  pubkeyHex: string;
  credentialIdB64: string;
  wrapped: WrappedSeed;
  createdAt: string;
  walletAddress?: string;
}

export interface IdentityMetadata {
  pubkeyHex: string;
  walletAddress?: string;
  createdAt: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// Seed cached in sessionStorage (cleared on tab close) to avoid a biometric
// prompt on every refresh. This exposes the raw seed to XSS for the tab
// session — an accepted product tradeoff (Walter).
function persistSeedToSession(pubkeyHex: string, seed: Uint8Array): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }

  try {
    sessionStorage.setItem(
      SESSION_SEED_KEY,
      JSON.stringify({ pubkeyHex, seedB64: bytesToBase64(seed) }),
    );
  } catch {
    // Ignore sessionStorage failures.
  }
}

function loadSeedFromSession(expectedPubkeyHex: string): Uint8Array | null {
  if (typeof sessionStorage === 'undefined') {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(SESSION_SEED_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as { pubkeyHex?: unknown; seedB64?: unknown };
    if (parsed.pubkeyHex !== expectedPubkeyHex || typeof parsed.seedB64 !== 'string') {
      return null;
    }

    const seed = base64ToBytes(parsed.seedB64);
    return seed.length === 32 ? seed : null;
  } catch {
    return null;
  }
}

function clearSessionSeed(): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }

  try {
    sessionStorage.removeItem(SESSION_SEED_KEY);
  } catch {
    // Ignore sessionStorage failures.
  }
}

function bytesToBase32Rfc4648NoPaddingUppercase(bytes: Uint8Array): string {
  let output = '';
  let bitBuffer = 0;
  let bitCount = 0;

  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;

    while (bitCount >= 5) {
      const index = (bitBuffer >>> (bitCount - 5)) & 0x1f;
      output += BASE32_RFC4648_ALPHABET[index];
      bitCount -= 5;
    }

    bitBuffer &= (1 << bitCount) - 1;
  }

  if (bitCount > 0) {
    const index = (bitBuffer << (5 - bitCount)) & 0x1f;
    output += BASE32_RFC4648_ALPHABET[index];
  }

  return output;
}

function base32Rfc4648NoPaddingUppercaseToBytes(value: string): Uint8Array {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return new Uint8Array(0);
  }

  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;

  for (const char of normalized) {
    const index = BASE32_RFC4648_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error('Invalid pairing code.');
    }

    bitBuffer = (bitBuffer << 5) | index;
    bitCount += 5;

    while (bitCount >= 8) {
      bytes.push((bitBuffer >>> (bitCount - 8)) & 0xff);
      bitCount -= 8;
      bitBuffer &= (1 << bitCount) - 1;
    }
  }

  if (bitCount > 0 && (bitBuffer & ((1 << bitCount) - 1)) !== 0) {
    throw new Error('Invalid pairing code.');
  }

  return new Uint8Array(bytes);
}

async function derivePairingKek(secret: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const secretKeyMaterial = await crypto.subtle.importKey(
    'raw',
    bytesToArrayBuffer(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bytesToArrayBuffer(hkdfSalt),
      info: bytesToArrayBuffer(PAIRING_KEK_INFO),
    },
    secretKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function deriveEd25519PubkeyHex(seed: Uint8Array): Promise<string> {
  const pubkey = await ed.getPublicKeyAsync(seed);
  return bytesToHex(pubkey);
}

function isWrappedSeed(value: unknown): value is WrappedSeed {
  return typeof value === 'object'
    && value !== null
    && 'v' in value
    && 'hkdfSaltB64' in value
    && 'ivB64' in value
    && 'ctB64' in value
    && (value as WrappedSeed).v === 1
    && typeof (value as WrappedSeed).hkdfSaltB64 === 'string'
    && typeof (value as WrappedSeed).ivB64 === 'string'
    && typeof (value as WrappedSeed).ctB64 === 'string';
}

async function loadIdentityRecord(): Promise<StoredIdentityRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(KEY_ID);
    req.onsuccess = () => {
      const result = req.result as Partial<StoredIdentityRecord> | undefined;
      if (
        !result
        || result.id !== KEY_ID
        || typeof result.pubkeyHex !== 'string'
        || typeof result.credentialIdB64 !== 'string'
        || typeof result.createdAt !== 'string'
        || !isWrappedSeed(result.wrapped)
        || (typeof result.walletAddress !== 'undefined' && typeof result.walletAddress !== 'string')
      ) {
        resolve(null);
        return;
      }

      resolve(result as StoredIdentityRecord);
    };
    req.onerror = () => reject(req.error);
  });
}

async function saveIdentityRecord(identity: StoredIdentityRecord): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(identity);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function ensureUnlockedSeed(): Promise<Uint8Array> {
  if (!unlockedSeed) {
    await unlockIdentity();
  }

  if (!unlockedSeed) {
    throw new Error('No dashboard identity seed is unlocked.');
  }

  return unlockedSeed;
}

export async function unlockIdentity(): Promise<void> {
  if (unlockedSeed) {
    return;
  }

  const record = await loadIdentityRecord();
  if (!record) {
    throw new Error('No dashboard identity. Generate one first.');
  }

  const cached = loadSeedFromSession(record.pubkeyHex);
  if (cached) {
    unlockedSeed = cached;
    return;
  }

  const credentialId = base64ToBytes(record.credentialIdB64);
  const seed = await unwrapSeed(credentialId, record.wrapped);

  if (seed.length !== 32) {
    throw new Error(`Invalid Ed25519 seed length in wrapped identity record: ${seed.length}`);
  }

  unlockedSeed = seed;
  persistSeedToSession(record.pubkeyHex, seed);
}

export function lockIdentity(): void {
  if (unlockedSeed) {
    unlockedSeed.fill(0);
    unlockedSeed = null;
  }

  clearSessionSeed();
}

export function isUnlocked(): boolean {
  return unlockedSeed !== null;
}

export async function exportIdentityPhrase(): Promise<string> {
  if (!isUnlocked()) {
    await unlockIdentity();
  }

  if (!unlockedSeed) {
    throw new Error('Identity is locked');
  }

  const { seedToMnemonic } = await import('./wevibe-crypto');
  return seedToMnemonic(unlockedSeed);
}

export async function createPairingToken(): Promise<{ token: string }> {
  const seed = await ensureUnlockedSeed();
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  try {
    const pairingId = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', secret)));
    const kek = await derivePairingKek(secret, hkdfSalt);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
      kek,
      bytesToArrayBuffer(seed),
    ));

    await import('./hub-client').then((m) => m.uploadPairingBlob({
      pairing_id: pairingId,
      hkdf_salt: bytesToBase64(hkdfSalt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
    }));

    const token = bytesToBase32Rfc4648NoPaddingUppercase(secret);
    return { token };
  } finally {
    secret.fill(0);
  }
}

export async function createGuestIdentity(): Promise<{ pubkeyHex: string }> {
  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not supported in this browser. A WebAuthn + PRF-capable passkey is required.');
  }

  const existing = await loadIdentityRecord();
  const { generateIdentity } = await import('./wevibe-crypto');
  const id = await generateIdentity();

  const seed = new Uint8Array(id.edPriv);
  if (seed.length !== 32) {
    seed.fill(0);
    id.edPriv.fill(0);
    id.xPriv.fill(0);
    throw new Error(`generateIdentity returned invalid Ed25519 seed length: ${seed.length}`);
  }

  try {
    const pubkeyHex = await deriveEd25519PubkeyHex(seed);

    const { credentialId, prfSupported } = await createIdentityPasskey({
      userId: id.edPub,
      userName: 'wevibe',
      displayName: 'WeVibe Identity',
    });

    if (!prfSupported) {
      throw new Error('Passkey PRF extension is required to protect your WeVibe identity seed.');
    }

    const wrapped = await wrapSeed(credentialId, seed);

    const identity: StoredIdentityRecord = {
      id: KEY_ID,
      pubkeyHex,
      credentialIdB64: bytesToBase64(credentialId),
      wrapped,
      createdAt: new Date().toISOString(),
      ...(existing?.walletAddress ? { walletAddress: existing.walletAddress } : {}),
    };

    await saveIdentityRecord(identity);
    lockIdentity();
    unlockedSeed = seed;

    try {
      const { uploadIdentityBlob } = await import('./hub-client');
      await uploadIdentityBlob({
        credential_id: identity.credentialIdB64,
        hkdf_salt: wrapped.hkdfSaltB64,
        iv: wrapped.ivB64,
        ciphertext: wrapped.ctB64,
      });
    } catch (e) {
      console.warn('WeVibe: identity blob upload to hub failed (identity still created locally):', e);
    }

    return { pubkeyHex };
  } catch (error) {
    seed.fill(0);
    throw error;
  } finally {
    id.edPriv.fill(0);
    id.xPriv.fill(0);
  }
}

async function adoptImportedSeed(seed: Uint8Array): Promise<{ pubkeyHex: string }> {
  try {
    const existing = await loadIdentityRecord();
    const pubkeyHex = await deriveEd25519PubkeyHex(seed);
    const userId = await ed.getPublicKeyAsync(seed);

    const { credentialId, prfSupported } = await createIdentityPasskey({
      userId,
      userName: 'wevibe',
      displayName: 'WeVibe Identity',
    });

    if (!prfSupported) {
      throw new Error('Passkey PRF extension is required to protect your WeVibe identity seed.');
    }

    const wrapped = await wrapSeed(credentialId, seed);

    const record: StoredIdentityRecord = {
      id: KEY_ID,
      pubkeyHex,
      credentialIdB64: bytesToBase64(credentialId),
      wrapped,
      createdAt: new Date().toISOString(),
      ...(existing?.walletAddress ? { walletAddress: existing.walletAddress } : {}),
    };

    await saveIdentityRecord(record);
    lockIdentity();
    unlockedSeed = seed;

    try {
      const { uploadIdentityBlob } = await import('./hub-client');
      await uploadIdentityBlob({
        credential_id: record.credentialIdB64,
        hkdf_salt: wrapped.hkdfSaltB64,
        iv: wrapped.ivB64,
        ciphertext: wrapped.ctB64,
      });
    } catch (e) {
      console.warn('WeVibe: identity blob upload to hub failed (identity still created locally):', e);
    }

    return { pubkeyHex };
  } catch (error) {
    seed.fill(0);
    throw error;
  }
}

export async function importIdentityFromPhrase(phrase: string): Promise<{ pubkeyHex: string }> {
  const { mnemonicToSeed } = await import('./wevibe-crypto');
  const seed = await mnemonicToSeed(phrase);

  return adoptImportedSeed(seed);
}

export async function adoptIdentityFromCode(token: string): Promise<{ pubkeyHex: string }> {
  const secret = base32Rfc4648NoPaddingUppercaseToBytes(token.trim().toUpperCase());
  if (secret.length !== 16) {
    secret.fill(0);
    throw new Error('Invalid pairing code.');
  }

  try {
    const pairingId = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(secret))));
    const blob = await import('./hub-client').then((m) => m.fetchPairingBlob(pairingId));
    if (!blob) {
      throw new Error('Pairing code not found or expired. Generate a new one in your plugin.');
    }

    const hkdfSalt = base64ToBytes(blob.hkdf_salt);
    const iv = base64ToBytes(blob.iv);
    const ciphertext = base64ToBytes(blob.ciphertext);
    const kek = await derivePairingKek(secret, hkdfSalt);
    const seed = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesToArrayBuffer(iv) },
      kek,
      bytesToArrayBuffer(ciphertext),
    ));

    if (seed.length !== 32) {
      seed.fill(0);
      throw new Error(`Invalid Ed25519 seed length in adopted identity record: ${seed.length}`);
    }

    return adoptImportedSeed(seed);
  } finally {
    secret.fill(0);
  }
}

export async function adoptIdentityFromPasskey(): Promise<{ pubkeyHex: string }> {
  const { credentialId, prfOutput } = await discoverPasskeyPrf();
  try {
    const credentialIdB64 = bytesToBase64(credentialId);
    const blob = await fetchIdentityBlob(credentialIdB64);

    if (!blob) {
      throw new Error('No identity found for this passkey');
    }

    const wrapped: WrappedSeed = {
      v: 1,
      hkdfSaltB64: blob.hkdf_salt,
      ivB64: blob.iv,
      ctB64: blob.ciphertext,
    };

    const seed = await decryptSeedWithPrf(prfOutput, wrapped);
    if (seed.length !== 32) {
      seed.fill(0);
      throw new Error(`Invalid Ed25519 seed length in adopted identity record: ${seed.length}`);
    }

    try {
      const pubkeyHex = await deriveEd25519PubkeyHex(seed);
      if (pubkeyHex.toLowerCase() !== blob.pubkey.toLowerCase()) {
        throw new Error('identity integrity check failed');
      }

      const record: StoredIdentityRecord = {
        id: KEY_ID,
        pubkeyHex,
        credentialIdB64,
        wrapped,
        createdAt: new Date().toISOString(),
      };

      await saveIdentityRecord(record);
      lockIdentity();
      unlockedSeed = seed;

      return { pubkeyHex };
    } catch (error) {
      seed.fill(0);
      throw error;
    }
  } finally {
    prfOutput.fill(0);
  }
}

export async function deriveIdentityX25519Keypair(): Promise<{ priv: Uint8Array; pub: Uint8Array }> {
  const seed = await ensureUnlockedSeed();
  const info = textEncoder.encode(X25519_DOMAIN_TAG);
  const priv = hkdf(sha256, seed, new Uint8Array(0), info, 32);
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

export async function getIdentity(): Promise<IdentityMetadata | null> {
  const record = await loadIdentityRecord();
  if (!record) {
    return null;
  }

  return {
    pubkeyHex: record.pubkeyHex,
    walletAddress: record.walletAddress,
    createdAt: record.createdAt,
  };
}

export async function signWithIdentity(data: Uint8Array): Promise<string> {
  const seed = await ensureUnlockedSeed();
  const sig = await ed.signAsync(data, seed);
  return bytesToHex(sig);
}

export async function signTimestamp(): Promise<{
  pubkeyHex: string;
  timestamp: string;
  signatureHex: string;
  authHeader: string;
} | null> {
  const identity = await getIdentity();
  if (!identity) return null;

  const timestamp = new Date().toISOString();
  const data = textEncoder.encode(timestamp);
  const signatureHex = await signWithIdentity(data);

  const authHeader = `WeVibe-Signed pubkey=${identity.pubkeyHex},timestamp=${timestamp},signature=${signatureHex}`;

  return {
    pubkeyHex: identity.pubkeyHex,
    timestamp,
    signatureHex,
    authHeader,
  };
}

export async function buildAuthHeaders(): Promise<Record<string, string>> {
  const signed = await signTimestamp();
  if (!signed) {
    throw new Error('No dashboard identity. Generate one first.');
  }
  return {
    Authorization: signed.authHeader,
  };
}

export async function clearIdentity(): Promise<void> {
  lockIdentity();
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function setWalletAddress(address: string): Promise<void> {
  const existing = await loadIdentityRecord();
  if (!existing) return;
  existing.walletAddress = address;
  await saveIdentityRecord(existing);
}

export async function clearWalletAddress(): Promise<void> {
  const existing = await loadIdentityRecord();
  if (!existing) return;
  existing.walletAddress = undefined;
  await saveIdentityRecord(existing);
}

export async function getWalletAddress(): Promise<string | null> {
  const identity = await getIdentity();
  return identity?.walletAddress ?? null;
}
