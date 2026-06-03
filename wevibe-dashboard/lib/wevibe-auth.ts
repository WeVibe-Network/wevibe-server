import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';

const DB_NAME = 'wevibe-dashboard';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const KEY_ID = 'dashboard-identity';

const IDENTITY_CHALLENGE_VERSION = 'v1';
const SEED_DOMAIN_TAG = 'wevibe-ed25519-v1';

const textEncoder = new TextEncoder();

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

interface StoredIdentity {
  id: string;
  pubkeyHex: string;
  seedHex: string;
  createdAt: string;
  walletAddress?: string;
}

function identityChallenge(address: string): string {
  return `WeVibe Dashboard Identity ${IDENTITY_CHALLENGE_VERSION}\nDerive my Ed25519 hub authentication key.\nWallet: ${address}`;
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

function bufToHex(buf: ArrayBuffer): string {
  return bytesToHex(new Uint8Array(buf));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex length');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('Invalid hex value');
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function hexToBuf(hex: string): ArrayBuffer {
  const bytes = hexToBytes(hex);
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function deriveSeedFromSignature(signatureBase64: string): Uint8Array {
  const signatureBytes = base64ToBytes(signatureBase64);
  return sha256(ed.etc.concatBytes(textEncoder.encode(SEED_DOMAIN_TAG), signatureBytes));
}

async function loadIdentityRecord(): Promise<StoredIdentity | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(KEY_ID);
    req.onsuccess = () => {
      const result = req.result as Partial<StoredIdentity> | undefined;
      if (!result || typeof result.pubkeyHex !== 'string' || typeof result.seedHex !== 'string') {
        resolve(null);
        return;
      }
      resolve(result as StoredIdentity);
    };
    req.onerror = () => reject(req.error);
  });
}

async function saveIdentityRecord(identity: StoredIdentity): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(identity);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deriveIdentityFromWallet(
  walletApi: {
    signArbitrary(
      chainId: string,
      address: string,
      message: string,
    ): Promise<{ signature: string }>;
  },
  chainId: string,
  address: string,
): Promise<StoredIdentity> {
  const challenge = identityChallenge(address);
  const signed = await walletApi.signArbitrary(chainId, address, challenge);
  const seed = deriveSeedFromSignature(signed.signature);
  const pubkey = await ed.getPublicKeyAsync(seed);

  const identity: StoredIdentity = {
    id: KEY_ID,
    pubkeyHex: bytesToHex(pubkey),
    seedHex: bytesToHex(seed),
    createdAt: new Date().toISOString(),
    walletAddress: address,
  };

  await saveIdentityRecord(identity);
  return identity;
}

export async function getIdentity(): Promise<StoredIdentity | null> {
  return loadIdentityRecord();
}

export async function signEd25519WithSeed(seedHex: string, data: Uint8Array): Promise<string> {
  const sig = await ed.signAsync(data, hexToBytes(seedHex));
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
  const signatureHex = await signEd25519WithSeed(identity.seedHex, data);

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

export async function exportIdentity(): Promise<{
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  pubkeyHex: string;
} | null> {
  const identity = await getIdentity();
  if (!identity) return null;

  const pubkeyBytes = hexToBytes(identity.pubkeyHex);

  const publicKeyJwk: JsonWebKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: bytesToBase64Url(pubkeyBytes),
  };

  const privateKeyJwk: JsonWebKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: bytesToBase64Url(pubkeyBytes),
    d: identity.seedHex,
  };

  return { publicKeyJwk, privateKeyJwk, pubkeyHex: identity.pubkeyHex };
}

export async function importIdentity(publicKeyJwk: JsonWebKey, privateKeyJwk: JsonWebKey): Promise<string> {
  const seedHexCandidate =
    typeof privateKeyJwk.d === 'string'
      ? privateKeyJwk.d
      : typeof privateKeyJwk.k === 'string'
        ? privateKeyJwk.k
        : null;

  if (!seedHexCandidate || !/^[0-9a-fA-F]{64}$/.test(seedHexCandidate)) {
    throw new Error('Invalid identity import. Expected 32-byte seed hex.');
  }

  const seedHex = seedHexCandidate.toLowerCase();
  const seed = hexToBytes(seedHex);
  const pubkey = await ed.getPublicKeyAsync(seed);
  const pubkeyHex = bytesToHex(pubkey);

  const identity: StoredIdentity = {
    id: KEY_ID,
    pubkeyHex,
    seedHex,
    createdAt: new Date().toISOString(),
  };

  await saveIdentityRecord(identity);
  return pubkeyHex;
}

export async function clearIdentity(): Promise<void> {
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
