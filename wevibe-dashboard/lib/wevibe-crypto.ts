// Browser-only helper module.

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

export async function encryptSymmetric(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const wasm = await ensureWasm();
  return wasm.encrypt_symmetric(plaintext, key);
}

export async function masterKeyToMnemonic(master: Uint8Array): Promise<string> {
  const wasm = await ensureWasm();
  return wasm.master_key_to_mnemonic(master);
}

export async function seedToMnemonic(seed: Uint8Array): Promise<string> {
  if (seed.length !== 32) {
    throw new Error(`Identity seed must be 32 bytes; received ${seed.length}`);
  }

  const wasm = await ensureWasm();
  return wasm.master_key_to_mnemonic(seed);
}

export async function mnemonicToSeed(phrase: string): Promise<Uint8Array> {
  const wasm = await ensureWasm();
  const seed = wasm.mnemonic_to_master_key(phrase.trim());
  const seedBytes = new Uint8Array(seed);

  if (seedBytes.length !== 32) {
    throw new Error(`mnemonic_to_master_key returned invalid seed length: ${seedBytes.length}`);
  }

  return seedBytes;
}

export async function signRaw(priv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const wasm = await ensureWasm();
  return wasm.sign(priv, data);
}
