const DB_NAME = 'wevibe-dashboard';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const KEY_ID = 'dashboard-identity';

interface StoredIdentity {
  id: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  pubkeyHex: string;
  createdAt: string;
  walletAddress?: string;
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

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getOrCreateIdentity(): Promise<{ pubkeyHex: string; isNew: boolean }> {
  const db = await openDB();

  const existing = await new Promise<StoredIdentity | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(KEY_ID);
    req.onsuccess = () => resolve(req.result as StoredIdentity | undefined);
    req.onerror = () => reject(req.error);
  });

  if (existing) {
    return { pubkeyHex: existing.pubkeyHex, isNew: false };
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );

  const rawPubkey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const pubkeyHex = bufToHex(rawPubkey);

  const identity: StoredIdentity = {
    id: KEY_ID,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    pubkeyHex,
    createdAt: new Date().toISOString(),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(identity);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  return { pubkeyHex, isNew: true };
}

export async function getIdentity(): Promise<StoredIdentity | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(KEY_ID);
    req.onsuccess = () => resolve((req.result as StoredIdentity) ?? null);
    req.onerror = () => reject(req.error);
  });
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
  const encoder = new TextEncoder();
  const data = encoder.encode(timestamp);

  const signature = await crypto.subtle.sign('Ed25519', identity.privateKey, data);
  const signatureHex = bufToHex(signature);

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

  const publicKeyJwk = await crypto.subtle.exportKey('jwk', identity.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', identity.privateKey);

  return { publicKeyJwk, privateKeyJwk, pubkeyHex: identity.pubkeyHex };
}

export async function importIdentity(publicKeyJwk: JsonWebKey, privateKeyJwk: JsonWebKey): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );

  const rawPubkey = await crypto.subtle.exportKey('raw', publicKey);
  const pubkeyHex = bufToHex(rawPubkey);

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({
      id: KEY_ID,
      publicKey,
      privateKey,
      pubkeyHex,
      createdAt: new Date().toISOString(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

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
  const db = await openDB();
  const existing = await new Promise<StoredIdentity | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(KEY_ID);
    req.onsuccess = () => resolve(req.result as StoredIdentity | undefined);
    req.onerror = () => reject(req.error);
  });
  if (!existing) return;
  existing.walletAddress = address;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(existing);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getWalletAddress(): Promise<string | null> {
  const identity = await getIdentity();
  return identity?.walletAddress ?? null;
}