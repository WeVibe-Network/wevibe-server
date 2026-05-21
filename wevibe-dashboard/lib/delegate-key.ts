import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';

const DB_NAME = 'wevibe-dashboard';
const DB_VERSION = 2;
const STORE_NAME = 'delegate-keys';

interface StoredDelegateKey {
  walletAddress: string;
  delegateAddress: string;
  encryptedMnemonic: string;
  createdAt: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'walletAddress' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deriveEncryptionKey(walletAddress: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(walletAddress),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode('wevibe-delegate-key-v1'),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptMnemonic(mnemonic: string, walletAddress: string): Promise<string> {
  const key = await deriveEncryptionKey(walletAddress);
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(mnemonic),
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptMnemonic(encrypted: string, walletAddress: string): Promise<string> {
  const key = await deriveEncryptionKey(walletAddress);
  const data = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}

export interface DelegateKeyInfo {
  address: string;
  pubkey: Uint8Array;
  mnemonic: string;
  walletAddress: string;
}

export async function generateDelegateKey(walletAddress: string): Promise<DelegateKeyInfo> {
  const hdWallet = await DirectSecp256k1HdWallet.generate(24, {
    prefix: 'wevibe',
  });

  const [account] = await hdWallet.getAccounts();
  const pubkey = account.pubkey;

  const mnemonic = hdWallet.mnemonic;

  return {
    address: account.address,
    pubkey,
    mnemonic,
    walletAddress,
  };
}

export async function storeDelegateKey(
  walletAddress: string,
  delegateAddress: string,
  mnemonic: string,
): Promise<void> {
  const encryptedMnemonic = await encryptMnemonic(mnemonic, walletAddress);
  const db = await openDB();
  const record: StoredDelegateKey = {
    walletAddress,
    delegateAddress,
    encryptedMnemonic,
    createdAt: new Date().toISOString(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getDelegateKey(
  walletAddress: string,
): Promise<{ delegateAddress: string; pubkey: Uint8Array } | null> {
  const db = await openDB();
  const record = await new Promise<StoredDelegateKey | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(walletAddress);
    req.onsuccess = () => resolve(req.result as StoredDelegateKey | undefined);
    req.onerror = () => reject(req.error);
  });
  if (!record) return null;

  try {
    const mnemonic = await decryptMnemonic(record.encryptedMnemonic, walletAddress);
    const hdWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: 'wevibe',
    });
    const [account] = await hdWallet.getAccounts();
    return {
      delegateAddress: account.address,
      pubkey: account.pubkey,
    };
  } catch {
    return {
      delegateAddress: record.delegateAddress,
      pubkey: new Uint8Array(),
    };
  }
}

export async function getDelegateWallet(
  walletAddress: string,
): Promise<DirectSecp256k1HdWallet | null> {
  const db = await openDB();
  const record = await new Promise<StoredDelegateKey | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(walletAddress);
    req.onsuccess = () => resolve(req.result as StoredDelegateKey | undefined);
    req.onerror = () => reject(req.error);
  });
  if (!record) return null;

  const mnemonic = await decryptMnemonic(record.encryptedMnemonic, walletAddress);
  return DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: 'wevibe',
  });
}

export async function clearDelegateKey(walletAddress: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(walletAddress);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}