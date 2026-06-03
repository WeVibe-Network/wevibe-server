import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { signEd25519WithSeed } from './wevibe-auth';
import { createOrgCanonical } from './wevibe-signing';

// Browser-only helper module. This file depends on browser APIs (btoa + WebCrypto via createOrgCanonical).

type WasmModule = typeof import('wevibe-sdk-wasm');

let wasmModulePromise: Promise<WasmModule> | null = null;

export interface EpochKeys {
  encKey: Uint8Array;
  searchKey: Uint8Array;
  auditKey: Uint8Array;
}

export interface IdentityBundle {
  edPriv: Uint8Array;
  edPub: Uint8Array;
  xPriv: Uint8Array;
  xPub: Uint8Array;
}

export interface BuildOrgSetupArgs {
  orgId: string;
  orgName: string;
  domain: string;
  leaderEd25519PubHex: string;
  leaderSeedHex: string;
  leaderWallet: string;
}

export interface BuildOrgSetupPayload {
  org_id: string;
  leader_pubkey: string;
  leader_x25519_pubkey: string;
  leader_wallet: string;
  org_name: string;
  domain: string;
  fee_model: null;
  pk_mod: string;
  signature: string;
  enc_envelope: string;
  search_envelope: string;
  mod_envelope: string;
}

export interface BuildOrgSetupResult {
  payload: BuildOrgSetupPayload;
  recoveryPhrase: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0) {
    throw new Error('Invalid hex length');
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    const byte = Number.parseInt(normalized.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('Invalid hex value');
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function requireBytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`SDK returned invalid ${name}`);
  }
  return value;
}

export async function ensureWasm(): Promise<WasmModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const m = await import('wevibe-sdk-wasm');
      if (m.default) {
        await m.default();
      }
      return m;
    })();
  }
  return wasmModulePromise;
}

export async function generateDek(): Promise<Uint8Array> {
  const wasm = await ensureWasm();
  return wasm.generate_dek();
}

export async function deriveEpochKeys(master: Uint8Array, epoch: number): Promise<EpochKeys> {
  const wasm = await ensureWasm();
  const tuple = wasm.derive_epoch_keys(master, epoch);

  if (!Array.isArray(tuple) || tuple.length < 3) {
    throw new Error('derive_epoch_keys returned an unexpected value');
  }

  return {
    encKey: requireBytes(tuple[0], 'encKey'),
    searchKey: requireBytes(tuple[1], 'searchKey'),
    auditKey: requireBytes(tuple[2], 'auditKey'),
  };
}

export async function generateIdentity(): Promise<IdentityBundle> {
  const wasm = await ensureWasm();
  const tuple = wasm.generate_identity();

  if (!Array.isArray(tuple) || tuple.length < 4) {
    throw new Error('generate_identity returned an unexpected value');
  }

  return {
    edPriv: requireBytes(tuple[0], 'edPriv'),
    edPub: requireBytes(tuple[1], 'edPub'),
    xPriv: requireBytes(tuple[2], 'xPriv'),
    xPub: requireBytes(tuple[3], 'xPub'),
  };
}

export async function sealToPubkey(plaintext: Uint8Array, recipientPub: Uint8Array): Promise<Uint8Array> {
  const wasm = await ensureWasm();
  return wasm.seal_to_pubkey(plaintext, recipientPub);
}

export async function masterKeyToMnemonic(master: Uint8Array): Promise<string> {
  const wasm = await ensureWasm();
  return wasm.master_key_to_mnemonic(master);
}

export async function signRaw(priv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const wasm = await ensureWasm();
  return wasm.sign(priv, data);
}

export function deriveX25519FromSeed(seedHex: string): { priv: Uint8Array; pub: Uint8Array } {
  const seed = hexToBytes(seedHex);
  if (seed.length !== 32) {
    throw new Error('leaderSeedHex must decode to 32 bytes');
  }

  const info = new TextEncoder().encode('wevibe-x25519-v1');
  const priv = hkdf(sha256, seed, new Uint8Array(0), info, 32);
  const pub = x25519.getPublicKey(priv);

  seed.fill(0);
  return { priv, pub };
}

export async function buildOrgSetup(args: BuildOrgSetupArgs): Promise<BuildOrgSetupResult> {
  const x25519Keys = deriveX25519FromSeed(args.leaderSeedHex);

  let masterKey: Uint8Array | null = null;
  let epoch0: EpochKeys | null = null;
  let moderatorIdentity: IdentityBundle | null = null;

  try {
    masterKey = await generateDek();
    epoch0 = await deriveEpochKeys(masterKey, 0);
    moderatorIdentity = await generateIdentity();

    const encEnvelope = bytesToBase64(await sealToPubkey(epoch0.encKey, x25519Keys.pub));
    const searchEnvelope = bytesToBase64(await sealToPubkey(epoch0.searchKey, x25519Keys.pub));
    const modEnvelope = bytesToBase64(await sealToPubkey(moderatorIdentity.xPriv, x25519Keys.pub));
    const pkMod = bytesToHex(moderatorIdentity.xPub);

    const leaderPubkey = args.leaderEd25519PubHex;
    const leaderX25519Pubkey = bytesToHex(x25519Keys.pub);

    const canonical = await createOrgCanonical(
      args.orgId,
      leaderPubkey,
      leaderX25519Pubkey,
      args.orgName,
      args.domain,
      encEnvelope,
      searchEnvelope,
      modEnvelope,
      pkMod,
      null,
    );

    const signature = await signEd25519WithSeed(args.leaderSeedHex, canonical);
    const recoveryPhrase = await masterKeyToMnemonic(masterKey);

    return {
      payload: {
        org_id: args.orgId,
        leader_pubkey: leaderPubkey,
        leader_x25519_pubkey: leaderX25519Pubkey,
        leader_wallet: args.leaderWallet,
        org_name: args.orgName,
        domain: args.domain,
        fee_model: null,
        pk_mod: pkMod,
        signature,
        enc_envelope: encEnvelope,
        search_envelope: searchEnvelope,
        mod_envelope: modEnvelope,
      },
      recoveryPhrase,
    };
  } finally {
    masterKey?.fill(0);
    epoch0?.encKey.fill(0);
    epoch0?.searchKey.fill(0);
    epoch0?.auditKey.fill(0);
    moderatorIdentity?.edPriv.fill(0);
    moderatorIdentity?.xPriv.fill(0);
    x25519Keys.priv.fill(0);
  }
}
