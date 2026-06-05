import * as ed from '@noble/ed25519';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import {
  type WrappedSeed,
  createIdentityPasskey,
  derivePrfKey,
  isPasskeySupported,
  unwrapSeed,
  wrapSeed,
} from './passkey';

const DB_NAME = 'wevibe-dashboard';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const KEY_ID = 'dashboard-identity';

const X25519_DOMAIN_TAG = 'wevibe-x25519-v1';

const textEncoder = new TextEncoder();

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

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function isWrappedSeed(value: unknown): value is WrappedSeed {
  return typeof value === 'object'
    && value !== null
    && 'v' in value
    && 'ivB64' in value
    && 'ctB64' in value
    && (value as WrappedSeed).v === 1
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

  const credentialId = base64ToBytes(record.credentialIdB64);
  const key = await derivePrfKey(credentialId);
  const seed = await unwrapSeed(key, record.wrapped);

  if (seed.length !== 32) {
    throw new Error(`Invalid Ed25519 seed length in wrapped identity record: ${seed.length}`);
  }

  unlockedSeed = seed;
}

export function lockIdentity(): void {
  if (unlockedSeed) {
    unlockedSeed.fill(0);
    unlockedSeed = null;
  }
}

export function isUnlocked(): boolean {
  return unlockedSeed !== null;
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

  const pubkeyHex = bytesToHex(id.edPub);

  try {
    const { credentialId, prfSupported } = await createIdentityPasskey({
      userId: id.edPub,
      userName: 'wevibe',
      displayName: 'WeVibe Identity',
    });

    if (!prfSupported) {
      throw new Error('Passkey PRF extension is required to protect your WeVibe identity seed.');
    }

    const key = await derivePrfKey(credentialId);
    const wrapped = await wrapSeed(key, seed);

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
    return { pubkeyHex };
  } catch (error) {
    seed.fill(0);
    throw error;
  } finally {
    id.edPriv.fill(0);
    id.xPriv.fill(0);
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

export async function getWalletAddress(): Promise<string | null> {
  const identity = await getIdentity();
  return identity?.walletAddress ?? null;
}
